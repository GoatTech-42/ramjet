// Local-only fixtures. Never point RJ_TEST_HOOKS at a production listener.
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { gzipSync, brotliCompressSync, deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import WebSocket from 'ws';
const root = mkdtempSync(join(tmpdir(), 'rj-speed-bench-'));
process.env.RJ_DATA = root; process.env.RJ_TEST_HOOKS = '1';
// Seed fresh list files so importing the production module cannot fetch lists.
writeFileSync(join(root, 'adblock-hosts.txt'), ''); writeFileSync(join(root, 'ubo-hosts.txt'), '');
const { pwsUpgrade } = await import('../core/' + (process.env.BENCH_PFETCH || 'pfetch.js'));
const raw = Buffer.alloc(Number(process.env.BENCH_MB || 8) * 1024 * 1024);
const seed = Buffer.from(Array.from({length:4096}, (_, i) => `<div id="i${i}"><a href="/${i*23}">Story number ${i}</a><p>Fixture ${i % 17}</p></div>\n`).join(''));
for (let p=0; p<raw.length; p+=seed.length) seed.copy(raw,p,0,Math.min(seed.length,raw.length-p));
const expected = createHash('sha256').update(raw).digest('hex');
const packed = { identity: raw, gzip: gzipSync(raw), br: brotliCompressSync(raw), deflate: deflateSync(raw) };
let connections=0;
const upstream = http.createServer((req,res) => { const [enc, kind] = req.url.slice(1).split('/'); res.writeHead(200, {'content-type':kind==='binary'?'application/octet-stream':'text/html', 'cache-control':'no-store', ...(enc==='identity'?{}:{'content-encoding':enc}), 'content-length':packed[enc].length }); res.end(packed[enc]); });
upstream.on('connection', () => connections++);
const tunnel = http.createServer(); tunnel.on('upgrade',(req,socket,head) => pwsUpgrade(req,socket,head,'benchmark',()=>{}));
await new Promise(r => upstream.listen(0,'127.0.0.1',r));
await new Promise(r => tunnel.listen(0,'127.0.0.1',r));
const ws = new WebSocket(`ws://127.0.0.1:${tunnel.address().port}/pws-t/${'a'.repeat(48)}/`, {perMessageDeflate:true});
const rows=[]; let id=0;
try {
 await new Promise((r,j) => {ws.once('open',r);ws.once('error',j);});
 const get = (enc,kind) => new Promise((resolve,reject) => {
  const mine=++id, start=performance.now(); let first=null, bytes=0, frames=0; const hash=createHash('sha256');
  const timer=setTimeout(()=>done(Error('request timeout')),15000);
  const done=(err,result)=>{clearTimeout(timer);ws.off('message',receive);err?reject(err):resolve(result);};
  const receive=b=>{if(b.readUInt32BE(0)!==mine)return;const type=b[4];if(type===1){first??=performance.now();const c=b.subarray(5);bytes+=c.length;frames++;hash.update(c);}else if(type===2){try{assert.equal(bytes,raw.length);assert.equal(hash.digest('hex'),expected);done(null,{ms:performance.now()-start,firstMs:first-start,frames});}catch(e){done(e);}}else if(type===3)done(Error(b.subarray(5).toString()));};
  ws.on('message',receive); ws.send(JSON.stringify({id:mine,url:`http://127.0.0.1:${upstream.address().port}/${enc}/${kind}`,method:'GET',headers:[],ab:false}));
 });
 for(const kind of ['binary','html'])for(const encoding of ['identity','gzip','br','deflate']){
  await get(encoding,kind); const values=[];for(let i=0;i<Number(process.env.BENCH_ROUNDS||5);i++)values.push(await get(encoding,kind));
  const med=key=>+values.map(v=>v[key]).sort((a,b)=>a-b)[Math.floor(values.length/2)].toFixed(2);
  rows.push({kind,encoding,decodedBytes:raw.length,medianMs:med('ms'),medianFirstMs:med('firstMs'),medianFrames:med('frames')});
 }
 console.log(JSON.stringify({node:process.version,note:'Local end-to-end HTTP upstream -> multiplexed websocket client. No WAN, rewrite engine, UI, or real pages. All responses no-store and SHA-256 checked.',connections,requests:id,rows},null,2));
} finally {
 ws.terminate(); await new Promise(r=>tunnel.close(r)); upstream.closeAllConnections();await new Promise(r=>upstream.close(r));rmSync(root,{recursive:true,force:true});
}
