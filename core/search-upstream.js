import { chmodSync } from 'node:fs';
import { serpImages } from './serp-images.js';
import { readJson, writeJson } from './util.js';
import { dataPath } from './data.js';
import { createCseGate, cseGate, cseFailure, cseCooldownLeft } from './cse-gate.js';

const budgetFile = dataPath('cse-budget.json');
const qwantGate = createCseGate({state:readJson(budgetFile,{}).qwant || {},save:state=>writeJson(budgetFile,{...readJson(budgetFile,{}),qwant:state})});
const braveGate = createCseGate({state:readJson(budgetFile,{}).brave || {},save:state=>writeJson(budgetFile,{...readJson(budgetFile,{}),brave:state})});
const braveFailed = data => (data?.unresponsive_engines || []).some(e=>String(Array.isArray(e)?e[0]:e?.engine).includes('brave'));
const qwantFailed = data => (data?.unresponsive_engines || []).some(e=>String(Array.isArray(e)?e[0]:e?.engine).includes('qwant'));
// Explicit fallback lists must not accidentally invoke CSE through defaults.
const fallback = { general: 'bing,brave,mojeek,startpage,wikipedia' };
export function cseFailed(data) {
  return (Array.isArray(data?.unresponsive_engines) ? data.unresponsive_engines : []).some(entry => {
    const engine = Array.isArray(entry) ? entry[0] : entry?.engine;
    return String(engine || '').toLowerCase().includes('cse');
  });
}
async function readPage(query, page, cat, safe, engines) {
  const params = new URLSearchParams({ q: query, format: 'json', safesearch: String(safe | 0) });
  if (engines) params.set('engines', engines);
  if (page > 1) params.set('pageno', String(page));
  if (cat !== 'general') params.set('categories', cat);
  const response = await fetch('http://127.0.0.1:8888/search?' + params, { headers: {accept:'application/json','accept-encoding':'identity'}, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error('search unavailable');
  const chunks=[];let size=0;
  for await(const chunk of response.body){size+=chunk.length;if(size>4*1024*1024)throw new Error('search response too large');chunks.push(chunk);}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export async function imageSources(query, page, safe, { qwant=qwantGate, admitCse=cseGate, failCse=cseFailure, backup=serpImages, brave=braveGate, read=readPage } = {}) {
  // Actual lazy priority, not parallel fanout disguised by result sorting.
  if (await qwant.admit()) {
    try {
      const data=await read(query,page,'images',safe,'qwant images');
      if(qwantFailed(data))qwant.fail();
      else if(data.results?.length)return {down:false,data,primaryUsed:true};
    }catch{qwant.fail();}
  }
  if(await admitCse()) {
    try {
      const data=await read(query,page,'images',safe,'google cse images');
      if(cseFailed(data))failCse();
      else if(data.results?.length)return {down:false,data,cseUsed:true};
    }catch{failCse();}
  }
  const rows=await backup(query,page,safe);
  if(rows?.length)return {down:false,data:{results:rows},backupUsed:true};
  if(!await brave.admit())return {down:true};
  try {const data=await read(query,page,'images',safe,'brave images');if(braveFailed(data))brave.fail();return {down:false,data};}
  catch{brave.fail();return {down:true};}
}
async function fetchUpstream(query, page, category, safe, allowCse = true) {
  const cat=category || 'general';
  if(cat==='images')return imageSources(query,page,safe);
  const permitted=cat==='general' && allowCse ? await cseGate() : false;
  try {
    const data=await readPage(query,page,cat,safe,cat==='general'?(permitted?'google cse,bing':fallback.general):'');
    if(permitted&&cseFailed(data))cseFailure();
    return {down:false,data,cseUsed:permitted,cooldown:cseCooldownLeft()};
  }catch{if(permitted)cseFailure();return {down:true};}
}

// Shared across accounts and web/Lite. Returned data is public, query keys are private.
const cacheFile = dataPath('search-results-cache.json');
const stored = readJson(cacheFile, {});
const shared = new Map(Object.entries(stored));
const pending = new Map();
export async function searchUpstream(query, page, category, safe, allowCse = true) {
  const key = JSON.stringify(['qwant-first-v1',String(query).trim().toLowerCase(), category || 'general', safe | 0, Math.max(1,page | 0), allowCse]);
  const hit = shared.get(key);
  if (hit && Date.now() < hit.expires) return hit.value;
  if (pending.has(key)) return pending.get(key);
  const request = (async () => {
    const value = await fetchUpstream(query, page, category, safe, allowCse);
    const good = !value.down && value.data?.results?.length;
    const ttl = good && (value.primaryUsed || value.backupUsed || (value.cseUsed && !value.cooldown)) ? (category === 'images' ? 1800000 : 300000) : 60000;
    shared.set(key, { expires: Date.now()+ttl, value });
    for (const [k,v] of shared) if (Date.now() >= v.expires) shared.delete(k);
    while (shared.size > 100) shared.delete(shared.keys().next().value);
    // Bound persisted cache size too; a large upstream page must not grow disk indefinitely.
    while (Buffer.byteLength(JSON.stringify(Object.fromEntries(shared))) > 8*1024*1024) shared.delete(shared.keys().next().value);
    writeJson(cacheFile, Object.fromEntries(shared), 0o600);
    chmodSync(cacheFile, 0o600);
    return value;
  })();
  pending.set(key,request);
  try { return await request; } finally { pending.delete(key); }
}
