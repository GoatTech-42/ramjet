import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,rmSync,writeFileSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Auth} from '../core/auth.js';

test('shared web/Lite/restart cache avoids admissions; lazy pages and Qwant cooldown', async()=>{
 const root=mkdtempSync(join(tmpdir(),'rj-fanout-'));new Auth(root).createUser('reviewer','fixture-password');
 const calls=[];
 const upstream=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://x');calls.push(url);
  const q=url.searchParams.get('q');
  res.setHeader('content-type','application/json');
  res.end(JSON.stringify({results:[{title:q,url:'https://example.com/',img_src:'https://example.com/image.png',engine:url.searchParams.get('engines').includes('cse')?'google cse images':'brave images'}],unresponsive_engines:q==='blocked'?[['google cse images','Suspended: unusual traffic']]:q==='qwant-block'?[['qwant images','CAPTCHA']]:[]}));
 });
 await new Promise(r=>upstream.listen(8888,'127.0.0.1',r));
 const child=spawn(process.execPath,['core/index.js'],{env:{...process.env,SERPAPI_API_KEY:'',RJ_DATA:root,RJ_PORT:'15433',RJ_HOST:'127.0.0.1'},stdio:'ignore'});
 try{
  const base='http://127.0.0.1:15433';
  for(let i=0;i<100;i++){try{if((await fetch(base+'/login')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
  const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'reviewer',password:'fixture-password'})});const cookie=login.headers.get('set-cookie').split(';')[0];
  const search=async path=>{const r=await fetch(base+'/searx/search?'+path,{headers:{cookie}});assert.equal(r.status,200);return r.text();};
  await Promise.all([search('q=general'),search('q=general')]);assert.equal(calls.length,1);assert(!calls[0].searchParams.has('categories'));assert(calls[0].searchParams.get('engines').includes('google cse'));
  await search('q=image&c=images&s=1');assert.equal(calls.length,2);assert.equal(calls[1].searchParams.get('engines'),'qwant images');assert(!calls[1].searchParams.has('pageno'));assert(!calls[1].searchParams.has('categories'));
  await search('q=image&c=images&s=1&p=2');assert.equal(calls.length,3);assert.equal(calls[2].searchParams.get('pageno'),'2');
  const headers={authorization:'Basic '+Buffer.from('reviewer:fixture-password').toString('base64')};
  const lite=await fetch(base+'/api/lite/imgsearch?q=image&n=40&page=1&format=json',{headers});assert.equal(lite.status,200);await lite.arrayBuffer();assert.equal(calls.length,3);
  const cached=execFileSync(process.execPath,['--input-type=module','-e',"import {searchUpstream} from './core/search-upstream.js'; const r=await searchUpstream('image',1,'images',1); console.log(r.data.results.length);"],{env:{...process.env,SERPAPI_API_KEY:'',RJ_DATA:root},encoding:'utf8'});assert.equal(cached.trim(),'1');assert.equal(calls.length,3);assert.equal(statSync(join(root,'search-results-cache.json')).mode&0o777,0o600);
  await search('q=qwant-block&c=images');assert.equal(calls.at(-1).searchParams.get('engines'),'google cse images');
  const before=calls.length;await search('q=qwant-block&c=images');assert.equal(calls.length,before);
  await search('q=after-qwant&c=images');assert.equal(calls.at(-1).searchParams.get('engines'),'google cse images');
 }finally{child.kill('SIGTERM');await once(child,'exit');upstream.closeAllConnections();await new Promise(r=>upstream.close(r));rmSync(root,{recursive:true});}
});
