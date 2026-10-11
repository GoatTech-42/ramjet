// jetstream shorts ranker. NOT the for-you ranker: this one only learns from
// short-form behavior (loops, skips, dwell), picks its own candidate seeds,
// models duration + freshness + channel reliability, spends a slice of every
// batch on exploration, and diversifies the batch with MMR before serving.
// pure module: no I/O, everything injected, so it is unit-testable offline.

const STOP = new Set('the and for with that this from your you are was were have has had not but all can will its his her she him they them their our out about into over after before between under again once here there when where why how what which who whom been being both each few more most other some such only own same than too very just challenge challenges tiktok viral viralvideo ytshorts shorts short video videos youtube reels fyp foryou trending compilation feat wait till end part'.split(' '));
export const SHORT_MAX = 61;
const BAIT = /tik ?tok|compilation|try not to|you won.?t believe|gone wrong|#shorts|\bfails?\b|top \d+ |\bpranks?\b|\breacts? to\b|subscribe|part \d+/i;

export const words = (t) => String(t || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !STOP.has(w));
const isShort = (v) => { const s = v.secs ?? parseSecs(v.duration); return s != null && s <= SHORT_MAX; };
export function parseSecs(t) {
  const p = String(t || '').trim().split(':');
  if (p.length < 2 || p.length > 3 || p.some((x) => !/^\d+$/.test(x))) return null;
  return p.reduce((a, x) => a * 60 + parseInt(x, 10), 0);
}
export function parseViews(t) {
  const m = /([\d,.]+)\s*([KMB])?/i.exec(String(t || ''));
  if (!m) return 0;
  const n = parseFloat(m[1].replace(/,/g, ''));
  return isFinite(n) ? n * ({ k: 1e3, m: 1e6, b: 1e9 }[String(m[2] || '').toLowerCase()] || 1) : 0;
}
export function parseAgoDays(t) {
  const m = /(\d+)\s+(minute|hour|day|week|month|year)s?\s+ago/i.exec(String(t || ''));
  if (!m) return null;
  return parseInt(m[1], 10) * { minute: 1 / 1440, hour: 1 / 24, day: 1, week: 7, month: 30, year: 365 }[m[2].toLowerCase()];
}

// outcome of one watched short, in [-1, 1.2]. a short is seconds long, so
// the ratio is everything: replays (ratio>=1) are the loudest yes, a swipe
// inside 1.5s is a hard no. rows with no telemetry count as a faint yes.
export function outcome(row) {
  const dur = row.secs || parseSecs(row.duration) || 0;
  const ws = typeof row.ws === 'number' ? row.ws : null;
  if (ws == null || dur <= 0) return 0.15;
  const r = ws / dur;
  if (ws < 1.5 || r < 0.15) return -1;
  if (r < 0.4) return -0.4;
  if (r < 0.7) return 0.25;
  if (r < 1.0) return 0.8;
  return 1.2;
}









export function longOutcome(row) {
  const dur = row.secs || parseSecs(row.duration) || 0;
  const ws = typeof row.ws === 'number' ? row.ws : null;
  if (ws != null && dur > 0) {
    const ratio = ws / dur;
    if (ws < 3 || (dur > 20 && ratio < 0.15)) return -3 / 6;
    if (ratio >= 0.7 || ws >= 25) return 1;
    return 0.5 / 6;
  }
  return 1 / 6;
}

export function trainingRows(hist, likes = [], dislikes = []) {
  const rows = [];
  let si = 0;
  hist.forEach((v, gi) => {
    if (isShort(v)) {
      // shorts: own outcomes (loop/skip/dwell), fast decay, last 8 count double
      const i = si++;
      const o = outcome(v);
      rows.push({ v, w: o * (1 / (1 + i / 10)) * (i < 8 ? 2 : 1), o, long: false });
    } else {
      // long-form: FYP decay (index over the whole history, as histProfile does)
      const o = longOutcome(v);
      rows.push({ v, w: o * (1 / (1 + gi / 6)), o, long: true });
    }
  });
  // likes: FYP weights a like like a watched-through video (6 = 6), decaying /8
  likes.forEach((v, i) => rows.push(isShort(v)
    ? { v, w: 1.5 / (1 + i / 12), o: 1.5, long: false }
    : { v, w: 1 / (1 + i / 8), o: 1, long: true }));
  dislikes.forEach((v, i) => rows.push({ v, w: -2 / (1 + i / 12), o: -1, long: !isShort(v) }));
  return rows;
}

export function buildProfile(rows, subs = []) {
  const topic = new Map(); const topicN = new Map(); const chan = new Map(); const chanN = new Map();
  let durW = 0; let durSum = 0;
  for (const { v, w, o } of rows) {
    for (const t of new Set(words(v.title))) {
      topic.set(t, (topic.get(t) || 0) + w);
      topicN.set(t, (topicN.get(t) || 0) + 1);
    }
    const c = String(v.channel || '').trim();
    if (c) { chan.set(c, (chan.get(c) || 0) + o); chanN.set(c, (chanN.get(c) || 0) + 1); }
    if (o > 0.2 && isShort(v)) { const d = v.secs || parseSecs(v.duration); if (d) { durW += o; durSum += o * d; } }
  }
  for (const s of subs) { const c = String(s.name || '').trim(); if (c) { chan.set(c, (chan.get(c) || 0) + 3); chanN.set(c, (chanN.get(c) || 0) + 1); } }
  return { topic, topicN, chan, chanN, prefDur: durW > 1 ? durSum / durW : null, exposures: rows.length };
}

// embedding centroid from SHORTS only: positives pull, skips push half as hard.
export function shortCentroid(rows, embed) {
  if (!embed) return null;
  let acc = null; let str = 0;
  for (const { v, w } of rows) {
    const e = embed(v.id); if (!e) continue;
    if (!acc) acc = new Float64Array(e.length);
    const k = w > 0 ? w : w * 0.5;
    for (let d = 0; d < e.length; d++) acc[d] += k * e[d];
    if (w > 0) str += w;
  }
  if (!acc || str < 1.5) return null;
  let n = 0; for (const x of acc) n += x * x; n = Math.sqrt(n) || 1;
  return Array.from(acc, (x) => x / n);
}
const cos = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

// candidate seeds for the shorts pool. different from for-you: shorts-first
// phrasing, channels that LOOP for this account, rising topics, plus a
// rotating exploration seed pulled from weak-but-positive topics so the pool
// widens instead of tunneling.
export function shortsSeeds(profile, n = 0, rng = Math.random) {
  const pos = [...profile.topic.entries()].filter(([, w]) => w > 0.4).sort((a, b) => b[1] - a[1]);
  const chans = [...profile.chan.entries()].filter(([, w]) => w > 0.8).sort((a, b) => b[1] - a[1]).map(([c]) => c);
  const out = [];
  for (let i = 0; i < 2; i++) { const c = chans[(n + i) % Math.max(chans.length, 1)]; if (c) out.push(`${c} shorts`); }
  const head = pos.slice(0, 6).map(([t]) => t);
  if (head.length) out.push(`${head[n % head.length]} shorts`);
  if (head.length > 1) out.push(`${head[0]} ${head[1 + (n % (head.length - 1))]} shorts`);
  const tail = pos.slice(6, 30).map(([t]) => t);   // adjacent interests: exploration
  if (tail.length) out.push(`${tail[Math.floor(rng() * tail.length)]} shorts`);
  out.push(['funny shorts', 'satisfying shorts', 'skill shorts', 'animals shorts', 'cooking shorts', 'science shorts', 'gaming shorts', 'music shorts'][(n + Math.floor(rng() * 8)) % 8]);
  return [...new Set(out)].slice(0, 6);
}

export function scoreShort(v, P, { taste = null, embed = null, now = Date.now(), rng = Math.random, explore = true } = {}) {
  const f = {};
  // topic fit: bounded squash of summed word weights (negatives push down)
  let tw = 0; let seenWords = 0;
  for (const t of new Set(words(v.title + ' ' + (v.desc || '').slice(0, 160)))) {
    if (P.topic.has(t)) { tw += P.topic.get(t) / Math.sqrt(1 + (P.topicN.get(t) || 0)); seenWords++; }
  }
  f.topic = 60 * Math.tanh(tw / 3);
  // semantic fit, shorts-only centroid
  f.embed = 0;
  if (taste && embed) { const e = embed(v.id); if (e) f.embed = Math.max(-60, Math.min(90, (cos(e, taste) - 0.08) * 330)); }
  // channel reliability: smoothed mean outcome (prior 0, 2 pseudo-obs)
  const c = String(v.channel || '').trim();
  const cn = P.chanN.get(c) || 0;
  f.chan = cn ? 28 * ((P.chan.get(c) || 0) / (cn + 2)) : 0;
  // duration fit: shorts the account actually finishes cluster at a length
  const d = v.secs;
  f.dur = P.prefDur && d ? -14 * Math.min(1, Math.abs(d - P.prefDur) / Math.max(15, P.prefDur)) : 0;
  if (d != null && d < 6) f.dur -= 10; // too-brief clips are mostly broken/loops of nothing
  // freshness + velocity (views per day) - shorts live and die by recency
  const age = parseAgoDays(v.published);
  f.fresh = age == null ? 0 : age <= 1 ? 12 : age <= 7 ? 8 : age <= 30 ? 3 : age > 365 ? -4 : 0;
  const vw = parseViews(v.views);
  f.pop = vw > 0 ? Math.min(14, Math.log10(vw) * 2) : 0;
  f.vel = vw > 0 && age != null ? Math.min(8, Math.log10(1 + vw / Math.max(age, 0.5)) * 1.6) : 0;
  f.bait = BAIT.test(String(v.title)) && f.topic <= 0 ? -30 : 0;
  // exploration bonus: unseen vocabulary is worth a look (UCB flavored)
  f.explore = explore && seenWords === 0 ? 10 : 0;
  f.jitter = explore ? rng() * 4 : 0;
  const total = Object.values(f).reduce((a, b) => a + b, 0);
  return { total, f, novel: seenWords === 0 && !(cn > 0) };
}

const jacc = (a, b) => { let i = 0; for (const x of a) if (b.has(x)) i++; const u = a.size + b.size - i; return u ? i / u : 0; };

// main entry. returns ordered shorts. cands: parsed search results (any
// length); everything else comes from the account's state.
export function rankShorts(cands, state, opts = {}) {
  const { hist = [], likes = [], dislikes = [], subs = [], dead = new Set(), served = new Set() } = state;
  const { embed = null, now = Date.now(), rng = Math.random, limit = 14, exploreFrac = 0.2, perChan = 2, lambda = 28 } = opts;
  const explore = exploreFrac > 0; // exploreFrac 0 = a query: no exploration, no jitter, deterministic order
  const rows = trainingRows(hist, likes, dislikes);
  const P = buildProfile(rows, subs);
  const taste = shortCentroid(rows, embed);
  const seen = new Set([...hist, ...likes, ...dislikes].map((v) => v.id));
  const pool = [];
  const dup = new Set();
  for (const v of cands) {
    if (!v || !v.id || dup.has(v.id) || seen.has(v.id) || dead.has(v.id) || served.has(v.id)) continue;
    const secs = v.secs ?? parseSecs(v.duration);
    if (secs == null || secs > SHORT_MAX) continue;
    dup.add(v.id);
    const w = { ...v, secs };
    const sc = scoreShort(w, P, { taste, embed, now, rng, explore });
    // a hard-skipped channel/topic never makes a batch
    if (sc.total < -25) continue;
    pool.push({ v: w, s: sc.total, novel: sc.novel, set: new Set(words(w.title)), e: embed ? embed(w.id) : null });
  }
  pool.sort((a, b) => b.s - a.s);
  const out = []; const chanCount = new Map();
  const nExplore = exploreFrac <= 0 ? 0 : P.exposures < 8 ? Math.ceil(limit * Math.max(0.4, exploreFrac)) : Math.round(limit * exploreFrac);
  const exploitN = limit - nExplore;
  const simTo = (x, y) => (x.e && y.e ? Math.max(0, cos(x.e, y.e)) : jacc(x.set, y.set));
  const take = (cand, bonus = 0) => { out.push(cand); chanCount.set(cand.v.channel, (chanCount.get(cand.v.channel) || 0) + 1); pool.splice(pool.indexOf(cand), 1); };
  // exploit: greedy MMR - best score minus redundancy with what is already picked
  while (out.length < exploitN && pool.length) {
    let best = null; let bs = -Infinity;
    for (const c of pool) {
      if ((chanCount.get(c.v.channel) || 0) >= perChan) continue;
      let red = 0; for (const o of out) red = Math.max(red, simTo(c, o));
      const sc = c.s - lambda * red * 3;
      if (sc > bs) { bs = sc; best = c; }
    }
    if (!best) break;
    take(best);
  }
  // explore: novel-topic shorts with a decent quality prior, random among the top of them
  const novel = !explore ? [] : pool.filter((c) => c.novel && c.s > -5).sort((a, b) => b.s - a.s).slice(0, 12);
  while (out.length < limit && novel.length) {
    const c = novel.splice(Math.floor(rng() * novel.length), 1)[0];
    if ((chanCount.get(c.v.channel) || 0) >= perChan) continue;
    take(c);
  }
  // top up from the remainder if exploration came up short
  for (const c of [...pool]) { if (out.length >= limit) break; if ((chanCount.get(c.v.channel) || 0) < perChan) take(c); }
  // sequencing: exploration slots go at positions 3,7,11 (never first), and no
  // two neighbors share a channel
  const seq = out.slice();
  const explored = explore ? seq.filter((c) => c.novel) : []; const core = explore ? seq.filter((c) => !c.novel) : seq.slice();
  const final = [];
  let ei = 0;
  for (let i = 0; i < seq.length; i++) {
    if ((i === 2 || i === 6 || i === 10) && ei < explored.length) final.push(explored[ei++]);
    else if (core.length) final.push(core.shift()); else if (ei < explored.length) final.push(explored[ei++]);
  }
  while (ei < explored.length) final.push(explored[ei++]);
  for (let i = 1; i < final.length; i++) {
    if (final[i].v.channel && final[i].v.channel === final[i - 1].v.channel) {
      const j = final.findIndex((c, k) => k > i && c.v.channel !== final[i - 1].v.channel);
      if (j > 0) [final[i], final[j]] = [final[j], final[i]];
    }
  }
  return final.map((c) => ({ ...c.v, score: c.s }));
}

// per-account feed cache: single-flight builds, stale-while-revalidate, served
// filtering. a cached list answers instantly; a rebuild runs behind it. only a
// cold account (or one that has burned through its cached batch) waits, and
// all concurrent callers for that account share ONE build.
export function createShortsFeed({ build, ttl = 4 * 60 * 1000, cap = 200, now = Date.now, minLeft = 6, servedCap = 60 }) {
  const cache = new Map();
  const entry = (u) => {
    let h = cache.get(u);
    if (!h) {
      h = { at: 0, ranked: [], served: new Set(), rerank: null, rerankGen: -1, gen: 0, n: 0 };
      cache.set(u, h);
      if (cache.size > cap) cache.delete(cache.keys().next().value);
    }
    return h;
  };
  // every state change that makes an in-flight build stale (watch outcome,
  // like, dislike, sub, clear) bumps gen: a build started under an older gen
  // may finish, but its result is discarded and never refreshes the timestamp.
  const bump = (h) => { h.gen++; h.at = 0; };
  const kick = (u, h, embedWaitMs) => {
    if (h.rerank && h.rerankGen === h.gen) return h.rerank;
    const gen = h.gen;
    h.n++;
    const p = Promise.resolve().then(() => build(u, h, { embedWaitMs })).then((r) => {
      if (gen === h.gen && Array.isArray(r) && r.length) { h.ranked = r; h.at = now(); }
    }).finally(() => { if (h.rerank === p) h.rerank = null; });
    h.rerank = p; h.rerankGen = gen;
    return p;
  };
  return {
    async get(u, { fresh = false, limit = 14 } = {}) {
      const h = entry(u);
      const left = () => h.ranked.filter((v) => !h.served.has(v.id));
      if (left().length < minLeft) {            // cold or exhausted: the only blocking path, shared by all callers
        let err = null; let out = [];
        for (let attempt = 0; attempt < 2; attempt++) {   // a 2nd pass only if feedback landed mid-build and discarded it
          try { await kick(u, h, 2500); } catch (e) { err = e; break; }
          out = left().slice(0, limit);
          if (out.length) break;
        }
        if (!out.length && err) throw err;
        return out;
      }
      if (fresh || h.at === 0 || now() - h.at >= ttl) kick(u, h, 8000).catch(() => {}); // refresh behind the answer
      return left().slice(0, limit);
    },
    serve(u, items) {
      const h = cache.get(u); if (!h) return;
      for (const v of items) h.served.add(v.id);
      while (h.served.size > servedCap) h.served.delete(h.served.values().next().value);
    },
    // like/dislike/sub: drop the cached list, keep served so nothing repeats
    invalidate(u) { const h = cache.get(u); if (h) { bump(h); h.ranked = []; } },
    // watch outcome arrived: keep serving the current list, rebuild behind it
    touch(u) { const h = cache.get(u); if (h) bump(h); },
    // explicit full reset (clear history): the whole entry goes, served state too
    reset(u) { const h = cache.get(u); if (h) { h.gen++; cache.delete(u); } },
    clear() { for (const h of cache.values()) { bump(h); h.ranked = []; } },
    _cache: cache,
  };
}
