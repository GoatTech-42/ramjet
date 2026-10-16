import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { isIP, BlockList } from 'node:net';

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
// Only an explicitly trusted socket peer may vouch for forwarded identity.
// Select from the right, never from an attacker-controlled leftmost entry.
const TRUSTED_PROXY = (process.env.RJ_TRUST_PROXY || '127.0.0.1,::1').split(',').map((s) => s.trim()).filter(Boolean);
const FORWARDED_HOPS = Number(process.env.RJ_FORWARDED_HOPS || '1');
if (!Number.isInteger(FORWARDED_HOPS) || FORWARDED_HOPS < 1 || FORWARDED_HOPS > 8) throw Error('Invalid forwarded hop count');
const forwardedProxyRanges = new BlockList();
for (const entry of (process.env.RJ_FORWARDED_PROXY_CIDRS || '').split(',').map(s => s.trim()).filter(Boolean)) {
  const [address, prefixText] = entry.split('/');
  const family = isIP(address);
  const prefix = prefixText === undefined ? (family === 4 ? 32 : 128) : Number(prefixText);
  if (!family || !Number.isInteger(prefix) || prefix < 0 || prefix > (family === 4 ? 32 : 128)) throw Error('Invalid forwarded proxy range');
  forwardedProxyRanges.addSubnet(address, prefix, family === 4 ? 'ipv4' : 'ipv6');
}
const bareIp = value => String(value || '').trim().replace(/^::ffff:/, '');
export function trustedProxy(req) {
  const peer = req.socket.remoteAddress || '';
  return TRUSTED_PROXY.includes(peer) || TRUSTED_PROXY.includes(bareIp(peer));
}
export function clientIp(req) {
  const peer = req.socket.remoteAddress || '';
  if (!trustedProxy(req)) return peer;
  const raw = req.headers['x-forwarded-for'];
  if (typeof raw !== 'string' || raw.length > 4096) return peer;
  const chain = raw.split(',').map(bareIp);
  if (chain.length < FORWARDED_HOPS || chain.length > 32) return peer;
  const selected = chain.length - FORWARDED_HOPS;
  // Every skipped intermediate hop must be an explicitly configured proxy.
  // A direct-origin request cannot invent a second-last client address.
  for (let i = selected + 1; i < chain.length; i++) {
    const family = isIP(chain[i]);
    if (!family || !forwardedProxyRanges.check(chain[i], family === 4 ? 'ipv4' : 'ipv6')) return peer;
  }
  return isIP(chain[selected]) ? chain[selected] : peer;
}
// session cookies go Secure when the deployment is https-fronted: explicitly
// (RJ_SECURE_COOKIES=1) or per request when a trusted proxy says the client
// hop was https. a direct client's spoofed x-forwarded-proto is ignored.
export function secureCookieFor(req) {
  if (process.env.RJ_SECURE_COOKIES === '1') return true;
  return !!(req && trustedProxy(req) && (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https');
}

export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
