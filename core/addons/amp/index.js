import { dataPath } from '../../data.js';
import { TtlCache } from '../../ttlcache.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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
const PL_FILE = dataPath('amp-playlists.json');
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
  // one listener set for the whole relay - per-chunk once() calls would
  // accumulate over a long stream (MaxListenersExceeded) and leak the losers
  let clientGone = false;
  let wake = null; // the single outstanding backpressure wait, if any
  let resolveGone;
  const goneP = new Promise((d) => { resolveGone = d; });
  const GONE = Symbol('client-gone');
  const onDrain = () => { const w = wake; wake = null; if (w) w(false); };
  const onGone = () => {
    clientGone = true;
    try { r.body?.cancel()?.catch(() => {}); } catch {}
    resolveGone(GONE);
    const w = wake; wake = null; if (w) w(true);
  };
  const unlisten = () => {
    res.removeListener('drain', onDrain);
    res.removeListener('close', onGone);
    res.removeListener('error', onGone);
  };
  if (r.status !== 200 && r.status !== 206) {
    unlisten();
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
  res.on('drain', onDrain);
  res.once('close', onGone);
  res.once('error', onGone);
  let bytes = 0;
  try {
    // manual iterator so every pending read races the one shared gone
    // promise - cancel() alone can't interrupt a locked for-await
    const it = r.body[Symbol.asyncIterator]();
    for (;;) {
      const step = await Promise.race([it.next(), goneP]);
      if (step === GONE || step.done) break;
      const chunk = step.value;
      bytes += chunk.length;
      if (clientGone || res.destroyed) break;
      if (!res.write(chunk)) {
        // a gone client never drains - the shared listeners settle the wait
        const gone = await new Promise((d) => { wake = d; });
        if (gone) { unlisten(); return { status: r.status, bytes }; }
      }
    }
  } catch {
    // upstream body died mid-relay with the response already committed -
    // destroy so the element gets an error, never a hang
    unlisten();
    res.destroy();
    return { status: r.status, bytes };
  }
  unlisten();
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

async function ytBlock(id, idx, resolve = ytAudioUrl) {
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
        try { u = await resolve(id, client, attempt > 0); } catch { break; }
        const end = t.total ? Math.min(start + YT_BLOCK, t.total) - 1 : start + YT_BLOCK - 1;
        const r = await fetch(u, { headers: { 'user-agent': YT_UA, range: 'bytes=' + start + '-' + end }, signal: AbortSignal.timeout(30000) }).catch(() => null);
        // anything but a clean 206 is a failed attempt: a null fetch is a
        // transient, and a 403/404 error page must never be cached as audio
        // (it decodes as garbage and kills playback at the block boundary)
        if (!r || r.status !== 206) { try { r?.body?.cancel()?.catch(() => {}); } catch {} continue; }
        let parts = null;
        try {
          parts = [];
          for await (const c of r.body) parts.push(c); // full read, never aborted
        } catch { parts = null; } // body died mid-read - try again
        if (!parts) continue;
        const got = Buffer.concat(parts);
        const want = Number(r.headers.get('content-length') || 0);
        if (want && got.length !== want) continue; // silently truncated
        buf = got;
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

// one YM track row (search + artist page share the shape). artistId is the
// channel browse id when the row links the artist - the client falls back to
// a name lookup when it is missing.
function ymRow(it) {
  let videoId = '';
  try { videoId = it.playlistItemData.videoId || ''; } catch {}
  if (!videoId) {
    try { videoId = it.overlay.musicItemThumbnailOverlayRenderer.content.musicPlayButtonRenderer.playNavigationEndpoint.watchEndpoint.videoId || ''; } catch {}
  }
  if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) return null;
  const cols = (it.flexColumns || []).map((c) => c.musicResponsiveListItemFlexColumnRenderer?.text?.runs || []);
  const title = cols[0]?.[0]?.text || '';
  // col 2 is runs joined by bullets, but artists can be several runs
  // themselves ("A & B") - split on bullet-only runs into real segments
  const segs = [[]];
  let artistId = '';
  for (const r2 of cols[1] || []) {
    const t = r2.text || '';
    if (/^[\u2022\s]+$/.test(t)) segs.push([]);
    else {
      segs[segs.length - 1].push(t);
      if (!artistId) {
        const b = r2.navigationEndpoint?.browseEndpoint?.browseId || '';
        if (/^UC[A-Za-z0-9_-]{10,30}$/.test(b)) artistId = b;
      }
    }
  }
  const segText = segs.map((s) => s.join('').trim()).filter(Boolean);
  const durText = segText.find((t) => /^(\d+:)?\d+:\d+$/.test(t)) || '';
  const metaNoDur = segText.filter((t) => t !== durText);
  const artist = metaNoDur[0] || '';
  const album = metaNoDur[1] || '';
  const durSec = durText ? durText.split(':').reduce((a, x) => a * 60 + parseInt(x, 10), 0) : 0;
  const plays = cols[2]?.[0]?.text || '';
  if (!title) return null;
  return {
    key: 'yt:' + videoId, src: 'yt', id: videoId, title, artist, album, plays, artistId,
    dur: durText, durSec,
    art: '/api/apps/amp/art?src=yt&id=' + videoId,
    stream: '/api/apps/amp/stream?src=yt&id=' + videoId,
  };
}

const ymPost = (endpoint, body) => fetch('https://music.youtube.com/youtubei/v1/' + endpoint + '?prettyPrint=false', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'user-agent': WEB_UA },
  body: JSON.stringify({ context: { client: { clientName: 'WEB_REMIX', clientVersion: '1.20240925.01.00', hl: 'en' } }, ...body }),
  signal: AbortSignal.timeout(12000),
});

// artist page by channel id: header (visual or immersive) + top songs.
// upstream-derived ONLY - the cached value is shared across requests, so
// caller-specific fallbacks are applied by the caller on a clone, never here.
async function ymArtistByIdLive(browseId) {
  const br = await ymPost('browse', { browseId });
  if (!br.ok) throw new Error('ym browse ' + br.status);
  const bd = await br.json();
  if (!bd || typeof bd !== 'object' || (!bd.contents && !bd.header)) throw new Error('ym bad payload'); // see ymSearchLive
  const tracks = [];
  const seen = new Set();
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    const it = node.musicResponsiveListItemRenderer;
    if (it) {
      const row = ymRow(it);
      if (row && !seen.has(row.id)) { seen.add(row.id); tracks.push(row); }
      return;
    }
    Object.values(node).forEach(walk);
  };
  walk(bd);
  let name = '', art = '', sub = '';
  try {
    const vh = bd.header.musicVisualHeaderRenderer || bd.header.musicImmersiveHeaderRenderer;
    if (vh) {
      name = (vh.title?.runs || []).map((r) => r.text).join('') || name;
      const th = vh.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || [];
      if (th.length) {
        // smallest thumb at or above 512px - the page shows a 96px circle,
        // the 2880px original is a megabyte of waste
        const sized = th.filter((t) => t.width >= 512).sort((a, b) => a.width - b.width)[0];
        art = (sized || th[th.length - 1]).url;
      }
      sub = (vh.subtitle?.runs || []).map((r) => r.text).join('')
        || (vh.monthlyListenerCount?.runs || []).map((r) => r.text).join('')
        || sub;
    }
  } catch {}
  return { name, art, sub, tracks: tracks.slice(0, 20) };
}

// artist name resolution: the search top-result card points at the channel.
// this resolution is itself cached (below), so a repeat artist page costs
// two cache reads and a clone.
async function ymArtistResolve(name) {
  const sr = await ymPost('search', { query: name });
  if (!sr.ok) throw new Error('ym ' + sr.status);
  const sd = await sr.json();
  if (!sd || typeof sd !== 'object' || !sd.contents) throw new Error('ym bad payload'); // see ymSearchLive
  let browseId = '', cardName = '', cardArt = '', cardSub = '';
  const findCard = (node) => {
    if (browseId || !node || typeof node !== 'object') return;
    const card = node.musicCardShelfRenderer;
    if (card) {
      const b = card.title?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId || '';
      if (/^UC[A-Za-z0-9_-]{10,30}$/.test(b)) {
        browseId = b;
        cardName = card.title.runs[0].text || '';
        const th = card.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || [];
        cardArt = th.length ? th[th.length - 1].url : '';
        cardSub = (card.subtitle?.runs || []).map((r) => r.text).join('');
      }
      return;
    }
    Object.values(node).forEach(findCard);
  };
  findCard(sd);
  if (!browseId) throw new Error('no artist page');
  return { browseId, cardName, cardArt, cardSub };
}
// artist page: cached name resolution + cached channel page; fallbacks (the
// search card, then the query itself) land on a per-request clone - the
// cached values are frozen and shared.
async function ymArtistLive(name) {
  const r = await ymArtistResolved(name);
  const base = await ymArtistById(r.browseId);
  const out = { ...base };
  if (!out.name) out.name = r.cardName || name;
  if (!out.art) out.art = r.cardArt;
  if (!out.sub) out.sub = r.cardSub;
  return out;
}

async function ymSearchLive(q) {
  const r = await ymPost('search', { query: q, params: YM_SONGS_PARAMS });
  if (!r.ok) throw new Error('ym ' + r.status);
  const data = await r.json();
  // an http-200 error envelope must not cache as an empty result; a real
  // search response always carries contents, even when nothing matched
  if (!data || typeof data !== 'object' || !data.contents) throw new Error('ym bad payload');
  const items = [];
  const seen = new Set();
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    const it = node.musicResponsiveListItemRenderer;
    if (!it) {
      Object.values(node).forEach(walk);
      return;
    }
    const row = ymRow(it);
    if (!row || seen.has(row.id)) return;
    seen.add(row.id);
    items.push(row);
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

const scTrackOk = (t) => {
  if (!t || !t.id || t.streamable === false) return false;
  const tcs = t.media?.transcodings || [];
  // progressive mp3 (gone upstream these days) or hls aac - the hls mpegurl
  // variant 404s at resolve time, and encrypted hls cannot play in a plain
  // element, so only the aac fmp4 ladder counts
  return tcs.length === 0 || tcs.some((x) => {
    const p = x.format?.protocol, m = x.format?.mime_type || '';
    return p === 'progressive' || (p === 'hls' && /mp4/.test(m));
  });
};
const scMap = (t) => ({
  key: 'sc:' + t.id, src: 'sc', id: String(t.id),
  title: t.title || '', artist: t.user?.username || '', artistId: t.user?.id ? String(t.user.id) : '',
  dur: fmtDur((t.duration || 0) / 1000), durSec: Math.round((t.duration || 0) / 1000),
  art: t.artwork_url ? '/api/apps/amp/art?src=sc&u=' + b64(t.artwork_url.replace('-large', '-t500x500')) : '',
  stream: '/api/apps/amp/stream?src=sc&id=' + t.id,
});

async function scSearchLive(q) {
  const d = await scFetchJson('https://api-v2.soundcloud.com/search/tracks?q=' + encodeURIComponent(q) + '&limit=24');
  if (!d || !Array.isArray(d.collection)) throw new Error('sc bad payload'); // see ymSearchLive
  return d.collection.filter(scTrackOk).slice(0, 12).map(scMap);
}

// artist page: profile + their public tracks, same row shape as search
async function scArtist(uid) {
  const [u, d] = await Promise.all([
    scFetchJson('https://api-v2.soundcloud.com/users/' + encodeURIComponent(uid)),
    scFetchJson('https://api-v2.soundcloud.com/users/' + encodeURIComponent(uid) + '/tracks?limit=24'),
  ]);
  const tracks = (d.collection || []).filter(scTrackOk).slice(0, 20).map(scMap);
  const art = u.avatar_url ? '/api/apps/amp/art?src=sc&u=' + b64(u.avatar_url.replace('-large', '-t500x500')) : '';
  const sub = u.followers_count ? Math.round(u.followers_count).toLocaleString('en-US') + ' followers' : '';
  return { name: u.username || '', art, sub, tracks };
}

const scMedia = new Map(); // trackId -> { url, expires }
// parse an m3u8 into { init, segs } absolute urls. one level of master
// playlist unwrapped; relative urls resolve against the playlist url.
function parseM3U8(text, base) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const variant = lines.find((l) => !l.startsWith('#') && /\.m3u8/.test(l));
  if (lines.some((l) => l.startsWith('#EXT-X-STREAM-INF')) && variant) return { variant: new URL(variant, base).href };
  let init = '';
  const segs = [];
  for (const l of lines) {
    if (l.startsWith('#EXT-X-MAP')) {
      const m = /URI="([^"]+)"/.exec(l);
      if (m) init = new URL(m[1], base).href;
    } else if (!l.startsWith('#')) {
      segs.push(new URL(l, base).href);
    }
  }
  if (!segs.length) throw new Error('empty playlist');
  return { init, segs };
}

// byte size of one signed url - HEAD when the cdn allows it, a 1-byte
// range GET otherwise (cloudfront answers content-range either way)
async function scSize(u) {
  let r = await fetch(u, { method: 'HEAD', headers: { 'user-agent': WEB_UA }, signal: AbortSignal.timeout(10000) });
  if (r.ok && +r.headers.get('content-length') > 0) return +r.headers.get('content-length');
  r = await fetch(u, { headers: { 'user-agent': WEB_UA, range: 'bytes=0-0' }, signal: AbortSignal.timeout(10000) });
  if (r.status === 206) {
    const m = /\/(\d+)$/.exec(r.headers.get('content-range') || '');
    if (m) return +m[1];
  }
  throw new Error('size ' + r.status);
}

// sc fmp4 init segments declare duration 0 (it's a live-style ladder) -
// a browser element then GUESSES the timeline from byte size and seeks
// land wrong. write the track's real duration into mvhd/tkhd/mdhd and add
// a mehd to mvex so the element reads the true length. v0 boxes only.
function patchInitDuration(init, durMs) {
  const ms = Math.max(0, Math.round(durMs) || 0);
  if (!ms || init.length < 16) return init;
  const boxes = (b, off, end) => {
    const out = [];
    while (off + 8 <= end) {
      const size = b.readUInt32BE(off);
      if (size < 8 || off + size > end) break;
      out.push({ type: b.toString('latin1', off + 4, off + 8), off, size });
      off += size;
    }
    return out;
  };
  const buf = Buffer.from(init); // copy - never mutate a cached buffer
  try {
    for (const top of boxes(buf, 0, buf.length)) {
      if (top.type !== 'moov') continue;
      let mediaScale = 0, movieScale = 0;
      for (const c of boxes(buf, top.off + 8, top.off + top.size)) {
        if (c.type === 'mvhd' && buf[c.off + 8] === 0) {
          movieScale = buf.readUInt32BE(c.off + 20);
          buf.writeUInt32BE(Math.round(ms * movieScale / 1000), c.off + 24);
        }
        if (c.type === 'tkhd' && buf[c.off + 8] === 0 && movieScale) {
          buf.writeUInt32BE(Math.round(ms * movieScale / 1000), c.off + 28);
        }
        if (c.type === 'trak') {
          for (const mdia of boxes(buf, c.off + 8, c.off + c.size)) {
            if (mdia.type !== 'mdia') continue;
            for (const h of boxes(buf, mdia.off + 8, mdia.off + mdia.size)) {
              if (h.type === 'mdhd' && buf[h.off + 8] === 0) {
                mediaScale = buf.readUInt32BE(h.off + 20);
                buf.writeUInt32BE(Math.round(ms * mediaScale / 1000), h.off + 24);
              }
            }
          }
        }
        if (c.type === 'mvex' && movieScale) {
          const mehd = Buffer.alloc(16);
          mehd.writeUInt32BE(16, 0);
          mehd.write('mehd', 4, 'latin1');
          mehd.writeUInt32BE(Math.round(ms * movieScale / 1000), 12);
          const at = c.off + c.size;
          const grown = Buffer.concat([buf.subarray(0, at), mehd, buf.subarray(at)]);
          grown.writeUInt32BE(top.size + 16, top.off);
          grown.writeUInt32BE(c.size + 16, c.off);
          return grown;
        }
      }
    }
  } catch {}
  return buf;
}

// resolve a track to a stream plan: legacy progressive url, or the aac hls
// ladder as an ordered part list with a byte-offset table for range serving.
// signed urls expire in ~20 minutes - plans cache for 10.
async function scStreamPlan(id, force = false) {
  const hit = scMedia.get(id);
  if (!force && hit && hit.expires > Date.now()) return hit.plan;
  const t = await scFetchJson('https://api-v2.soundcloud.com/tracks/' + id);
  const tcs = t.media?.transcodings || [];
  const prog = tcs.find((x) => x.format?.protocol === 'progressive' && /mp3/.test(x.format?.mime_type || ''))
    || tcs.find((x) => x.format?.protocol === 'progressive');
  let plan;
  if (prog) {
    const j = await scFetchJson(prog.url);
    if (!j || !j.url) throw new Error('no url');
    plan = { kind: 'url', url: j.url };
  } else {
    const tc = tcs.find((x) => x.format?.protocol === 'hls' && /mp4/.test(x.format?.mime_type || ''));
    if (!tc) throw new Error('no playable stream');
    const j = await scFetchJson(tc.url);
    if (!j || !j.url) throw new Error('no url');
    let pl = parseM3U8(await (await fetch(j.url, { headers: { 'user-agent': WEB_UA }, signal: AbortSignal.timeout(12000) })).text(), j.url);
    if (pl.variant) pl = parseM3U8(await (await fetch(pl.variant, { headers: { 'user-agent': WEB_UA }, signal: AbortSignal.timeout(12000) })).text(), pl.variant);
    let initBuf = null;
    if (pl.init) {
      const r = await fetch(pl.init, { headers: { 'user-agent': WEB_UA }, signal: AbortSignal.timeout(12000) });
      if (!r.ok) throw new Error('init ' + r.status);
      initBuf = patchInitDuration(Buffer.from(await r.arrayBuffer()), t.duration);
    }
    const parts = (initBuf ? [initBuf] : []).concat(pl.segs);
    // offset table: one parallel pass of size probes, then cumulative sums
    const sizes = new Array(parts.length);
    if (initBuf) sizes[0] = initBuf.length;
    let i = initBuf ? 1 : 0;
    await Promise.all(Array.from({ length: Math.min(6, parts.length) }, async () => {
      while (i < parts.length) { const k = i++; sizes[k] = await scSize(parts[k]); }
    }));
    const offs = new Array(parts.length);
    let acc = 0;
    for (let k = 0; k < parts.length; k++) { offs[k] = acc; acc += sizes[k]; }
    plan = { kind: 'hls', parts, sizes, offs, total: acc };
  }
  scMedia.set(id, { plan, expires: Date.now() + 10 * 60 * 1000 });
  if (scMedia.size > 300) scMedia.delete(scMedia.keys().next().value);
  return plan;
}

// serve [start,end] of the concatenated fmp4 (init + segments) as one
// audio/mp4 stream - chromium's demuxer reads the moof sequence fine, and
// the offset table makes seeks plain range requests again
async function pipeScHls(plan, start, end, req, res, track) {
  end = Math.min(end, plan.total - 1);
  if (start > end || start < 0) { res.writeHead(416, { 'content-range': 'bytes */' + plan.total }); res.end(); return { bytes: 0, status: 416 }; }
  let sent = 0, dead = false;
  // res close = the client went away (a GET req 'close' fires the moment the
  // empty request stream ends, far too early - that one hangs the stream)
  res.on('close', () => { if (!res.writableEnded) dead = true; });
  res.on('error', () => { dead = true; });
  for (let k = 0; k < plan.parts.length && !dead; k++) {
    const p0 = plan.offs[k], p1 = p0 + plan.sizes[k] - 1;
    if (p1 < start || p0 > end) continue;
    let buf;
    if (Buffer.isBuffer(plan.parts[k])) {
      buf = plan.parts[k];
    } else {
      const r = await fetch(plan.parts[k], { headers: { 'user-agent': WEB_UA }, signal: AbortSignal.timeout(15000) }).catch(() => null);
      // a 200 whose body dies mid-read (reset, truncation, timeout) rejects
      // the read, not the fetch - fold it into the same failure handling
      const body = r && r.ok ? await r.arrayBuffer().then((b2) => Buffer.from(b2)).catch(() => null) : null;
      // headers go out only after a part is proven good, so a first-part
      // failure (expired signature: 403/410) reaches the caller clean and
      // its re-resolve branch can actually run
      if (!body) {
        if (!sent && !res.headersSent) return { bytes: 0, status: r && !r.ok ? r.status : 502 };
        res.destroy(); // midstream: abort, never hang a half-sent body
        return { bytes: sent, status: 206 };
      }
      buf = body;
    }
    if (!res.headersSent) {
      res.writeHead(206, {
        'content-type': 'audio/mp4',
        'content-length': end - start + 1,
        'content-range': 'bytes ' + start + '-' + end + '/' + plan.total,
        'accept-ranges': 'bytes',
        'cache-control': 'private, no-store',
      });
    }
    const lo = Math.max(start - p0, 0), hi = Math.min(end - p0, plan.sizes[k] - 1);
    buf = buf.subarray(lo, hi + 1);
    if (!res.write(buf)) {
      // backpressure: settle on drain, but a closed/errored socket must not
      // park this request forever
      await new Promise((ok2) => {
        const fin = () => { res.off('drain', onDrain); res.off('close', fin); res.off('error', fin); ok2(); };
        const onDrain = () => { res.off('close', fin); res.off('error', fin); ok2(); };
        res.once('drain', onDrain);
        res.once('close', fin);
        res.once('error', fin);
      });
      if (dead) break;
    }
    sent += buf.length;
    track(buf.length);
  }
  if (!res.writableEnded && !res.destroyed) res.end();
  return { bytes: sent, status: res.headersSent ? 206 : 502 };
}

// ---------- audius ----------

const auGet = async (path) => {
  const r = await fetch(AU_HOST + path + (path.includes('?') ? '&' : '?') + 'app_name=' + AU_APP, {
    headers: { 'user-agent': WEB_UA, accept: 'application/json' },
    signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) throw new Error('audius ' + r.status);
  return r.json();
};
const auMap = (t) => {
  const artUrl = t.artwork?.['480x480'] || t.artwork?.['150x150'] || '';
  return {
    key: 'au:' + t.id, src: 'au', id: String(t.id),
    title: t.title || '', artist: t.user?.name || '', artistId: t.user?.id ? String(t.user.id) : '',
    dur: fmtDur(t.duration), durSec: Math.round(Number(t.duration) || 0),
    art: artUrl ? '/api/apps/amp/art?src=au&u=' + b64(artUrl) : '',
    stream: '/api/apps/amp/stream?src=au&id=' + encodeURIComponent(t.id),
  };
};

async function auSearchLive(q) {
  const j = await auGet('/v1/tracks/search?query=' + encodeURIComponent(q));
  if (!j || !Array.isArray(j.data)) throw new Error('au bad payload'); // see ymSearchLive
  return j.data.slice(0, 12).map(auMap);
}

// artist page: profile + their tracks, same row shape as search
async function auArtist(uid) {
  const [u, d] = await Promise.all([
    auGet('/v1/users/' + encodeURIComponent(uid)),
    auGet('/v1/users/' + encodeURIComponent(uid) + '/tracks'),
  ]);
  const tracks = (d.data || []).slice(0, 20).map(auMap);
  const pic = u.data?.profile_picture?.['480x480'] || u.data?.profile_picture?.['150x150'] || '';
  const sub = u.data?.follower_count ? Math.round(u.data.follower_count).toLocaleString('en-US') + ' followers' : '';
  return { name: u.data?.name || '', art: pic ? '/api/apps/amp/art?src=au&u=' + b64(pic) : '', sub, tracks };
}

// ---------- routes ----------

// pure row mapping exposed for the unit tests
export const ampInternals = { ymRow, scTrackOk, scMap, auMap, parseM3U8, patchInitDuration, pipeScHls, pipeMedia, ytBlock,
  // cache-wrapped artist lookups + their stores, exposed for the cache
  // tests (getters: the caches are declared further down)
  ymArtist: (...a) => ymArtist(...a), ymArtistById: (...a) => ymArtistById(...a),
  ymSearch: (...a) => ymSearch(...a), scSearch: (...a) => scSearch(...a), auSearch: (...a) => auSearch(...a),
  get artistTtl() { return artistTtl; }, get searchTtl() { return searchTtl; } };

// read-path caches, same 3-minute budget as jetstream search: a repeat
// query (paging, tab reopens, the artist card following a search row) must
// not re-pay three external round trips. values only - failures never cache.
const searchTtl = new TtlCache(3 * 60 * 1000, 100);
const artistTtl = new TtlCache(10 * 60 * 1000, 60);
const ymSearch = (q) => searchTtl.through('ym:' + q, () => ymSearchLive(q));
const scSearch = (q) => searchTtl.through('sc:' + q, () => scSearchLive(q));
const auSearch = (q) => searchTtl.through('au:' + q, () => auSearchLive(q));
const ymArtistById = (id) => artistTtl.through('ymid:' + id, () => ymArtistByIdLive(id));
const ymArtistResolved = (name) => artistTtl.through('ymr:' + name, () => ymArtistResolve(name));
const ymArtist = (name) => ymArtistLive(name); // two cached reads + a per-request clone

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

  if (sub === '/artist' && req.method === 'GET') {
    const src = url.searchParams.get('src') || '';
    try {
      let out = null;
      if (src === 'yt') {
        const name = (url.searchParams.get('name') || '').trim();
        const id = (url.searchParams.get('id') || '').trim();
        if (id && /^UC[A-Za-z0-9_-]{10,30}$/.test(id)) out = await ymArtistById(id).catch(() => null);
        if (!out && name && name.length <= 120) out = await ymArtist(name).catch((e) => { if (e && e.message === 'no artist page') return null; throw e; });
      } else if (src === 'sc') {
        const id = (url.searchParams.get('id') || '').trim();
        if (/^\d{3,12}$/.test(id)) out = await scArtist(id);
      } else if (src === 'au') {
        const id = (url.searchParams.get('id') || '').trim();
        if (/^[A-Za-z0-9]{4,20}$/.test(id)) out = await auArtist(id);
      }
      guard.trackBytes(session.user, 8192);
      if (!out || !out.name) return sendJson(res, 404, { ok: false, error: 'no artist page found' });
      if (!out.tracks.length) return sendJson(res, 404, { ok: false, error: 'nothing to play from them yet' });
      // cached values are frozen: adapt on a copy, never in place
      const body = { ...out };
      if (body.art && /^https:/.test(body.art)) body.art = '/api/apps/amp/art?src=ytu&u=' + b64(body.art);
      return sendJson(res, 200, { ok: true, src, ...body });
    } catch {
      return sendJson(res, 502, { ok: false, error: 'artist lookup broke - try again' });
    }
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
        let plan = await scStreamPlan(id);
        if (plan.kind === 'url') {
          let r = await pipeMedia(plan.url, req, res, { writeErrors: false });
          if (r.status === 403 || r.status === 410) {
            plan = await scStreamPlan(id, true);
            if (plan.kind === 'url') r = await pipeMedia(plan.url, req, res, { writeErrors: false });
          }
          if (!res.headersSent && r.bytes === 0) { res.writeHead(r.status); res.end(); }
          if (r.bytes) guard.trackBytes(session.user, r.bytes);
          return;
        }
        const rm = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
        const startByte = rm ? parseInt(rm[1], 10) : 0;
        const endByte = rm && rm[2] ? parseInt(rm[2], 10) : plan.total - 1;
        const track = (n) => guard.trackBytes(session.user, n);
        let r = await pipeScHls(plan, startByte, endByte, req, res, track);
        if ((r.status === 403 || r.status === 410) && !res.headersSent) {
          plan = await scStreamPlan(id, true);
          if (plan.kind === 'hls') r = await pipeScHls(plan, startByte, endByte, req, res, track);
        }
        if (!res.headersSent && r.bytes === 0) { res.writeHead(r.status); res.end(); }
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
    } else if (src === 'ytu') {
      // artist avatars live on YouTube's content hosts, not i.ytimg.com
      const u = unb64(url.searchParams.get('u'));
      try { const p = new URL(u); if (p.protocol === 'https:' && /(^|\.)(ggpht\.com|googleusercontent\.com)$/.test(p.hostname) && !p.username && !p.password) up = u; } catch {}
      if (!up) return sendJson(res, 400, { ok: false, error: 'bad url' });
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
      let r = await fetch(up, { headers: { 'user-agent': WEB_UA }, redirect: 'follow', signal: AbortSignal.timeout(12000) }).catch(() => null);
      if (!r || !r.ok) r = await fetch(up, { headers: { 'user-agent': WEB_UA }, redirect: 'follow', signal: AbortSignal.timeout(12000) }).catch(() => null);
      if (!r || !r.ok) {
        // 204 keeps the page quiet, but the log has to say why art is blank
        console.log('[amp art] upstream failed:', r ? r.status : 'no response', new URL(up).hostname);
        res.writeHead(204); return res.end();
      }
      const buf = Buffer.from(await r.arrayBuffer());
      guard.trackBytes(session.user, buf.length);
      res.writeHead(200, { 'content-type': r.headers.get('content-type') || 'image/jpeg', 'cache-control': 'public, max-age=86400' });
      return res.end(buf);
    } catch (e) {
      console.log('[amp art] upstream threw:', e && e.message, new URL(up).hostname);
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
