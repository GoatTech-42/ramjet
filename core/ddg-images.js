import { chmodSync } from 'node:fs';
import { dataPath } from './data.js';
import { readJson, writeJson } from './util.js';
import { createRequestBudget } from './request-budget.js';

const UA='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const publicUrl=value=>{try{const u=new URL(value);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password?u.href:'';}catch{return '';}};
const IMAGE_ERRORS={provider_blocked:'DuckDuckGo blocked image requests; changing the query will not fix this',provider_rate_limited:'DuckDuckGo image search is rate limited; try later',cooldown:'Image search is cooling down; try later',provider_invalid:'DuckDuckGo image response is unavailable; try later',network:'DuckDuckGo image connection failed; try later',unavailable:'DuckDuckGo image search is unavailable; try later'};
export function imageFailure(code='unavailable',upstreamStatus){const e=new Error(IMAGE_ERRORS[code]||IMAGE_ERRORS.unavailable);e.code=Object.hasOwn(IMAGE_ERRORS,code)?code:'unavailable';if(Number.isInteger(upstreamStatus))e.upstream_status=upstreamStatus;return e;}
const safeFailure=e=>({code:Object.hasOwn(IMAGE_ERRORS,e?.code)?e.code:'unavailable',...(Number.isInteger(e?.upstream_status)?{upstream_status:e.upstream_status}:{})});
export function createDdgImages({fetcher=fetch,admit=async()=>true,fail=()=>{}}={}){
 const tokens=new Map(),tokenBusy=new Map();
 const read=async(url,headers)=>{
  if(!await admit())throw imageFailure('cooldown');
  let r;try{r=await fetcher(url,{headers,signal:AbortSignal.timeout(12000),redirect:'error'});}catch{throw imageFailure('network');}
  if(!r.ok){await r.body?.cancel();throw imageFailure(r.status===403?'provider_blocked':r.status===429?'provider_rate_limited':'unavailable',r.status);}
  const chunks=[];let size=0;for await(const c of r.body){size+=c.length;if(size>4194304)throw imageFailure('provider_invalid');chunks.push(c);}
  return Buffer.concat(chunks).toString('utf8');
 };
 const token=async q=>{
  const key=q.trim().toLowerCase(),hit=tokens.get(key);if(hit&&Date.now()<hit.expires)return hit.value;
  if(tokenBusy.has(key))return tokenBusy.get(key);
  const promise=(async()=>{const html=await read('https://duckduckgo.com/?'+new URLSearchParams({q,iar:'images',t:'h_'}),{'user-agent':UA,accept:'text/html'});
   if(/anomaly\.js|challenge-form|select all squares/i.test(html))throw imageFailure('provider_blocked',200);
   const value=/vqd=["']([\w-]+)["']/.exec(html)?.[1];if(!value)throw imageFailure('provider_invalid');
   tokens.set(key,{value,expires:Date.now()+600000});while(tokens.size>100)tokens.delete(tokens.keys().next().value);return value;})();tokenBusy.set(key,promise);try{return await promise;}finally{tokenBusy.delete(key);}
 };
 return async(query,page,safe)=>{
  if(!Number.isInteger(page)||page<1||page>5)throw imageFailure('provider_invalid');
  try{
   const vqd=await token(query),params=new URLSearchParams({o:'json',q:query,u:'bing',l:'us-en',bpia:'1',vqd,a:'h_',ct:'EN'});
   if(page>1)params.set('s',String((page-1)*100));
   const mode=safe===0?'-2':safe===2?'1':null;if(mode!==null)params.set('p',mode);
   const headers={'user-agent':UA,accept:'*/*',referer:'https://duckduckgo.com/',cookie:'ad=en_US; ah=us-en; l=us-en'+(mode!==null?'; p='+mode:'')};
   const text=await read('https://duckduckgo.com/i.js?'+params,headers);
   if(/anomaly\.js|challenge-form/i.test(text))throw imageFailure('provider_blocked',200);
   let data;try{data=JSON.parse(text);}catch{throw imageFailure('provider_invalid');}
   if(data.url)throw imageFailure('provider_blocked',200);if(!Array.isArray(data.results))throw imageFailure('provider_invalid');
   const results=data.results.map(r=>({title:String(r.title||'Image').slice(0,300),url:publicUrl(r.url),img_src:publicUrl(r.image),thumbnail_src:publicUrl(r.thumbnail),engine:'duckduckgo images'})).filter(r=>r.url&&r.img_src);
   return {results,has_more:!!data.next};
  }catch(e){if(e.code!=='cooldown')fail();if(Object.hasOwn(IMAGE_ERRORS,e.code))throw e;throw imageFailure('network');}
 };
}
export function createImageCache({load,save,search,now=Date.now}){
 const cache=new Map(Object.entries(load())),busy=new Map();
 return async(query,page,safe)=>{
  const key=JSON.stringify(['ddg-direct-v1',query.trim().toLowerCase(),page,safe]);const hit=cache.get(key);
  if(hit&&now()<hit.expires){if(hit.error){const info=hit.failure||{};throw imageFailure(info.code,info.upstream_status);}return hit.data;}
  if(busy.has(key))return busy.get(key);
  const request=(async()=>{
   let data,error,failure;try{data=await search(query,page,safe);}catch(e){failure=safeFailure(e);error=imageFailure(failure.code,failure.upstream_status).message;}
   cache.set(key,{data,error,failure,expires:now()+(data?.results?.length?1800000:60000)});
   for(const [k,v]of cache)if(now()>=v.expires)cache.delete(k);
   while(cache.size>100||Buffer.byteLength(JSON.stringify(Object.fromEntries(cache)))>8*1024*1024)cache.delete(cache.keys().next().value);
   save(Object.fromEntries(cache));if(error)throw imageFailure(failure.code,failure.upstream_status);return data;
  })();busy.set(key,request);try{return await request;}finally{busy.delete(key);}
 };
}
const budgetFile=dataPath('ddg-budget.json');
const gate=createRequestBudget({state:readJson(budgetFile,{}),save:s=>writeJson(budgetFile,s,0o600)});
const cacheFile=dataPath('ddg-images-cache.json');
export const ddgImages=createImageCache({load:()=>readJson(cacheFile,{}),save:s=>{writeJson(cacheFile,s,0o600);chmodSync(cacheFile,0o600);},search:createDdgImages({admit:()=>gate.admit(),fail:()=>gate.fail()})});
