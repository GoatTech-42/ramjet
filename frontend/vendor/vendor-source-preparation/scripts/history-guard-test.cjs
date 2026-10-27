'use strict';
const assert = require('node:assert/strict');
// Regression model for the reconstructed TypeScript patch, not a runtime build.
function apply(args, calls, events) {
  const relevant = { url: { href: 'https://example.test/original', origin: 'https://example.test' }, rewriteUrl: value => '/proxy/' + value };
  if (args[2] == null) {
    calls.push([...args]);
    events.push({ type: 'history', url: relevant.url.href });
    return;
  }
  const url = String(args[2]);
  if (URL.canParse(url) && new URL(url).origin !== relevant.url.origin) return;
  if (url || url === '') args[2] = relevant.rewriteUrl(url);
  calls.push([...args]);
  events.push({ type: 'history', url: relevant.url.href });
}
for (const value of [undefined, null]) {
  const calls=[], events=[], args=[{}, '', value]; apply(args,calls,events);
  assert.equal(calls.length,1); assert.equal(calls[0][2],value); assert.equal(events.length,1);
}
for (const value of ['', '/next', 'https://example.test/next']) {
  const calls=[],events=[];apply([{},'',value],calls,events);
  assert.equal(calls[0][2],'/proxy/'+value);assert.equal(events.length,1);
}
{ const calls=[],events=[];apply([{},'','https://other.test/'],calls,events);assert.equal(calls.length,0);assert.equal(events.length,0); }
console.log('6 reconstructed history-handler vectors pass. Not a compiled runtime equivalence claim.');
