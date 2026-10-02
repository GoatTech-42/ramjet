import { join } from 'node:path';
import { readJson, writeJson } from './util.js';

const WINDOW_MS = 3600 * 1000;
const BYTE_BUDGET = 1024 * 1024 * 1024; // per user per hour - one hd video runs 60-100MB, one proxied web page ~12MB; this is the sanity guardrail, not a savings measure
const REQ_BUDGET = 5000;              // per user per hour - abuse ceiling, not a human-use limit
// luke asked (Sep 29 3:58 PM, verbatim "Unlimited cap on my account plz") -
// his account rides free of the hourly byte budget; everyone else keeps it.
const BYTE_EXEMPT = new Set(['luke']);
const LOGIN_TRIES = 10;               // per account per 10 min; a wide per-ip ceiling sits in index.js
const LOGIN_WINDOW = 600 * 1000;

export class Guard {
  constructor(dataDir) {
    this.path = join(dataDir, 'guard.json');
    this.state = readJson(this.path, {});
    this.loginTries = new Map();
    this.dirtyAt = 0;
  }
  bucket(user) {
    const now = Date.now();
    let b = this.state[user];
    if (!b || now - b.windowStart > WINDOW_MS) {
      b = { windowStart: now, bytes: 0, requests: 0 };
      this.state[user] = b;
    }
    return b;
  }
  allowRequest(user) {
    const b = this.bucket(user);
    b.requests += 1;
    this.persistSoon();
    return b.requests <= REQ_BUDGET;
  }
  trackBytes(user, n) {
    this.bucket(user).bytes += n;
    this.persistSoon();
  }
  bytesLeft(user) {
    if (BYTE_EXEMPT.has(user)) return Number.MAX_SAFE_INTEGER;
    return BYTE_BUDGET - this.bucket(user).bytes;
  }
  allowLogin(key, limit = LOGIN_TRIES) {
    const now = Date.now();
    let t = this.loginTries.get(key);
    if (!t || now - t.start > LOGIN_WINDOW) { t = { start: now, count: 0 }; this.loginTries.set(key, t); }
    t.count += 1;
    return t.count <= limit;
  }
  persistSoon() {
    const now = Date.now();
    if (now - this.dirtyAt > 15000) { this.dirtyAt = now; writeJson(this.path, this.state); }
  }
  flush() { writeJson(this.path, this.state); }
}
