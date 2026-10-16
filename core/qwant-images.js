import { chmodSync } from 'node:fs';
import { dataPath } from './data.js';
import { readJson, writeJson } from './util.js';
import { createRequestBudget } from './request-budget.js';

const UA='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const publicUrl=value=>{try{const u=new URL(value);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password?u.href:'';}catch{return '';}};
export function createQwantImages({fetcher=fetch,admit=async()=>true,fail=()=>{}}={}){
 return async(query,page,safe)=>{
  if(page>5)return {results:[]};
  if(!await admit())throw new Error('image search is cooling down; try later');
  try{
   const params=new URLSearchParams({q:query,count:'50',locale:'en_US',offset:String((page-1)*50),tgp:'1',device:'desktop',safesearch:String(safe),displayed:'true',llm:'true'});
   const response=await fetcher('https://api.qwant.com/v3/search/images?'+params,{headers:{'user-agent':UA,accept:'application/json',referer:'https://www.qwant.com/',origin:'https://www.qwant.com'},signal:AbortSignal.timeout(12000),redirect:'error'});
   if(!response.ok)throw new Error('image source unavailable');
   const chunks=[];let size=0;for await(const c of response.body){size+=c.length;if(size>4*1024*1024)throw new Error('image source response too large');chunks.push(c);}
   const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));
   if(data.status!=='success'||!Array.isArray(data.data?.result?.items))throw new Error('image source unavailable');
   const results=data.data.result.items.map(r=>({title:String(r.title||'Image').slice(0,300),url:publicUrl(r.url),img_src:publicUrl(r.media),thumbnail_src:publicUrl(r.thumbnail),engine:'qwant images'})).filter(r=>r.url&&r.img_src);
   return {results};
  }catch{fail();throw new Error('Qwant image search is unavailable; try later');}
 };
}
export function createImageCache({load,save,search,now=Date.now}){
 const cache=new Map(Object.entries(load())),busy=new Map();
 return async(query,page,safe)=>{
  const key=JSON.stringify(['qwant-direct-v1',query.trim().toLowerCase(),page,safe]);const hit=cache.get(key);
  if(hit&&now()<hit.expires){if(hit.error)throw new Error(hit.error);return hit.data;}
  if(busy.has(key))return busy.get(key);
  const request=(async()=>{
   let data,error;try{data=await search(query,page,safe);}catch{error='Qwant image search is unavailable; try later';}
   cache.set(key,{data,error,expires:now()+(data?.results?.length?1800000:60000)});
   for(const [k,v]of cache)if(now()>=v.expires)cache.delete(k);
   while(cache.size>100||Buffer.byteLength(JSON.stringify(Object.fromEntries(cache)))>8*1024*1024)cache.delete(cache.keys().next().value);
   save(Object.fromEntries(cache));if(error)throw new Error(error);return data;
  })();busy.set(key,request);try{return await request;}finally{busy.delete(key);}
 };
}
const budgetFile=dataPath('qwant-budget.json');
const gate=createRequestBudget({state:readJson(budgetFile,{}),save:s=>writeJson(budgetFile,s,0o600)});
const cacheFile=dataPath('qwant-images-cache.json');
export const qwantImages=createImageCache({load:()=>readJson(cacheFile,{}),save:s=>{writeJson(cacheFile,s,0o600);chmodSync(cacheFile,0o600);},search:createQwantImages({admit:()=>gate.admit(),fail:()=>gate.fail()})});
