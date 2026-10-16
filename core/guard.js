import { join } from 'node:path';
import { readJson, writeJson } from './util.js';

const WINDOW_MS = 3600 * 1000;
const BYTE_BUDGET = 1024 * 1024 * 1024; // per user per hour - one hd video runs 60-100MB, one proxied web page ~12MB; this is the sanity guardrail, not a savings measure
const REQ_BUDGET = 5000;              // per user per hour - abuse ceiling, not a human-use limit
// the owner account rides free of the hourly byte budget; everyone else keeps it.
const BYTE_EXEMPT = new Set((process.env.RJ_BYTE_EXEMPT || '').split(',').map(s => s.trim()).filter(Boolean));
const LOGIN_TRIES = 10;               // per account per 10 min; a wide per-ip ceiling sits in index.js
const LOGIN_WINDOW = 600 * 1000;
// key-space bounds with anti-churn admission: entries with a LIVE window are
// never evicted (a victim's throttle state must never silently reset), expired
// windows are shed first, and a map full of live entries refuses admission -
// the callers then fail CLOSED, so churning fake keys buys no verify and no
// request. without this, 10001 invented usernames (or ips) could erase a
// victim's cap, and every unbounded map is a memory DoS.
const LOGIN_KEYS_CAP = 10000;
const STATE_KEYS_CAP = 10000;

export class Guard {
  constructor(dataDir) {
    this.path = join(dataDir, 'guard.json');
    this.state = readJson(this.path, {});
    this.loginTries = new Map();
    // an inherited state file can outsize the live window: shed expired
    // buckets at boot so a stale oversized guard.json shrinks back
    const boot = Date.now();
    for (const k of Object.keys(this.state)) if (boot - this.state[k].windowStart > WINDOW_MS) delete this.state[k];
    this._buckets = Object.keys(this.state).length;
    this.dirtyAt = 0;
  }
  bucket(user) {
    const now = Date.now();
    let b = this.state[user];
    if (b && now - b.windowStart > WINDOW_MS) { delete this.state[user]; this._buckets--; b = null; }
    if (!b) {
      if (this._buckets >= STATE_KEYS_CAP) {
        for (const k of Object.keys(this.state)) {
          if (now - this.state[k].windowStart > WINDOW_MS) { delete this.state[k]; this._buckets--; }
        }
        if (this._buckets >= STATE_KEYS_CAP) return null; // full of live buckets: fail closed
      }
      b = { windowStart: now, bytes: 0, requests: 0 };
      this.state[user] = b;
      this._buckets++;
    }
    return b;
  }
  allowRequest(user) {
    const b = this.bucket(user);
    if (!b) return false; // under churn a new key is denied, never reset-by-eviction
    b.requests += 1;
    this.persistSoon();
    return b.requests <= REQ_BUDGET;
  }
  trackBytes(user, n) {
    const b = this.bucket(user);
    if (b) b.bytes += n; // admission refused: the matching allowRequest already denied
    this.persistSoon();
  }
  bytesLeft(user) {
    if (BYTE_EXEMPT.has(user)) return Number.MAX_SAFE_INTEGER;
    const b = this.bucket(user);
    return b ? BYTE_BUDGET - b.bytes : 0; // unknown key under churn: nothing to spend
  }
  // one admission path for every login-throttle key (acct:, ip:, signup:):
  // live entries are never evicted; a map full of live entries fails closed.
  _loginEntry(key, now) {
    let t = this.loginTries.get(key);
    if (t && now - t.start > LOGIN_WINDOW) { this.loginTries.delete(key); t = null; }
    if (!t) {
      if (this.loginTries.size >= LOGIN_KEYS_CAP) {
        for (const [k, v] of this.loginTries) if (now - v.start > LOGIN_WINDOW) this.loginTries.delete(k);
        if (this.loginTries.size >= LOGIN_KEYS_CAP) return null;
      }
      t = { start: now, count: 0 };
      this.loginTries.set(key, t);
    }
    return t;
  }
  allowLogin(key, limit = LOGIN_TRIES) {
    const t = this._loginEntry(key, Date.now());
    if (!t) return false; // churn: fail closed
    t.count += 1;
    return t.count <= limit;
  }
  // account-level brute-force budget counts FAILURES, not attempts: a correct
  // password never spends it, and a success clears it. over budget the login
  // route demands the account's known-device cookie before verifying, so an
  // attacker who knows a username cannot lock the owner out.
  accountLoginLimited(key, limit = LOGIN_TRIES) {
    const now = Date.now();
    const t = this.loginTries.get(key);
    if (!t || now - t.start > LOGIN_WINDOW) {
      if (this.loginTries.size < LOGIN_KEYS_CAP) return false;
      // shed before concluding: a map full of EXPIRED entries must not deny
      // anyone (e.g. change-password for an account with no live entry)
      for (const [k, v] of this.loginTries) if (now - v.start > LOGIN_WINDOW) this.loginTries.delete(k);
      // an unknown key while the map is full of LIVE entries fails closed:
      // a spray of invented names must not buy verifies by churn
      return this.loginTries.size >= LOGIN_KEYS_CAP;
    }
    return t.count >= limit;
  }
  recordLoginFailure(key) {
    const t = this._loginEntry(key, Date.now());
    if (t) t.count += 1; // admission refused: that key is already failing closed
  }
  resetLoginFailures(key) { this.loginTries.delete(key); }
  persistSoon() {
    const now = Date.now();
    if (now - this.dirtyAt > 15000) { this.dirtyAt = now; writeJson(this.path, this.state); }
  }
  flush() { writeJson(this.path, this.state); }
}
