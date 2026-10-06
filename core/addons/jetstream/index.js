import os from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readJson, writeJson, readBody } from '../../util.js';
import { existsSync, statSync, mkdirSync, readdirSync, unlinkSync, createReadStream, utimesSync } from 'node:fs';
import { open as fsOpen, rename as fsRename } from 'node:fs/promises';

// watch history: per-account "keep watching" list. the client records a
// video once its stream actually resolves; most recent first, deduped,
// capped small - it is a shelf, not an archive.
const HIST_FILE = fileURLToPath(new URL('../../../data/jetstream-history.json', import.meta.url));
// storage cap is the algorithm's memory, not the shelf (Tue 4:39 PM): at 25,
// a short scroll session flushed every long-form signal. shelf display still
// filters through shelfHist - this cap only bounds how much taste persists.
const HIST_CAP = 200;
// keep watching is a shelf, not an archive (Luke, Tue 4:27 PM): entries age
// out, shorts never sit on it, and a video you finished leaves it. the full
// history still feeds recommendations - only the shelf filters.
const HIST_TTL = 3 * 24 * 3600 * 1000;
function shelfHist(user) {
  const now = Date.now();
  return userHist(user).filter((v) => {
    if (v.completed) return false;
    const secs = v.secs ?? parseSecs(v.duration);
    if (secs != null && secs <= 61) return false;
    if (v.at && now - v.at > HIST_TTL) return false;
    return true;
  });
}
function loadHist() { return readJson(HIST_FILE, {}); }
function userHist(user) {
  const h = loadHist();
  return Array.isArray(h[user]) ? h[user] : [];
}

// likes: per-account, newest first, capped. a like is the strongest signal
// the account gives - liked channels and title words weigh heavy in the
// one ranking system, and liked videos leave the feed (you've seen them).
const LIKES_FILE = fileURLToPath(new URL('../../../data/jetstream-likes.json', import.meta.url));
const LIKES_CAP = 100;
function loadLikes() { return readJson(LIKES_FILE, {}); }
function userLikes(user) {
  const l = loadLikes();
  return Array.isArray(l[user]) ? l[user] : [];
}

// not-interested: the negative twin of a like. disliked videos never come
// back, their channels sink hard, and their title words weigh against every
// candidate. per account, capped like the other lists.
const DIS_FILE = fileURLToPath(new URL('../../../data/jetstream-dislikes.json', import.meta.url));
const DIS_CAP = 100;
function loadDislikes() { return readJson(DIS_FILE, {}); }

// subscriptions (Luke 6:09 PM, channel pages): per-account channel subs.
// a sub is a standing "more from this channel" - it folds into the taste
// profile as channel weight, like a like that never leaves.
const SUBS_FILE = fileURLToPath(new URL('../../../data/jetstream-subs.json', import.meta.url));
const SUBS_CAP = 100;
function loadSubs() { return readJson(SUBS_FILE, {}); }
function userSubs(user) { return loadSubs()[user] || []; }

// dead pool (Luke 6:28 PM): a video that can't play - restricted, no
// formats - never surfaces again. global: if ytdlp can't resolve it from
// the box, no account can play it. feeds + channel pages filter it out.
const DEAD_FILE = fileURLToPath(new URL('../../../data/jetstream-dead.json', import.meta.url));
function loadDead() {
  const d = new Set(readJson(DEAD_FILE, { ids: [] }).ids || []);
  for (const id of Object.keys(blockedMem || {})) d.add(id); // age-gated ids found by the pre-check leave every feed too
  return d;
}
function markDead(id) {
  const d = readJson(DEAD_FILE, { ids: [] });
  if (d.ids.includes(id)) return;
  d.ids.unshift(id);
  d.ids = d.ids.slice(0, 500);
  writeJson(DEAD_FILE, d);
  recCache.clear(); // dead ids must leave every cached feed now
}
function userDislikes(user) {
  const d = loadDislikes();
  return Array.isArray(d[user]) ? d[user] : [];
}

// recommendations: ONE ranking system behind both home shelves. seeds come
// from what the account actually watches (channels first, then title
// keywords) mixed with broad seeds so it never tunnels; every candidate is
// scored against the same watch history. the shorts shelf takes the
// short-form slice (<= ~1 min), "for you" takes the rest - same engine.
const REC_CAP = 14;
const REC_TTL = 10 * 60 * 1000;
// user -> { at, ranked, served:Set, rerank:Promise|null, n }
// served = recently-served ids so each new batch is actually new shorts;
// n rotates the seed window so re-ranks explore different pools.
const recCache = new Map();
const GENERIC_SEEDS = ['trending now', 'viral clips'];
// platform-filler words are taste poison: "challenge", "tiktok", "viral"
// say nothing about what a video IS, but they swarm titles - and they were
// his top taste words (Luke 6:34 PM: "I watch videos of 1 topic and get
// random stuff"). filler never enters the profile.
const STOPWORDS = new Set('the and for with that this from your you are was were have has had not but all can will its his her she him they them their our out about into over after before between under again once here there when where why how what which who whom been being both each few more most other some such only own same than too very just challenge challenges tiktok viral viralvideo ytshorts shorts short video videos youtube reels fyp foryou trending compilation bigbank goon gyatt feat wait till end'.split(' '));

function parseViews(t) {
  const m = /([\d,.]+)\s*([KMB])?/i.exec(String(t || ''));
  if (!m) return 0;
  const n = parseFloat(m[1].replace(/,/g, ''));
  if (!isFinite(n)) return 0;
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[String(m[2] || '').toLowerCase()] || 1;
  return n * mult;
}

// "3 days ago", "2 weeks ago", "streamed 5 hours ago" -> age in days (null
// when unknown). freshness matters for shorts - week-old clips rank up.
function parseAgoDays(t) {
  const m = /(\d+)\s+(minute|hour|day|week|month|year)s?\s+ago/i.exec(String(t || ''));
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const per = { minute: 1 / 1440, hour: 1 / 24, day: 1, week: 7, month: 30, year: 365 }[m[2].toLowerCase()];
  return n * per;
}

function parseSecs(t) {
  const parts = String(t || '').trim().split(':');
  if (parts.length < 2 || parts.length > 3 || parts.some((x) => !/^\d+$/.test(x))) return null;
  return parts.reduce((a, x) => a * 60 + parseInt(x, 10), 0);
}


// watch-history settings, per account: pause + clear live on the ramjet
// settings page (all settings centralized there, not inside apps).
const SET_FILE = fileURLToPath(new URL('../../../data/jetstream-settings.json', import.meta.url));
function loadSettings() { return readJson(SET_FILE, {}); }
function histPaused(user) { return !!loadSettings()[user]?.paused; }

// taste profile (Luke, Tue 5:58 PM): learn the TYPE of video, not just the
// channel, and learn it from what he actually did. a 2-second skip used to
// teach the feed "more of this" - now it teaches the opposite. content words
// carry the signal, channel rides along as a hint. weights can go negative.
function histProfile(hist, likes = [], subs = []) {
  const chan = new Map(); const words = new Map();
  const add = (map, k, w) => map.set(k, (map.get(k) || 0) + w);
  const fold = (v, w) => {
    if (!w) return;
    const c = String(v.channel || '').trim();
    if (c) add(chan, c, w * 0.4); // channel: a minor signal, never the driver
    for (const word of String(v.title || '').toLowerCase().split(/[^a-z0-9]+/)) {
      if (word.length < 4 || STOPWORDS.has(word)) continue;
      add(words, word, w);
    }
  };
  hist.forEach((v, i) => {
    const rec = 1 / (1 + i / 6); // recency decay - what he watched last night > last month
    const dur = v.secs || parseSecs(v.duration) || 0;
    const ws = typeof v.ws === 'number' ? v.ws : null;
    if (ws != null && dur > 0) {
      const ratio = ws / dur;
      if (ws < 3 || (dur > 20 && ratio < 0.15)) return fold(v, -3 * rec); // quick skip: hard no
      if (ratio >= 0.7 || ws >= 25) return fold(v, 6 * rec);              // watched through: the loudest organic signal - one topic floods the next batch (Luke 6:34 PM)
      return fold(v, 0.5 * rec);                                          // sampled, mild yes
    }
    fold(v, rec); // legacy row without an outcome: count the view
  });
  likes.forEach((v, i) => fold(v, 6 / (1 + i / 8))); // a like shouts, but an old like fades
  for (const s of subs) fold({ channel: s.name, title: '' }, 10); // a sub never leaves
  return { chan, words };
}

function chanWordProfile(list) {
  const chan = new Map(); const words = new Map();
  for (const v of list) {
    const c = String(v.channel || '').trim();
    if (c) chan.set(c, (chan.get(c) || 0) + 1);
    for (const w of String(v.title || '').toLowerCase().split(/[^a-z0-9]+/)) {
      if (w.length < 4 || STOPWORDS.has(w)) continue;
      words.set(w, (words.get(w) || 0) + 1);
    }
  }
  return { chan, words };
}

function recSeeds(profile, n = 0) {
  // rotation (Luke, Tue 4:39 PM): the same top seeds every re-rank froze the
  // feed. take a wider window and rotate through it so each re-rank pulls a
  // different pool - the profile stays the compass, the heading changes.
  const chans = [...profile.chan.entries()].filter(([, w]) => w > 0.5).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([c]) => c);
  const kws = [...profile.words.entries()].filter(([, w]) => w > 0.5).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([w]) => w);
  const all = [];
  for (let i = 0; i < 5; i++) {
    if (chans[i]) all.push(chans[i]);
    if (kws.length === 1 && i === 0) all.push(kws[0]);
    else if (kws.length > 1 && i === 0) all.push(kws.join(' '));
    else if (kws[i]) all.push(kws[i]);
  }
  for (const g of GENERIC_SEEDS) all.push(g);
  if (all.length <= 4) return all;
  const seeds = [];
  for (let i = 0; i < 4; i++) seeds.push(all[(n + i) % all.length]);
  return seeds;
}

const BAIT = /tik ?tok|compilation|try not to|you won.?t believe|gone wrong|#shorts|\bfails?\b|top \d+ |\bpranks?\b|\breacts? to\b/i;
function scoreCandidate(v, profile, histIds, dis = null, taste = null) {
  if (histIds.has(v.id)) return -1;
  let s = 0;
  // the trained model: cosine against the taste centroid - it understands
  // topic neighborhoods, not just exact words. needs a little signal first.
  const ev = taste && taste.evec && embedMem && embedMem[v.id] ? embedMem[v.id].v : null;
  if (ev && taste.estrength > 2) {
    const c = cosArr(ev, taste.evec);
    s += Math.max(-100, Math.min(200, (c - 0.08) * 450)); // unrelated videos cluster near the 0.08 floor
  } else if (taste && taste.strength > 3) {
    const c = cosine(docVec({ title: v.title, tags: [], desc: v.desc || '' }), taste.vec);
    s += Math.max(-100, Math.min(180, c * 400));
  }
  // content overlap is the driver: sum the taste weight of every matching
  // word (weights can be negative - skipped topics push a video DOWN).
  let wsum = 0;
  for (const w of String(v.title).toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length >= 4 && profile.words.has(w)) wsum += profile.words.get(w);
  }
  s += Math.max(-80, Math.min(140, wsum * 12));
  // engagement-bait packaging (compilations, "try not to", reposted tiktoks)
  // sinks unless this account's own taste already points at those words.
  if (wsum <= 0 && BAIT.test(String(v.title))) s -= 45;
  const cw = profile.chan.get(v.channel) || 0; // channel: a nudge, not the driver
  s += Math.max(-20, Math.min(24, cw * 4));
  if (dis) {
    if (dis.chan.has(v.channel)) s -= 40 + dis.chan.get(v.channel) * 5;
    let dOverlap = 0;
    for (const w of String(v.title).toLowerCase().split(/[^a-z0-9]+/)) {
      if (w.length >= 4 && dis.words.has(w)) dOverlap++;
    }
    s -= Math.min(dOverlap, 5) * 6;
  }
  const vw = parseViews(v.views);
  if (vw > 0) s += Math.min(10, Math.log10(vw));
  const age = parseAgoDays(v.published);
  if (age != null) s += age <= 1 ? 8 : age <= 7 ? 5 : age <= 30 ? 2 : 0;
  return s + Math.random() * 6; // jitter so a refresh isn't the same frozen row
}

// one candidate pool per seed, plain + " shorts" phrasing (short-form titles
// carry the tag), merged and ranked once. both shelves slice this same list.
// search results cached briefly: rapid opens should not re-hit InnerTube.
const searchCache = new Map(); // query -> { at, data }
async function ytSearch(query) {
  const hit = searchCache.get(query);
  if (hit && Date.now() - hit.at < 3 * 60 * 1000) return hit.data;
  const data = await yt('search', { query });
  searchCache.set(query, { at: Date.now(), data });
  if (searchCache.size > 100) searchCache.delete(searchCache.keys().next().value);
  return data;
}

async function buildRanked(user, hit) {
  const hist = userHist(user);
  const likes = userLikes(user);
  const dislikes = userDislikes(user);
  const profile = histProfile(hist, likes, userSubs(user));
  const dis = chanWordProfile(dislikes);
  const taste = tasteCentroid(user);
  const seeds = recSeeds(profile, hit ? hit.n : 0);
  const histIds = new Set([...hist, ...likes, ...dislikes].map((v) => v.id));
  const deadIds = loadDead();
  const queries = [];
  for (const s of seeds) { queries.push(s); queries.push(s + ' shorts'); }
  const pools = await Promise.all(queries.map((q) => ytSearch(q).catch(() => null)));
  const seen = new Set(); const cands = []; const ranked = [];
  for (const data of pools) {
    if (!data) continue;
    for (const v of parseSearch(data)) {
      if (seen.has(v.id)) continue;
      if (deadIds.has(v.id)) continue; // restricted: never surface (Luke 6:28 PM)
      if (hit && hit.served.has(v.id)) continue; // a new batch is NEW shorts
      seen.add(v.id);
      cands.push(v);
    }
  }
  // semantic layer: embed the batch before scoring. this runs inside the
  // background re-rank, so a couple of seconds is invisible; on any worker
  // trouble TF-IDF carries the term.
  if (!embedBroken && cands.length) {
    await Promise.race([
      Promise.all(cands.slice(0, 60).map((c) => embedAsync(c.id, embedText({ t: c.title, desc: c.desc })).catch(() => null))),
      new Promise((d) => setTimeout(d, 12000)),
    ]);
  }
  for (const v of cands) {
    const score = scoreCandidate(v, profile, histIds, dis, taste);
    if (score < 0) continue;
    ranked.push({ id: v.id, title: v.title, channel: v.channel, channelId: v.channelId || '', duration: v.duration, views: v.views, desc: v.desc || '', secs: parseSecs(v.duration), score });
  }
  ranked.sort((a, b) => b.score - a.score);
  // channel diversity: nobody wants a whole feed from one channel. max 3
  // per channel, overflow re-appended after so small pools still fill.
  const perChan = new Map(); const head = []; const tail = [];
  for (const v of ranked) {
    const n = perChan.get(v.channel) || 0;
    perChan.set(v.channel, n + 1);
    (n < 3 ? head : tail).push(v);
  }
  return [...head, ...tail];
}

// stale-while-revalidate (Luke, Tue 4:39 PM): opens used to block on a full
// cold re-rank - that was the "forever to load". now a cached list answers
// instantly while a background re-rank builds the next batch behind it.
async function rankedRecs(user, fresh = false) {
  let hit = recCache.get(user);
  if (!hit) {
    hit = { at: 0, ranked: [], served: new Set(), rerank: null, n: 0 };
    recCache.set(user, hit);
    if (recCache.size > 200) recCache.delete(recCache.keys().next().value);
  }
  const stale = Date.now() - hit.at >= REC_TTL;
  if (!fresh && !stale && hit.ranked.length) return hit.ranked;
  if (hit.ranked.length) {
    if (!hit.rerank) {
      hit.n++;
      hit.rerank = buildRanked(user, hit)
        .then((r) => { if (r.length) { hit.ranked = r; hit.at = Date.now(); prefetchSlides(r.filter((v) => v.secs != null && v.secs <= 61).map((v) => v.id), '', true); } hit.rerank = null; })
        .catch(() => { hit.rerank = null; });
    }
    return hit.ranked;
  }
  hit.n++;
  const ranked = await buildRanked(user, hit);
  hit.ranked = ranked; hit.at = Date.now();
  return ranked;
}

const stripRec = ({ score, secs, ...rest }) => rest;

// jetstream: search YouTube (InnerTube, no API key), play through ramjet's own
// backend - the client never touches Google domains. Luke's call, 5:15 PM.
// HD (Mon late evening): adaptive video-only (up to 1080p avc1) + best m4a
// audio, both proxied byte-for-byte; the client plays them as a synced
// video+audio pair (no server transcode, cpu stays idle) - the exact pattern
// the old ramjet used, where 1080p worked. The server passes each browser
// range request through transparently and caps open-ended reads at 1MB, so
// googlevideo sees ordinary browser traffic and the browser natively retries
// the occasional 403. Server-side chunked fetching (16MB bursts) got the box
// IP rate-walled within seconds; this pattern does not.

const API = 'https://www.youtube.com/youtubei/v1';
const CLIENT = {
  context: {
    client: { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 34, hl: 'en', gl: 'US' },
  },
};
const UA = 'com.google.android.youtube/20.10.38 (Linux; U; Android 14)';
const GV_UA = 'ramjet-jetstream/1.2';

// resolved stream cache (googlevideo URLs expire; 10 min is safe)
const resolved = new Map(); // id -> { url, mime, quality, hd, expires }
// googlevideo size probe cache (url -> { size, ts })
const gvSize = new Map();

async function yt(endpoint, body) {
  const r = await fetch(`${API}/${endpoint}?prettyPrint=false`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': UA },
    body: JSON.stringify({ context: CLIENT.context, ...body }),
    signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) throw new Error(`yt ${endpoint} ${r.status}`);
  return r.json();
}

function parseSearch(data) {
  const out = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    const v = node.videoRenderer || node.compactVideoRenderer;
    if (v) {
      const text = (t) => (t?.runs ? t.runs.map((r) => r.text).join('') : t?.simpleText) || '';
      if (v.videoId && text(v.title) && text(v.lengthText)) { // no length = live or upcoming: not playable here
        const byline = v.ownerText || v.longBylineText || v.shortBylineText;
        let channelId = '';
        try { channelId = byline?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId || ''; } catch {}
        out.push({
          id: v.videoId,
          title: text(v.title),
          channel: text(byline),
          channelId,
          duration: text(v.lengthText),
          views: text(v.viewCountText),
          published: text(v.publishedTimeText),
          desc: text(v.descriptionSnippet),
        });
      }
      return;
    }
    for (const val of Object.values(node)) {
      if (Array.isArray(val)) val.forEach(walk);
      else if (val && typeof val === 'object') walk(val);
    }
  };
  walk(data);
  const seen = new Set();
  return out.filter((v) => (seen.has(v.id) ? false : (seen.add(v.id), true))).slice(0, 20);
}


const execFileP = promisify(execFile);
const YTDLP = process.env.YTDLP || new URL("../../../bin/yt-dlp", import.meta.url).pathname;
const inflight = new Map(); // id -> Promise<entry>; dedupes concurrent resolves

// Tue 7:30 AM: InnerTube ANDROID URLs are head-capped (audio 403s past ~2MB,
// video past ~10-16MB). yt-dlp applies the n-parameter transform, its URLs
// serve any offset. Resolve through the local yt-dlp binary instead.
async function resolveViaYtdlp(id) {
  const watch = `https://www.youtube.com/watch?v=${id}`;
  const OPTS = { maxBuffer: 32 * 1024 * 1024, timeout: 30000 };
  // the hls/dash manifests are never played (only direct https urls are), so
  // skipping them drops a whole upstream round trip per resolve with the same
  // usable formats (verified identical direct avc1/vp9/m4a set).
  const SKIP = ['--extractor-args', 'youtube:skip=hls,dash'];
  let stdout;
  try {
    stdout = await execFileP(YTDLP, ['--no-playlist', '--no-warnings', '--skip-download', ...SKIP, '-j', watch], OPTS).then((r) => r.stdout);
  } catch (e) {
    console.error("jetstream ytdlp fail", id, String(e.stderr || e.message).trim().split("\n").pop().slice(0, 160));
    throw new Error("can't load this video - try another");
  }
  let data;
  try { data = JSON.parse(stdout); } catch { throw new Error("can't load this video - try another"); }
  const fmts = data.formats || [];
  const direct = (f) => f.url && f.protocol === 'https'; // no m3u8/dash manifests - <video> can't play them
  // android client carries the muxed 360p stream (itag 18) the default client
  // lacks. it is a SECOND yt-dlp process, so it only runs when a play actually
  // needs the muxed fallback (no HD pair, /stream, muxed prefetch) - never on
  // the HD path that feeds and watch pages use. Two procs per resolve on a
  // shared 4-core box was the root of the slow cold loads.
  let muxP = null;
  const getMux = () => {
    if (!muxP) {
      muxP = execFileP(YTDLP, ['--no-playlist', '--no-warnings', '--skip-download', '--extractor-args', 'youtube:player_client=android', '-j', watch], OPTS)
        .then((r) => {
          const md = JSON.parse(r.stdout);
          const m = (md.formats || []).filter((f) => direct(f) && f.vcodec && f.vcodec !== 'none' && f.acodec && f.acodec !== 'none' && f.ext === 'mp4');
          m.sort((a, b) => Math.abs((a.height || 360) - 360) - Math.abs((b.height || 360) - 360)); // badge promises 360p - land on it
          return m;
        })
        .catch(() => []);
    }
    return muxP;
  };
  // measure by the short side: a vertical 720x1280 short IS 720p - the old
  // height<=1080 cap silently dropped every portrait video to 480p.
  const eff = (f) => { const w = f.width || 0, h = f.height || 0; return w && h ? Math.min(w, h) : (h || w); };
  const videos = fmts.filter((f) => direct(f) && (!f.acodec || f.acodec === 'none') && (f.vcodec || '').startsWith('avc1') && eff(f) > 360);
  videos.sort((a, b) => eff(b) - eff(a));
  // 60fps doubles the phone's decode cost. drop to 30fps ONLY at the same
  // resolution - never trade pixels for frames. cap = max short side.
  const pickCap = (list, cap) => {
    const w = list.filter((f) => eff(f) <= cap);
    const b = w[0] || list[list.length - 1];
    return b ? (w.find((f) => (f.fps || 30) <= 30 && eff(f) === eff(b)) || b) : null;
  };
  const video = pickCap(videos, 1080);
  const audios = fmts.filter((f) => direct(f) && (!f.vcodec || f.vcodec === 'none') && (f.ext === 'm4a' || (f.acodec || '').startsWith('mp4a')));
  audios.sort((a, b) => (b.abr || 0) - (a.abr || 0));
  const audio = audios[0];
  const vp9s = fmts.filter((f) => direct(f) && (!f.acodec || f.acodec === 'none') && /^(vp9|vp09)/.test(f.vcodec || '') && eff(f) > 360);
  vp9s.sort((a, b) => eff(b) - eff(a));
  const vpick = pickCap(vp9s, 1080);
  // low-data tier for phones: 720 short side (a 390pt phone shows a 720p short
  // pixel for pixel), same codec + 30fps preference. roughly half the bytes of 1080.
  const lvideo = pickCap(videos, 720), lvpick = pickCap(vp9s, 720);
  const hdOf = (v) => (v && audio ? { videoUrl: v.url, audioUrl: audio.url, quality: v.format_note || `${v.height}p` } : null);
  const hdOk = !!((video && audio) || (vpick && audio));
  let pick = null;
  if (!hdOk) {
    const muxed = await getMux();
    pick = muxed[0] || fmts.find((f) => direct(f) && f.vcodec && f.vcodec !== 'none');
    if (!pick) throw new Error('no playable stream for this one');
  }
  const entry = {
    url: pick ? pick.url : null, // null on the HD path until muxUrl() lazily fetches the 360p fallback
    getMux,
    mime: 'video/mp4',
    quality: pick ? (pick.format_note || `${pick.height || '?'}p`) : ((video || vpick).format_note || `${(video || vpick).height}p`),
    channel: String(data.channel || data.uploader || '').slice(0, 200),
    channelId: String(data.channel_id || data.uploader_id || '').slice(0, 64),
    hd: hdOf(video),
    hdVp9: hdOf(vpick),
    hdL: hdOf(lvideo),
    hdLVp9: hdOf(lvpick),
    duration: Number(data.duration) || 0,
    lite: {
      v: videos.map((f) => ({ h: eff(f), fps: f.fps || 30, url: f.url, size: f.filesize || f.filesize_approx || 0, tbr: f.tbr || 0 })).slice(0, 12),
      a: audios.map((f) => ({ abr: f.abr || 0, url: f.url, size: f.filesize || f.filesize_approx || 0 })).slice(0, 3),
    },
    expires: Date.now() + 10 * 60 * 1000,
  };
  // feed the taste model: this resolve already paid for the full metadata
  noteMeta(id, {
    t: String(data.title || '').slice(0, 300),
    ch: String(data.channel || data.uploader || '').slice(0, 200),
    desc: String(data.description || '').slice(0, 600),
    tags: (Array.isArray(data.tags) ? data.tags : []).slice(0, 30).map((t) => String(t).slice(0, 60)),
    cat: String((Array.isArray(data.categories) && data.categories[0]) || '').slice(0, 60),
  });
  resolved.set(id, entry);
  if (resolved.size > 200) resolved.delete(resolved.keys().next().value);
  return entry;
}

// the muxed 360p fallback url, fetched on demand (see resolveViaYtdlp)
async function muxUrl(s) {
  if (s.url) return s.url;
  const m = (await s.getMux())[0];
  if (m) { s.url = m.url; }
  return s.url || null;
}

async function resolveStream(id, force = false) {
  const hit = resolved.get(id);
  if (!force && hit && hit.expires > Date.now()) return hit;
  const prior = inflight.get(id);
  if (prior) return prior;
  const job = resolveViaYtdlp(id).finally(() => inflight.delete(id));
  inflight.set(id, job);
  return job;
}

// release an unused fetch response body
const dropBody = (r) => { try { r.body?.cancel()?.catch(() => {}); } catch {} };

// byte proxy for googlevideo. one upstream fetch per browser request, statuses
// passed through truthfully (a hidden 403 strands the player; a visible one
// gets retried natively). googlevideo throttles long reads to a stall, but
// every fresh range request gets a full-speed burst - so open-ended reads
// (bytes=N-, how browsers stream media) are capped to one 1MB chunk with a
// truthful content-range, and the browser comes back for the rest itself.
async function gvProxy(u, req, res, track, refresh, capBytes) {
  const rm = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
  const CAP = capBytes || (1 << 20);
  const start = rm ? parseInt(rm[1], 10) : 0;
  const headers = { 'user-agent': GV_UA };
  if (rm) headers.range = 'bytes=' + start + '-' + (rm[2] ? rm[2] : start + CAP - 1);
  if (rm && !rm[2]) {
    // probe one byte to learn the real size, then cap the chunk in-bounds
    let size = 0;
    const hit = gvSize.get(u);
    if (hit && Date.now() - hit.ts < 1800000) size = hit.size;
    else {
      let pr;
      try {
        pr = await fetch(u, { headers: { 'user-agent': GV_UA, range: `bytes=${start}-${start}` }, redirect: 'follow', signal: AbortSignal.timeout(30000) });
      } catch { res.writeHead(502); return res.end(); }
      if (pr.status === 416) { dropBody(pr); res.writeHead(416); return res.end(); }
      if (pr.status === 403 || pr.status === 410) {
        dropBody(pr);
        await new Promise((d) => setTimeout(d, 400));
        try {
          pr = await fetch(u, { headers: { 'user-agent': GV_UA, range: `bytes=${start}-${start}` }, redirect: 'follow', signal: AbortSignal.timeout(30000) });
        } catch { res.writeHead(502); return res.end(); }
      }
      if (pr.status !== 206 && pr.status !== 200) {
        dropBody(pr);
        if (refresh && (pr.status === 403 || pr.status === 410)) {
          const nu = await refresh().catch(() => null);
          if (nu && nu !== u) return gvProxy(nu, req, res, track, null, capBytes);
        }
        res.writeHead(pr.status || 502); return res.end();
      }
      const crm = /\/(\d+)\s*$/.exec(pr.headers.get('content-range') || '');
      dropBody(pr);
      if (crm) {
        size = parseInt(crm[1], 10);
        if (Number.isSafeInteger(size) && size > 0) {
          if (gvSize.size >= 512) gvSize.delete(gvSize.keys().next().value);
          gvSize.set(u, { size, ts: Date.now() });
        }
      }
    }
    if (size && start >= size) { res.writeHead(416, { 'content-range': 'bytes */' + size }); return res.end(); }
    if (size) headers.range = 'bytes=' + start + '-' + Math.min(start + CAP - 1, size - 1);
    else headers.range = 'bytes=' + start + '-';
  }
  let r = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      r = await fetch(u, { headers, redirect: 'follow', signal: AbortSignal.timeout(30000) });
    } catch { res.writeHead(502); return res.end(); }
    if (r.status === 200 || r.status === 206) break;
    const st = r.status;
    dropBody(r);
    if ((st === 403 || st === 410) && attempt < 4) {
      await new Promise((d) => setTimeout(d, 300 * (attempt + 1)));
      if (attempt === 2 && refresh) {
        const nu = await refresh().catch(() => null);
        if (nu && nu !== u) u = nu;
      }
      continue;
    }
    res.writeHead(st); return res.end();
  }
  res.once('close', () => { dropBody(r); });
  const h = { 'content-type': r.headers.get('content-type') || 'video/mp4', 'cache-control': 'private, no-store' };
  for (const k of ['content-length', 'content-range', 'accept-ranges']) {
    const v = r.headers.get(k);
    if (v) h[k] = v;
  }
  res.writeHead(r.status, h);
  if (!r.body) return res.end();
  let bytes = 0;
  for await (const chunk of r.body) {
    bytes += chunk.length;
    if (!res.write(chunk)) await new Promise((d) => res.once('drain', d));
  }
  track(bytes);
  return res.end();
}

// ── warm stream cache (Luke 6:38-6:39 PM: "SO SLOW", "instant scrolling like
// real YouTube") ──
// his network filters googlevideo, so every byte he plays flows through this
// box live. live proxying means every swipe pays an upstream handshake. the
// fix: the moment a feed batch is ranked, the box pulls the next slides'
// streams to its own disk in the background; his phone then downloads from
// the box at full local speed. swipes stop paying the upstream tax.
const CACHE_DIR = fileURLToPath(new URL('../../../data/stream-cache', import.meta.url));
try { mkdirSync(CACHE_DIR, { recursive: true }); } catch {}

// thumb cache: posters used to ride i.ytimg upstream on EVERY cold request
// (the buffering background, the watch poster, every feed grid image). on
// Luke's filtered home network the box is the fast path, so every fetched
// poster lands on disk and repeats serve in milliseconds. lru by mtime,
// capped by bytes - plain multiplication, bitshifts overflow past 2^31.
const THUMB_DIR = fileURLToPath(new URL('../../../data/thumb-cache', import.meta.url));
try { mkdirSync(THUMB_DIR, { recursive: true }); } catch {}
const THUMB_CAP = 128 * 1024 * 1024;
const thumbPath = (id, lite) => THUMB_DIR + '/' + id + (lite ? '.l' : '') + '.jpg';
const thumbInflight = new Map(); // id -> Promise<buf|null>, dedupes parallel cold misses
let thumbEvictTimer = null;
function evictThumbs() {
  if (thumbEvictTimer) return; // debounced; writes are tiny and rare
  thumbEvictTimer = setTimeout(() => {
    thumbEvictTimer = null;
    try {
      let total = 0;
      const files = readdirSync(THUMB_DIR)
        .filter((f) => f.endsWith('.jpg'))
        .map((f) => { const st = statSync(THUMB_DIR + '/' + f); return { f, size: st.size, mtime: st.mtimeMs }; })
        .sort((a, b) => a.mtime - b.mtime);
      for (const x of files) total += x.size;
      for (const x of files) {
        if (total <= THUMB_CAP) break;
        try { unlinkSync(THUMB_DIR + '/' + x.f); total -= x.size; } catch {}
      }
    } catch {}
  }, 5000);
  thumbEvictTimer.unref?.();
}
// best poster available: maxres (1280) -> sd (640) -> hq (480) -> mq (320).
// a 320x180 thumb stretched over a phone screen reads as "the app is
// blurry" even when the stream behind it is true 1080p.
async function fetchThumbBuffer(id, lite) {
  for (const name of (lite ? ['hqdefault', 'mqdefault'] : ['maxresdefault', 'sddefault', 'hqdefault', 'mqdefault'])) {
    try {
      const r = await fetch(`https://i.ytimg.com/vi/${id}/${name}.jpg`, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) continue;
      const buf = Buffer.from(await r.arrayBuffer());
      if (name !== 'mqdefault' && buf.length < 6000) continue; // placeholder fake, keep walking down
      return buf;
    } catch { /* keep walking down */ }
  }
  return null;
}
function getThumb(id, lite) {
  const ik = lite ? id + ':l' : id;
  if (thumbInflight.has(ik)) return thumbInflight.get(ik);
  const p = (async () => {
    try {
      const buf = await fetchThumbBuffer(id, lite);
      if (buf) {
        try {
          const tmp = thumbPath(id, lite) + '.part';
          const fh = await fsOpen(tmp, 'w');
          await fh.writeFile(buf);
          await fh.close();
          await fsRename(tmp, thumbPath(id, lite));
          evictThumbs();
        } catch {}
      }
      return buf;
    } finally {
      thumbInflight.delete(ik);
    }
  })();
  thumbInflight.set(ik, p);
  return p;
}
// fire-and-forget warmer: feed builds and scroll-ahead pings warm posters
// before the client asks, so first paint is already on disk.
function warmThumbs(ids) {
  for (const id of ids) {
    const s = String(id || '');
    if (!/^[A-Za-z0-9_-]{11}$/.test(s)) continue;
    if (existsSync(thumbPath(s))) continue;
    getThumb(s).catch(() => {});
  }
}
const CACHE_CAP = 3072 * 1024 * 1024; // 3GB of shorts, evicted oldest-first (26G free on the box). NO << here: 3072<<20 overflows int32 into a negative cap, which made evictCache wipe EVERYTHING (found 8:52 PM - cache at 0 files while Luke scrolled)
const CACHE_MAXFILE = 40 << 20; // a short is seconds long - huge files aren't shorts
const cachePath = (id, kind) => CACHE_DIR + '/' + id + '.' + kind;

// serve a cached stream from disk: full ranges at local speed, no upstream.
function serveCached(path, req, res, track, ctype = 'video/mp4') {
  let st;
  try { st = statSync(path); } catch { res.writeHead(404); return res.end(); }
  const size = st.size;
  const rm = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
  let start = 0; let end = size - 1; let status = 200;
  if (rm) {
    start = parseInt(rm[1], 10);
    end = rm[2] ? Math.min(parseInt(rm[2], 10), size - 1) : size - 1;
    if (!Number.isFinite(start) || start >= size || start > end) {
      res.writeHead(416, { 'content-range': 'bytes */' + size });
      return res.end();
    }
    status = 206;
  }
  const h = {
    'content-type': ctype,
    'accept-ranges': 'bytes',
    'cache-control': 'private, no-store',
    'content-length': end - start + 1,
  };
  if (status === 206) h['content-range'] = 'bytes ' + start + '-' + end + '/' + size;
  res.writeHead(status, h);
  let bytes = 0;
  const stream = createReadStream(path, { start, end });
  stream.on('data', (c) => { bytes += c.length; });
  stream.on('error', () => { try { res.end(); } catch {} });
  stream.on('close', () => track(bytes));
  stream.pipe(res);
}

// googlevideo throttles long open reads to a stall but hands every fresh
// range a full-speed burst - so downloads run as 4MB hops, same trick the
// proxy uses for the browser.
async function downloadToCache(url, dest) {
  if (existsSync(dest)) return;
  const pr = await fetch(url, { headers: { 'user-agent': GV_UA, range: 'bytes=0-0' }, redirect: 'follow', signal: AbortSignal.timeout(30000) });
  const crm = /\/(\d+)\s*$/.exec(pr.headers.get('content-range') || '');
  dropBody(pr);
  if (pr.status !== 206 && pr.status !== 200) throw new Error('probe ' + pr.status);
  const size = crm ? parseInt(crm[1], 10) : 0;
  if (!size || !Number.isSafeInteger(size)) throw new Error('no size');
  if (size > CACHE_MAXFILE) throw new Error('too big');
  const CHUNK = 4 << 20;
  const part = dest + '.part';
  const fh = await fsOpen(part, 'w');
  try {
    let off = 0;
    while (off < size) {
      const last = Math.min(off + CHUNK, size) - 1;
      let ok = false;
      for (let a = 0; a < 3 && !ok; a++) {
        try {
          const r = await fetch(url, { headers: { 'user-agent': GV_UA, range: 'bytes=' + off + '-' + last }, redirect: 'follow', signal: AbortSignal.timeout(45000) });
          if (r.status !== 206 && r.status !== 200) { dropBody(r); await new Promise((d) => setTimeout(d, 400 * (a + 1))); continue; }
          const buf = Buffer.from(await r.arrayBuffer());
          await fh.write(buf, 0, buf.length, off);
          off += buf.length;
          ok = true;
        } catch { await new Promise((d) => setTimeout(d, 400 * (a + 1))); }
      }
      if (!ok) throw new Error('chunk failed');
    }
  } finally { await fh.close().catch(() => {}); }
  await fsRename(part, dest);
  evictCache();
}

function evictCache() {
  try {
    const files = readdirSync(CACHE_DIR)
      .filter((f) => !f.endsWith('.part'))
      .map((f) => { const st = statSync(CACHE_DIR + '/' + f); return { f, size: st.size, mtime: st.mtimeMs }; })
      .sort((a, b) => a.mtime - b.mtime);
    let total = files.reduce((n, x) => n + x.size, 0);
    for (const x of files) {
      if (total <= CACHE_CAP) break;
      try { unlinkSync(CACHE_DIR + '/' + x.f); total -= x.size; } catch {}
    }
    for (const f of readdirSync(CACHE_DIR).filter((x) => x.endsWith('.part'))) {
      try { if (Date.now() - statSync(CACHE_DIR + '/' + f).mtimeMs > 10 * 60 * 1000) unlinkSync(CACHE_DIR + '/' + f); } catch {}
    }
  } catch {}
}

// background prefetch: ranked batch in, next slides' streams land on disk.
// two downloads at a time, ids deduped, resolving warms the url cache too.
const prefetchQ = [];
const prefetching = new Set();
let prefetchActive = 0;
function prefetchSlides(ids, ua, forceSafari, priority, lite) {
  lite = lite === true || /iPhone|Android.*Mobile/.test(ua || '');
  const safari = forceSafari === true ? true : /iPhone|iPad|Macintosh.*Version\//.test(ua || '');
  // priority = the client's live scroll position: these jump the queue ahead
  // of feed-load backlog, because a slide he's about to reach cold is a stall.
  const jobs = [];
  for (const id of ids.slice(0, lite ? (priority ? 3 : 4) : (priority ? 6 : 8))) {
    if (prefetching.has(id)) continue;
    if (lite ? (existsSync(cachePath(id, 'lvideo')) || existsSync(cachePath(id, 'lvp9video'))) : (existsSync(cachePath(id, 'video')) || existsSync(cachePath(id, 'vp9video')))) continue;
    if (existsSync(cachePath(id, 'muxed'))) continue;
    prefetching.add(id);
    jobs.push({ id, safari, lite });
  }
  if (priority) prefetchQ.unshift(...jobs); else prefetchQ.push(...jobs);
  pumpPrefetch();
}
function pumpPrefetch() {
  while (prefetchActive < 3 && prefetchQ.length) {
    const job = prefetchQ.shift();
    prefetchActive++;
    prefetchOne(job.id, job.safari, job.lite)
      .catch(() => {})
      .finally(() => { prefetching.delete(job.id); prefetchActive--; pumpPrefetch(); });
  }
}
async function prefetchOne(id, safari, lite) {
  const s = await resolveStream(id);
  if (lite && (s.hdL || s.hdLVp9)) {
    const pick = safari ? (s.hdL || s.hdLVp9) : (s.hdLVp9 || s.hdL);
    const k = pick === s.hdLVp9 ? 'lvp9video' : 'lvideo';
    await downloadToCache(pick.videoUrl, cachePath(id, k));
    await downloadToCache(pick.audioUrl, cachePath(id, 'audio'));
    return;
  }
  if (safari && s.hd) {
    await downloadToCache(s.hd.videoUrl, cachePath(id, 'video'));
    await downloadToCache(s.hd.audioUrl, cachePath(id, 'audio'));
  } else if (s.hdVp9) {
    await downloadToCache(s.hdVp9.videoUrl, cachePath(id, 'vp9video'));
    await downloadToCache(s.hdVp9.audioUrl, cachePath(id, 'audio'));
  } else if (s.hd) {
    await downloadToCache(s.hd.videoUrl, cachePath(id, 'video'));
    await downloadToCache(s.hd.audioUrl, cachePath(id, 'audio'));
  } else {
    await downloadToCache(await muxUrl(s), cachePath(id, 'muxed'));
  }
}

// resolve-only warmer for home (long) items: one slot, skipped when the box is
// busy or memory is low, so a click on a home card finds its stream url ready.
const warmQ = []; let warmBusy = false;
function warmResolve(ids) {
  for (const id of ids.slice(0, 4)) { if (!resolved.has(id) && !warmQ.includes(id)) warmQ.push(id); }
  pumpWarm();
}
async function pumpWarm() {
  if (warmBusy) return; warmBusy = true;
  try {
    while (warmQ.length) {
      const id = warmQ.shift();
      if (os.loadavg()[0] > 4.5 || os.freemem() < 2500 * 1024 * 1024) continue;
      await resolveStream(id).catch(() => {});
      await new Promise((r) => setTimeout(r, 1500));
    }
  } finally { warmBusy = false; }
}

// channel pages (Luke 6:09 PM): one page per channel - their videos, their
// shorts, subscribe. listings are yt-dlp flat playlists of the channel tabs,
// cached 30 min: they change slowly and a cold resolve takes seconds.
const chanCache = new Map(); // `id:tab` -> { at, name, items }

// ---- video summary helpers ----
const SUM_FILE = fileURLToPath(new URL('../../../data/jetstream-summaries.json', import.meta.url));
const AI_CONF = fileURLToPath(new URL('../../../data/sage-provider.json', import.meta.url));
const sumLimit = new Map();
function aiProvider() {
  try {
    const c = readJson(AI_CONF, null);
    if (c && c.base && c.key) return { url: String(c.base).replace(/\/+$/, '') + '/chat/completions', model: c.model || 'openai/gpt-oss-120b', key: c.key };
  } catch {}
  return { url: 'https://text.pollinations.ai/', model: 'openai', key: '' };
}
async function aiAsk(system, user) {
  const p = aiProvider();
  const payload = p.key
    ? { model: p.model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: 900, temperature: 0.3 }
    : { model: p.model, private: true, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
  for (let i = 0; i < 2; i++) {
    const r = await fetch(p.url, { method: 'POST', headers: { 'content-type': 'application/json', ...(p.key ? { authorization: 'Bearer ' + p.key } : {}) }, body: JSON.stringify(payload), signal: AbortSignal.timeout(60000) });
    if (r.status === 402 || r.status === 429) { const e = new Error('quota'); e.code = 'quota'; throw e; }
    if (!r.ok) { if (i === 0) { await new Promise((d) => setTimeout(d, 1200)); continue; } throw new Error('model ' + r.status); }
    const raw = (await r.text()).trim();
    if (p.key) { try { return JSON.parse(raw).choices?.[0]?.message?.content?.trim() || ''; } catch { return ''; } }
    return raw;
  }
  return '';
}
const mmss = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
async function captionLines(id) {
  const dir = os.tmpdir() + '/js-cap-' + id + '-' + Date.now();
  mkdirSync(dir, { recursive: true });
  try {
    await execFileP(YTDLP, ['--skip-download', '--write-auto-subs', '--write-subs', '--sub-langs', 'en,en-orig', '--sub-format', 'json3', '-o', dir + '/%(id)s', 'https://www.youtube.com/watch?v=' + id], { timeout: 45000, maxBuffer: 8 * 1024 * 1024 }).catch(() => {});
    const files = readdirSync(dir).filter((f) => f.endsWith('.json3'));
    const pick = files.find((f) => /\.en\.json3$/.test(f)) || files.find((f) => /en-orig/.test(f)) || files[0];
    if (!pick) return null;
    const data = readJson(dir + '/' + pick, null);
    const events = (data?.events || []).filter((e) => e.segs);
    if (!events.length) return null;
    const buckets = new Map();
    for (const e of events) {
      const t = Math.floor((e.tStartMs || 0) / 1000 / 20) * 20;
      const txt = e.segs.map((g) => g.utf8 || '').join('').replace(/\s+/g, ' ').trim();
      if (txt) buckets.set(t, (buckets.get(t) ? buckets.get(t) + ' ' : '') + txt);
    }
    return [...buckets.entries()].map(([t, x]) => ({ t, x }));
  } finally {
    try { for (const f of readdirSync(dir)) unlinkSync(dir + '/' + f); (await import('node:fs')).rmdirSync(dir); } catch {}
  }
}
async function summarize(id) {
  const lines = await captionLines(id);
  if (!lines || lines.length < 3) return null;
  let use = lines;
  const total = lines.reduce((n, l) => n + l.x.length + 8, 0);
  if (total > 14000) { const keep = Math.floor(lines.length * 14000 / total); const step = lines.length / keep; use = Array.from({ length: keep }, (_, i) => lines[Math.floor(i * step)]); }
  const transcript = use.map((l) => `[${mmss(l.t)}] ${l.x}`).join('\n');
  const sys = 'You summarize YouTube videos from their captions. Reply with ONLY a JSON object: {"tldr": one plain sentence, "points": 3 to 6 short plain bullet strings, "moments": up to 6 objects {"t": "m:ss" taken from the transcript timestamps, "label": under 8 words}}. No markdown, no extra text. Do not invent anything that is not in the transcript.';
  const raw = await aiAsk(sys, transcript);
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('model gave no json');
  const j = JSON.parse(m[0]);
  const toSecs = (x) => { const q = String(x || '').split(':').map(Number); return q.length === 2 && q.every((n) => Number.isFinite(n)) ? q[0] * 60 + q[1] : q.length === 3 ? q[0] * 3600 + q[1] * 60 + q[2] : null; };
  const maxT = lines[lines.length - 1].t + 20;
  return {
    tldr: String(j.tldr || '').slice(0, 400),
    points: (Array.isArray(j.points) ? j.points : []).map((x) => String(x).slice(0, 240)).slice(0, 6),
    moments: (Array.isArray(j.moments) ? j.moments : []).map((o) => ({ t: toSecs(o.t), label: String(o.label || '').slice(0, 80) })).filter((o) => o.t != null && o.t <= maxT && o.label).slice(0, 6),
  };
}

async function channelTab(id, tab) {
  const key = `${id}:${tab}`;
  const hit = chanCache.get(key);
  if (hit && Date.now() - hit.at < 30 * 60 * 1000) return hit;
  // videos: the channel's uploads playlist (every UC id maps to a UU
  // playlist) - the plain-playlist extractor is far steadier from a busy
  // server IP than the /videos tab, which flakes to null under load. shorts:
  // the channel /shorts tab. each upload lives in exactly one section.
  const url = tab === 'shorts'
    ? `https://www.youtube.com/channel/${id}/shorts`
    : `https://www.youtube.com/playlist?list=UU${id.slice(2)}`;
  const { stdout } = await execFileP(YTDLP, ['--flat-playlist', '--dump-single-json', url], { maxBuffer: 32 * 1024 * 1024, timeout: 60000 });
  const data = JSON.parse(stdout);
  if (!data) throw new Error('channel lookup came back empty');
  const fmtDur = (s) => (typeof s === 'number' && s > 0 ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}` : '');
  const fmtViews = (n) => (typeof n === 'number' && n > 0 ? `${n.toLocaleString('en-US')} views` : '');
  let items = (data.entries || []).filter((e) => e && e.id && e.title).map((e) => ({
    id: e.id,
    title: String(e.title || '').slice(0, 300),
    channel: String(e.channel || data.channel || data.uploader || '').slice(0, 200),
    channelId: id,
    duration: fmtDur(e.duration),
    views: fmtViews(e.view_count),
    secs: typeof e.duration === 'number' ? e.duration : null,
  }));
  if (tab === 'videos') {
    const shortsIds = await channelTab(id, 'shorts').then((t) => new Set(t.items.map((v) => v.id))).catch(() => new Set());
    items = items.filter((v) => !shortsIds.has(v.id) && (v.secs == null || v.secs > 61));
  } else {
    items = items.filter((v) => v.secs == null || v.secs <= 61);
  }
  const deadIds = loadDead();
  items = items.filter((v) => !deadIds.has(v.id)).slice(0, 60);
  const name = String(data.channel || data.uploader || data.title || '').replace(/^Uploads from /, '').slice(0, 200);
  const out = { at: Date.now(), name, items };
  chanCache.set(key, out);
  if (chanCache.size > 60) chanCache.delete(chanCache.keys().next().value);
  return out;
}

// ── neural embeddings (MiniLM-L6-v2) ──
// every video with metadata gets a 384-d semantic vector from a child
// worker (models/embed-worker.mjs, onnxruntime, quantized model on disk).
// the taste centroid and every candidate score use embedding cosine when
// both sides have vectors; TF-IDF cosine is the fallback. semantic = it
// knows an obstacle course video and a ninja warrior video are neighbors
// even with zero shared words.
const EMB_FILE = fileURLToPath(new URL('../../../data/jetstream-embed.json', import.meta.url));
const EMB_WORKER = fileURLToPath(new URL('../../../models/embed-worker.mjs', import.meta.url));
const EMB_CAP = 2000;
let embedMem = null;
let embedTimer = null;
let embedWorker = null;
let embedBroken = false;
let embedSeq = 0;
const embedPending = new Map();
const embedQueue = [];
const embedInflight = new Set();

function loadEmbed() {
  if (!embedMem) {
    embedMem = readJson(EMB_FILE, {});
    for (const k of Object.keys(embedMem)) { if (!embedMem[k] || !Array.isArray(embedMem[k].v)) delete embedMem[k]; }
  }
  return embedMem;
}
function saveEmbedSoon() {
  if (embedTimer) return;
  embedTimer = setTimeout(() => {
    embedTimer = null;
    try {
      const keys = Object.keys(embedMem);
      if (keys.length > EMB_CAP) {
        const sorted = keys.sort((a, b) => (embedMem[a].at || 0) - (embedMem[b].at || 0));
        for (const k of sorted.slice(0, keys.length - EMB_CAP)) delete embedMem[k];
      }
      writeJson(EMB_FILE, embedMem);
    } catch {}
  }, 8000);
}
function embedText(m) {
  return [m.t || m.title || '', (m.tags || []).join(' '), String(m.desc || '').slice(0, 220)].join(' ').replace(/\s+/g, ' ').slice(0, 500);
}
function killEmbedder() {
  embedWorker = null;
  embedBroken = true; // one life - TF-IDF carries the term from here
  for (const p of embedPending.values()) { clearTimeout(p.timer); p.resolve(null, p.id); }
  embedPending.clear();
  while (embedQueue.length) { const j = embedQueue.shift(); embedInflight.delete(j.id); j.resolve(null); }
}
function spawnEmbedder() {
  if (embedWorker || embedBroken) return embedWorker;
  try {
    embedWorker = spawn('node', [EMB_WORKER], { stdio: ['pipe', 'pipe', 'ignore'] });
    let buf = '';
    embedWorker.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let row = null;
        try { row = JSON.parse(line); } catch {}
        if (!row) continue;
        const p = embedPending.get(row.id);
        if (p) { embedPending.delete(row.id); clearTimeout(p.timer); p.resolve(Array.isArray(row.v) ? row.v : null, p.id); }
      }
    });
    embedWorker.on('error', () => killEmbedder());
    embedWorker.on('exit', () => killEmbedder());
  } catch { killEmbedder(); }
  return embedWorker;
}
function pumpEmbed() {
  if (embedBroken) return;
  if (!spawnEmbedder()) return;
  while (embedQueue.length && embedPending.size < 8) {
    const job = embedQueue.shift();
    const seq = ++embedSeq;
    const timer = setTimeout(() => {
      const p = embedPending.get(seq);
      if (p) { embedPending.delete(seq); p.resolve(null, p.id); }
    }, 15000);
    embedPending.set(seq, {
      id: job.id,
      timer,
      resolve: (v, id) => {
        embedInflight.delete(id);
        if (v && v.length === 384) {
          const mem = loadEmbed();
          mem[id] = { v, at: Date.now() };
          saveEmbedSoon();
        }
        job.resolve(v && v.length === 384 ? v : null);
        pumpEmbed();
      },
    });
    try { embedWorker.stdin.write(JSON.stringify({ id: seq, text: job.text }) + '\n'); }
    catch { killEmbedder(); break; }
  }
}
function embedAsync(id, text) {
  if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return Promise.resolve(null);
  const mem = loadEmbed();
  if (mem[id]) return Promise.resolve(mem[id].v);
  if (embedBroken) return Promise.resolve(null);
  return new Promise((resolve) => {
    embedInflight.add(id);
    embedQueue.push({ id, text: String(text || '').slice(0, 500), resolve });
    pumpEmbed();
  });
}
function requestEmbed(id, text) { if (!embedInflight.has(id)) embedAsync(id, text).catch(() => {}); }
function cosArr(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; } // both sides normalized

// ── the taste model (Luke 6:35 PM: "train a small little model off your
// watches") ──
// every resolved video's full metadata (title, tags, description, category)
// lands in a persistent store - yt-dlp already paid for it. each video
// becomes a TF-IDF document over title x3 + tags x2 + description x1. each
// account's watch outcomes train a taste CENTROID: full-watch pulls in,
// quick-skip pushes out, likes pull hard, all recency-decayed. candidates
// rank by cosine similarity to that centroid - so "ninja warrior" matches a
// watched "obstacle course" through shared tag/description vocabulary even
// when the titles share no words. that is the "it understands" feel.
const META_FILE = fileURLToPath(new URL('../../../data/jetstream-meta.json', import.meta.url));
const META_CAP = 3000;
let metaMem = null;
let metaVer = 0;
let metaTimer = null;

function noteMeta(id, fields) {
  if (!metaMem) metaMem = loadMeta();
  metaMem[id] = { ...fields, at: Date.now() };
  metaVer++;
  requestEmbed(id, embedText(metaMem[id]));
  const keys = Object.keys(metaMem);
  if (keys.length > META_CAP) {
    let oldest = null, ots = Infinity;
    for (const k of keys) { if ((metaMem[k].at || 0) < ots) { ots = metaMem[k].at || 0; oldest = k; } }
    if (oldest) delete metaMem[oldest];
  }
  if (metaTimer) clearTimeout(metaTimer);
  metaTimer = setTimeout(() => { try { writeJson(META_FILE, metaMem); } catch {} }, 5000);
}
function loadMeta() { return readJson(META_FILE, {}); }

const tok = (text) => {
  const out = [];
  for (const w of String(text || '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length >= 3 && !STOPWORDS.has(w)) out.push(w);
  }
  return out;
};

function docTerms({ title, tags, desc, cat }) {
  const tf = new Map();
  const add = (words, w) => { for (const t of words) tf.set(t, (tf.get(t) || 0) + w); };
  add(tok(title), 3);
  add((tags || []).flatMap((t) => tok(t)), 2);
  add(tok(cat || ''), 2); // the category is what it IS (Luke 6:36 PM)
  add(tok(String(desc || '').slice(0, 600)), 1);
  return tf;
}

let idfCache = { ver: -1, idf: new Map(), n: 50 };
function idf() {
  if (!metaMem) metaMem = loadMeta();
  if (idfCache.ver === metaVer) return idfCache;
  const df = new Map();
  for (const d of Object.values(metaMem)) {
    const seen = docTerms({ title: d.t, tags: d.tags, desc: d.desc });
    for (const t of seen.keys()) df.set(t, (df.get(t) || 0) + 1);
  }
  const n = Math.max(Object.keys(metaMem).length, 50);
  const m = new Map();
  for (const [t, c] of df) m.set(t, Math.log(1 + n / c));
  idfCache = { ver: metaVer, idf: m, n };
  return idfCache;
}

const backfillState = { started: false, queue: [], active: 0, done: new Set() };
function scheduleMetaBackfill() {
  if (backfillState.started) return;
  backfillState.started = true;
  setTimeout(() => {
    try {
      if (!metaMem) loadMeta();
      const want = [];
      const hist = loadHist(); const likes = loadLikes();
      for (const u of Object.keys(hist)) for (const v of (hist[u] || []).slice(0, 40)) want.push(v.id);
      for (const u of Object.keys(likes)) for (const v of (likes[u] || []).slice(0, 40)) want.push(v.id);
      const deadIds = loadDead();
      backfillState.queue = [...new Set(want)].filter((id) => id && /^[A-Za-z0-9_-]{11}$/.test(id) && !deadIds.has(id) && !backfillState.done.has(id) && !(metaMem[id] && metaMem[id].tags)).slice(0, 80);
      pumpBackfill();
    } catch {}
  }, 15000); // let the restart settle first
}
function pumpBackfill() {
  while (backfillState.active < 2 && backfillState.queue.length) {
    const id = backfillState.queue.shift();
    backfillState.active++;
    (async () => {
      const { stdout } = await execFileP(YTDLP, ['--no-playlist', '--no-warnings', '--skip-download', '-j', 'https://www.youtube.com/watch?v=' + id], { maxBuffer: 32 * 1024 * 1024, timeout: 30000 });
      const data = JSON.parse(stdout);
      noteMeta(id, {
        t: String(data.title || '').slice(0, 300),
        ch: String(data.channel || data.uploader || '').slice(0, 200),
        desc: String(data.description || '').slice(0, 600),
        tags: (Array.isArray(data.tags) ? data.tags : []).slice(0, 30).map((t) => String(t).slice(0, 60)),
        cat: String((Array.isArray(data.categories) && data.categories[0]) || '').slice(0, 60),
      });
    })().catch(() => {}).finally(() => {
      backfillState.done.add(id);
      backfillState.active--;
      pumpBackfill();
    });
  }
}
scheduleMetaBackfill();

function docVec(fields) {
  const { idf: m, n } = idf();
  const tf = docTerms(fields);
  const v = new Map();
  let norm = 0;
  const fresh = Math.log(1 + n); // unseen term = maximally informative
  for (const [t, f] of tf) {
    const w = (1 + Math.log(f)) * (m.get(t) || fresh);
    v.set(t, w);
    norm += w * w;
  }
  norm = Math.sqrt(norm) || 1;
  for (const [t, w] of v) v.set(t, w / norm);
  return v;
}

function cosine(a, b) {
  let s = 0;
  for (const [t, w] of a) { const u = b.get(t); if (u) s += w * u; }
  return s;
}

function tasteCentroid(user) {
  if (!metaMem) metaMem = loadMeta();
  const hist = userHist(user);
  const likes = userLikes(user);
  const emb = loadEmbed();
  const eacc = new Float64Array(384);
  let estrength = 0;
  const addEmb = (id, w) => {
    const e = emb[id];
    if (!e || !e.v) return;
    for (let d = 0; d < 384; d++) eacc[d] += w * e.v[d];
    if (w > 0) estrength += w;
  };
  const acc = new Map();
  const addVec = (vec, w) => { for (const [t, x] of vec) acc.set(t, (acc.get(t) || 0) + w * x); };
  const fieldsFor = (v) => {
    const m = metaMem[v.id];
    if (m) return { title: m.t, tags: m.tags, desc: m.desc, cat: m.cat };
    return { title: v.title, tags: [], desc: '' };
  };
  let strength = 0;
  hist.forEach((v, i) => {
    const rec = 1 / (1 + i / 6);
    const dur = v.secs || parseSecs(v.duration) || 0;
    const ws = typeof v.ws === 'number' ? v.ws : null;
    let w = 0;
    if (ws != null && dur > 0) {
      const ratio = ws / dur;
      if (ws < 3 || (dur > 20 && ratio < 0.15)) w = -3 * rec;   // quick skip: push out
      else if (ratio >= 0.7 || ws >= 25) w = 6 * rec;           // watched through: pull in
      else w = 0.5 * rec;                                       // sampled
    } else w = rec;
    if (!w) return;
    addVec(docVec(fieldsFor(v)), w);
    addEmb(v.id, w);
    if (w > 0) strength += w;
  });
  likes.forEach((v, i) => {
    const w = 6 / (1 + i / 8);
    addVec(docVec(fieldsFor(v)), w);
    addEmb(v.id, w);
    strength += w;
  });
  let norm = 0;
  for (const x of acc.values()) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  for (const [t, x] of acc) acc.set(t, x / norm);
  let evec = null;
  if (estrength > 0) {
    let enorm = 0;
    for (let d = 0; d < 384; d++) enorm += eacc[d] * eacc[d];
    enorm = Math.sqrt(enorm) || 1;
    evec = Array.from(eacc, (x) => x / enorm);
  }
  return { vec: acc, strength, evec, estrength };
}

export const __taste = { docVec, tasteCentroid, cosine };


// ── channel + playlist search, playlist pages, channel playlists tab (Luke 6:11 PM) ──
// the ANDROID client hands back opaque element blobs for these result types,
// the WEB client returns the real renderers, so these calls use WEB.
const WEB_CTX = { client: { clientName: 'WEB', clientVersion: '2.20250925.01.00', hl: 'en', gl: 'US' } };
async function ytWeb(endpoint, body) {
  const r = await fetch(`${API}/${endpoint}?prettyPrint=false`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36' },
    body: JSON.stringify({ context: WEB_CTX, ...body }),
    signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) throw new Error(`ytweb ${endpoint} ${r.status}`);
  return r.json();
}
const txt = (t) => (t?.runs ? t.runs.map((r) => r.text).join('') : t?.simpleText || t?.content || '') || '';
const fixImg = (u) => (u ? (u.startsWith('//') ? 'https:' + u : u) : '');
function parseKindSearch(data, kind) {
  const out = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (kind === 'channel' && node.channelRenderer) {
      const c = node.channelRenderer;
      const id = c.channelId;
      if (/^UC[A-Za-z0-9_-]{20,24}$/.test(id || '')) {
        const th = c.thumbnail?.thumbnails || [];
        out.push({
          id, name: txt(c.title),
          handle: String(c.subscriberCountText?.simpleText || '').startsWith('@') ? c.subscriberCountText.simpleText : '',
          subs: txt(c.videoCountText) || txt(c.subscriberCountText),
          desc: txt(c.descriptionSnippet),
          avatar: fixImg(th[th.length - 1]?.url || ''),
        });
      }
      return;
    }
    if (kind === 'playlist' && node.lockupViewModel && /PLAYLIST/.test(node.lockupViewModel.contentType || '')) {
      const l = node.lockupViewModel;
      const id = l.contentId;
      if (/^(PL|OL|UU|FL|RD)[A-Za-z0-9_-]{8,40}$/.test(id || '')) {
        const src = l.contentImage?.collectionThumbnailViewModel?.primaryThumbnail?.thumbnailViewModel?.image?.sources?.[0]?.url || '';
        const vid = (/\/vi\/([A-Za-z0-9_-]{11})\//.exec(src) || [])[1] || '';
        const badge = l.contentImage?.collectionThumbnailViewModel?.primaryThumbnail?.thumbnailViewModel?.overlays?.[0]?.thumbnailOverlayBadgeViewModel?.thumbnailBadges?.[0]?.thumbnailBadgeViewModel?.text || '';
        const rows = l.metadata?.lockupMetadataViewModel?.metadata?.contentMetadataViewModel?.metadataRows || [];
        const channel = rows[0]?.metadataParts?.[0]?.text?.content || '';
        out.push({ id, title: txt(l.metadata?.lockupMetadataViewModel?.title), channel, count: badge, thumbVid: vid });
      }
      return;
    }
    for (const val of Object.values(node)) {
      if (Array.isArray(val)) val.forEach(walk);
      else if (val && typeof val === 'object') walk(val);
    }
  };
  walk(data);
  const seen = new Set();
  return out.filter((v) => (seen.has(v.id) ? false : (seen.add(v.id), true))).slice(0, 20);
}


// ── restricted / unplayable pre-check (Luke 7:25 PM) ──
// the ANDROID player endpoint tells us up front, per video, whether it is playable
// without a login: OK, or LOGIN_REQUIRED ("may be inappropriate" = age-gated),
// or ERROR/UNPLAYABLE (private, removed, blocked). cached: blocked ids persist in
// data/jetstream-blocked.json (30 days), OK ids stay in memory 12 hours. a network
// failure is "unknown": never cached, never blocks.
const BLOCK_FILE = fileURLToPath(new URL('../../../data/jetstream-blocked.json', import.meta.url));
let blockedMem = null;
function blockedMap() { if (!blockedMem) blockedMem = readJson(BLOCK_FILE, {}); return blockedMem; }
const okMem = new Map(); // id -> ts
async function checkPlayable(id) {
  const b = blockedMap()[id];
  if (b && Date.now() - b < 30 * 86400000) return false;
  const ok = okMem.get(id);
  if (ok && Date.now() - ok < 12 * 3600000) return true;
  try {
    const r = await fetch(`${API}/player?prettyPrint=false`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': UA },
      body: JSON.stringify({ context: CLIENT.context, videoId: id, contentCheckOk: false, racyCheckOk: false }),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    const j = await r.json();
    const st = j.playabilityStatus?.status;
    if (!st) return null;
    if (st === 'OK' || st === 'LIVE_STREAM_OFFLINE') { okMem.set(id, Date.now()); if (okMem.size > 20000) okMem.delete(okMem.keys().next().value); return true; }
    if (['LOGIN_REQUIRED', 'AGE_CHECK_REQUIRED', 'CONTENT_CHECK_REQUIRED', 'UNPLAYABLE', 'ERROR'].includes(st)) {
      const m = blockedMap(); m[id] = Date.now();
      const keys = Object.keys(m); if (keys.length > 5000) for (const k of keys.slice(0, keys.length - 5000)) delete m[k];
      writeJson(BLOCK_FILE, m);
      return false;
    }
    return null;
  } catch { return null; }
}
// check a list of videos with limited parallelism; returns Map id -> true|false|null
async function checkMany(ids, conc = 8, deadlineMs = 25000) {
  const out = new Map(); const t0 = Date.now(); let i = 0;
  await Promise.all(Array.from({ length: Math.min(conc, ids.length) }, async () => {
    while (i < ids.length && Date.now() - t0 < deadlineMs) { const id = ids[i++]; out.set(id, await checkPlayable(id)); }
  }));
  return out;
}

const plCache = new Map();
async function playlistPage(id) {
  const hit = plCache.get(id);
  if (hit && Date.now() - hit.at < 30 * 60 * 1000) return hit;
  const { stdout } = await execFileP(YTDLP, ['--flat-playlist', '--dump-single-json', '--playlist-end', '3000', `https://www.youtube.com/playlist?list=${id}`], { maxBuffer: 128 * 1024 * 1024, timeout: 120000 });
  const data = JSON.parse(stdout);
  if (!data) throw new Error('playlist came back empty');
  const fmtDur = (s) => (typeof s === 'number' && s > 0 ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}` : '');
  const deadIds = loadDead();
  const items = (data.entries || []).filter((e) => e && /^[A-Za-z0-9_-]{11}$/.test(e.id || '') && e.title && e.title !== '[Private video]' && e.title !== '[Deleted video]' && !(e.age_limit >= 18) && !['needs_auth', 'premium_only', 'subscriber_only', 'private'].includes(e.availability) && !deadIds.has(e.id)).map((e) => ({
    id: e.id,
    title: String(e.title).slice(0, 300),
    channel: String(e.channel || e.uploader || '').slice(0, 200),
    channelId: /^UC/.test(e.channel_id || '') ? e.channel_id : '',
    duration: fmtDur(e.duration),
    views: typeof e.view_count === 'number' && e.view_count > 0 ? `${e.view_count.toLocaleString('en-US')} views` : '',
  }));
  const seenIds = new Set();
  for (let i = items.length - 1; i >= 0; i--) { if (seenIds.has(items[i].id)) items.splice(i, 1); else seenIds.add(items[i].id); }
  const out = {
    at: Date.now(), id,
    name: String(data.title || '').slice(0, 200),
    channel: String(data.channel || data.uploader || '').slice(0, 200),
    channelId: /^UC/.test(data.channel_id || '') ? data.channel_id : '',
    count: data.playlist_count || items.length,
    items,
  };
  plCache.set(id, out);
  if (plCache.size > 60) plCache.delete(plCache.keys().next().value);
  return out;
}

const chanPlCache = new Map();
async function channelPlaylists(id) {
  const hit = chanPlCache.get(id);
  if (hit && Date.now() - hit.at < 30 * 60 * 1000) return hit;
  let data = null;
  try {
    const { stdout } = await execFileP(YTDLP, ['--flat-playlist', '--dump-single-json', `https://www.youtube.com/channel/${id}/playlists`], { maxBuffer: 16 * 1024 * 1024, timeout: 60000 });
    data = JSON.parse(stdout);
  } catch (e) {
    if (!/does not have a playlists tab/i.test(String(e.stderr || e.message))) throw e;
  }
  const items = ((data && data.entries) || []).filter((e) => e && /^(PL|OL|FL)[A-Za-z0-9_-]{8,40}$/.test(e.id || '') && e.title).map((e) => {
    const th = (e.thumbnails || []).map((t) => t.url || '').find((u) => /\/vi\/[A-Za-z0-9_-]{11}\//.test(u)) || '';
    return { id: e.id, title: String(e.title).slice(0, 300), count: '', thumbVid: (/\/vi\/([A-Za-z0-9_-]{11})\//.exec(th) || [])[1] || '' };
  }).slice(0, 60);
  const out = { at: Date.now(), items };
  chanPlCache.set(id, out);
  if (chanPlCache.size > 60) chanPlCache.delete(chanPlCache.keys().next().value);
  return out;
}


const chanInfoCache = new Map();
async function channelInfo(id) {
  const hit = chanInfoCache.get(id);
  if (hit && Date.now() - hit.at < 30 * 60 * 1000) return hit;
  const j = await ytWeb('browse', { browseId: id });
  const meta = j.metadata?.channelMetadataRenderer || {};
  const vm = j.header?.pageHeaderRenderer?.content?.pageHeaderViewModel || {};
  const rows = vm.metadata?.contentMetadataViewModel?.metadataRows || [];
  const parts = rows.flatMap((r) => (r.metadataParts || []).map((x) => x.text?.content || '')).filter(Boolean);
  const handle = parts.find((x) => x.startsWith('@')) || '';
  const subs = parts.find((x) => /subscriber/i.test(x)) || '';
  const videos = parts.find((x) => /video/i.test(x)) || '';
  const bsrc = vm.banner?.imageBannerViewModel?.image?.sources || [];
  const banner = (bsrc.find((x) => (x.width || 0) >= 1000) || bsrc[bsrc.length - 1] || {}).url || '';
  const av = (meta.avatar?.thumbnails || [])[0]?.url || '';
  const out = {
    at: Date.now(), id,
    name: String(meta.title || '').slice(0, 200),
    desc: String(meta.description || '').slice(0, 3000),
    handle, subs, videos,
    banner: banner ? 'https:' === banner.slice(0, 6) ? banner : fixImg(banner) : '',
    avatar: av,
    country: '',
  };
  chanInfoCache.set(id, out);
  if (chanInfoCache.size > 100) chanInfoCache.delete(chanInfoCache.keys().next().value);
  return out;
}

const avatarCache = new Map();
async function getAvatar(u) {
  const hit = avatarCache.get(u);
  if (hit) return hit;
  const r = await fetch(u, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) return null;
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > 1500000) return null;
  const v = { buf, type: r.headers.get('content-type') || 'image/jpeg' };
  avatarCache.set(u, v);
  if (avatarCache.size > 300) avatarCache.delete(avatarCache.keys().next().value);
  return v;
}

export async function register(req, res, ctx) {
  const { url, sendJson, guard, session } = ctx;
  const sub = req.url.split('?')[0].replace(/^\/api\/apps\/jetstream/, '') || '/';

  if (sub === '/search' && req.method === 'GET') {
    const q = (url.searchParams.get('q') || '').trim();
    if (!q) return sendJson(res, 400, { ok: false, error: 'search for something first' });
    if (q.length > 120) return sendJson(res, 400, { ok: false, error: 'keep searches under 120 characters' });
    const kind = url.searchParams.get('type');
    if (kind === 'channel' || kind === 'playlist') {
      try {
        const data = await ytWeb('search', { query: q, params: kind === 'channel' ? 'EgIQAg==' : 'EgIQAw==' });
        guard.trackBytes(session.user, 4096);
        return sendJson(res, 200, { ok: true, q, type: kind, results: parseKindSearch(data, kind) });
      } catch {
        return sendJson(res, 502, { ok: false, error: 'search timed out - try again' });
      }
    }
    try {
      const data = await yt('search', { query: q });
      guard.trackBytes(session.user, 4096);
      return sendJson(res, 200, { ok: true, q, results: parseSearch(data) });
    } catch {
      return sendJson(res, 502, { ok: false, error: 'search timed out - try again' });
    }
  }

  if (sub === '/history' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, items: shelfHist(session.user).slice(0, 10) });
  }

  if (sub === '/history/delete' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse((await readBody(req)).toString('utf8') || '{}'); } catch {}
    const id = String(body.id || '');
    const all = loadHist();
    const mine = (Array.isArray(all[session.user]) ? all[session.user] : []).filter((v) => v.id !== id);
    all[session.user] = mine;
    writeJson(HIST_FILE, all);
    return sendJson(res, 200, { ok: true });
  }

  if (sub === '/history' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse((await readBody(req)).toString('utf8') || '{}'); } catch {}
    const id = String(body.id || '');
    if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return sendJson(res, 400, { ok: false, error: 'bad video id' });
    const title = String(body.title || '').slice(0, 200).trim();
    if (!title) return sendJson(res, 400, { ok: false, error: 'need a title' });
    if (histPaused(session.user)) return sendJson(res, 200, { ok: true, paused: true });
    const dur = String(body.duration || '').slice(0, 8);
    const ws = typeof body.watched === 'number' && isFinite(body.watched) ? Math.max(0, Math.round(body.watched)) : null;
    const all = loadHist();
    const mine0 = Array.isArray(all[session.user]) ? all[session.user] : [];
    // outcome update for an entry already on the shelf: record how much he
    // watched (the algorithm's core signal) without re-surfacing the row,
    // and stale the feed cache so the next batch learns from it.
    if (ws != null && mine0.some((v) => v.id === id)) {
      const hit0 = mine0.find((v) => v.id === id);
      hit0.ws = ws;
      writeJson(HIST_FILE, all);
      const rc = recCache.get(session.user);
      if (rc) rc.at = 0; // next batch re-learns from this outcome
      return sendJson(res, 200, { ok: true });
    }
    const item = {
      id, title,
      channel: String(body.channel || '').slice(0, 200),
      duration: dur,
      secs: parseSecs(dur),
      completed: false,
      at: Date.now(),
    };
    if (ws != null) item.ws = ws;
    const mine = mine0.filter((v) => v.id !== id);
    mine.unshift(item);
    all[session.user] = mine.slice(0, HIST_CAP);
    writeJson(HIST_FILE, all);
    return sendJson(res, 200, { ok: true });
  }

  if (sub === '/history/complete' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse((await readBody(req)).toString('utf8') || '{}'); } catch {}
    const id = String(body.id || '');
    const all = loadHist();
    const mine = Array.isArray(all[session.user]) ? all[session.user] : [];
    const hit = mine.find((v) => v.id === id);
    if (hit) { hit.completed = true; writeJson(HIST_FILE, all); }
    return sendJson(res, 200, { ok: true });
  }

  if (sub === '/settings' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, paused: histPaused(session.user), count: userHist(session.user).length });
  }

  if (sub === '/settings' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse((await readBody(req)).toString('utf8') || '{}'); } catch {}
    const all = loadSettings();
    all[session.user] = { paused: !!body.paused };
    writeJson(SET_FILE, all);
    return sendJson(res, 200, { ok: true, paused: !!body.paused });
  }

  // watch history only (clear-on-close): likes, not-interested marks and subscriptions are kept.
  if (sub === '/history/clear-watch' && req.method === 'POST') {
    const all = loadHist();
    all[session.user] = [];
    writeJson(HIST_FILE, all);
    recCache.delete(session.user);
    return sendJson(res, 200, { ok: true });
  }

  // Luke 9:52 AM: clearing history must clear the algorithm too - likes,
    // not-interested marks and watch-outcome rows are all training data, so a
    // clear is a real fresh start - nothing about the account survives it.
    if (sub === '/history/clear' && req.method === 'POST') {
    const all = loadHist();
    all[session.user] = [];
    writeJson(HIST_FILE, all);
    const lk = loadLikes();
    lk[session.user] = [];
    writeJson(LIKES_FILE, lk);
    const ds = loadDislikes();
    ds[session.user] = [];
    writeJson(DIS_FILE, ds);
    const sb = loadSubs();
    sb[session.user] = [];
    writeJson(SUBS_FILE, sb); // Luke 11:27 AM: the one clear nukes subs too
    recCache.delete(session.user); // the learned profile goes with it
    return sendJson(res, 200, { ok: true });
  }

  // shorts feed + for-you shelf: two slices of the same ranked list.
  // ?q= turns the shorts feed into a searchable zone: fresh search on the
  // query (+ the " shorts" phrasing), scored by the same engine, short-form
  // slice only. query feeds aren't cached - you asked for something new.
  if (sub === '/shorts' && req.method === 'GET') {
    try {
      const q = (url.searchParams.get('q') || '').trim();
      let ranked;
      if (q) {
        const dislikes = userDislikes(session.user);
        const profile = histProfile(userHist(session.user), userLikes(session.user));
        const dis = chanWordProfile(dislikes);
        const taste = tasteCentroid(session.user);
        const seen = new Set([...userHist(session.user), ...userLikes(session.user), ...dislikes].map((v) => v.id));
        const pools = await Promise.all([q, `${q} shorts`].map((x) => yt('search', { query: x }).catch(() => null)));
        const done = new Set(); const pool = [];
        for (const data of pools) {
          if (!data) continue;
          for (const v of parseSearch(data)) {
            if (done.has(v.id)) continue;
            const score = scoreCandidate(v, profile, seen, dis, taste);
            if (score < 0) continue;
            done.add(v.id);
            pool.push({ id: v.id, title: v.title, channel: v.channel, channelId: v.channelId || '', duration: v.duration, views: v.views, desc: v.desc || '', secs: parseSecs(v.duration), score });
          }
        }
        pool.sort((a, b) => b.score - a.score);
        ranked = pool;
      } else {
        // ?fresh=1 re-ranks on the spot - feed opens and "more shorts" calls
        // use it so the feed actually refreshes instead of serving the same
        // cached row.
        ranked = await rankedRecs(session.user, url.searchParams.get('fresh') === '1');
      }
      const shorts = ranked.filter((v) => v.secs != null && v.secs <= 61).slice(0, REC_CAP);
      const h = recCache.get(session.user);
      if (h) {
        for (const v of shorts) h.served.add(v.id);
        while (h.served.size > 60) h.served.delete(h.served.values().next().value);
      }
      const items = shorts.map(stripRec);
      guard.trackBytes(session.user, 8192);
      prefetchSlides(shorts.map((v) => v.id), req.headers['user-agent']); // warm the box for the next swipes
      warmThumbs(shorts.map((v) => v.id)); // posters on disk before the first paint asks
      return sendJson(res, 200, { ok: true, items });
    } catch {
      return sendJson(res, 502, { ok: false, error: 'could not build your feed - try again' });
    }
  }

  // client telemetry: the device reports what it actually rendered per
  // slide (dimensions + hd/muxed + ua). jsonl, capped small.
  if (sub === '/clientlog' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse((await readBody(req)).toString('utf8') || '{}'); } catch {}
    // scroll-follow prefetch: the client reports its live position's next ids
    // and they jump the queue (validated hard - this writes server work)
    if (body.kind === 'slide-ahead' && Array.isArray(body.ids)) {
      const ids = body.ids.filter((x) => /^[A-Za-z0-9_-]{11}$/.test(String(x || ''))).slice(0, 6);
      if (ids.length) { prefetchSlides(ids, String(body.ua || ''), false, true, body.lite === true); warmThumbs(ids); }
    }
    const line = JSON.stringify({
      ts: new Date().toISOString(), user: session.user,
      kind: String(body.kind || '').slice(0, 24), id: String(body.id || '').slice(0, 16),
      vw: body.vw | 0, vh: body.vh | 0, hd: !!body.hd, why: String(body.why || '').slice(0, 40),
      ua: String(body.ua || '').slice(0, 120),
    });
    try {
      const { appendFileSync, statSync, readFileSync, writeFileSync } = await import('node:fs');
      const LOG = fileURLToPath(new URL('../../../data/jetstream-clientlog.jsonl', import.meta.url));
      try { if (statSync(LOG).size > 262144) { const lines = readFileSync(LOG, 'utf8').split('\n'); writeFileSync(LOG, lines.slice(-500).join('\n')); } } catch {}
      appendFileSync(LOG, line + '\n');
    } catch {}
    return sendJson(res, 200, { ok: true });
  }

  // likes: read the id set, toggle one on/off
  if (sub === '/likes' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, ids: userLikes(session.user).map((v) => v.id) });
  }
  if (sub === '/likes/toggle' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse((await readBody(req)).toString('utf8') || '{}'); } catch {}
    const id = String(body.id || '');
    if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return sendJson(res, 400, { ok: false, error: 'bad id' });
    const all = loadLikes();
    const mine = Array.isArray(all[session.user]) ? all[session.user] : [];
    const at = mine.findIndex((v) => v.id === id);
    let liked;
    if (at >= 0) { mine.splice(at, 1); liked = false; }
    else {
      mine.unshift({ id, title: String(body.title || ''), channel: String(body.channel || ''), duration: String(body.duration || ''), at: Date.now() });
      mine.length = Math.min(mine.length, LIKES_CAP);
      liked = true;
    }
    all[session.user] = mine;
    writeJson(LIKES_FILE, all);
    recCache.delete(session.user); // a like reshapes the feed right away
    return sendJson(res, 200, { ok: true, liked });
  }

  // not-interested: read the id set, toggle one on/off
  if (sub === '/dislikes' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, ids: userDislikes(session.user).map((v) => v.id) });
  }
  if (sub === '/dislikes/toggle' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse((await readBody(req)).toString('utf8') || '{}'); } catch {}
    const id = String(body.id || '');
    if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return sendJson(res, 400, { ok: false, error: 'bad id' });
    const all = loadDislikes();
    const mine = Array.isArray(all[session.user]) ? all[session.user] : [];
    const at = mine.findIndex((v) => v.id === id);
    let disliked;
    if (at >= 0) { mine.splice(at, 1); disliked = false; }
    else {
      mine.unshift({ id, title: String(body.title || ''), channel: String(body.channel || ''), duration: String(body.duration || ''), at: Date.now() });
      mine.length = Math.min(mine.length, DIS_CAP);
      disliked = true;
    }
    all[session.user] = mine;
    writeJson(DIS_FILE, all);
    recCache.delete(session.user); // same instant effect as a like
    return sendJson(res, 200, { ok: true, disliked });
  }

  // subscriptions: read the list, toggle one on/off
  if (sub === '/subs' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, subs: userSubs(session.user) });
  }
  // video summary: captions from yt-dlp -> the free hosted model (same provider chain as sage:
  // data/sage-provider.json free-tier key if present, else pollinations keyless). cached per video.
  if (sub === '/summary' && req.method === 'GET') {
    const id = (url.searchParams.get('id') || '').trim();
    if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return sendJson(res, 400, { ok: false, error: 'bad video id' });
    const cache = readJson(SUM_FILE, {});
    if (cache[id]) return sendJson(res, 200, { ok: true, cached: true, ...cache[id] });
    const rl = sumLimit.get(session.user) || [];
    const recent = rl.filter((t) => Date.now() - t < 3600e3);
    if (recent.length >= 15) return sendJson(res, 429, { ok: false, error: 'that is plenty of summaries for one hour - try again later' });
    sumLimit.set(session.user, [...recent, Date.now()]);
    try {
      const out = await summarize(id);
      if (!out) return sendJson(res, 200, { ok: false, error: "this video has no captions, so there is nothing to summarize" });
      const c2 = readJson(SUM_FILE, {}); c2[id] = out;
      const keys = Object.keys(c2); if (keys.length > 300) for (const k of keys.slice(0, keys.length - 300)) delete c2[k];
      writeJson(SUM_FILE, c2);
      guard.trackBytes(session.user, 4096);
      return sendJson(res, 200, { ok: true, ...out });
    } catch (e) {
      console.error('summary error:', String(e.message || e).slice(0, 200));
      return sendJson(res, 502, { ok: false, error: e.code === 'quota' ? 'the free model is resting for today - back soon' : "couldn't summarize this one - try again" });
    }
  }

  // new from your subs: the latest uploads of each subscribed channel you have not watched.
  // reads the 30-min channel cache, so most calls cost nothing; capped at 8 channels.
  if (sub === '/subs/new' && req.method === 'GET') {
    const mySubs = userSubs(session.user).slice(0, 8);
    if (!mySubs.length) return sendJson(res, 200, { ok: true, items: [] });
    const seen = new Set(userHist(session.user).map((v) => v.id));
    const out = [];
    for (const sb of mySubs) {
      try {
        const t = await channelTab(sb.id, 'videos');
        for (const v of t.items.slice(0, 4)) if (!seen.has(v.id)) out.push({ ...v, channel: v.channel || sb.name });
      } catch {}
    }
    return sendJson(res, 200, { ok: true, items: out.slice(0, 12) });
  }
  if (sub === '/subs/toggle' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString() || '{}');
    const id = String(body.id || '').trim();
    const name = String(body.name || '').trim().slice(0, 200);
    if (!id || !name) return sendJson(res, 400, { ok: false, error: 'missing channel' });
    const all = loadSubs();
    const mine = all[session.user] || [];
    const at = mine.findIndex((s) => s.id === id);
    let subbed;
    if (at >= 0) { mine.splice(at, 1); subbed = false; }
    else { mine.unshift({ id, name, ts: Date.now() }); mine.length = Math.min(mine.length, SUBS_CAP); subbed = true; }
    all[session.user] = mine;
    writeJson(SUBS_FILE, all);
    recCache.delete(session.user); // a sub reshapes the feed right away too
    return sendJson(res, 200, { ok: true, subbed });
  }

  // channel page data: videos or shorts tab
  if (sub === '/channel' && req.method === 'GET') {
    const id = (url.searchParams.get('id') || '').trim();
    const tab = url.searchParams.get('tab') === 'shorts' ? 'shorts' : 'videos';
    if (!/^[A-Za-z0-9_-]{2,64}$/.test(id)) return sendJson(res, 400, { ok: false, error: 'bad channel id' });
    try {
      const t = await channelTab(id, tab);
      guard.trackBytes(session.user, 4096);
      return sendJson(res, 200, { ok: true, id, name: t.name, tab, items: t.items });
    } catch (e) {
      console.error('channel tab error:', e.message);
      return sendJson(res, 502, { ok: false, error: "can't load this channel - try again" });
    }
  }

  if (sub === '/channel/info' && req.method === 'GET') {
    const id = (url.searchParams.get('id') || '').trim();
    if (!/^UC[A-Za-z0-9_-]{20,24}$/.test(id)) return sendJson(res, 400, { ok: false, error: 'bad channel id' });
    try {
      const t = await channelInfo(id);
      guard.trackBytes(session.user, 4096);
      return sendJson(res, 200, { ok: true, ...t });
    } catch (e) {
      console.error('channel info error:', e.message);
      return sendJson(res, 502, { ok: false, error: 'no channel info' });
    }
  }

  if (sub === '/channel/playlists' && req.method === 'GET') {
    const id = (url.searchParams.get('id') || '').trim();
    if (!/^UC[A-Za-z0-9_-]{20,24}$/.test(id)) return sendJson(res, 400, { ok: false, error: 'bad channel id' });
    try {
      const t = await channelPlaylists(id);
      guard.trackBytes(session.user, 4096);
      return sendJson(res, 200, { ok: true, id, items: t.items });
    } catch (e) {
      console.error('channel playlists error:', e.message);
      return sendJson(res, 502, { ok: false, error: "can't load playlists - try again" });
    }
  }

  if (sub === '/playlist' && req.method === 'GET') {
    const id = (url.searchParams.get('id') || '').trim();
    if (!/^(PL|OL|UU|FL|LL)[A-Za-z0-9_-]{8,40}$/.test(id)) return sendJson(res, 400, { ok: false, error: 'bad playlist id' });
    try {
      const t = await playlistPage(id);
      guard.trackBytes(session.user, 4096);
      let list = t.items;
      const qq = (url.searchParams.get('q') || '').trim().toLowerCase().slice(0, 100);
      if (qq) list = list.filter((v) => (v.title + ' ' + v.channel).toLowerCase().includes(qq));
      if (url.searchParams.get('rev') === '1') list = [...list].reverse();
      const bm = blockedMap();
      const isBlocked = (v) => bm[v.id] && Date.now() - bm[v.id] < 30 * 86400000;
      const all = url.searchParams.get('all') === '1';
      const off = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
      const lim = Math.min(200, Math.max(1, parseInt(url.searchParams.get('limit') || '50', 10) || 50));
      // walk the raw list from the cursor; pre-check in batches; stop once the window is full.
      // `next` is a raw-list cursor, so dropping blocked ones never shifts later pages.
      const items = []; let cur = all ? 0 : off;
      const target = all ? Infinity : lim;
      while (cur < list.length && items.length < target) {
        const batch = list.slice(cur, cur + (all ? 400 : Math.max(8, (target - items.length) + 4)));
        const res = await checkMany(batch.filter((v) => !isBlocked(v)).map((v) => v.id), 8, all ? 20000 : 12000);
        let used = 0;
        for (const v of batch) {
          if (items.length >= target) break;
          used++;
          if (isBlocked(v) || res.get(v.id) === false) continue;
          items.push(v);
        }
        cur += used;
      }
      const blockedKnown = list.filter(isBlocked).length;
      const total = list.length - blockedKnown;
      guard.trackBytes(session.user, 4096);
      return sendJson(res, 200, { ok: true, id, name: t.name, channel: t.channel, channelId: t.channelId, count: t.count, total, next: cur, done: cur >= list.length, hidden: blockedKnown, items });
    } catch (e) {
      console.error('playlist error:', e.message);
      return sendJson(res, 502, { ok: false, error: "can't load this playlist - it may be private or gone" });
    }
  }

  if (sub === '/avatar' && req.method === 'GET') {
    const u = (url.searchParams.get('u') || '').trim();
    let host = '';
    try { host = new URL(u).hostname; } catch {}
    if (!/^https:\/\//.test(u) || !/^(yt3\.ggpht\.com|yt3\.googleusercontent\.com)$/.test(host)) return sendJson(res, 400, { ok: false, error: 'bad image' });
    const a = await getAvatar(u).catch(() => null);
    if (!a) return sendJson(res, 502, { ok: false, error: 'no image' });
    guard.trackBytes(session.user, a.buf.length);
    res.writeHead(200, { 'content-type': a.type, 'cache-control': 'public, max-age=86400' });
    return res.end(a.buf);
  }

  if (sub === '/for-you' && req.method === 'GET') {
    try {
      const ranked = await rankedRecs(session.user);
      const off = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
      const long = ranked.filter((v) => v.secs == null || v.secs > 61);
      const items = long.slice(off, off + REC_CAP).map(stripRec);
      if (off === 0) warmResolve(items.map((v) => v.id));
      guard.trackBytes(session.user, 8192);
      return sendJson(res, 200, { ok: true, items, more: off + items.length < long.length });
    } catch {
      return sendJson(res, 502, { ok: false, error: 'could not build your feed - try again' });
    }
  }

  if (sub === '/watch' && req.method === 'GET') {
    const id = (url.searchParams.get('id') || '').trim();
    if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return sendJson(res, 400, { ok: false, error: 'bad video id' });
    try {
      const s = await resolveStream(id);
      // direct-first (Luke 6:08 PM): hand the client the CDN urls too - it
      // plays direct when his network doesn't filter them, proxy fallback
      // when it does. the proxy stays the product on filtered networks.
      const body = { ok: true, id, quality: s.quality, stream: `/api/apps/jetstream/stream?id=${id}`, direct: s.url, channel: s.channel || '', channelId: s.channelId || '' };
      const wantVp9 = url.searchParams.get('vp9') === '1' && s.hdVp9;
      const lite = url.searchParams.get('lite') === '1' && (wantVp9 ? s.hdLVp9 : s.hdL);
      const hdPick = lite ? (wantVp9 ? s.hdLVp9 : s.hdL) : (wantVp9 ? s.hdVp9 : s.hd);
      if (hdPick) {
        body.hd = {
          quality: hdPick.quality,
          video: `/api/apps/jetstream/vsrc?id=${id}&kind=${lite ? (wantVp9 ? 'lvp9video' : 'lvideo') : (wantVp9 ? 'vp9video' : 'video')}`,
          audio: `/api/apps/jetstream/vsrc?id=${id}&kind=audio`,
          directVideo: hdPick.videoUrl,
          directAudio: hdPick.audioUrl,
        };
      }
      return sendJson(res, 200, body);
    } catch (e) {
      console.error("jetstream watch error:", e.message);
      if (e.message === 'no playable stream for this one') markDead(id); // restricted: out of every feed
      const human = ["can't load this video - try another", "no playable stream for this one"];
      return sendJson(res, 502, { ok: false, error: human.includes(e.message) ? e.message : "can't load this video - try another" });
    }
  }

  // hd sources: kind=video (adaptive, video-only) or kind=audio (m4a)
  if (sub === '/vsrc' && req.method === 'GET') {
    const id = (url.searchParams.get('id') || '').trim();
    const kind = url.searchParams.get('kind') || '';
    if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return sendJson(res, 400, { ok: false, error: 'bad video id' });
    if (!['video', 'audio', 'vp9video', 'lvideo', 'lvp9video'].includes(kind)) return sendJson(res, 400, { ok: false, error: 'bad kind' });
    if (guard.bytesLeft(session.user) <= 0) return sendJson(res, 429, { ok: false, error: 'out of bandwidth for now - it resets every hour' });
    // disk first: a warm pair serves without paying a yt-dlp resolve at all -
    // faster, and immune to upstream resolve flapping on bytes we already hold
    const cp = cachePath(id, kind);
    if (existsSync(cp)) return serveCached(cp, req, res, (n) => guard.trackBytes(session.user, n), kind === 'vp9video' || kind === 'lvp9video' ? 'video/webm' : 'video/mp4');
    let s;
    try { s = await resolveStream(id); }
    catch { res.writeHead(502); return res.end(); }
    if (!s.hd) { res.writeHead(404); return res.end(); }
    if (kind === 'vp9video' && !s.hdVp9) { res.writeHead(404); return res.end(); }
    if ((kind === 'lvideo' && !s.hdL) || (kind === 'lvp9video' && !s.hdLVp9)) { res.writeHead(404); return res.end(); }
    // cold touch: this play rides the live proxy, but the pair downloads to
    // disk right now at queue-front - the next loop/replay/visit is warm
    prefetchSlides([id], req.headers['user-agent'] || '', false, true, kind === 'lvideo' || kind === 'lvp9video');
    const pk = (x) => kind === 'video' ? x.hd?.videoUrl : kind === 'vp9video' ? x.hdVp9?.videoUrl : kind === 'lvideo' ? x.hdL?.videoUrl : kind === 'lvp9video' ? x.hdLVp9?.videoUrl : x.hd?.audioUrl;
    const u = pk(s);
    return gvProxy(u, req, res, (n) => guard.trackBytes(session.user, n), async () => {
      const s2 = await resolveStream(id, true);
      return pk(s2);
    }, kind === 'audio' ? (4 << 20) : (8 << 20));
  }

  // 360p muxed fallback stream
  if (sub === '/stream' && req.method === 'GET') {
    const id = (url.searchParams.get('id') || '').trim();
    if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return sendJson(res, 400, { ok: false, error: 'bad video id' });
    if (guard.bytesLeft(session.user) <= 0) return sendJson(res, 429, { ok: false, error: 'out of bandwidth for now - it resets every hour' });
    // disk first (see /vsrc): never resolve for bytes we already hold
    const cp = cachePath(id, 'muxed');
    if (existsSync(cp)) return serveCached(cp, req, res, (n) => guard.trackBytes(session.user, n));
    let s;
    try { s = await resolveStream(id); }
    catch { res.writeHead(502); return res.end(); }
    // cold touch: warm it for next time (see /vsrc)
    prefetchSlides([id], req.headers['user-agent'] || '', false, true);
    const mu = await muxUrl(s);
    if (!mu) { res.writeHead(404); return res.end(); }
    return gvProxy(mu, req, res, (n) => guard.trackBytes(session.user, n), async () => muxUrl(await resolveStream(id, true)), 4 << 20);
  }

  if (sub === '/thumb' && req.method === 'GET') {
    const id = (url.searchParams.get('id') || '').trim();
    if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return sendJson(res, 400, { ok: false, error: 'bad id' });
    // disk first: a cached poster serves in milliseconds even when the
    // upstream image host is slow; cold misses fetch, cache, then serve.
    const lite = url.searchParams.get('lite') === '1';
    const tp = thumbPath(id, lite);
    if (existsSync(tp)) {
      const now = new Date();
      try { utimesSync(tp, now, now); } catch {} // lru touch
      guard.trackBytes(session.user, statSync(tp).size);
      res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=86400' });
      return createReadStream(tp).pipe(res);
    }
    const buf = await getThumb(id, lite);
    if (!buf) return sendJson(res, 502, { ok: false, error: 'no thumb' });
    guard.trackBytes(session.user, buf.length);
    res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=86400' });
    return res.end(buf);
  }

  return sendJson(res, 404, { ok: false, error: 'unknown jetstream call' });
}


// ---- lite api (core/lite.js) ------------------------------------------------
// everything below is only used by /api/lite/*: a phone shortcut downloads a
// finished, single-file H.264+AAC mp4 (Quick Look cannot play vp9/av1/opus).
// video-only and audio-only avc1/m4a urls from the resolver are pulled to disk
// in 4MB hops (same trick as downloadToCache), then muxed with ffmpeg stream
// copy. one mux at a time, temp files removed, result lives in the stream cache.
let liteChain = Promise.resolve();
function liteSerial(fn) {
  const run = liteChain.then(fn, fn);
  liteChain = run.catch(() => {});
  return run;
}
async function liteHop(url, dest, cap) {
  const pr = await fetch(url, { headers: { 'user-agent': GV_UA, range: 'bytes=0-0' }, redirect: 'follow', signal: AbortSignal.timeout(30000) });
  const crm = /\/(\d+)\s*$/.exec(pr.headers.get('content-range') || '');
  dropBody(pr);
  if (pr.status !== 206 && pr.status !== 200) throw new Error('probe ' + pr.status);
  const size = crm ? parseInt(crm[1], 10) : 0;
  if (!size || !Number.isSafeInteger(size)) throw new Error('no size');
  if (size > cap) throw new Error('too big');
  const CHUNK = 4 << 20;
  const fh = await fsOpen(dest, 'w');
  try {
    let off = 0;
    while (off < size) {
      const last = Math.min(off + CHUNK, size) - 1;
      let ok = false;
      for (let a = 0; a < 3 && !ok; a++) {
        try {
          const r = await fetch(url, { headers: { 'user-agent': GV_UA, range: 'bytes=' + off + '-' + last }, redirect: 'follow', signal: AbortSignal.timeout(45000) });
          if (r.status !== 206 && r.status !== 200) { dropBody(r); await new Promise((d) => setTimeout(d, 400 * (a + 1))); continue; }
          const buf = Buffer.from(await r.arrayBuffer());
          await fh.write(buf, 0, buf.length, off);
          off += buf.length;
          ok = true;
        } catch { await new Promise((d) => setTimeout(d, 400 * (a + 1))); }
      }
      if (!ok) throw new Error('chunk failed');
    }
  } finally { await fh.close().catch(() => {}); }
  return size;
}
const LITE_MAX_BYTES = 150 * 1024 * 1024;
const LITE_MAX_SECS = 15 * 60;
// pick the formats for a quality: biggest avc1 video at or under q (short side), m4a audio.
function litePlan(entry, q) {
  const L = entry.lite || { v: [], a: [] };
  const vids = L.v.filter((f) => f.h && f.h <= q).sort((a, b) => b.h - a.h || a.fps - b.fps);
  const top = vids[0];
  const pick = top ? (vids.find((f) => f.h === top.h && f.fps <= 30) || top) : null;
  const aud = L.a.slice().sort((a, b) => b.abr - a.abr)[0];
  const secs = entry.duration || 0;
  if (pick && aud) {
    const est = (pick.size || (pick.tbr * 125 * secs)) + (aud.size || (aud.abr * 125 * secs));
    return { mode: 'mux', v: pick, a: aud, height: pick.h, secs, est: Math.round(est) };
  }
  return { mode: 'itag18', secs, height: 360, est: Math.round(60 * 1024 * secs) };
}
async function liteMakeVideo(id, q, entry) {
  const out = cachePath(id, 'lite' + q);
  if (existsSync(out)) { try { utimesSync(out, new Date(), new Date()); } catch {} return out; }
  const plan = litePlan(entry, q);
  return liteSerial(async () => {
    if (existsSync(out)) return out;
    const tmpv = cachePath(id, 'lite' + q + 'v.part'), tmpa = cachePath(id, 'lite' + q + 'a.part'), tmpo = cachePath(id, 'lite' + q + 'o.part');
    const rm = () => { for (const f of [tmpv, tmpa, tmpo]) { try { unlinkSync(f); } catch {} } };
    try {
      if (plan.mode === 'itag18') {
        const u = await muxUrl(entry);
        if (!u) throw new Error('no playable stream for this one');
        await liteHop(u, tmpo, LITE_MAX_BYTES);
        await fsRename(tmpo, out);
      } else {
        await liteHop(plan.v.url, tmpv, LITE_MAX_BYTES);
        await liteHop(plan.a.url, tmpa, LITE_MAX_BYTES);
        await new Promise((resolve, reject) => {
          const ff = spawn('nice', ['-n', '10', 'ffmpeg', '-v', 'error', '-y', '-i', tmpv, '-i', tmpa, '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', tmpo], { stdio: ['ignore', 'ignore', 'pipe'] });
          let err = ''; ff.stderr.on('data', (c) => { err += c; });
          const to = setTimeout(() => ff.kill('SIGKILL'), 120000);
          ff.on('close', (c) => { clearTimeout(to); c === 0 ? resolve() : reject(new Error('mux failed ' + err.slice(0, 120))); });
          ff.on('error', reject);
        });
        await fsRename(tmpo, out);
      }
      evictCache();
      return out;
    } finally { rm(); }
  });
}
export const liteApi = {
  async search(q) { return parseSearch(await ytSearch(q)); },
  resolveStream,
  litePlan,
  makeVideo: liteMakeVideo,
  serveCached,
  getThumb,
  LITE_MAX_BYTES,
  LITE_MAX_SECS,
};
