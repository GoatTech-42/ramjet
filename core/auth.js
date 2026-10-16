import { scryptSync, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { join } from 'node:path';
import { chmodSync, existsSync } from 'node:fs';
import { readJson, writeJson, secureCookieFor } from './util.js';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
const SESSION_TTL = 30 * 24 * 3600 * 1000;
const COOKIE = 'rj2_session';
const KD_COOKIE = '__Host-rj_kd';
// known-device cookies let the rightful account owner through a login
// throttle their own typos (or an attacker who knows their username) filled
// up. only sha256 hashes are stored; the raw token lives only in the cookie.
// every entry carries a server-side expiry and a bounded failure budget: a
// stolen cookie buys at most KD_DEVICE_TRIES verified guesses before the
// device revokes itself, and each logout / logout-all / ban / password
// change path drops the entries the credential must not outlive.
const KD_TTL = 90 * 24 * 3600 * 1000; // server-side expiry, renewed on each login
const KD_MAX = 8; // devices remembered per account, fifo
const KD_DEVICE_TRIES = 20; // verified failures before a device self-revokes
// timing equalization for unknown usernames: a login for a name that does
// not exist still pays one scrypt, so the 401 is indistinguishable from a
// wrong password on a real account. the salt is a constant; nothing is
// stored or compared.
const DUMMY_SALT = '6b6575702d74696d696e672d657175616c697a6572';

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
    delete u.kd; // a new password must not inherit devices the old one trusted
    writeJson(this.usersPath, this.users, 0o600);
  }
  verify(username, password) {
    const u = this.users[String(username || '').trim().toLowerCase()];
    if (!u || !u.salt || !u.key) { scryptSync(String(password), DUMMY_SALT, SCRYPT.keylen, SCRYPT); return null; }
    const key = scryptSync(String(password), u.salt, SCRYPT.keylen, SCRYPT);
    return timingSafeEqual(key, Buffer.from(u.key, 'hex')) ? u : null;
  }
  get kdCookieName() { return KD_COOKIE; }
  kdHash(token) { return createHash('sha256').update(String(token)).digest('hex'); }
  // the stored entry for a presented cookie, or null. expired entries are
  // pruned on read, so an aged-out cookie simply stops matching.
  kdEntry(username, token) {
    const u = this.users[String(username || '').trim().toLowerCase()];
    if (!u || !token || !Array.isArray(u.kd)) return null;
    const now = Date.now();
    const live = u.kd.filter((e) => e && e.exp > now);
    if (live.length !== u.kd.length) { u.kd = live; writeJson(this.usersPath, this.users, 0o600); }
    const h = this.kdHash(token);
    return live.find((e) => e.h === h) || null;
  }
  // a fresh known-device token for the account; returns the raw token for
  // the cookie, stores only its hash (fifo at KD_MAX)
  mintKnownDevice(username) {
    const u = this.users[String(username || '').trim().toLowerCase()];
    if (!u) return null;
    const token = randomBytes(32).toString('hex'); // 256-bit
    u.kd = [...(Array.isArray(u.kd) ? u.kd : []), { h: this.kdHash(token), exp: Date.now() + KD_TTL, fails: 0 }].slice(-KD_MAX);
    writeJson(this.usersPath, this.users, 0o600);
    return token;
  }
  // a successful login from a remembered device renews THAT entry in place:
  // same token, fresh expiry. the failure count is NOT reset - it is a
  // lifetime budget, so a copied token never regains guesses when the owner
  // logs in. repeated logins from one browser never evict other devices.
  renewKnownDevice(username, token) {
    const e = this.kdEntry(username, token);
    if (!e) return false;
    e.exp = Date.now() + KD_TTL;
    writeJson(this.usersPath, this.users, 0o600);
    return true;
  }
  // a failed verify on a remembered device spends its LIFETIME budget (it is
  // never reset by later successes); at the cap the device revokes itself,
  // so a stolen cookie is a bounded asset.
  recordKdFailure(username, token) {
    const u = this.users[String(username || '').trim().toLowerCase()];
    const e = this.kdEntry(username, token);
    if (!u || !e) return;
    e.fails = (e.fails || 0) + 1;
    if (e.fails >= KD_DEVICE_TRIES) u.kd = u.kd.filter((x) => x !== e);
    writeJson(this.usersPath, this.users, 0o600);
  }
  // single-device logout forgets the asking device: its cookie must not keep
  // spending verifies after the session it rode in on is gone.
  revokeKnownDevice(username, token) {
    const u = this.users[String(username || '').trim().toLowerCase()];
    if (!u || !token || !Array.isArray(u.kd)) return;
    const h = this.kdHash(token);
    const keep = u.kd.filter((e) => e.h !== h);
    if (keep.length !== u.kd.length) { u.kd = keep; writeJson(this.usersPath, this.users, 0o600); }
  }
  clearKnownDevices(username) {
    const u = this.users[String(username || '').trim().toLowerCase()];
    if (u && u.kd) { delete u.kd; writeJson(this.usersPath, this.users, 0o600); }
  }
  kdCookieHeader(token) {
    // __Host- rules: Secure, Path=/, no Domain attribute. Secure is
    // unconditional - on a plain-http deployment the cookie simply never
    // sticks, degrading to pre-kd behavior instead of flying over http.
    return `${KD_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${KD_TTL / 1000}`;
  }
  clearKdCookieHeader() {
    return `${KD_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0`;
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
    this.clearKnownDevices(name); // no device may outlive the authority it rode in on
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
