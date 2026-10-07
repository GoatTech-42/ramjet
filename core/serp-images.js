import { readJson, writeJson } from './util.js';
import { dataPath } from './data.js';
import { cseFailure } from './cse-gate.js';

// Conservative rolling window covers any monthly billing boundary. Count attempts,
// including failures/cache hits at the provider, before network I/O. Dedicated key only.
export function reserveSerp(state, now = Date.now()) {
  const old = state.serp || {};
  const stamps = (Array.isArray(old.stamps) ? old.stamps : []).filter(t => Number.isFinite(t) && now-t < 31*86400000);
  if (now < (Number(old.until)||0) || stamps.length >= 200 || stamps.filter(t=>now-t < 3600000).length >= 40) return null;
  return { ...state, serp: { ...old, stamps: [...stamps,now] } };
}
// SerpApi has only active/off. Moderate uses active (filtered), not an invented
// moderate or the omitted-parameter blur default. Strict also uses active.
const publicUrl = value => {
  try {const u=new URL(value);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password&&!u.searchParams.has('api_key')?u.href:'';}catch{return '';}
};
export const serpSafe = safe => safe === 0 ? 'off' : 'active';
export function createSerpImages({ key, load, save, fetcher = fetch, now = Date.now, fail = () => {} }) {
  return async (query, page, safe) => {
    if (!key()) return null;
    const next = reserveSerp(load(), now());
    if (!next) return null;
    save(next);
    try {
      const params = new URLSearchParams({engine:'google_images',q:query,ijn:String(Math.max(0,page-1)),safe:serpSafe(safe),api_key:key(),output:'json'});
      const response = await fetcher('https://serpapi.com/search.json?'+params,{signal:AbortSignal.timeout(12000)});
      if (!response.ok) throw new Error('image backup unavailable');
      const bytes = []; let size = 0;
      for await (const chunk of response.body) {size+=chunk.length;if(size>4*1024*1024)throw new Error('image backup response too large');bytes.push(chunk);}
      const data = JSON.parse(Buffer.concat(bytes).toString('utf8'));
      if (data.error || !Array.isArray(data.images_results)) throw new Error('image backup unavailable');
      // Only public image fields are retained; no request metadata or key-bearing links.
      return data.images_results.slice(0,100).map(r=>({title:String(r.title||'Image'),url:publicUrl(r.link),img_src:publicUrl(r.original),thumbnail_src:publicUrl(r.thumbnail),engine:'google images (SerpApi)'})).filter(r=>/^https?:\/\//i.test(r.url||'') && /^https?:\/\//i.test(r.img_src||''));
    } catch {
      const state = load();save({...state,serp:{...state.serp,until:now()+600000}});fail();return null;
    }
  };
}
const file = dataPath('cse-budget.json');
export const serpImages = createSerpImages({key:()=>process.env.SERPAPI_API_KEY || '',load:()=>readJson(file,{}),save:s=>writeJson(file,s),fail:cseFailure});
