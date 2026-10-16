// shared ssrf defenses: outbound hops resolve once, pin the resolved ip, and
// every candidate address is checked against a full non-global deny list.
import net from 'node:net';
import dns from 'node:dns';

function v4(ip) { return ip.split('.').map(Number); }
function blockedV4Bytes(bytes) {
  const [a, b, c] = bytes;
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0 && c === 0) || (a === 192 && b === 0 && c === 2) ||
    (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113);
}
// parse any RFC 4291 form (compressed, expanded, dotted-v4 tail) to 16 bytes
function v6Bytes(ip) {
  if (!net.isIPv6(ip)) return null;
  let s = ip.toLowerCase();
  const m = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (m) { // embedded dotted v4 tail becomes its two hex groups
    s = s.slice(0, m.index) + ((+m[1] << 8) | +m[2]).toString(16) + ':' + ((+m[3] << 8) | +m[4]).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1 && head.length !== 8) return null;
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  const bytes = [];
  for (const g of [...head, ...Array(missing).fill('0'), ...tail]) {
    const n = parseInt(g, 16);
    if (!(n >= 0 && n <= 0xffff) || g === '') return null;
    bytes.push(n >> 8, n & 0xff);
  }
  return bytes.length === 16 ? bytes : null;
}
// bit-prefix match on the normalized 16-byte form
function inPrefix(b, prefixBytes, bits) {
  for (let i = 0; i * 8 < bits; i++) {
    const full = Math.min(8, bits - i * 8);
    const mask = full === 8 ? 0xff : (0xff << (8 - full)) & 0xff;
    if ((b[i] & mask) !== (prefixBytes[i] & mask)) return false;
  }
  return true;
}
// iana v6 special registry: the 2001::/23 protocol-assignment entries marked
// globally reachable - the rest of 2001::/23 fails closed below.
const V6_2001_GLOBALS = [
  [[0x20, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01], 128], // 2001:1::1 pcp anycast
  [[0x20, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02], 128], // 2001:1::2 turn anycast
  [[0x20, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03], 128], // 2001:1::3 dns-sd anycast
  [[0x20, 0x01, 0x00, 0x03], 32],   // 2001:3::/32 amt
  [[0x20, 0x01, 0x00, 0x04, 0x01, 0x12], 48], // 2001:4:112::/48 as112-v6
  [[0x20, 0x01, 0x00, 0x20], 28],   // 2001:20::/28 orchidv2 (registry: reachable)
];
// ipv6 default is DENY: allow only global unicast (2000::/3) minus the iana
// special-purpose ranges. site-local, discard-only, benchmark, documentation,
// tunneling and every unallocated/future range fail closed.
function blockedV6Global(b) {
  if (!inPrefix(b, [0x20], 3)) return true; // outside global unicast
  if (V6_2001_GLOBALS.some(([p, bits]) => inPrefix(b, p, bits))) return false;
  if (inPrefix(b, [0x20, 0x01], 23)) return true; // 2001::/23 ietf protocol assignments (teredo, benchmark, orchid, ...)
  if (inPrefix(b, [0x20, 0x01, 0x0d, 0xb8], 32)) return true; // 2001:db8::/32 documentation
  if (inPrefix(b, [0x20, 0x02], 16)) return true; // 2002::/16 6to4
  if (inPrefix(b, [0x3f, 0xff], 20)) return true; // 3fff::/20 documentation
  return false;
}
// classify the normalized 128-bit address, never its text form: expanded,
// compressed and mapped forms of the same address classify identically.
export function blockedIp(ip) {
  if (net.isIPv6(ip)) {
    const b = v6Bytes(ip);
    if (!b) return true;
    const allZero = (arr) => arr.every((v) => v === 0);
    if (allZero(b)) return true; // ::
    if (allZero(b.slice(0, 15)) && b[15] === 1) return true; // ::1
    // ::ffff:a.b.c.d mapped, ::a.b.c.d deprecated-compatible: classify the embedded v4
    if (allZero(b.slice(0, 10)) && ((b[10] === 0xff && b[11] === 0xff) || (b[10] === 0 && b[11] === 0)))
      return blockedV4Bytes(b.slice(12));
    return blockedV6Global(b);
  }
  if (!net.isIPv4(ip)) return true;
  return blockedV4Bytes(v4(ip));
}
// resolve once, return the pinned address (throws on anything private).
// opts.allowPrivate is for test fixtures only (loopback servers).
export async function pin(host, opts = {}) {
  host = host.replace(/^\[|\]$/g, '');
  if (!host || host.length > 253) throw new Error('bad host');
  if (/^(localhost|.*\.localhost|.*\.local|.*\.internal|host\.docker\.internal)$/i.test(host)) throw new Error('blocked address');
  if (opts.allowPrivate) {
    if (net.isIP(host)) return { address: host, family: net.isIPv6(host) ? 6 : 4 };
    const list = await dns.promises.lookup(host, { all: true });
    if (!list.length) throw new Error('no address');
    const r = list.find((x) => x.family === 4) || list[0];
    return { address: r.address, family: r.family };
  }
  if (net.isIP(host)) { if (blockedIp(host)) throw new Error('blocked address'); return { address: host, family: net.isIPv6(host) ? 6 : 4 }; }
  // odd encodings (decimal 2130706433, hex 0x7f.1, octal 0177.1) are numeric-looking hosts: refuse
  if (/^[0-9a-fx.]+$/i.test(host) && !/[g-z]/i.test(host)) throw new Error('blocked address');
  const list = await dns.promises.lookup(host, { all: true });
  if (!list.length) throw new Error('no address');
  for (const r of list) if (blockedIp(r.address)) throw new Error('blocked address'); // any private answer taints the name
  const r = list.find((x) => x.family === 4) || list[0];
  return { address: r.address, family: r.family };
}
export function checkUrl(u) {
  let t; try { t = new URL(u); } catch { throw new Error('bad url'); }
  if (!/^https?:$/.test(t.protocol) || t.username || t.password) throw new Error('bad url');
  const port = t.port ? Number(t.port) : (t.protocol === 'https:' ? 443 : 80);
  if (port !== 80 && port !== 443) throw new Error('port not allowed');
  return t;
}
