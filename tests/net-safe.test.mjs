import test from 'node:test';
import assert from 'node:assert/strict';
import { blockedIp, pin, checkUrl } from '../core/net-safe.js';

test('blockedIp rejects IPv4-mapped IPv6 in dotted and hex forms', () => {
  for (const ip of ['::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:0a00:1', '::ffff:169.254.0.1'])
    assert.equal(blockedIp(ip), true, ip);
  assert.equal(blockedIp('::ffff:8.8.8.8'), false, 'mapped public v4 classifies as the v4 host');
});
test('blockedIp rejects multicast, reserved, broadcast, and documentation ranges', () => {
  for (const ip of ['224.0.0.1', '239.1.1.1', '240.0.0.1', '255.255.255.255', '192.0.2.1', '198.51.100.1', '203.0.113.1', '0.0.0.0', '100.64.0.1', '100.127.0.1', '198.18.0.1', '198.19.0.1'])
    assert.equal(blockedIp(ip), true, ip);
});
test('blockedIp rejects nat64, 6to4, link-local, ula, multicast v6, unspecified', () => {
  for (const ip of ['64:ff9b::1', '2002::1', 'fe80::1', 'fe90::1', 'fc00::1', 'fd00::1', 'ff02::1', '::', '::1'])
    assert.equal(blockedIp(ip), true, ip);
});
test('blockedIp allows ordinary public addresses', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])
    assert.equal(blockedIp(ip), false, ip);
});
test('pin refuses loopback, localhost names, mapped addrs, odd encodings; the test hook allows loopback fixtures', async () => {
  await assert.rejects(pin('127.0.0.1'), /blocked/);
  await assert.rejects(pin('::ffff:7f00:1'), /blocked/);
  await assert.rejects(pin('localhost'), /blocked/);
  await assert.rejects(pin('2130706433'), /blocked/);
  const ok = await pin('127.0.0.1', { allowPrivate: true });
  assert.equal(ok.address, '127.0.0.1');
  assert.equal(ok.family, 4);
});
test('checkUrl pins scheme and ports 80/443 only', () => {
  assert.throws(() => checkUrl('http://example.com:8080/'), /port not allowed/);
  assert.throws(() => checkUrl('ftp://example.com/'), /bad url/);
  assert.equal(checkUrl('https://example.com/x').hostname, 'example.com');
});

test('blockedIp classifies normalized 128-bit values: expanded, compressed and mapped forms agree', () => {
  // expanded forms of loopback / mapped v4 / documentation must block like their compressed forms
  for (const ip of ['0:0:0:0:0:0:0:1', '0:0:0:0:0:0:0:0', '0:0:0:0:0:ffff:7f00:1', '0000:0000:0000:0000:0000:ffff:7f00:0001',
    '0:0:0:0:0:0:7f00:1', '2001:db8::1', '2001:db8:0:0:0:0:0:1', '2001:0::1', '2002:808:808::1'])
    assert.equal(blockedIp(ip), true, ip);
  // expanded mapped PUBLIC v4 classifies as the v4 host: allowed
  assert.equal(blockedIp('0:0:0:0:0:ffff:0808:0808'), false);
  // expanded public v6 stays allowed
  assert.equal(blockedIp('2606:4700:4700:0:0:0:0:1111'), false);
});

test('ipv6 fails closed: only global unicast 2000::/3 minus iana special ranges is allowed', () => {
  // sage repros: site-local, discard-only, benchmark must not pass
  for (const ip of ['fec0::1', 'fec0::ffff:1', '100::1', '2001:2::1', '2001:2:0:8000::1'])
    assert.equal(blockedIp(ip), true, ip);
  // special-purpose table inside and beside 2000::/3
  for (const ip of ['2001:db8::1', '2002:808:808::1', '3fff::1', '3fff:0fff::1', '2001:0::1', '2001:10::1',
    '64:ff9b::1', 'fc00::1', 'fd00::1', 'fe80::1', 'ff02::1', '::1', '::'])
    assert.equal(blockedIp(ip), true, ip);
  // explicit globals within 2001::/23 stay reachable (iana registry)
  for (const ip of ['2001:1::1', '2001:1::2', '2001:3::1', '2001:4:112::1', '2001:20::1'])
    assert.equal(blockedIp(ip), false, ip);
  // real cdn global unicast is allowed
  for (const ip of ['2606:4700:4700::1111', '2607:f8b0:4000::1', '2a00:1450:4000::1'])
    assert.equal(blockedIp(ip), false, ip);
});
