// Test-only bootstrap: bind port zero and publish the actual kernel-assigned port.
import { Server } from 'node:net';
const listen = Server.prototype.listen;
Server.prototype.listen = function (...args) {
  this.once('listening', () => process.stdout.write(`TEST_READY ${this.address().port}\n`));
  return listen.apply(this, args);
};
// The wisp server refuses loopback/private TCP targets by default (SSRF
// guard, kept on in production). The fixture server only ever runs tests,
// whose fixture targets listen on 127.0.0.1, so allow loopback here.
const { server: wisp } = await import('@mercuryworkshop/wisp-js');
wisp.options.allow_loopback_ips = true;
wisp.options.allow_private_ips = true;
await import('../../core/index.js');
