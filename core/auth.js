import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { chmodSync, existsSync } from 'node:fs';
import { readJson, writeJson, secureCookieFor } from './util.js';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
const SESSION_TTL = 30 * 24 * 3600 * 1000;
const COOKIE = 'rj2_session';
const NAME_RE = /^[a-z0-9_.-]{2,24}$/;


export class Auth {
  constructor(dataDir) {
    this.usersPath = join(dataDir, 'users.json');
    this.sessionsPath = join(dataDir, 'sessions.json');
    this.users = readJson(this.usersPath, {});
    this.sessions = new Map();
    const now = Date.now();
    for (const [token, s] of Object.entries(readJson(this.sessionsPath, {}))) {
      if (s.expires > now) this.sessions.set(token, s);
    }
    // revocation generation: bumped whenever a user's authority is cut
    // (sessions killed, single-session logout, ban, removal, password
    // change). short-lived bearers (proxy tickets, the lite credential
    // cache) record the generation at mint and are validated against it at
    // use, so they can never outlive the authority that minted them.
    this.revGen = new Map();
    this.onRevoked = null; // the server hooks this to drop live proxy pipes
    this.onRenamed = null; // the server hooks this to rekey live proxy pipes
    // credential stores must never sit group/other-readable on disk; repair
    // the mode of anything a looser era left behind
    for (const f of [this.usersPath, this.sessionsPath]) {
      if (existsSync(f)) chmodSync(f, 0o600); // a store we cannot lock down must not be used
    }
  }
  revGeneration(username) { return this.revGen.get(String(username || '').trim().toLowerCase()) || 0; }
  bumpRev(username) {
    const name = String(username || '').trim().toLowerCase();
    this.revGen.set(name, this.revGeneration(name) + 1);
    try { this.onRevoked && this.onRevoked(name); } catch {}
  }
  hashPassword(password, salt) {
    salt = salt || randomBytes(16).toString('hex');
    const key = scryptSync(String(password), salt, SCRYPT.keylen, SCRYPT).toString('hex');
    return { salt, key };
  }
  createUser(username, password, extra = {}) {
    const name = String(username || '').trim().toLowerCase();
    if (!NAME_RE.test(name)) throw new Error('usernames are 2-24 chars: letters, numbers, . _ -');
    if (this.users[name]) throw new Error('that name is taken');
    if (String(password).length < 6) throw new Error('password needs 6+ characters');
    this.users[name] = { ...this.hashPassword(password), created: Date.now(), ...extra };
    writeJson(this.usersPath, this.users, 0o600);
    return name;
  }
  renameUser(oldName, newName) {
    const o = String(oldName || '').trim().toLowerCase();
    const n = String(newName || '').trim().toLowerCase();
    if (!NAME_RE.test(n)) throw new Error('usernames are 2-24 chars: letters, numbers, . _ -');
    if (!this.users[o]) throw new Error('no such user');
    if (this.users[n]) throw new Error('that name is taken');
    this.users[n] = this.users[o];
    delete this.users[o];
    writeJson(this.usersPath, this.users, 0o600);
    for (const sess of this.sessions.values()) if (sess.user === o) sess.user = n;
    this.persistSessions();
    // live proxy pipes key on the account name: follow the rename or a later
    // revocation under the new name misses connections the old name opened
    try { this.onRenamed && this.onRenamed(o, n); } catch {}
    return n;
  }
  setPassword(username, password) {
    const name = String(username || '').trim().toLowerCase();
    const u = this.users[name];
    if (!u) throw new Error('no such user');
    if (String(password).length < 6) throw new Error('password needs 6+ characters');
    Object.assign(u, this.hashPassword(password));
    writeJson(this.usersPath, this.users, 0o600);
  }
  verify(username, password) {
    const u = this.users[String(username || '').trim().toLowerCase()];
    if (!u || !u.salt || !u.key) return null;
    const key = scryptSync(String(password), u.salt, SCRYPT.keylen, SCRYPT);
    return timingSafeEqual(key, Buffer.from(u.key, 'hex')) ? u : null;
  }
  createSession(username) {
    const token = randomBytes(32).toString('base64url');
    this.sessions.set(token, { user: username, created: Date.now(), expires: Date.now() + SESSION_TTL });
    this.persistSessions();
    return token;
  }
  sessionFromCookies(cookies) {
    const token = cookies[COOKIE];
    if (!token) return null;
    const s = this.sessions.get(token);
    if (!s) return null;
    // a banned or still-pending account never rides an old session
    const acct = this.users[s.user];
    if (!acct || (acct.status && acct.status !== 'active')) return null;
    if (s.expires < Date.now()) { this.sessions.delete(token); this.persistSessions(); return null; }
    return { token, user: s.user };
  }
  setStatus(username, status) {
    const u = this.users[String(username || '').trim().toLowerCase()];
    if (!u) throw new Error('no such user');
    if (status === 'active') delete u.status; else u.status = status;
    writeJson(this.usersPath, this.users, 0o600);
    if (status !== 'active') this.killSessions(username);
  }
  removeUser(username) {
    const name = String(username || '').trim().toLowerCase();
    if (!this.users[name]) throw new Error('no such user');
    delete this.users[name];
    writeJson(this.usersPath, this.users, 0o600);
    this.killSessions(name);
  }
  killSessions(username) {
    const name = String(username || '').trim().toLowerCase();
    for (const [t, sess] of this.sessions) if (sess.user === name) this.sessions.delete(t);
    this.persistSessions();
    this.bumpRev(name);
  }
  listUsers() {
    return Object.entries(this.users).map(([name, u]) => ({ name, status: u.status || 'active', created: u.created || 0 }));
  }
  destroySession(token) {
    const sess = this.sessions.get(token);
    if (this.sessions.delete(token)) {
      this.persistSessions();
      // one session logging out still revokes that user's minted bearers
      // (90s tickets, lite cache); a fresh login re-mints them
      if (sess) this.bumpRev(sess.user);
    }
  }
  persistSessions() {
    writeJson(this.sessionsPath, Object.fromEntries(this.sessions), 0o600);
  }
  cookieHeader(token, req) {
    return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL / 1000}${secureCookieFor(req) ? '; Secure' : ''}`;
  }
  clearCookieHeader(req) {
    return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureCookieFor(req) ? '; Secure' : ''}`;
  }
}
