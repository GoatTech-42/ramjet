import { cseGate, cseFailure, cseCooldownLeft } from './cse-gate.js';

// Explicit fallback lists must not accidentally invoke CSE through defaults.
const fallback = { general: 'bing,brave,mojeek,startpage,wikipedia', images: 'brave images' };
export function cseFailed(data) {
  return (Array.isArray(data?.unresponsive_engines) ? data.unresponsive_engines : []).some(entry => {
    const engine = Array.isArray(entry) ? entry[0] : entry?.engine;
    return String(engine || '').toLowerCase().includes('cse');
  });
}
export async function searchUpstream(query, page, category, safe, allowCse = true) {
  const cat = category || 'general';
  const touchesCse = cat === 'general' || cat === 'images';
  const permitted = touchesCse && allowCse ? await cseGate() : false;
  const engines = touchesCse ? (permitted ? (cat === 'images' ? 'google cse images,brave images' : 'google cse,bing') : fallback[cat]) : '';
  const params = new URLSearchParams({ q: query, format: 'json', safesearch: String(safe | 0) });
  if (engines) params.set('engines', engines);
  if (page > 1) params.set('pageno', String(page));
  if (cat !== 'general') params.set('categories', cat);
  try {
    const response = await fetch('http://127.0.0.1:8888/search?' + params, { headers: {accept:'application/json','accept-encoding':'identity'}, signal: AbortSignal.timeout(15000) });
    if (!response.ok) { if (permitted) cseFailure(); return {down:true}; }
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) throw new Error('search response too large');
      chunks.push(chunk);
    }
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (permitted && cseFailed(data)) cseFailure();
    if (touchesCse && Array.isArray(data.results)) {
      data.results = data.results.map((r,k)=>[r,k]).sort((a,b)=>Number(String(b[0].engine||'').includes('cse'))-Number(String(a[0].engine||'').includes('cse'))||a[1]-b[1]).map(x=>x[0]);
    }
    return {down:false,data,cseUsed:permitted, cooldown:cseCooldownLeft()};
  } catch {
    if (permitted) cseFailure(); return {down:true};
  }
}
