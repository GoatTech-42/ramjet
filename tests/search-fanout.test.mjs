import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Auth} from '../core/auth.js';

test('one requested page only; cache coalesces; failures cool both general and images', async()=>{
 const root=mkdtempSync(join(tmpdir(),'rj-fanout-'));new Auth(root).createUser('reviewer','fixture-password');
 const calls=[];
 const upstream=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://x');calls.push(url);
  const q=url.searchParams.get('q');
  res.setHeader('content-type','application/json');
  res.end(JSON.stringify({results:[{title:q,url:'https://example.com/',img_src:'https://example.com/image.png',engine:url.searchParams.get('engines').includes('cse')?'google cse images':'brave images'}],unresponsive_engines:q==='blocked'?[['google cse images','Suspended: unusual traffic']]:[]}));
 });
 await new Promise(r=>upstream.listen(8888,'127.0.0.1',r));
 const child=spawn(process.execPath,['core/index.js'],{env:{...process.env,RJ_DATA:root,RJ_PORT:'15433',RJ_HOST:'127.0.0.1'},stdio:'ignore'});
 try{
  const base='http://127.0.0.1:15433';
  for(let i=0;i<100;i++){try{if((await fetch(base+'/login')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
  const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'reviewer',password:'fixture-password'})});const cookie=login.headers.get('set-cookie').split(';')[0];
  const search=async path=>{const r=await fetch(base+'/searx/search?'+path,{headers:{cookie}});assert.equal(r.status,200);return r.text();};
  await Promise.all([search('q=general'),search('q=general')]);assert.equal(calls.length,1);assert(!calls[0].searchParams.has('categories'));assert(calls[0].searchParams.get('engines').includes('google cse'));
  await search('q=image&c=images');assert.equal(calls.length,2);assert(!calls[1].searchParams.has('pageno'));
  await search('q=image&c=images&p=2');assert.equal(calls.length,3);assert.equal(calls[2].searchParams.get('pageno'),'2');
  await search('q=blocked&c=images');assert.equal(calls.length,4);
  await search('q=blocked&c=images');assert.equal(calls.length,4);
  await search('q=new-image&c=images');assert.equal(calls[4].searchParams.get('engines'),'brave images');
  await search('q=new-web');assert(!calls[5].searchParams.get('engines').includes('cse'));assert.equal(calls.length,6);
  await search('q=invalid-category&c=unknown');assert(!calls[6].searchParams.get('engines').includes('cse'));assert(!calls[6].searchParams.has('categories'));
  const headers={authorization:'Basic '+Buffer.from('reviewer:fixture-password').toString('base64')};
  const lite=await fetch(base+'/api/lite/imgsearch?q=lite&n=40&page=1&format=json',{headers});assert.equal(lite.status,200);await lite.arrayBuffer();
  assert.equal(calls.length,8);assert.equal(calls[7].searchParams.get('engines'),'brave images');
  const repeat=await fetch(base+'/api/lite/imgsearch?q=lite&n=40&page=1&format=json',{headers});await repeat.arrayBuffer();assert.equal(calls.length,8);

 }finally{child.kill('SIGTERM');await once(child,'exit');upstream.closeAllConnections();await new Promise(r=>upstream.close(r));rmSync(root,{recursive:true});}
});
