import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (cause) {
    if (cause.code === 'ENOENT') return fallback;
    // JSON parser messages can include private file contents. Do not retain them.
    const error = new Error('stored JSON is unreadable or invalid');
    error.code = 'RJ_STORE_INVALID';
    throw error;
  }
}
export function writeJson(path, obj, mode) {
  // Never replace corrupt existing state, even if a caller caught a failed read.
  readJson(path, undefined);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2), mode == null ? undefined : { mode });
  renameSync(tmp, path);
}
export function readBody(req, limit = 65536) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
export function sendJson(res, status, obj, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(obj));
}
export function redirect(res, location) {
  res.writeHead(302, { location });
  res.end();
}
export function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    // a malformed percent escape must skip the pair, never throw the request
    if (i > 0) { try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch {} }
  }
  return out;
}
// forwarded identity is only as real as the peer that vouches for it: honor
// x-forwarded-for from the on-box proxy (loopback, or RJ_TRUST_PROXY peers)
// and use the socket address for everyone else, or a direct client rotates
// its identity at will
const TRUSTED_PROXY = (process.env.RJ_TRUST_PROXY || '127.0.0.1,::1').split(',').map((s) => s.trim()).filter(Boolean);
export function trustedProxy(req) {
  const peer = req.socket.remoteAddress || '';
  const bare = peer.replace(/^::ffff:/, '');
  return TRUSTED_PROXY.includes(peer) || TRUSTED_PROXY.includes(bare);
}
export function clientIp(req) {
  if (trustedProxy(req)) {
    const fwd = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (fwd) return fwd;
  }
  return req.socket.remoteAddress || '';
}
// session cookies go Secure when the deployment is https-fronted: explicitly
// (RJ_SECURE_COOKIES=1) or per request when a trusted proxy says the client
// hop was https. a direct client's spoofed x-forwarded-proto is ignored.
export function secureCookieFor(req) {
  if (process.env.RJ_SECURE_COOKIES === '1') return true;
  return !!(req && trustedProxy(req) && (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https');
}

export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
