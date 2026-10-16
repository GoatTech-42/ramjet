// Isolated source-function microbenchmark. Real static APIs are covered by tests/static-cache.test.mjs.
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, extname } from 'node:path';
import vm from 'node:vm';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { brotliCompressSync, gzipSync, constants as zc } from 'node:zlib';
import assert from 'node:assert/strict';
const source=fs.readFileSync(new URL('../core/index.js',import.meta.url),'utf8');
const start=source.indexOf('const sCache = new Map();');const end=source.indexOf('// addon apps:',start);
if(start<0||end<0)throw Error('static function source boundary not found');
const root=fs.mkdtempSync(join(tmpdir(),'rj-static-bench-'));const rounds=Number(process.env.BENCH_ROUNDS||5), iterations=Number(process.env.BENCH_REQUESTS||10000);
try {
 const body=Buffer.from('/* deterministic fixture */\n'.repeat(1000));fs.writeFileSync(join(root,'probe.js'),body);
 const calls={existsSync:0,statSync:0,openSync:0,readFileSync:0}; const context={DIST:root,PINNED:new Map(),MIME:{'.js':'text/javascript; charset=utf-8'},Buffer,Map,Set,resolve,extname,createHash,brotliCompressSync,gzipSync,zc,closeSync:fs.closeSync,fstatSync:fs.fstatSync};
 for(const name of Object.keys(calls))context[name]=(...args)=>{calls[name]++;return fs[name](...args);};
 vm.createContext(context);vm.runInContext(source.slice(start,end)+'\nthis.serve=serveStatic;',context);
 let lastStatus,lastBody,headers;const res={writeHead(status,h){lastStatus=status;headers=h;},end(b){lastBody=b;}};const req={headers:{'accept-encoding':'gzip'}};
 assert.equal(context.serve(req,res,'/probe.js'),true);assert.equal(lastStatus,200);assert.equal(headers['content-encoding'],'gzip');
 const expected=Buffer.from(lastBody);const values=[];
 for(let r=0;r<rounds;r++){for(const k of Object.keys(calls))calls[k]=0;const t=performance.now();for(let i=0;i<iterations;i++)context.serve(req,res,'/probe.js');values.push(performance.now()-t);assert.deepEqual(Buffer.from(lastBody),expected);}
 values.sort((a,b)=>a-b);
 console.log(JSON.stringify({node:process.version,note:'Isolated serveStatic warm-cache microbenchmark; not network/page throughput.',rounds,iterations,medianMs:+values[Math.floor(values.length/2)].toFixed(2),callsPerRequest:Object.fromEntries(Object.entries(calls).map(([k,v])=>[k,v/iterations]))},null,2));
}finally{fs.rmSync(root,{recursive:true,force:true});}
