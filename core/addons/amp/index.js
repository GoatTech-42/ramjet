import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { readJson, writeJson, readBody } from '../../util.js';
// amp: one clean music player across three sources - youtube music,
// soundcloud and audius. everything is searched and streamed through
// ramjet's own backend; the client never talks to google, sndcdn or
// audius content nodes directly. mechanisms carried over from the old
// ramjet, where they worked: innertube WEB_REMIX search for yt music,
// soundcloud's public-web client_id (scraped, re-scraped when it rots),
// audius's public discovery api. streams are byte proxies with truthful
// statuses, same discipline as jetstream: open-ended ranges capped at
// 1MB so upstreams see ordinary browser traffic.

const WEB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const YT_UA = 'com.google.android.youtube/20.10.38 (Linux; U; Android 14)';
const AU_HOST = 'https://discoveryprovider.audius.co';
const AU_APP = 'ramjet-amp';
const CAP = 1 << 20;

// playlists: per-user, server-side, so they follow the account across
// devices. one small json file, written atomically; a playlist is just
// an ordered list of the same track objects search returns.
const PL_FILE = fileURLToPath(new URL('../../../data/amp-playlists.json', import.meta.url));
const MAX_PLAYLISTS = 20;
const MAX_TRACKS = 100;

function loadPlaylists() { return readJson(PL_FILE, {}); }
function userPlaylists(user) {
  const all = loadPlaylists();
  return Array.isArray(all[user]) ? all[user] : [];
}
function saveUserPlaylists(user, list) {
  const all = loadPlaylists();
  all[user] = list;
  writeJson(PL_FILE, all);
}

// accept only the track shape search itself emits - id validated per
// source, stream rebuilt from src+id so nothing client-made is trusted.
function cleanTrack(t) {
  if (!t || typeof t !== 'object') return null;
  const src = String(t.src || '');
  if (src !== 'yt' && src !== 'sc' && src !== 'au') return null;
  const id = String(t.id || '');
  const idOk = src === 'yt' ? /^[A-Za-z0-9_-]{11}$/.test(id)
    : src === 'sc' ? /^\d{5,15}$/.test(id)
    : /^[A-Za-z0-9]{1,24}$/.test(id);
  if (!idOk) return null;
  const title = String(t.title || '').slice(0, 200).trim();
  if (!title) return null;
  const art = String(t.art || '');
  return {
    key: src + ':' + id, src, id, title,
    artist: String(t.artist || '').slice(0, 200),
    album: String(t.album || '').slice(0, 200),
    dur: String(t.dur || '').slice(0, 8),
    durSec: Math.max(0, Math.round(Number(t.durSec) || 0)),
    art: art.startsWith('/api/apps/amp/art?') ? art.slice(0, 400) : '',
    stream: '/api/apps/amp/stream?src=' + src + '&id=' + encodeURIComponent(id),
  };
}

function cleanName(n) {
  n = String(n || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  return n;
}
function findPl(list, id) { return list.find((p) => p.id === id); }

function b64(u) { return Buffer.from(u, 'utf8').toString('base64url'); }
function unb64(s) { try { return Buffer.from(String(s || ''), 'base64url').toString('utf8'); } catch { return ''; } }
function fmtDur(sec) {
  sec = Math.max(0, Math.round(Number(sec) || 0));
  return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
}

// pass a media response through to the browser, statuses truthful. an
// open-ended browser range (bytes=N-, how media elements read) becomes a
// bounded 1MB chunk upstream, with the real content-range passed back so
// the element comes back for the rest itself.
async function pipeMedia(up, req, res, opts = {}) {
  const headers = { 'user-agent': WEB_UA };
  // googlevideo 403s requests with no range at all, and chromium's audio
  // element sometimes probes without one - always send a range. it also
  // 403s OPEN-ENDED ranges (bytes=0-) outright, any UA - so every read
  // is bounded: opts.cap turns the browser's open range into a truthful
  // 1MB chunk, the same pattern jetstream streams 1080p with.
  const rm = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
  if (rm) headers.range = 'bytes=' + rm[1] + '-' + (rm[2] ? rm[2] : (opts.cap ? String(parseInt(rm[1], 10) + opts.cap - 1) : ''));
  else headers.range = 'bytes=0-' + (opts.cap ? String(opts.cap - 1) : '');
  let r;
  try {
    r = await fetch(up, { headers, redirect: 'follow', signal: AbortSignal.timeout(30000) });
  } catch { if (opts.writeErrors !== false) { res.writeHead(502); res.end(); } return { status: 502, bytes: 0 }; }
  res.once('close', () => { try { r.body?.cancel()?.catch(() => {}); } catch {} });
  if (r.status !== 200 && r.status !== 206) {
    try { r.body?.cancel()?.catch(() => {}); } catch {}
    if (opts.writeErrors !== false) { res.writeHead(r.status); res.end(); }
    return { status: r.status, bytes: 0 };
  }
  const h = { 'content-type': r.headers.get('content-type') || 'audio/mpeg', 'cache-control': 'private, no-store' };
  for (const k of ['content-length', 'content-range', 'accept-ranges']) {
    const v = r.headers.get(k);
    if (v) h[k] = v;
  }
  res.writeHead(r.status, h);
  if (!r.body) { res.end(); return { status: r.status, bytes: 0 }; }
  let bytes = 0;
  for await (const chunk of r.body) {
    bytes += chunk.length;
    if (!res.write(chunk)) await new Promise((d) => res.once('drain', d));
  }
  res.end();
  return { status: r.status, bytes };
}

// ---------- youtube music ----------

const execFileP = promisify(execFile);
const YTDLP = process.env.YTDLP || new URL("../../../bin/yt-dlp", import.meta.url).pathname;
const ytAudio = new Map(); // videoId -> { url, expires }
const ytInflight = new Map(); // videoId -> Promise<url>

// Tue 7:40 AM: youtube audio resolves through the local
// yt-dlp binary, same fix as jetstream HD - InnerTube client URLs are
// head-capped by googlevideo (~2MB absolute) without the n-parameter
// transform, which yt-dlp applies. One resolver plus one forced re-resolve
// replaces the old client ladder; if yt-dlp flakes for a track the block
// cache below still fails honestly.
const YT_LADDER = ['YTDLP'];

async function ytAudioResolve(id) {
  let stdout;
  try {
    ({ stdout } = await execFileP(YTDLP, ['--no-playlist', '--no-warnings', '--skip-download', '-j', `https://www.youtube.com/watch?v=${id}`], { maxBuffer: 32 * 1024 * 1024, timeout: 30000 }));
  } catch { throw new Error("can't play this one"); }
  let data;
  try { data = JSON.parse(stdout); } catch { throw new Error("can't play this one"); }
  const audios = (data.formats || []).filter((f) => f.url && f.protocol === 'https' && (!f.vcodec || f.vcodec === 'none') && (f.ext === 'm4a' || (f.acodec || '').startsWith('mp4a')));
  audios.sort((a, b) => (b.abr || 0) - (a.abr || 0));
  if (!audios[0]) throw new Error('no audio stream for this one');
  return audios[0].url;
}

async function ytAudioUrl(id, _client = 'YTDLP', force = false) {
  const hit = ytAudio.get(id);
  if (!force && hit && hit.expires > Date.now()) return hit.url;
  const prior = ytInflight.get(id);
  if (prior) return prior;
  const job = ytAudioResolve(id).then((url) => {
    ytAudio.set(id, { url, expires: Date.now() + 10 * 60 * 1000 });
    if (ytAudio.size > 200) ytAudio.delete(ytAudio.keys().next().value);
    return url;
  }).finally(() => ytInflight.delete(id));
  ytInflight.set(id, job);
  return job;
}

// ---- yt block cache ----
// googlevideo's anti-abuse walls the element's natural access pattern:
// chromium probes, aborts mid-transfer, then re-requests - and aborted
// or repeated transfers get 403s, fast on long-tail tracks. the access
// pattern that survives is complete, sequential, never-repeated reads.
// so youtube audio is fetched once per 1MB block, always read to the
// last byte, cached, and every element request (probes, aborts, seeks)
// is served from that cache. googlevideo sees exactly one full read per
// block, ever.
const YT_BLOCK = 1 << 20;
const ytTracks = new Map(); // id -> { blocks, total, failed, fetching, waiters, lastTouched }

async function ytTrack(id) {
  let t = ytTracks.get(id);
  if (t) { t.lastTouched = Date.now(); return t; }
  t = { blocks: new Map(), total: 0, failed: false, fetching: new Set(), waiters: [], lastTouched: Date.now() };
  ytTracks.set(id, t);
  if (ytTracks.size > 12) {
    let oldK = null, oldT = Infinity;
    for (const [k, v] of ytTracks) if (v.lastTouched < oldT) { oldT = v.lastTouched; oldK = k; }
    if (oldK) ytTracks.delete(oldK);
  }
  return t;
}

async function ytBlock(id, idx) {
  const t = await ytTrack(id);
  const hit = t.blocks.get(idx);
  if (hit) return hit;
  if (t.failed) throw new Error('yt throttled');
  if (t.fetching.has(idx)) {
    await new Promise((res2, rej) => t.waiters.push({ idx, res: res2, rej }));
    const got = t.blocks.get(idx);
    if (got) return got;
    throw new Error('yt throttled');
  }
  t.fetching.add(idx);
  const start = idx * YT_BLOCK;
  try {
    let buf = null;
    for (const client of YT_LADDER) {
      for (let attempt = 0; attempt < 2 && !buf; attempt++) {
        let u;
        try { u = await ytAudioUrl(id, client, attempt > 0); } catch { break; }
        const end = t.total ? Math.min(start + YT_BLOCK, t.total) - 1 : start + YT_BLOCK - 1;
        const r = await fetch(u, { headers: { 'user-agent': YT_UA, range: 'bytes=' + start + '-' + end }, signal: AbortSignal.timeout(30000) }).catch(() => null);
        const parts = [];
        for await (const c of r.body) parts.push(c); // full read, never aborted
        buf = Buffer.concat(parts);
        const cr = /\/(\d+)$/.exec(r.headers.get('content-range') || '');
        if (cr) t.total = Number(cr[1]);
      }
      if (buf) break;
    }
    if (!buf) { t.failed = true; throw new Error('yt throttled'); }
    t.blocks.set(idx, buf);
    return buf;
  } finally {
    t.fetching.delete(idx);
    for (const w of t.waiters) if (w.idx === idx) { t.blocks.has(idx) ? w.res() : w.rej(new Error('yt throttled')); }
    t.waiters = t.waiters.filter((w) => w.idx !== idx);
  }
}

// the songs-filtered search (the YM "Songs" tab) - its rows carry
// artist, album and duration; the default search's rows don't
const YM_SONGS_PARAMS = 'EgWKAQIIAWoKEAoQAxADEAQQAQ==';

async function ymSearch(q) {
  const r = await fetch('https://music.youtube.com/youtubei/v1/search?prettyPrint=false', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': WEB_UA },
    body: JSON.stringify({
      context: { client: { clientName: 'WEB_REMIX', clientVersion: '1.20240925.01.00', hl: 'en' } },
      query: q,
      params: YM_SONGS_PARAMS,
    }),
    signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) throw new Error('ym ' + r.status);
  const data = await r.json();
  const items = [];
  const seen = new Set();
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    const it = node.musicResponsiveListItemRenderer;
    if (!it) {
      Object.values(node).forEach(walk);
      return;
    }
    let videoId = '';
    try { videoId = it.playlistItemData.videoId || ''; } catch {}
    if (!videoId) {
      try { videoId = it.overlay.musicItemThumbnailOverlayRenderer.content.musicPlayButtonRenderer.playNavigationEndpoint.watchEndpoint.videoId || ''; } catch {}
    }
    if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId) || seen.has(videoId)) return;
    seen.add(videoId);
    const cols = (it.flexColumns || []).map((c) => c.musicResponsiveListItemFlexColumnRenderer?.text?.runs || []);
    const title = cols[0]?.[0]?.text || '';
    // col 2 is runs joined by bullets, but artists can be several runs
    // themselves ("A & B") - split on bullet-only runs into real segments
    const segs = [[]];
    for (const r2 of cols[1] || []) {
      const t = r2.text || '';
      if (/^[\u2022\s]+$/.test(t)) segs.push([]);
      else segs[segs.length - 1].push(t);
    }
    const segText = segs.map((s) => s.join('').trim()).filter(Boolean);
    const durText = segText.find((t) => /^(\d+:)?\d+:\d+$/.test(t)) || '';
    const metaNoDur = segText.filter((t) => t !== durText);
    const artist = metaNoDur[0] || '';
    const album = metaNoDur[1] || '';
    const durSec = durText ? durText.split(':').reduce((a, x) => a * 60 + parseInt(x, 10), 0) : 0;
    const plays = cols[2]?.[0]?.text || '';
    if (!title) return;
    items.push({
      key: 'yt:' + videoId, src: 'yt', id: videoId, title, artist, album, plays,
      dur: durText, durSec,
      art: '/api/apps/amp/art?src=yt&id=' + videoId,
      stream: '/api/apps/amp/stream?src=yt&id=' + videoId,
    });
  };
  walk(data);
  return items.slice(0, 12);
}

// ---------- soundcloud ----------

// the public-web client_id, scraped from soundcloud's own bundles like
// every proxy music site does; re-scraped when it starts 403ing.
let scCid = '', scCidAt = 0;
async function scClientId(force = false) {
  if (!force && scCid && Date.now() - scCidAt < 6 * 3600e3) return scCid;
  const html = await (await fetch('https://soundcloud.com/', { headers: { 'user-agent': WEB_UA }, signal: AbortSignal.timeout(12000) })).text();
  const srcs = [...html.matchAll(/<script[^>]+src="(https:\/\/a-v2\.sndcdn\.com\/[^"]+\.js)"/g)].map((m) => m[1]);
  for (const src of srcs.reverse()) {
    try {
      const js = await (await fetch(src, { headers: { 'user-agent': WEB_UA }, signal: AbortSignal.timeout(12000) })).text();
      const m = /client_id\s*[:=]\s*"([a-zA-Z0-9]{32})"/.exec(js) || /client_id\s*[:=]\s*"([a-zA-Z0-9]{24,40})"/.exec(js);
      if (m) { scCid = m[1]; scCidAt = Date.now(); return scCid; }
    } catch {}
  }
  if (scCid) return scCid;
  throw new Error('no soundcloud client_id');
}

async function scFetchJson(up) {
  let cid = await scClientId();
  let r = await fetch(up + (up.includes('?') ? '&' : '?') + 'client_id=' + cid, { headers: { 'user-agent': WEB_UA }, signal: AbortSignal.timeout(15000) });
  if (r.status === 403) {
    cid = await scClientId(true);
    r = await fetch(up + (up.includes('?') ? '&' : '?') + 'client_id=' + cid, { headers: { 'user-agent': WEB_UA }, signal: AbortSignal.timeout(15000) });
  }
  if (!r.ok) throw new Error('sc ' + r.status);
  return r.json();
}

async function scSearch(q) {
  const d = await scFetchJson('https://api-v2.soundcloud.com/search/tracks?q=' + encodeURIComponent(q) + '&limit=24');
  return (d.collection || []).filter((t) => {
    if (!t || !t.id || t.streamable === false) return false;
    const tcs = t.media?.transcodings || [];
    // only progressive (plain-mp3) transcodings can stream through us -
    // encrypted-hls-only tracks cannot play in a browser element
    return tcs.length === 0 || tcs.some((x) => x.format?.protocol === 'progressive');
  }).slice(0, 12).map((t) => ({
    key: 'sc:' + t.id, src: 'sc', id: String(t.id),
    title: t.title || '', artist: t.user?.username || '',
    dur: fmtDur((t.duration || 0) / 1000), durSec: Math.round((t.duration || 0) / 1000),
    art: t.artwork_url ? '/api/apps/amp/art?src=sc&u=' + b64(t.artwork_url.replace('-large', '-t500x500')) : '',
    stream: '/api/apps/amp/stream?src=sc&id=' + t.id,
  }));
}

const scMedia = new Map(); // trackId -> { url, expires }
async function scStreamUrl(id, force = false) {
  const hit = scMedia.get(id);
  if (!force && hit && hit.expires > Date.now()) return hit.url;
  const t = await scFetchJson('https://api-v2.soundcloud.com/tracks/' + id);
  const tcs = t.media?.transcodings || [];
  const tc = tcs.find((x) => x.format?.protocol === 'progressive' && /mp3/.test(x.format?.mime_type || ''))
    || tcs.find((x) => x.format?.protocol === 'progressive');
  if (!tc) throw new Error('no progressive stream');
  const j = await scFetchJson(tc.url);
  if (!j || !j.url) throw new Error('no url');
  // signed progressive urls expire in minutes - cache the resolve briefly
  scMedia.set(id, { url: j.url, expires: Date.now() + 45 * 1000 });
  if (scMedia.size > 300) scMedia.delete(scMedia.keys().next().value);
  return j.url;
}

// ---------- audius ----------

async function auSearch(q) {
  const r = await fetch(AU_HOST + '/v1/tracks/search?query=' + encodeURIComponent(q) + '&app_name=' + AU_APP, {
    headers: { 'user-agent': WEB_UA, accept: 'application/json' },
    signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) throw new Error('audius ' + r.status);
  const j = await r.json();
  return (j.data || []).slice(0, 12).map((t) => {
    const artUrl = t.artwork?.['480x480'] || t.artwork?.['150x150'] || '';
    return {
      key: 'au:' + t.id, src: 'au', id: String(t.id),
      title: t.title || '', artist: t.user?.name || '',
      dur: fmtDur(t.duration), durSec: Math.round(Number(t.duration) || 0),
      art: artUrl ? '/api/apps/amp/art?src=au&u=' + b64(artUrl) : '',
      stream: '/api/apps/amp/stream?src=au&id=' + encodeURIComponent(t.id),
    };
  });
}

// ---------- routes ----------

export async function register(req, res, ctx) {
  const { url, sendJson, guard, session } = ctx;
  const sub = req.url.split('?')[0].replace(/^\/api\/apps\/amp/, '') || '/';

  if (sub === '/search' && req.method === 'GET') {
    const q = (url.searchParams.get('q') || '').trim();
    if (!q) return sendJson(res, 400, { ok: false, error: 'search for something first' });
    if (q.length > 120) return sendJson(res, 400, { ok: false, error: 'keep searches under 120 characters' });
    const [yt, sc, au] = await Promise.allSettled([ymSearch(q), scSearch(q), auSearch(q)]);
    guard.trackBytes(session.user, 8192);
    const results = {
      youtube: yt.status === 'fulfilled' ? yt.value : [],
      soundcloud: sc.status === 'fulfilled' ? sc.value : [],
      audius: au.status === 'fulfilled' ? au.value : [],
    };
    const failed = [yt, sc, au].filter((x) => x.status === 'rejected').length;
    if (failed === 3) return sendJson(res, 502, { ok: false, error: 'every source timed out - try again' });
    return sendJson(res, 200, { ok: true, q, results });
  }

  if (sub === '/stream' && req.method === 'GET') {
    if (guard.bytesLeft(session.user) <= 0) return sendJson(res, 429, { ok: false, error: 'out of bandwidth for now - it resets every hour' });
    const src = url.searchParams.get('src') || '';
    const id = (url.searchParams.get('id') || '').trim();
    try {
      if (src === 'yt') {
        if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return sendJson(res, 400, { ok: false, error: 'bad id' });
        // served from the per-block cache - googlevideo sees one full
        // sequential read per 1MB block, never an abort, never a repeat.
        const rm = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '') || [null, '0', ''];
        const startByte = parseInt(rm[1], 10);
        try {
          const t = await ytTrack(id);
          const idx = Math.floor(startByte / YT_BLOCK);
          const block = await ytBlock(id, idx);
          const off = startByte - idx * YT_BLOCK;
          const body = block.subarray(off);
          const total = t.total || (idx * YT_BLOCK + block.length);
          res.writeHead(206, {
            'content-type': 'audio/mp4',
            'content-length': body.length,
            'content-range': 'bytes ' + startByte + '-' + (startByte + body.length - 1) + '/' + total,
            'accept-ranges': 'bytes',
            'cache-control': 'private, no-store',
          });
          res.end(body);
          guard.trackBytes(session.user, body.length);
          // one block of lookahead keeps playback seamless while pacing
          // googlevideo to a slow sequential walk
          if (block.length === YT_BLOCK) ytBlock(id, idx + 1).catch(() => {});
        } catch (e) {
          if (!res.headersSent) { res.writeHead(503); res.end(); }
        }
        return;
      }
      if (src === 'sc') {
        if (!/^\d{5,15}$/.test(id)) return sendJson(res, 400, { ok: false, error: 'bad id' });
        let u = await scStreamUrl(id);
        let r = await pipeMedia(u, req, res, { writeErrors: false });
        if (r.status === 403 || r.status === 410) {
          u = await scStreamUrl(id, true);
          r = await pipeMedia(u, req, res, { writeErrors: false });
        }
        if (!res.headersSent && r.bytes === 0) { res.writeHead(r.status); res.end(); }
        if (r.bytes) guard.trackBytes(session.user, r.bytes);
        return;
      }
      if (src === 'au') {
        if (!/^[A-Za-z0-9]{1,24}$/.test(id)) return sendJson(res, 400, { ok: false, error: 'bad id' });
        // content nodes sit behind cloudflare browser checks that reject
        // media-element loads - server-to-server sails through
        const u = AU_HOST + '/v1/tracks/' + id + '/stream?app_name=' + AU_APP;
        const r = await pipeMedia(u, req, res, { cap: CAP });
        if (r.bytes) guard.trackBytes(session.user, r.bytes);
        return;
      }
      return sendJson(res, 400, { ok: false, error: 'bad source' });
    } catch {
      if (!res.headersSent) { res.writeHead(502); res.end(); }
      return;
    }
  }

  if (sub === '/art' && req.method === 'GET') {
    const src = url.searchParams.get('src') || '';
    let up = '';
    if (src === 'yt') {
      const id = (url.searchParams.get('id') || '').trim();
      if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return sendJson(res, 400, { ok: false, error: 'bad id' });
      up = 'https://i.ytimg.com/vi/' + id + '/mqdefault.jpg';
    } else if (src === 'sc') {
      const u = unb64(url.searchParams.get('u'));
      try { const p = new URL(u); if (p.protocol === 'https:' && /(^|\.)sndcdn\.com$/.test(p.hostname) && !p.username && !p.password) up = u; } catch {}
      if (!up) return sendJson(res, 400, { ok: false, error: 'bad url' });
    } else if (src === 'au') {
      // content nodes are arbitrary hosts - validate the shape instead:
      // https, no creds, /content/<cid>/<size>.<ext>
      const u = unb64(url.searchParams.get('u'));
      try {
        const p = new URL(u);
        if (p.protocol === 'https:' && !p.username && !p.password && /^\/content\/[A-Za-z0-9]{20,64}\/[0-9]{2,4}x[0-9]{2,4}\.(jpg|jpeg|png|webp)$/i.test(p.pathname)) up = u;
      } catch {}
      if (!up) return sendJson(res, 400, { ok: false, error: 'bad url' });
    } else {
      return sendJson(res, 400, { ok: false, error: 'bad source' });
    }
    try {
      const r = await fetch(up, { headers: { 'user-agent': WEB_UA }, redirect: 'follow', signal: AbortSignal.timeout(12000) });
      if (!r.ok) { res.writeHead(204); return res.end(); }
      const buf = Buffer.from(await r.arrayBuffer());
      guard.trackBytes(session.user, buf.length);
      res.writeHead(200, { 'content-type': r.headers.get('content-type') || 'image/jpeg', 'cache-control': 'public, max-age=86400' });
      return res.end(buf);
    } catch {
      res.writeHead(204); return res.end();
    }
  }

  if (sub === '/playlists' && req.method === 'GET') {
    const list = userPlaylists(session.user);
    return sendJson(res, 200, {
      ok: true,
      playlists: list.map((p) => ({ id: p.id, name: p.name, count: p.tracks.length, art: p.tracks[0]?.art || '' })),
    });
  }

  if (sub === '/playlists' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    const name = cleanName(body.name);
    if (!name) return sendJson(res, 400, { ok: false, error: 'give it a name first' });
    const list = userPlaylists(session.user);
    if (list.length >= MAX_PLAYLISTS) return sendJson(res, 400, { ok: false, error: 'twenty playlists is plenty - delete one first' });
    if (list.some((p) => p.name.toLowerCase() === name.toLowerCase())) return sendJson(res, 400, { ok: false, error: 'you already have one called that' });
    const pl = { id: randomBytes(4).toString('hex'), name, tracks: [] };
    list.push(pl);
    saveUserPlaylists(session.user, list);
    return sendJson(res, 200, { ok: true, playlist: { id: pl.id, name: pl.name, count: 0, art: '' } });
  }

  if (sub === '/playlists/tracks' && req.method === 'GET') {
    const pl = findPl(userPlaylists(session.user), url.searchParams.get('id') || '');
    if (!pl) return sendJson(res, 404, { ok: false, error: 'that playlist is gone' });
    return sendJson(res, 200, { ok: true, playlist: { id: pl.id, name: pl.name, tracks: pl.tracks } });
  }

  if (sub === '/playlists/add' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    const list = userPlaylists(session.user);
    const pl = findPl(list, String(body.id || ''));
    if (!pl) return sendJson(res, 404, { ok: false, error: 'that playlist is gone' });
    const track = cleanTrack(body.track);
    if (!track) return sendJson(res, 400, { ok: false, error: 'that song could not be saved' });
    if (pl.tracks.some((t) => t.key === track.key)) return sendJson(res, 200, { ok: true, already: true, count: pl.tracks.length });
    if (pl.tracks.length >= MAX_TRACKS) return sendJson(res, 400, { ok: false, error: 'this playlist is full (100 songs)' });
    pl.tracks.push(track);
    saveUserPlaylists(session.user, list);
    return sendJson(res, 200, { ok: true, already: false, count: pl.tracks.length });
  }

  if (sub === '/playlists/remove' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    const list = userPlaylists(session.user);
    const pl = findPl(list, String(body.id || ''));
    if (!pl) return sendJson(res, 404, { ok: false, error: 'that playlist is gone' });
    const i = Number(body.index);
    if (!Number.isInteger(i) || i < 0 || i >= pl.tracks.length) return sendJson(res, 400, { ok: false, error: 'no song there' });
    pl.tracks.splice(i, 1);
    saveUserPlaylists(session.user, list);
    return sendJson(res, 200, { ok: true, count: pl.tracks.length });
  }

  if (sub === '/playlists/move' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    const list = userPlaylists(session.user);
    const pl = findPl(list, String(body.id || ''));
    if (!pl) return sendJson(res, 404, { ok: false, error: 'that playlist is gone' });
    const i = Number(body.index); const j = i + (Number(body.dir) < 0 ? -1 : 1);
    if (!Number.isInteger(i) || i < 0 || i >= pl.tracks.length || j < 0 || j >= pl.tracks.length) return sendJson(res, 400, { ok: false, error: 'cannot move that song' });
    const [t] = pl.tracks.splice(i, 1); pl.tracks.splice(j, 0, t);
    saveUserPlaylists(session.user, list);
    return sendJson(res, 200, { ok: true });
  }

  if (sub === '/playlists/rename' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    const list = userPlaylists(session.user);
    const pl = findPl(list, String(body.id || ''));
    if (!pl) return sendJson(res, 404, { ok: false, error: 'that playlist is gone' });
    const name = cleanName(body.name);
    if (!name) return sendJson(res, 400, { ok: false, error: 'give it a name first' });
    pl.name = name;
    saveUserPlaylists(session.user, list);
    return sendJson(res, 200, { ok: true });
  }

  if (sub === '/playlists/delete' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    const list = userPlaylists(session.user);
    const kept = list.filter((p) => p.id !== String(body.id || ''));
    if (kept.length === list.length) return sendJson(res, 404, { ok: false, error: 'that playlist is gone' });
    saveUserPlaylists(session.user, kept);
    return sendJson(res, 200, { ok: true });
  }

  if (sub === '/playlists/clear' && req.method === 'POST') {
    saveUserPlaylists(session.user, []);
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { ok: false, error: 'unknown amp call' });
}
