import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

function resolve(headers, peer = '::ffff:172.25.0.1', extra = {}) {
  const code = `import {clientIp} from './core/util.js';console.log(JSON.stringify(clientIp(${JSON.stringify({socket:{remoteAddress:peer},headers})})));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], {cwd:new URL('../',import.meta.url),encoding:'utf8',env:{...process.env,RJ_TRUST_PROXY:'172.25.0.1',RJ_FORWARDED_HOPS:'2',RJ_FORWARDED_PROXY_CIDRS:'192.0.2.0/24,2001:db8::/32',...extra}});
  assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);
}
test('configured two-hop chain ignores arbitrary spoofed prefixes',()=>{
  assert.equal(resolve({'x-forwarded-for':'203.0.113.199, 198.51.100.12, 192.0.2.24'}),'198.51.100.12');
  assert.equal(resolve({'x-forwarded-for':'bad, 10.0.0.1, 198.51.100.12, 192.0.2.24'}),'198.51.100.12');
});
test('direct-origin, short, malformed and excessive chains fail closed to socket peer',()=>{
  for(const h of ['203.0.113.199, 198.51.100.12','198.51.100.12','198.51.100.12, unknown','unknown, 192.0.2.24',Array(34).fill('192.0.2.24').join(',')])assert.equal(resolve({'x-forwarded-for':h}),'::ffff:172.25.0.1');
});
test('untrusted socket ignores even a plausible proxy chain',()=>assert.equal(resolve({'x-forwarded-for':'198.51.100.12, 192.0.2.24'},'198.51.100.50'),'198.51.100.50'));
test('IPv6 and mapped IPv4 chain addresses normalize and validate',()=>{
 assert.equal(resolve({'x-forwarded-for':'2001:db8:abcd::1, 2001:db8::4'}),'2001:db8:abcd::1');
 assert.equal(resolve({'x-forwarded-for':'::ffff:198.51.100.12, ::ffff:192.0.2.24'}),'198.51.100.12');
});
test('default one-hop selection is rightmost and validates the selected IP',()=>{
 assert.equal(resolve({'x-forwarded-for':'203.0.113.199, 198.51.100.12'},undefined,{RJ_FORWARDED_HOPS:'1'}),'198.51.100.12');
 assert.equal(resolve({'x-forwarded-for':'203.0.113.199, garbage'},undefined,{RJ_FORWARDED_HOPS:'1'}),'::ffff:172.25.0.1');
});
