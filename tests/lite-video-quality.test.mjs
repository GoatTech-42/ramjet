import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {handleLite,setAuth,setJetstream} from '../core/lite.js';
import {liteApi} from '../core/addons/jetstream/index.js';
const entry={duration:20,lite:{v:[360,480,720,1080].map(h=>({h,fps:30,url:'https://example.invalid/'+h,size:1000,tbr:500})),a:[{abr:128,size:1000}]}};
test('native Lite planner selects exact tiers, short-side sizes and honest lower fallback',async()=>{for(const q of[360,480,720,1080])assert.equal((await liteApi.litePlan(entry,q)).height,q);assert.equal((await liteApi.litePlan({...entry,lite:{...entry.lite,v:entry.lite.v.filter(v=>v.h!==1080)}},1080)).height,720);});
test('HTTP numeric quality contract, metadata, default and final byte cap',async()=>{const root=mkdtempSync(join(tmpdir(),'rj-quality-')),file=join(root,'fixture.mp4');writeFileSync(file,'fixture-only-not-media');let called=0,over=false;setAuth({verify:()=>({status:'approved'}),users:{fixture:{status:'approved'}},revGeneration:()=>0});setJetstream({...liteApi,LITE_MAX_BYTES:150*1024*1024,resolveStream:async()=>{called++;return over?{...entry,duration:901}:entry;},makeVideo:async(id,q)=>{assert.ok([360,480,720,1080].includes(q));return file;}});const s=http.createServer((req,res)=>handleLite(req,res,new URL(req.url,'http://localhost')));await new Promise(r=>s.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+s.address().port+'/api/lite/video?id=fixture0001',headers={authorization:'Bearer fixture:fixture-only'};try{for(const q of[360,480,720,1080]){const r=await fetch(base+'&q='+q+'&info=1',{headers});assert.equal(r.status,200);const j=await r.json();assert.equal(j.q,q);assert.equal(j.chosen_quality,q);assert.deepEqual(j.available_qualities,[1080,720,480,360]);const media=await fetch(base+'&q='+q,{headers});assert.equal(media.status,200);assert.equal(media.headers.get('content-type'),'video/mp4');await media.arrayBuffer();}const d=await(await fetch(base+'&info=1',{headers})).json();assert.equal(d.q,480);const before=called;for(const q of['','240','1080p','720.0','-360','NaN']){const r=await fetch(base+'&q='+q,{headers});assert.equal(r.status,400);assert.match(r.headers.get('content-type'),/^application\/json/);await r.json();}assert.equal(called,before);over=true;assert.equal((await fetch(base+'&q=1080',{headers})).status,413);over=false;setJetstream({...liteApi,resolveStream:async()=>entry,makeVideo:async()=>file,LITE_MAX_BYTES:10});const big=await fetch(base+'&q=1080',{headers});assert.equal(big.status,413);assert.match(big.headers.get('content-type'),/^application\/json/);}finally{await new Promise(r=>s.close(r));rmSync(root,{recursive:true,force:true});}});

test('native normalizer bounds heights, drops unusable formats and caps the list',()=>{
 const fmt=(o)=>({protocol:'https',vcodec:'avc1.4d401f',acodec:'none',fps:30,url:'https://example.invalid/x',...o});
 const many=Array.from({length:20},(_,i)=>fmt({width:320,height:180+i*50}));
 const out=liteApi.liteVideoFormats([fmt({}),fmt({width:0,height:0}),fmt({width:72,height:72}),fmt({width:2560,height:1440}),fmt({width:1280,height:720,vcodec:'vp09.00.10.08'}),fmt({width:1280,height:720,acodec:'mp4a.40.2'}),fmt({width:1280,height:720,protocol:'m3u8_native'}),fmt({width:640,height:360,fps:60}),fmt({width:640,height:360,fps:30}),...many]);
 assert.ok(out.every(v=>Number.isFinite(v.h)&&v.h>=144&&v.h<=1080),'finite heights inside 144..1080');
 assert.ok(out.length<=16,'format list is count-capped');
 const tier360=out.filter(v=>v.h===360);
 assert.equal(tier360.length,1,'deduped to one entry per tier');
 assert.equal(tier360[0].fps,30,'same height prefers 30fps');
 const hs=out.map(v=>v.h);assert.deepEqual([...hs].sort((a,b)=>b-a),hs,'best first');
});
test('normalizer dedupes per distinct quality before capping, so duplicates never starve the fallback tier',()=>{
 const fmt=(o)=>({protocol:'https',vcodec:'avc1.4d401f',acodec:'none',fps:30,url:'https://example.invalid/x',...o});
 const out=liteApi.liteVideoFormats([...Array.from({length:16},(_,i)=>fmt({width:1920,height:1080,url:'https://example.invalid/dup'+i})),fmt({width:640,height:360,url:'https://example.invalid/low'})]);
 assert.equal(out.filter(v=>v.h===1080).length,1,'duplicate tiers collapse');
 assert.ok(out.some(v=>v.h===360),'lower fallback tier survives the cap');
});
test('no setLiteLimits hook without RJ_TEST_HOOKS',()=>{assert.equal(liteApi.setLiteLimits,undefined);});
test('native fallback binds real mux properties and rejects upward/unsupported fallback',async()=>{
 const high={duration:20,lite:{v:[{h:720,fps:30,url:'https://example.invalid/720',size:1000,tbr:500},{h:1080,fps:30,url:'https://example.invalid/1080',size:1000,tbr:500}],a:[{abr:128,size:1000}]}};
 const mux360={protocol:'https',vcodec:'avc1.4d401f',acodec:'mp4a.40.2',width:640,height:360,fps:30,url:'https://example.invalid/mux360',filesize:5000};
 const withMux=(list)=>({...high,getMux:async()=>list});
 let plan=await liteApi.litePlan(withMux([mux360]),360);
 assert.equal(plan.mode,'itag18');assert.equal(plan.height,360);assert.equal(plan.v.url,'https://example.invalid/mux360');
 const aboveOnly=(list)=>({duration:20,lite:{v:[{h:1080,fps:30,url:'https://example.invalid/1080',size:1000,tbr:500}],a:[{abr:128,size:1000}]},getMux:async()=>list});
 plan=await liteApi.litePlan(aboveOnly([{...mux360,width:854,height:480}]),720);
 assert.equal(plan.mode,'itag18');assert.equal(plan.height,480,'actual fallback height reported, not an assumed 360');
 plan=await liteApi.litePlan(withMux([{...mux360,height:720}]),360);
 assert.equal(plan.mode,'unavailable','taller-than-requested fallback rejected');
 plan=await liteApi.litePlan(withMux([{...mux360,vcodec:'vp09.00.10.08'}]),360);
 assert.equal(plan.mode,'unavailable','unsupported codec pairing rejected');
 plan=await liteApi.litePlan(withMux([]),360);
 assert.equal(plan.mode,'unavailable','no candidate rejected');
});

test('normalizer pins requested tiers before the cap: 16 unrelated heights cannot starve 480/360',()=>{
 const fmt=(o)=>({protocol:'https',vcodec:'avc1.4d401f',acodec:'none',fps:30,url:'https://example.invalid/x',...o});
 const mids=Array.from({length:16},(_,i)=>fmt({width:Math.round((600+i*25)*16/9),height:600+i*25,url:'https://example.invalid/m'+i}));
 const out=liteApi.liteVideoFormats([...mids,fmt({width:854,height:480}),fmt({width:640,height:360})]);
 assert.ok(out.length<=16,'still count-capped');
 assert.ok(out.some(v=>v.h===480),'480 requested tier survives the cap');
 assert.ok(out.some(v=>v.h===360),'360 fallback tier survives the cap');
 const hs=out.map(v=>v.h);assert.deepEqual([...hs].sort((a,b)=>b-a),hs,'best first');
});
