<script>
  import { readSearches, addSearch } from '../../lib/searchhist.js';
  import '../../tokens.css';
  import { onMount, tick } from "svelte";
  import { api } from '../../lib/api.js';

  let q = $state('');
  let results = $state([]);
  let watching = $state(null);
  let busy = $state(false);
  let error = $state('');
  let searched = $state(false);
  let kind = $state('video'); // search tab: video | channel | playlist
  let kres = $state({ channel: null, playlist: null, q: '' });
  let bioOpen = $state(false);
  let plQ = $state('');
  let plRev = $state(false);
  let plTotal = $state(0);
  let plNext = 0;
  let plDone = $state(false);
  let plHidden = $state(0);
  let plLoading = false;
  let plTimer = null;
  const plUrl = (extra) => `/api/apps/jetstream/playlist?id=${encodeURIComponent(plPage.id)}&q=${encodeURIComponent(plQ.trim())}&rev=${plRev ? 1 : 0}${extra}`;
  async function loadPl(reset) {
    if (!plPage || plLoading) { if (reset && plLoading) setTimeout(() => loadPl(true), 150); return; }
    const id = plPage.id; const q0 = plQ; const rev0 = plRev;
    plLoading = true;
    const r = await api(plUrl(`&offset=${reset ? 0 : plNext}&limit=50`));
    plLoading = false;
    if (!plPage || plPage.id !== id) return;
    if (!r.ok) { if (reset || !plPage.items) plPage = { ...plPage, err: r.data?.error || "can't load this playlist" }; return; }
    if (q0 !== plQ || rev0 !== plRev) { loadPl(true); return; } // changed while loading
    plTotal = r.data.total; plNext = r.data.next; plDone = r.data.done; plHidden = r.data.hidden || 0;
    plPage = { ...plPage, err: '', name: r.data.name || plPage.name, channel: r.data.channel || plPage.channel, channelId: r.data.channelId || plPage.channelId, count: r.data.count, items: reset ? r.data.items : [...(plPage.items || []), ...r.data.items.filter((x) => !(plPage.items || []).some((y) => y.id === x.id))] };
  }
  function plSearchInput() { clearTimeout(plTimer); plTimer = setTimeout(() => loadPl(true), 300); }
  function plToggleRev() { plRev = !plRev; loadPl(true); }
  function plMore(node) {
    const io = new IntersectionObserver((e) => { if (e[0].isIntersecting && plPage?.items && !plDone) loadPl(false); }, { rootMargin: '700px' });
    io.observe(node);
    return { destroy() { io.disconnect(); } };
  }
  async function plAll() {
    const r = await api(plUrl('&all=1'));
    return r.ok ? r.data.items : (plPage?.items || []);
  }
  async function playPlFrom(v) {
    const all = await plAll();
    const idx = Math.max(0, all.findIndex((x) => x.id === v.id));
    autoplay = { items: all, idx, channelName: plPage.name };
    watch(v, true);
  }
  async function shufflePl() {
    const l = [...(await plAll())];
    if (!l.length) return;
    for (let i = l.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [l[i], l[j]] = [l[j], l[i]]; }
    autoplay = { items: l, idx: 0, channelName: plPage.name + ' (shuffled)' };
    watch(l[0], true);
  }
  let plPage = $state(null); // playlist page: { id, name, channel, channelId, count, items, err }
  let videoEl = $state(null);
  let portrait = $state(false);

  const chips = ['lofi beats', 'minecraft', 'music videos', 'gaming'];

  // keep watching: your last few, on the home screen
  let history = $state([]);
  let shorts = $state([]);
  let forYou = $state([]);
  onMount(async () => {
    const r = await api('/api/apps/jetstream/history');
    if (r.ok) history = r.data.items || [];
    api('/api/apps/jetstream/shorts').then((s) => { if (s.ok) shorts = s.data.items || []; });
    api('/api/apps/jetstream/for-you').then((f) => { if (f.ok) forYou = f.data.items || []; });
    api('/api/apps/jetstream/likes').then((l) => { if (l.ok) liked = new Set(l.data.ids || []); });
    api('/api/apps/jetstream/dislikes').then((d) => { if (d.ok) dislikedSet = new Set(d.data.ids || []); });
    api('/api/apps/jetstream/subs/new').then((r) => { if (r.ok) newSubs = r.data.items || []; });
    api('/api/apps/jetstream/subs').then((s) => { if (s.ok) subs = new Set((s.data.subs || []).map((x) => x.id)); });
    // deeplink: /jetstream?v=<video id> plays it, ?q=<words> searches (browse's "open in jetstream" button)
    try {
      const sp = new URLSearchParams(location.search);
      const dv = sp.get('v'), dq = sp.get('q');
      if (dv && /^[\w-]{11}$/.test(dv)) watch({ id: dv, title: '', channel: '', duration: '' });
      else if (dq && dq.trim()) { q = dq.trim().slice(0, 200); search(); }
      if (dv || dq) window.history.replaceState(null, '', location.pathname);
    } catch {}
    window.addEventListener('popstate', () => { if (pushed > 0) pushed--; fromPop = true; goBack(); });
    window.addEventListener('scroll', () => {
      if (searched || watching || chanPage || subsPage || feedOpen) return;
      if (window.innerHeight + window.scrollY > document.body.scrollHeight - 900) loadMoreForYou();
    }, { passive: true });
    // app backgrounded / tab closed mid-watch: the last slide's outcome is
    // the one a plain close never reports - beacon it out on the way down.
    window.addEventListener('pagehide', () => flushOutcomes(true));
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushOutcomes(true); });
  });

  async function loadMoreForYou() {
    if (fyBusy || fyDone) return;
    fyBusy = true;
    const r = await api(`/api/apps/jetstream/for-you?offset=${forYou.length}`);
    fyBusy = false;
    if (!r.ok) return;
    const items = r.data.items || [];
    if (!items.length || !r.data.more) fyDone = true;
    if (items.length) {
      const have = new Set(forYou.map((v) => v.id));
      forYou = [...forYou, ...items.filter((v) => !have.has(v.id))];
    }
  }

  // subscriptions manager (Luke 6:44 PM): every sub, tap through to the
  // channel, unsubscribe in place.
  async function openSubs() {
    back();
    chanPage = null;
    subsPage = { list: null };
    window.scrollTo(0, 0);
    const r = await api('/api/apps/jetstream/subs');
    if (!subsPage) return;
    subsPage = { list: r.ok ? (r.data.subs || []) : [] };
  }
  function closeSubs() { subsPage = null; }
  async function unsubFromPage(s2) {
    const r = await api('/api/apps/jetstream/subs/toggle', { method: 'POST', body: { id: s2.id, name: s2.name } });
    if (!r.ok || r.data.subbed) return;
    const s3 = new Set(subs); s3.delete(s2.id); subs = s3;
    subsPage = { list: (subsPage?.list || []).filter((x) => x.id !== s2.id) };
  }
  async function removeHistory(v, e) {
    e.stopPropagation();
    history = history.filter((x) => x.id !== v.id);
    await api('/api/apps/jetstream/history/delete', { method: 'POST', body: { id: v.id } });
  }

  async function recordWatch(v) {
    await api('/api/apps/jetstream/history', {
      method: 'POST',
      body: { id: v.id, title: v.title, channel: v.channel || '', duration: v.duration || '' },
    });
    const r = await api('/api/apps/jetstream/history');
    if (r.ok) history = r.data.items || [];
  }


  // shorts feed: full-screen vertical snap scroll. shorts play the hd pair
  // (adaptive video + m4a audio, the main player's proven pattern - 360p was
  // rough on a phone), falling back to the muxed stream if hd hiccups. only
  // the slide on screen (and the one after it) holds a stream: the next slide
  // pre-buffers its first seconds so a swipe starts hot, far slides drop
  // everything so doom-scrolling can't burn the hourly byte budget.
  let feedOpen = $state(false);
  let feedWrap = $state(null);
  let feedQ = $state('');
  let feedSearchOpen = $state(false); // the search pill stays out of the way until asked for (Luke 6:37 PM)
  let feedMode = $state('foryou'); // 'foryou' = your ranked feed, 'search' = searched shorts
  let feedSearchErr = $state('');
  let liked = $state(new Set());
  let dislikedSet = $state(new Set());
  let chanTab = $state('videos');
  let chanPage = $state(null); // channel page: { id, name, videos, shorts, err }
  // video summary (free hosted model, from captions)
  let sum = $state(null); // null | {loading} | {data} | {error}
  async function runSummary() {
    if (!watching || sum?.loading) return;
    if (sum?.data) { sum = null; return; }
    const id = watching.id;
    sum = { loading: true };
    const r = await api('/api/apps/jetstream/summary?id=' + encodeURIComponent(id));
    if (watching?.id !== id) return;
    sum = r.ok && r.data?.ok ? { data: r.data } : { error: r.data?.error || "couldn't summarize this one" };
  }
  function jumpTo(t) { if (videoEl) { try { videoEl.currentTime = t; videoEl.play?.(); } catch {} } }
  import { techOn } from './../../lib/tech.js';
  let statsOpen = $state(false), stats = $state(null);
  let statsTimer = null;
  function readStats() {
    const v = videoEl; if (!v) { stats = null; return; }
    let buf = 0; try { for (let i = 0; i < v.buffered.length; i++) if (v.buffered.start(i) <= v.currentTime + 0.5 && v.buffered.end(i) >= v.currentTime) buf = v.buffered.end(i) - v.currentTime; } catch {}
    const q = v.getVideoPlaybackQuality?.();
    stats = { res: v.videoWidth ? v.videoWidth + 'x' + v.videoHeight : 'audio', buf: buf.toFixed(1), dropped: q ? q.droppedVideoFrames + '/' + q.totalVideoFrames : 'n/a', src: audioOnly ? 'audio only (proxy)' : hdMode ? 'hd video + audio (proxy)' : '360p combined (proxy)', rate: v.playbackRate, state: v.paused ? 'paused' : 'playing', net: v.networkState, ready: v.readyState };
  }
  function toggleStats() {
    statsOpen = !statsOpen; clearInterval(statsTimer);
    if (statsOpen) { readStats(); statsTimer = setInterval(readStats, 700); }
  }
  let newSubs = $state([]); // fresh uploads from subscribed channels
  let subsPage = $state(null); // subscriptions manager (Luke 6:44 PM)
  let fyBusy = false; let fyDone = false;
  let subs = $state(new Set()); // subscribed channel ids
  let autoplay = $state(null); // { items, idx, channelName } - the play-all chain
  let feedPlaying = $state(-1);
  let feedErr = $state({});
  let feedLoading = $state({});
  let lastActive = -1;
  let observer = null;
  let feedAudio = {};
  let driftTimer = null;
  const watched = {}; // idx -> max seconds reached - the algorithm's core signal
  let prefetchGen = 0; // settle-guard generation: stale warmups die on swipe
  let feedGuard = null;
  let feedBridge = null;

  // belt and braces: whatever the observer timing does, only the active slide
  // (or a slide mid-prebuffer) may be audible/playing.
  function armFeedGuard() {
    if (feedGuard) return;
    feedGuard = setInterval(() => {
      if (!feedWrap) return;
      feedWrap.querySelectorAll('video').forEach((vid) => {
        const i = parseInt(vid.dataset.idx, 10);
        if (i !== feedPlaying && !vid.paused) { vid.pause(); killAudio(i); }
      });
    }, 1500);
  }

  // ios blocks the hd audio track until a real gesture - first touch anywhere
  // in the feed kicks it in, same pattern as the main player.
  function armFeedBridge() {
    if (feedBridge) return;
    feedBridge = () => {
      const a = feedAudio[feedPlaying];
      const vid = feedVideo(feedPlaying);
      if (a && vid && !vid.paused && a.paused) { syncSlideAudio(feedPlaying, true); a.play().catch(() => {}); }
      if (!a && vid && !vid.paused && vid.muted) vid.muted = false; // muxed slide that started muted - sound on first touch
    };
    document.addEventListener('touchstart', feedBridge, { passive: true });
    document.addEventListener('click', feedBridge);
  }

  function killAudio(i) {
    const a = feedAudio[i];
    if (a) { a.pause(); a.remove(); delete feedAudio[i]; }
  }

  function setupAudio(i, url) {
    killAudio(i);
    const a = new Audio(url);
    a.preload = 'auto';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.addEventListener('error', () => {
      if (feedAudio[i] !== a) return;
      // Only a failed direct source can switch routes. A failed proxy must
      // not reload itself in a loop or interrupt the playing video.
      if (!slideProxy[i] && !directDead) swapToProxy(i, 'audio-error');
    });
    feedAudio[i] = a;
  }

  // sync, old-jetstream port (Luke, Tue 5:30 PM - "new approach"): the exact
  // model the old watch page ran for months on his iPhone. one video holds a
  // src at a time (no prebuffer, no muted-play warmup), the audio element is
  // DOM-attached and lazily built, and a 600ms caretaker mirrors the old
  // player's: audio follows play/pause, hard-seeks past 0.3s of drift, and
  // restarts the audio if it died while the video runs. no rate API, no
  // waiting-event interference - audio rides through a video stall, exactly
  // like the old build that never froze for him.
  function syncSlideAudio(i, hard) {
    const v = feedVideo(i); const a = feedAudio[i];
    if (!v || !a) return;
    if (hard || Math.abs(a.currentTime - v.currentTime) > 0.3) a.currentTime = v.currentTime;
  }

  const reported = new Set();
  function reportSlide(i) {
    if (reported.has(i)) return;
    reported.add(i);
    const v = feedVideo(i);
    if (!v || !v.videoWidth) { if (feedPlaying === i) setTimeout(() => { reported.delete(i); reportSlide(i); }, 1200); return; }
    api('/api/apps/jetstream/clientlog', { method: 'POST', body: { kind: feedAudio[i] || v.muted ? 'slide-hd' : 'slide-muxed', id: shorts[i]?.id || '', vw: v.videoWidth, vh: v.videoHeight, hd: !!(feedAudio[i] || v.muted), path: slideProxy[i] ? 'proxy' : 'direct', ua: navigator.userAgent } }).catch(() => {});
  }

  function onSlidePlay(i) {
    feedPlaying = i;
    reportSlide(i);
    const a = feedAudio[i];
    if (a) { a.muted = false; a.volume = 1; syncSlideAudio(i, true); a.play().catch(() => {}); }
    if (!driftTimer) driftTimer = setInterval(() => {
      const v = feedVideo(feedPlaying); const a2 = feedAudio[feedPlaying];
      if (!v || !a2) return;
      if (v.paused) { if (!a2.paused) a2.pause(); return; }
      if (a2.paused) { syncSlideAudio(feedPlaying, true); a2.play().catch(() => {}); return; }
      if (Math.abs(a2.currentTime - v.currentTime) > 0.3) a2.currentTime = v.currentTime;
    }, 600);
  }

  function onSlidePause(i) { feedAudio[i]?.pause(); }

  // direct-first (Luke 6:08 PM): if his network doesn't filter googlevideo,
  // the CDN serves him straight and the box leaves the path - that is the
  // whole speed problem gone. every slide starts direct with a 5s no-data
  // watchdog; a blocked or dead source swaps to the ramjet proxy exactly
  // once and that slide stays proxied. the proxy carries filtered networks.
  const slideResolve = {};
  const slideProxy = {};
  const directWatchdog = {};
  // once direct fails anywhere it fails everywhere on this network - one
  // probe per SESSION, not per slide. Luke 6:26 PM: "scrolling takes
  // forever" was every slide burning a dead direct try on his filtered
  // network before the proxy swap. the flag resets with the tab (a new
  // network gets a fresh probe).
  let directDead = sessionStorage.getItem('rj-direct') === 'dead';
  function markDirectDead() {
    directDead = true;
    try { sessionStorage.setItem('rj-direct', 'dead'); } catch {}
  }

  function clearWatchdog(i) {
    if (directWatchdog[i]) { clearTimeout(directWatchdog[i]); delete directWatchdog[i]; }
  }

  function swapToProxy(i, why) {
    const d = slideResolve[i];
    const vid = feedVideo(i);
    if (!d || !vid || slideProxy[i]) return;
    slideProxy[i] = true;
    markDirectDead();
    clearWatchdog(i);
    vid.dataset.srcmode = 'proxy';
    if (d.hd) {
      vid.muted = true;
      vid.src = d.hd.video;
      if (feedAudio[i]) setupAudio(i, d.hd.audio);
    } else {
      vid.muted = false;
      vid.src = `/api/apps/jetstream/stream?id=${shorts[i]?.id}`;
    }
    vid.load();
    if (feedPlaying === i) vid.play().catch(() => {});
    api('/api/apps/jetstream/clientlog', { method: 'POST', body: { kind: 'slide-proxy-fallback', id: shorts[i]?.id || '', why: why || '', ua: navigator.userAgent } }).catch(() => {});
    // one dead direct means the network filters googlevideo: re-point every
    // slide that was ALREADY attached direct (the pre-warmed next slides got
    // their src before the session flag flipped) instead of letting each one
    // burn its own dead direct try. Luke's 6 PM telemetry: 26 fallbacks in
    // one session - every one was a slide waiting on a try that could never
    // work.
    for (const k of Object.keys(slideResolve)) {
      const j = +k;
      if (j !== i && !slideProxy[j] && feedVideo(j)?.dataset.srcmode === 'direct') swapToProxy(j, 'direct-dead-session');
    }
  }

  function armDirectWatchdog(i) {
    clearWatchdog(i);
    directWatchdog[i] = setTimeout(() => {
      delete directWatchdog[i];
      const vid = feedVideo(i);
      if (vid && vid.dataset.srcmode === 'direct' && vid.readyState < 2) swapToProxy(i, 'no-data-5s');
    }, 5000);
  }

  function attachStream(i, d, videoOnly) {
    const vid = feedVideo(i);
    if (!vid) return;
    slideResolve[i] = d;
    vid.preload = 'auto';
    const proxied = !!slideProxy[i] || directDead;
    if (d.hd) {
      vid.muted = true;
      vid.src = proxied ? d.hd.video : (d.hd.directVideo || d.hd.video);
      vid.dataset.srcmode = proxied || !d.hd.directVideo ? 'proxy' : 'direct';
      if (!videoOnly) setupAudio(i, proxied ? d.hd.audio : (d.hd.directAudio || d.hd.audio));
    } else {
      vid.muted = false;
      vid.src = proxied ? d.stream : (d.direct || d.stream);
      vid.dataset.srcmode = proxied || !d.direct ? 'proxy' : 'direct';
    }
    if (vid.dataset.srcmode === 'direct') armDirectWatchdog(i);
  }

  function onSlideErr(i) {
    const ev = feedVideo(i);
    if (ev && ev.dataset.srcmode === 'direct' && !slideProxy[i]) { swapToProxy(i, 'video-error'); return; }
    // hd pair hiccuped? drop to the muxed stream once, like the main player
    if (feedAudio[i]) {
      killAudio(i);
      const v = feedVideo(i);
      if (v) { v.muted = false; v.src = `/api/apps/jetstream/stream?id=${shorts[i].id}`; v.play().catch(() => {}); }
      return;
    }
    // every fallback failed - the video is dead to him: pull it, don't card it.
    killAudio(i);
    shorts = shorts.filter((_, x) => x !== i);
    if (feedPlaying === i) feedPlaying = -1;
  }

  function feedVideo(i) { return feedWrap?.querySelector(`video[data-idx="${i}"]`) || null; }

  // desktop chrome/firefox decode vp9 webm - that unlocks 1080p on videos
  // whose avc1 ladder stops short (Luke 6:43 PM). safari says no, stays avc1.
  const canVp9 = (() => { try { return document.createElement('video').canPlayType('video/webm; codecs="vp9"') === 'probably'; } catch { return false; } })();
  // phone = low-data mode: 720p tier (pixel-exact on a phone screen, about half
  // the bytes of 1080p) and lighter prefetch. desktop keeps the full tier.
  const isPhone = (() => { try { const ds = localStorage.getItem('rj-datasaver'); if (ds === 'on') return true; if (ds === 'off') return false; return /iPhone|Android.*Mobile/.test(navigator.userAgent) || (matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) <= 500); } catch { return false; } })();
  const watchUrl = (id) => `/api/apps/jetstream/watch?id=${id}${canVp9 ? '&vp9=1' : ''}${isPhone ? '&lite=1' : ''}`;

  let pullingMore = false;
  let lastAheadAt = -1;
  let prog = $state({}); // idx -> { cur, dur } for the seek bar
  const stalls = {}; // idx -> waiting-event count, reported when the slide is swept
  function onSlideWaiting(i) { stalls[i] = (stalls[i] || 0) + 1; }
  function reportStalls(i) {
    const n = stalls[i] || 0;
    if (!n) return;
    delete stalls[i];
    api('/api/apps/jetstream/clientlog', { method: 'POST', body: { kind: 'slide-stalls', id: shorts[i]?.id || '', vw: n, vh: 0, hd: !!feedAudio[i], ua: navigator.userAgent } }).catch(() => {});
  }
  let pullRetries = 0;

  function progPct(i) {
    const x = prog[i];
    return x && x.dur > 0 ? Math.min(100, (x.cur / x.dur) * 100) : 0;
  }

  function onSlideTime(i, e) {
    const v = e.currentTarget;
    if (v.currentTime > (watched[i] || 0)) watched[i] = v.currentTime;
    prog = { ...prog, [i]: { cur: v.currentTime, dur: v.duration || 0 } };
  }

  // tell the server how much of this short he actually watched: quick skips
  // teach the feed "less of this", full watches "more". posts on the way out.
  function reportOutcome(i) {
    const v = shorts[i];
    const ws = watched[i];
    if (!v || ws == null) return;
    delete watched[i];
    api('/api/apps/jetstream/history', { method: 'POST', body: { id: v.id, title: v.title, channel: v.channel || '', duration: v.duration || '', watched: Math.round(ws) } }).catch(() => {});
  }

  // post every still-pending outcome at once - feed close, list swap, or
  // the page going away. a fetch dies mid-flight on unload, so that path
  // uses sendBeacon (cookies ride same-origin, the server parses the raw
  // body regardless of content-type).
  function flushOutcomes(beacon) {
    for (const k of Object.keys(watched)) {
      const v = shorts[+k];
      const ws = watched[k];
      delete watched[k];
      if (!v || ws == null) continue;
      const body = { id: v.id, title: v.title, channel: v.channel || '', duration: v.duration || '', watched: Math.round(ws) };
      if (beacon && navigator.sendBeacon) navigator.sendBeacon('/api/apps/jetstream/history', JSON.stringify(body));
      else api('/api/apps/jetstream/history', { method: 'POST', body }).catch(() => {});
    }
  }

  // tap-to-seek (youtube shorts parity): jump the pair - video and its
  // synced audio element - to the tapped spot.
  function seekSlide(i, e) {
    const v = feedVideo(i);
    if (!v || !isFinite(v.duration) || v.duration <= 0) return;
    const r = e.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    v.currentTime = ratio * v.duration;
    if (feedAudio[i]) feedAudio[i].currentTime = v.currentTime;
    prog = { ...prog, [i]: { cur: v.currentTime, dur: v.duration } };
  }

  async function activateSlide(i) {
    const vid = feedVideo(i);
    if (!vid || feedErr[i]) return;
    lastActive = i;
    // tell the box where he is: the next slides jump the prefetch queue so
    // his scroll position always has warm disk behind it, not the live proxy
    if (i !== lastAheadAt) {
      lastAheadAt = i;
      const ahead = shorts.slice(i + 1, i + (isPhone ? 4 : 6)).map((s) => s?.id).filter(Boolean);
      if (ahead.length) api('/api/apps/jetstream/clientlog', { method: 'POST', body: { kind: 'slide-ahead', ids: ahead, id: ahead[0], vw: ahead.length, ua: navigator.userAgent, lite: isPhone } }).catch(() => {});
    }
    // endless feed: landing on the last slide quietly pulls a fresh batch
    if (i >= shorts.length - 1 && !pullingMore && feedMode === 'foryou') {
      pullingMore = true;
      api('/api/apps/jetstream/shorts?fresh=1').then((r) => {
        if (!r.ok) { pullingMore = false; return; }
        const have = new Set(shorts.map((v) => v.id));
        const more = (r.data.items || []).filter((v) => !have.has(v.id));
        if (more.length) {
          pullingMore = false; pullRetries = 0;
          shorts = [...shorts, ...more]; setTimeout(setupObserver, 60);
        } else if (pullRetries < 3) {
          // the server answered instantly with the current batch while the
          // next one builds behind it - try again in a beat, capped so an
          // exhausted pool never polls forever.
          pullRetries++;
          setTimeout(() => { pullingMore = false; if (lastActive >= shorts.length - 1) activateSlide(shorts.length - 1); }, 2500);
        } else { pullingMore = false; pullRetries = 0; }
      }).catch(() => { pullingMore = false; });
    }
    // hard sweep: the active slide and the next (buffer-only warmup, never
    // played) may hold a src. everything else drops its src and decoder.
    feedWrap?.querySelectorAll('video').forEach((v) => {
      const idx = parseInt(v.dataset.idx, 10);
      if (idx !== i && idx !== i + 1 && v.src) {
        v.pause();
        reportOutcome(idx);
        reportStalls(idx);
        clearWatchdog(idx);
        v.removeAttribute('src');
        v.load();
        killAudio(idx);
      }
    });
    try {
      if (!vid.src) {
        feedLoading = { ...feedLoading, [i]: true };
        const r = await api(watchUrl(shorts[i].id));
        feedLoading = { ...feedLoading, [i]: false };
        if (!r.ok) {
          // can't play = never surface (Luke 6:28 PM): the slide leaves the
          // feed instead of showing an error card.
          shorts = shorts.filter((_, x) => x !== i);
          return;
        }
        attachStream(i, r.data);
        recordWatch(shorts[i]);
      } else if (vid.muted && !feedAudio[i]) {
        // hd slide we already watched once (swiped away and came back): its
        // audio element was torn down - rebuild it from the cached resolve
        const r = await api(watchUrl(shorts[i].id));
        if (r.ok && r.data.hd) { slideResolve[i] = r.data; setupAudio(i, (slideProxy[i] || directDead) ? r.data.hd.audio : (r.data.hd.directAudio || r.data.hd.audio)); }
      }
      vid.muted = !!feedAudio[i];
      try {
        await vid.play();
      } catch {
        // ios blocked it (no fresh gesture): get motion on screen muted,
        // the touch bridge restores sound on the next tap anywhere
        vid.muted = true;
        await vid.play().catch(() => {});
      }
      onSlidePlay(i);
      // ios-safe warm swipe (Luke 5:51 PM: "prebuffering is good tho"), now
      // settle-guarded (Luke 5:56 PM): a slide must HOLD the spotlight for
      // half a second before anything warms, so fast-scrolling past never
      // spins up loads. the next slide's video buffers (src + preload=auto)
      // but NEVER plays, and no audio element exists until it's active.
      const gen = ++prefetchGen;
      setTimeout(() => {
        if (gen !== prefetchGen || feedPlaying !== i) return;
        const n = i + 1;
        const nn = i + 2;
        if (nn < shorts.length && !feedErr[nn]) api(watchUrl(shorts[nn].id)).catch(() => {});
        if (n < shorts.length && !feedErr[n]) {
          api(watchUrl(shorts[n].id)).then((r2) => {
            const v2 = feedVideo(n);
            if (r2.ok && v2 && !v2.src && feedPlaying === i) attachStream(n, r2.data, true);
          }).catch(() => {});
        }
      }, 500);
    } catch { /* play rejected (no gesture yet) - the big button stays up */ }
  }

  function deactivateSlide(i) {
    const vid = feedVideo(i);
    prefetchGen++; // any swipe kills pending warmups - they chase where he IS
    reportOutcome(i);
    if (!vid) return;
    vid.pause();
    reportStalls(i);
    clearWatchdog(i);
    killAudio(i);
    if (vid.src) { vid.removeAttribute('src'); vid.load(); }
    if (feedPlaying === i) feedPlaying = -1;
  }

  function setupObserver() {
    observer?.disconnect();
    if (!feedWrap) return;
    observer = new IntersectionObserver((entries) => {
      for (const en of entries) {
        const i = parseInt(en.target.dataset.idx, 10);
        if (en.isIntersecting && en.intersectionRatio >= 0.6) activateSlide(i);
        else if (en.intersectionRatio < 0.6) deactivateSlide(i);
      }
    }, { root: feedWrap, threshold: [0, 0.6] });
    feedWrap.querySelectorAll('.slide').forEach((s) => observer.observe(s));
  }

  // root fix (Luke 6:26 PM): the tapped short is ALWAYS the one that plays first.
  // the old code swapped the whole list out from under the playing slide when the
  // fresh re-rank landed, so a different short could take over. now the fresh list
  // is fetched BEFORE opening (500ms cap), the tapped one is pinned to slot 0, and
  // nothing swaps once the feed is open.
  let savedShorts = null; // home shelf, parked while a channel's shorts take over the feed
  async function openFeed(i) {
    const picked = shorts[i];
    let start = i;
    if (picked) {
      const r = await Promise.race([
        api('/api/apps/jetstream/shorts?fresh=1').catch(() => null),
        new Promise((res) => setTimeout(() => res(null), 500)),
      ]);
      if (r && r.ok && (r.data.items || []).length) {
        resetSlides();
        shorts = [picked, ...r.data.items.filter((v) => v.id !== picked.id)];
        start = 0;
      }
    }
    feedMode = 'foryou';
    startFeedAt(start);
  }

  function startFeedAt(i) {
    feedOpen = true; feedErr = {}; feedLoading = {}; feedPlaying = -1; lastActive = i;
    armFeedGuard();
    armFeedBridge();
    setTimeout(() => {
      feedWrap?.querySelector(`.slide[data-idx="${i}"]`)?.scrollIntoView({ block: 'start' });
      setupObserver();
    }, 30);
  }

  function togglePlay(i) {
    const vid = feedVideo(i);
    if (!vid) return;
    if (!vid.paused) { vid.pause(); feedPlaying = -1; return; }
    activateSlide(i);
  }

  function retrySlide(i) {
    const e = { ...feedErr }; delete e[i]; feedErr = e;
    activateSlide(i);
  }

  // tear down every slide's playback; used by close, list swaps, and searches
  function resetSlides() {
    flushOutcomes(false); // closing the feed or swapping lists still teaches the algorithm
    observer?.disconnect(); observer = null;
    if (driftTimer) { clearInterval(driftTimer); driftTimer = null; }
    Object.keys(feedAudio).forEach((k) => killAudio(k));
    feedAudio = {};
    feedWrap?.querySelectorAll('video').forEach((v) => { v.pause(); v.removeAttribute('src'); v.load(); });
    feedErr = {}; feedLoading = {}; feedPlaying = -1; lastActive = -1;
  }

  // swap in a new slide list (search results or back to for-you) and re-arm
  function swapFeedList(items, mode) {
    resetSlides();
    shorts = items;
    feedMode = mode;
    setTimeout(() => { feedWrap?.scrollTo(0, 0); setupObserver(); }, 30);
  }

  // searchable shorts: the zone takes its own queries, ranked by the same
  // engine as the for-you feed (server side), short-form slice only.
  async function searchShorts(e) {
    e?.preventDefault();
    const query = feedQ.trim();
    if (!query) return;
    const r = await api(`/api/apps/jetstream/shorts?q=${encodeURIComponent(query)}`);
    if (!r.ok) { feedSearchErr = r.data?.error || 'search broke - try again'; return; }
    feedSearchErr = '';
    swapFeedList(r.data.items || [], 'search');
  }

  async function backToForYou() {
    const r = await api('/api/apps/jetstream/shorts');
    if (!r.ok) { feedSearchErr = r.data?.error || 'feed broke - try again'; return; }
    feedQ = ''; feedSearchErr = ''; feedSearchOpen = false;
    swapFeedList(r.data.items || [], 'foryou');
  }

  // watch later: this device only, newest first, capped. opening one from the
  // home row takes it off the list (you are watching it now).
  let later = $state([]);
  try { later = JSON.parse(localStorage.getItem('js-later') || '[]').slice(0, 20); } catch {}
  const saveLater = () => { try { localStorage.setItem('js-later', JSON.stringify(later)); } catch {} };
  let linkCopied = $state(false);
  async function copyLink(v) {
    const url = 'https://www.youtube.com/watch?v=' + v.id;
    try { await navigator.clipboard.writeText(url); }
    catch { const ta = document.createElement('textarea'); ta.value = url; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); } catch {} ta.remove(); }
    linkCopied = true; setTimeout(() => (linkCopied = false), 1500);
  }
  const inLater = (id) => later.some((x) => x.id === id);
  function toggleLater(v) {
    if (!v) return;
    later = inLater(v.id) ? later.filter((x) => x.id !== v.id) : [{ id: v.id, title: v.title || '', channel: v.channel || '', duration: v.duration || '' }, ...later].slice(0, 20);
    saveLater();
  }
  function openLater(v) {
    later = later.filter((x) => x.id !== v.id); saveLater();
    watch(v);
  }
  // double-tap a short to like it (like the apps everyone knows). the second
  // tap still runs the normal play toggle so the video ends where it was.
  let lastTap = { i: -1, t: 0 };
  let heartAt = $state(-1);
  function slideTap(i) {
    const now = Date.now();
    const dbl = lastTap.i === i && now - lastTap.t < 320;
    lastTap = { i, t: dbl ? 0 : now };
    togglePlay(i);
    if (dbl) {
      const v = shorts[i];
      if (v && !liked.has(v.id)) toggleLike(i);
      heartAt = i; setTimeout(() => { if (heartAt === i) heartAt = -1; }, 700);
    }
  }
  // like a short: strongest signal the ranking engine gets. instant toggle.
  async function toggleLike(i) {
    const v = shorts[i];
    if (!v) return;
    const r = await api('/api/apps/jetstream/likes/toggle', { method: 'POST', body: { id: v.id, title: v.title, channel: v.channel || '', duration: v.duration || '' } });
    if (!r.ok) return;
    const s = new Set(liked);
    if (r.data.liked) s.add(v.id); else s.delete(v.id);
    liked = s;
  }

  // like a long-form video: same signal, same taste profile - one like
  // here reshapes shorts and for you just like a short like does.
  async function toggleWatchLike() {
    const v = watching;
    if (!v) return;
    const r = await api('/api/apps/jetstream/likes/toggle', { method: 'POST', body: { id: v.id, title: v.title, channel: v.channel || '', duration: v.duration || '' } });
    if (!r.ok) return;
    const s = new Set(liked);
    if (r.data.liked) s.add(v.id); else s.delete(v.id);
    liked = s;
  }

  // not interested: the negative twin. marking one slides you to the next
  // short right away (that is what the button means everywhere else), and
  // the ranking engine sinks that channel + its title words from here.
  async function toggleDislike(i) {
    const v = shorts[i];
    if (!v) return;
    const r = await api('/api/apps/jetstream/dislikes/toggle', { method: 'POST', body: { id: v.id, title: v.title, channel: v.channel || '', duration: v.duration || '' } });
    if (!r.ok) return;
    const s = new Set(dislikedSet);
    if (r.data.disliked) s.add(v.id); else s.delete(v.id);
    dislikedSet = s;
    if (r.data.disliked && i + 1 < shorts.length) {
      feedWrap?.querySelector(`.slide[data-idx="${i + 1}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  function closeFeed() {
    feedSearchOpen = false;
    resetSlides();
    if (feedGuard) { clearInterval(feedGuard); feedGuard = null; }
    if (feedBridge) {
      document.removeEventListener('touchstart', feedBridge);
      document.removeEventListener('click', feedBridge);
      feedBridge = null;
    }
    feedOpen = false;
    if (savedShorts) { shorts = savedShorts; savedShorts = null; feedMode = 'foryou'; }
  }

  let recentQ = $state(readSearches('js-searches'));
  async function search(e) {
    e?.preventDefault();
    if (busy || !q.trim()) return;
    recentQ = addSearch('js-searches', q);
    busy = true; error = ''; back(); chanPage = null; plPage = null; subsPage = null;
    kind = 'video'; kres = { channel: null, playlist: null, q: q.trim() };
    const r = await api(`/api/apps/jetstream/search?q=${encodeURIComponent(q.trim())}`);
    busy = false; searched = true;
    if (!r.ok) { error = r.data?.error || 'search broke - try again'; return; }
    results = r.data.results;
  }

  function chip(c) { q = c; search(); }

  async function setKind(k) {
    kind = k;
    if (k === 'video' || kres[k]) return;
    const want = kres.q;
    const r = await api(`/api/apps/jetstream/search?q=${encodeURIComponent(want)}&type=${k}`);
    if (kres.q !== want) return;
    kres = { ...kres, [k]: r.ok ? r.data.results : [], [k + 'Err']: r.ok ? '' : (r.data?.error || 'search broke - try again') };
  }
  const avatar = (u) => (u ? `/api/apps/jetstream/avatar?u=${encodeURIComponent(u)}` : '');

  async function openPlaylist(id, name, channel) {
    if (!id) return;
    subsPage = null;
    if (feedOpen) closeFeed();
    back();
    plQ = ''; plRev = false;
    plPage = { id, name: name || '', channel: channel || '', channelId: '', count: 0, items: null, err: '' };
    window.scrollTo(0, 0);
    plTotal = 0; plNext = 0; plDone = false; plHidden = 0; plLoading = false;
    await loadPl(true);
  }
  function closePlaylist() { plPage = null; autoplay = null; }
  async function playAllPl() {
    const list = await plAll();
    if (!list.length) return;
    autoplay = { items: list, idx: 0, channelName: plPage.name };
    watch(list[0], true);
  }

  let loadingWatch = $state(false);
  let watchInfo = $state(null);

  let retScroll = 0;
  async function watch(v, keepAutoplay = false) {
    if (loadingWatch) return;
    if (!watching) retScroll = window.scrollY; // where the list was when he left it
    if (!keepAutoplay) autoplay = null;
    // autoplay advance: keep the SAME <video> element mounted (don't null watchInfo) so
    // fullscreen survives the swap - the effect below just points it at the new source.
    const keepEl = keepAutoplay && !!videoEl && !!watchInfo;
    if (keepEl) {
      // resolve the next PLAYABLE one first (skipping restricted/dead ones) and only then
      // swap title + source in one step: no flash of a dead video's title or poster.
      loadingWatch = true;
      let cand = v; let r;
      for (;;) {
        r = await api(watchUrl(cand.id));
        if (r.ok) break;
        dropDeadEverywhere(cand.id);
        if (!autoplay || autoplay.idx >= autoplay.items.length) { autoplay = null; loadingWatch = false; return; }
        cand = autoplay.items[autoplay.idx];
      }
      loadingWatch = false;
      if (!watching || !autoplay) return; // closed the player while the next one was resolving
      error = ''; portrait = false; streamError = false; hdDropped = false; stalling = false;
      watching = cand; watchInfo = r.data;
      recordWatch(cand);
      return;
    }
    sum = null;
    watching = v; if (!keepEl) watchInfo = null; error = ''; portrait = false;
    streamError = false; hdDropped = false; stalling = false;
    window.scrollTo(0, 0);
    loadingWatch = true;
    const r = await api(watchUrl(v.id));
    loadingWatch = false;
    if (watching?.id !== v.id) return; // left the player (or picked another) while this was loading
    if (!r.ok) {
      if (autoplay) { skipDeadInAutoplay(v.id); return; } // restricted: skip, don't strand him
      dropDeadEverywhere(v.id);
      error = r.data?.error || "can't load this one"; watching = null; return;
    }
    watchInfo = r.data;
    recordWatch(v);
  }

  // HD: adaptive video-only + m4a audio played as a synced pair - the old
  // ramjet's proven pattern, which delivered 1080p. The video element stays
  // muted in HD and a hidden audio element carries the sound; it re-syncs on
  // play, on seek, and whenever drift passes a third of a second. iOS needs a
  // user gesture before an audio element can start, so the first touch/click
  // kicks the track in. 360p muxed stays one tap away as the fallback.
  let au = null;
  let driftPoll = null;
  let audioBridge = null;
  let hdMode = $state(false);
  let streamError = $state(false);
  let hdDropped = $state(false);
  let stalling = $state(false);

  function dropAudio() {
    clearWatchDog();
    if (au) { au.pause(); au.remove(); au = null; }
    if (driftPoll) { clearInterval(driftPoll); driftPoll = null; }
    if (audioBridge) {
      document.removeEventListener('touchstart', audioBridge);
      document.removeEventListener('click', audioBridge);
      audioBridge = null;
    }
  }

  function syncAudio(hard) {
    if (!au || !videoEl) return;
    if (hard || Math.abs(au.currentTime - videoEl.currentTime) > 0.8) au.currentTime = videoEl.currentTime;
  }

  // direct-first on the watch page too (Luke 6:08 PM): start on the CDN
  // urls, 6s no-data watchdog, one swap to the proxy and it sticks until
  // the next video. filtered networks land on the proxy every time.
  let watchDirect = false;
  let watchDog = null;

  function clearWatchDog() { if (watchDog) { clearTimeout(watchDog); watchDog = null; } }

  function armWatchDog(mode) {
    clearWatchDog();
    watchDog = setTimeout(() => {
      watchDog = null;
      if (watchDirect && videoEl && videoEl.readyState < 2) {
        if (mode === 'hd') hdToProxy('no-data-6s'); else muxedToProxy('no-data-6s');
      }
    }, 6000);
  }

  function hdToProxy(why) {
    if (!watchInfo?.hd || !videoEl) return;
    watchDirect = false;
    markDirectDead();
    clearWatchDog();
    api('/api/apps/jetstream/clientlog', { method: 'POST', body: { kind: 'watch-proxy-fallback', id: watching?.id || '', why: why || '', ua: navigator.userAgent } }).catch(() => {});
    dropAudio();
    au = new Audio(watchInfo.hd.audio);
    au.preload = 'auto';
    au.style.display = 'none';
    document.body.appendChild(au);
    const mine = au;
    mine.addEventListener('error', () => {
      if (au === mine && watchInfo?.stream) { hdMode = false; hdDropped = true; startFallback(); }
    });
    videoEl.muted = true;
    videoEl.src = watchInfo.hd.video;
    videoEl.load();
    videoEl.play?.().catch(() => {});
  }

  function muxedToProxy(why) {
    if (!watchInfo || !videoEl) return;
    watchDirect = false;
    markDirectDead();
    clearWatchDog();
    api('/api/apps/jetstream/clientlog', { method: 'POST', body: { kind: 'watch-proxy-fallback', id: watching?.id || '', why: why || '', ua: navigator.userAgent } }).catch(() => {});
    videoEl.muted = false;
    videoEl.src = watchInfo.stream;
    videoEl.load();
    videoEl.play?.().catch(() => {});
  }

  // audio only (YouTube Premium background-play parity): the same <video> element plays
  // the m4a through the proxy, so overlay, scrub, fullscreen-less lock-screen play and
  // autoplay all keep working, and the video bytes never download. Remembered per device.
  let audioOnly = $state(false);
  try { audioOnly = localStorage.getItem('js-audio-only') === '1'; } catch {}
  // lock-screen / control-center metadata and buttons (needed for audio-only to feel real)
  $effect(() => {
    if (!('mediaSession' in navigator) || !watching || !watchInfo) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: watching.title || watchInfo.title || '',
        artist: watchInfo.channel || watching.channel || '',
        artwork: [{ src: location.origin + thumb(watching.id), sizes: '480x360', type: 'image/jpeg' }],
      });
      const ms = navigator.mediaSession;
      ms.setActionHandler('play', () => videoEl?.play?.());
      ms.setActionHandler('pause', () => videoEl?.pause?.());
      ms.setActionHandler('seekto', (d) => { if (videoEl && d.seekTime != null) videoEl.currentTime = d.seekTime; });
      ms.setActionHandler('nexttrack', autoplay && autoplay.idx + 1 < autoplay.items.length ? () => vNext() : null);
      ms.setActionHandler('previoustrack', autoplay ? () => vPrev() : null);
    } catch {}
  });
  function startAudioOnly() {
    dropAudio();
    watchDirect = false;
    videoEl.muted = false;
    videoEl.src = watchInfo.hd.audio;
    videoEl.play?.().catch(() => {});
  }
  function toggleAudioOnly() {
    if (!videoEl || !watchInfo?.hd) return;
    const t = videoEl.currentTime || 0;
    const wasPlaying = !videoEl.paused;
    audioOnly = !audioOnly;
    try { localStorage.setItem('js-audio-only', audioOnly ? '1' : '0'); } catch {}
    if (t > 1 && watching) pending = { id: watching.id, t };
    hdMode = true;
    startHd();
    if (!wasPlaying) videoEl.pause?.();
  }

  function startHd() {
    if (!watchInfo?.hd || !videoEl) return;
    if (audioOnly) { startAudioOnly(); return; }
    dropAudio();
    watchDirect = !directDead && !!watchInfo.hd.directVideo;
    au = new Audio(watchInfo.hd.directAudio || watchInfo.hd.audio);
    au.preload = 'auto';
    au.style.display = 'none';
    document.body.appendChild(au);
    const mine = au;
    mine.addEventListener('error', () => {
      if (au !== mine) return;
      if (watchDirect) { hdToProxy('audio-error'); return; }
      if (watchInfo?.stream) { hdMode = false; hdDropped = true; startFallback(); }
    });
    videoEl.muted = true;
    videoEl.src = watchInfo.hd.directVideo || watchInfo.hd.video;
    if (watchDirect) armWatchDog('hd');
    audioBridge = () => {
      if (videoEl && !videoEl.paused && au && au.paused) { syncAudio(true); au.play().catch(() => {}); }
    };
    document.addEventListener('touchstart', audioBridge, { passive: true });
    document.addEventListener('click', audioBridge);
    driftPoll = setInterval(() => { if (au && videoEl && !videoEl.paused) syncAudio(false); }, 2000);
    videoEl.play?.().catch(() => {});
  }

  function startFallback() {
    if (!watchInfo || !videoEl) return;
    dropAudio();
    watchDirect = !directDead && !!watchInfo.direct;
    videoEl.muted = false;
    videoEl.src = watchInfo.direct || watchInfo.stream;
    if (watchDirect) armWatchDog('muxed');
    videoEl.play?.().catch(() => {});
  }

  function onVidError() {
    if (!watchInfo || streamError) return;
    if (watchDirect) { if (hdMode) hdToProxy('video-error'); else muxedToProxy('video-error'); return; }
    if (hdMode && watchInfo.stream) { hdMode = false; hdDropped = true; startFallback(); return; }
    if (autoplay) { skipDeadInAutoplay(watching?.id); return; }
    stalling = false;
    streamError = true;
  }

  function retryStream() {
    streamError = false; stalling = false;
    if (hdMode) startHd(); else startFallback();
  }

  function toggleQuality() {
    hdMode = !hdMode;
    if (hdMode) hdDropped = false;
    if (hdMode) startHd(); else startFallback();
  }

  $effect(() => {
    if (!watchInfo || !videoEl) return;
    const useHd = !!watchInfo.hd;
    hdMode = useHd;
    if (useHd) startHd(); else startFallback();
  });

  // safety net: whatever path closes the player, the hidden audio half of an HD
  // pair must die with it (it is a detached <audio>, so removing <video> never stops it).
  $effect(() => { if (!watching) dropAudio(); });
  $effect(() => {
    const kill = () => { dropAudio(); try { videoEl?.pause(); } catch {} };
    window.addEventListener('pagehide', kill);
    return () => { window.removeEventListener('pagehide', kill); dropAudio(); };
  });

  function onVidPlay() { if (au) { syncAudio(true); au.play().catch(() => {}); } }

  // watched to the end: it leaves keep watching (the shelf is for things
  // you are mid-way through), and the server marks it complete.
  // autoplay chain advance; a dead video is skipped and dropped from the
  // chain entirely (Luke 6:28 PM: restricted = skip it and remove it).
  function autoplayNext() {
    if (autoplay && autoplay.idx + 1 < autoplay.items.length) {
      const next = autoplay.idx + 1;
      autoplay = { ...autoplay, idx: next };
      watch(autoplay.items[next], true);
    } else {
      autoplay = null;
    }
  }

  function dropDeadEverywhere(id) {
    if (plPage?.items) plPage = { ...plPage, items: plPage.items.filter((v) => v.id !== id) };
    if (chanPage?.videos) chanPage = { ...chanPage, videos: chanPage.videos.filter((v) => v.id !== id) };
    if (chanPage?.shorts) chanPage = { ...chanPage, shorts: chanPage.shorts.filter((v) => v.id !== id) };
    if (autoplay) autoplay = { ...autoplay, items: autoplay.items.filter((v) => v.id !== id) };
  }

  // the dead one was the chain's current video: after removal the next
  // playable slides into the SAME index - play it there, don't skip past.
  function skipDeadInAutoplay(id) {
    dropDeadEverywhere(id);
    if (!autoplay) return;
    if (autoplay.idx >= autoplay.items.length) { autoplay = null; return; }
    watch(autoplay.items[autoplay.idx], true);
  }

  async function onVidEnded() {
    if (watching) { const o = posRead(); delete o[watching.id]; posWrite(o); }
    if (watching) { const o = posRead(); delete o[watching.id]; posWrite(o); }
    onVidPause();
    if (!watching) return;
    const doneId = watching.id;
    history = history.filter((x) => x.id !== doneId);
    await api('/api/apps/jetstream/history/complete', { method: 'POST', body: { id: doneId } });
    autoplayNext(); // chain finished? it clears itself
  }
  function onSeeked() { syncAudio(true); }
  function onVidPause() { if (au) au.pause(); }

  // resume: remember where you were in long videos (this device only, 40 max)
  let posLast = 0, resumedId = '', pending = null;
  function posRead() { try { return JSON.parse(localStorage.getItem('js-pos') || '{}'); } catch { return {}; } }
  function posWrite(o) { try { localStorage.setItem('js-pos', JSON.stringify(o)); } catch {} }
  function onTime() {
    if (!videoEl || !watching || videoEl.paused) return;
    const t = videoEl.currentTime;
    if (pending && pending.id === watching.id) { if (t >= pending.t - 2) pending = null; else return; }
    if (Math.abs(t - posLast) < 5) return;
    posLast = t;
    const o = posRead();
    if (t < 20 || (videoEl.duration && t > videoEl.duration - 30)) delete o[watching.id];
    else { delete o[watching.id]; o[watching.id] = Math.floor(t); }
    const k = Object.keys(o); if (k.length > 40) delete o[k[0]];
    posWrite(o);
  }
  // custom controls overlay (Luke 6:24 PM). native chrome is off; this draws play/pause,
  // prev/next (autoplay chains), a scrub bar, time, quality and fullscreen over the video.
  // iPhone Safari can only fullscreen the <video> itself (native controls take over there,
  // no way around that); desktop/iPad/Android fullscreen the whole frame so this stays.
  let frameEl = $state(null);
  let vcur = $state(0), vdur = $state(0), vpaused = $state(true), vui = $state(true), vscrub = $state(false), isFs = $state(false);
  let vuiTimer = null, vLastTap = 0;
  const fmtT = (t) => { t = Math.max(0, Math.floor(t || 0)); const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), x = String(t % 60).padStart(2, '0'); return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`; };
  function vTick() { if (!videoEl || vscrub) return; vcur = videoEl.currentTime || 0; vdur = isFinite(videoEl.duration) ? videoEl.duration : 0; }
  function vSync() { vpaused = !videoEl || videoEl.paused; vTick(); if (vpaused) { vui = true; clearTimeout(vuiTimer); } else vPoke(); }
  function vPoke() { vui = true; clearTimeout(vuiTimer); vuiTimer = setTimeout(() => { if (videoEl && !videoEl.paused && !vscrub) vui = false; }, 3000); }
  function vToggle() { if (!videoEl) return; if (videoEl.paused) videoEl.play?.().catch(() => {}); else videoEl.pause(); }
  function vTap(e) {
    const r = e.currentTarget.getBoundingClientRect();
    const now = Date.now();
    const x = (e.clientX - r.left) / r.width;
    if (now - vLastTap < 320 && (x < 0.33 || x > 0.67) && videoEl) { // double tap a side: skip 10s
      videoEl.currentTime = Math.max(0, Math.min((videoEl.duration || 1e9), videoEl.currentTime + (x < 0.5 ? -10 : 10)));
      vTick(); vPoke(); vLastTap = 0; return;
    }
    vLastTap = now;
    if (vui && !vpaused) { vui = false; clearTimeout(vuiTimer); } else vPoke();
  }
  function vSeekInput(e) { vscrub = true; vcur = Number(e.currentTarget.value); }
  function vSeekChange(e) { if (videoEl) { videoEl.currentTime = Number(e.currentTarget.value); } vscrub = false; vTick(); vPoke(); }
  function vFs() {
    const doc = document;
    if (doc.fullscreenElement || doc.webkitFullscreenElement) { (doc.exitFullscreen || doc.webkitExitFullscreen)?.call(doc); return; }
    if (frameEl?.requestFullscreen) frameEl.requestFullscreen().catch(() => {});
    else if (frameEl?.webkitRequestFullscreen) frameEl.webkitRequestFullscreen();
    else if (videoEl?.webkitEnterFullscreen) videoEl.webkitEnterFullscreen(); // iPhone: native player takes over
  }
  $effect(() => {
    const f = () => { isFs = !!(document.fullscreenElement || document.webkitFullscreenElement); };
    document.addEventListener('fullscreenchange', f); document.addEventListener('webkitfullscreenchange', f);
    return () => { document.removeEventListener('fullscreenchange', f); document.removeEventListener('webkitfullscreenchange', f); };
  });
  function vPrev() { if (!autoplay) return; if (videoEl && videoEl.currentTime > 4) { videoEl.currentTime = 0; return; } if (autoplay.idx > 0) { const i = autoplay.idx - 1; autoplay = { ...autoplay, idx: i }; watch(autoplay.items[i], true); } }
  function vNext() { if (autoplay && autoplay.idx + 1 < autoplay.items.length) autoplayNext(); }

  function onMeta() {
    vTick();
    if (videoEl && watching && videoEl.duration) {
      if (resumedId !== watching.id) {
        resumedId = watching.id;
        const t = posRead()[watching.id];
        pending = t > 20 && t < videoEl.duration - 30 ? { id: watching.id, t } : null;
      }
      if (pending && pending.id === watching.id) { videoEl.currentTime = pending.t; posLast = pending.t; }
    }
    if (videoEl && videoEl.videoWidth && videoEl.videoHeight) {
      portrait = videoEl.videoHeight > videoEl.videoWidth;
    }
  }

  // leaving a video via back lands him at the same spot in the list he came from
  // (playlist items stay loaded in state, so infinite-scroll depth is preserved too).
  function backToList() {
    const y = retScroll;
    back();
    tick().then(() => requestAnimationFrame(() => { window.scrollTo(0, y); setTimeout(() => window.scrollTo(0, y), 120); }));
  }
  function back() { statsOpen = false; clearInterval(statsTimer); dropAudio(); autoplay = null; watching = null; watchInfo = null; portrait = false; streamError = false; hdDropped = false; stalling = false; }
  // channel pages (Luke 6:09 PM): scroll a channel's shorts, subscribe,
  // autoplay everything they've made. videos + shorts load together, the
  // sub folds into the same taste profile the feeds rank with.
  function goChannelFromShort(v) {
    if (!v?.channelId) return;
    closeFeed();
    openChannel(v.channelId, v.channel);
  }

  async function openChannel(id, name) {
    if (!id) return;
    subsPage = null;
    if (feedOpen) closeFeed();
    back(); // leave the player - the channel page replaces it
    plPage = null; bioOpen = false;
    chanTab = 'videos';
    chanPage = { id, name: name || '', videos: null, shorts: null, playlists: null, info: null, err: '' };
    api(`/api/apps/jetstream/channel/info?id=${encodeURIComponent(id)}`).then((ir) => { if (chanPage && chanPage.id === id && ir.ok) chanPage = { ...chanPage, name: chanPage.name || ir.data.name, info: ir.data }; });
    api(`/api/apps/jetstream/channel/playlists?id=${encodeURIComponent(id)}`).then((pr) => { if (chanPage && chanPage.id === id) chanPage = { ...chanPage, playlists: pr.ok ? (pr.data.items || []) : [] }; });
    window.scrollTo(0, 0);
    const [v, s] = await Promise.all([
      api(`/api/apps/jetstream/channel?id=${encodeURIComponent(id)}&tab=videos`),
      api(`/api/apps/jetstream/channel?id=${encodeURIComponent(id)}&tab=shorts`),
    ]);
    if (!chanPage || chanPage.id !== id) return;
    if (v.ok) chanPage = { ...chanPage, name: chanPage.name || v.data.name, videos: v.data.items || [] };
    else chanPage = { ...chanPage, err: v.data?.error || "can't load this channel" };
    if (s.ok) chanPage = { ...chanPage, shorts: s.data.items || [] };
  }

  // one back button for every view: leaves the top-most screen and lands on
  // the one under it. also wired to the browser/phone back gesture.
  let pushed = 0;
  let fromPop = false;
  const viewKey = $derived(feedOpen ? 'feed' : watching ? 'watch' : plPage ? 'pl' : chanPage ? 'chan' : subsPage ? 'subs' : searched ? 'search' : '');
  let lastKey = '';
  $effect(() => {
    const k = viewKey;
    if (k === lastKey) return;
    const prev = lastKey; lastKey = k;
    if (fromPop) { fromPop = false; return; }
    if (k && k !== prev) { try { window.history.pushState({ jt: 1 }, ''); pushed++; } catch {} }
  });
  function goBack() {
    if (feedOpen) closeFeed();
    else if (watching) backToList();
    else if (plPage) closePlaylist();
    else if (chanPage) closeChannel();
    else if (subsPage) closeSubs();
    else if (searched) { searched = false; results = []; kind = 'video'; error = ''; }
  }
  function backNav() { if (pushed > 0) window.history.back(); else goBack(); }

  function closeChannel() { chanPage = null; autoplay = null; }

  async function toggleSub() {
    if (!chanPage) return;
    const r = await api('/api/apps/jetstream/subs/toggle', { method: 'POST', body: { id: chanPage.id, name: chanPage.name } });
    if (!r.ok) return;
    const s = new Set(subs);
    if (r.data.subbed) s.add(chanPage.id); else s.delete(chanPage.id);
    subs = s;
  }

  // play all: the whole videos tab as one continuous chain. onVidEnded
  // advances it; any other tap on a video breaks the chain.
  function playAll() {
    const list = chanPage?.videos || [];
    if (!list.length) return;
    autoplay = { items: list, idx: 0, channelName: chanPage.name };
    watch(list[0], true);
  }

  function scrollChannelShorts(i = 0) {
    const list = chanPage?.shorts || [];
    if (!list.length) return;
    feedQ = ''; feedSearchErr = '';
    if (feedMode !== 'channel' && !savedShorts) savedShorts = shorts;
    resetSlides();
    shorts = list;
    feedMode = 'channel';
    startFeedAt(Math.min(Math.max(0, i), list.length - 1));
  }

  const thumb = (id) => `/api/apps/jetstream/thumb?id=${id}`;
</script>

<main>
  <header>
    {#if viewKey}
      <button class="home" onclick={backNav} aria-label="back"><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7" /></svg></button>
    {:else}
      <a class="home" href="/" aria-label="back to hub"><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7" /></svg></a>
    {/if}
    <div class="brand">jetstream</div>
    <button class="subs-link" onclick={openSubs}>subscriptions</button>
    <span class="spacer"></span>
  </header>

  <form class="bar" onsubmit={search}>
    <input bind:value={q} list="js-recent-q" placeholder="search anything" enterkeyhint="search" autocapitalize="off" />
    <datalist id="js-recent-q">{#each recentQ as r}<option value={r}></option>{/each}</datalist>
    <button type="submit" disabled={busy}>{busy ? '...' : 'go'}</button>
  </form>

  {#if error}<p class="err" role="alert">{error}</p>{/if}

  {#if watching}
    <section class="player">
      <div class="frame" class:portrait bind:this={frameEl}>
        {#if watchInfo}
          <video bind:this={videoEl} playsinline preload="auto" poster={thumb(watching.id)}
            onloadedmetadata={onMeta} ontimeupdate={() => { onTime(); vTick(); }} ondurationchange={vTick} onplay={() => { onVidPlay(); vSync(); }} onpause={() => { onVidPause(); vSync(); }} onseeked={onSeeked} onended={onVidEnded}
            onerror={onVidError}
            onwaiting={() => { if (!streamError && videoEl && !videoEl.paused) stalling = true; }}
            onplaying={() => stalling = false} oncanplay={() => stalling = false}></video>
          <div class="vo" class:hide={!vui} role="presentation" onclick={vTap}>
            <div class="vo-top"><span class="vo-title">{watching.title || watchInfo.title || ''}</span></div>
            <div class="vo-mid" role="presentation" onclick={(e) => e.stopPropagation()}>
              {#if autoplay}<button class="vo-b" aria-label="previous" onclick={vPrev}><svg viewBox="0 0 24 24"><path d="M6 6h2v12H6zM9.5 12L18 6v12z"/></svg></button>{/if}
              <button class="vo-b vo-play" aria-label={vpaused ? 'play' : 'pause'} onclick={() => { vToggle(); vPoke(); }}>
                {#if vpaused}<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>{:else}<svg viewBox="0 0 24 24"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>{/if}
              </button>
              {#if autoplay}<button class="vo-b" aria-label="next" onclick={vNext} disabled={autoplay.idx + 1 >= autoplay.items.length}><svg viewBox="0 0 24 24"><path d="M16 6h2v12h-2zM6 18V6l8.5 6z"/></svg></button>{/if}
            </div>
            <div class="vo-bot" role="presentation" onclick={(e) => e.stopPropagation()}>
              <span class="vo-t">{fmtT(vcur)}</span>
              <input class="vo-seek" type="range" min="0" max={vdur || 1} step="0.25" value={vcur} oninput={vSeekInput} onchange={vSeekChange} aria-label="seek" style="--p:{vdur ? (vcur / vdur) * 100 : 0}%" />
              <span class="vo-t">{fmtT(vdur)}</span>
              {#if watchInfo?.hd}<button class="vo-q" class:on={audioOnly} onclick={toggleAudioOnly} aria-label="audio only" aria-pressed={audioOnly}>audio</button>{#if !audioOnly}<button class="vo-q" onclick={toggleQuality} aria-label="switch quality">{hdMode ? watchInfo.hd.quality : '360p'}</button>{/if}{/if}
              <button class="vo-b vo-sm" aria-label="fullscreen" onclick={vFs}>
                {#if isFs}<svg viewBox="0 0 24 24"><path d="M9 9H5V7h2V5h2zm6 0V5h2v2h2v2zM9 15v4H7v-2H5v-2zm6 0h4v2h-2v2h-2z"/></svg>{:else}<svg viewBox="0 0 24 24"><path d="M5 5h5v2H7v3H5zm9 0h5v5h-2V7h-3zM5 14h2v3h3v2H5zm12 0h2v5h-5v-2h3z"/></svg>{/if}
              </button>
            </div>
          </div>
          {#if stalling && !streamError}
            <div class="stall"><span>buffering...</span></div>
          {/if}
          {#if streamError}
            <div class="stall"><div class="cut">
              <p>the stream cut out</p>
              <p class="sub">give it another go, or pick something else</p>
              <button class="retry" onclick={retryStream}>retry</button>
            </div></div>
          {/if}
        {:else}
          <div class="buffering" style="background-image:url({thumb(watching.id)})">
            <span>loading the stream...</span>
          </div>
        {/if}
      </div>
      <h1>{watching.title}</h1>
      <p class="meta">
        {#if watchInfo?.channelId}
          <button class="chanlink" onclick={() => openChannel(watchInfo.channelId, watchInfo.channel || watching.channel)}>{watchInfo.channel || watching.channel}</button>
        {:else}
          {watching.channel}
        {/if}{watching.views ? ` · ${watching.views}` : ''}
        {#if watchInfo?.hd}
          {' · '}{#if !audioOnly}<button class="qbtn" onclick={toggleQuality} aria-label="switch quality">{hdMode ? watchInfo.hd.quality : '360p'}</button>{/if}
          {' '}<button class="qbtn" class:on={audioOnly} onclick={toggleAudioOnly} aria-label="audio only" aria-pressed={audioOnly}>audio only</button>
        {/if}
        {#if techOn()}{' '}<button class="qbtn" class:on={statsOpen} onclick={toggleStats} aria-label="stats for nerds">stats</button>{/if}
      </p>
      {#if statsOpen && stats}
        <pre class="nerd">{stats.src}
{stats.res} · {stats.state} · buffer {stats.buf}s
dropped frames {stats.dropped} · rate {stats.rate}x
network {stats.net} · ready {stats.ready}</pre>
      {/if}
      <div class="sumrow">
        <button class="qbtn" class:on={!!sum?.data} onclick={runSummary} aria-label="summarize this video">{sum?.loading ? 'reading the captions...' : sum?.data ? 'hide summary' : 'summarize'}</button>
      </div>
      {#if sum?.error}<p class="hdnote">{sum.error}</p>{/if}
      {#if sum?.data}
        <section class="sumcard">
          <p class="sumtl">{sum.data.tldr}</p>
          <ul>{#each sum.data.points as pt}<li>{pt}</li>{/each}</ul>
          {#if sum.data.moments?.length}
            <div class="summ">{#each sum.data.moments as mo}<button onclick={() => jumpTo(mo.t)}><b>{fmtT(mo.t)}</b> {mo.label}</button>{/each}</div>
          {/if}
          <p class="sumfoot">made by a free ai from the captions, so it can be wrong</p>
        </section>
      {/if}
      {#if hdDropped}
        <p class="hdnote">hd hiccuped - dropped you to 360p</p>
      {/if}
      {#if autoplay}
        <p class="hdnote">autoplaying {autoplay.channelName} - video {autoplay.idx + 1} of {autoplay.items.length}</p>
      {/if}
      <div class="wactions">
        <button class="wlike" class:liked={liked.has(watching.id)} onclick={toggleWatchLike} aria-label={liked.has(watching.id) ? 'unlike' : 'like'} aria-pressed={liked.has(watching.id)}>
          <svg viewBox="0 0 24 24"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" /></svg>
          <span>{liked.has(watching.id) ? 'liked' : 'like'}</span>
        </button>
        <button class="wlike" class:liked={inLater(watching.id)} onclick={() => toggleLater(watching)} aria-pressed={inLater(watching.id)} aria-label={inLater(watching.id) ? 'remove from watch later' : 'save to watch later'}>
          <svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 100 20 10 10 0 000-20zm4.2 14.2L11 13V7h1.5v5.2l4.5 2.7-.8 1.3z" /></svg>
          <span>{inLater(watching.id) ? 'saved' : 'later'}</span>
        </button>
        <button class="wlike" onclick={() => copyLink(watching)} aria-label="copy video link">
          <svg viewBox="0 0 24 24"><path d="M3.9 12a3.1 3.1 0 013.1-3.1h4V7H7a5 5 0 000 10h4v-1.9H7A3.1 3.1 0 013.9 12zM8 13h8v-2H8v2zm9-6h-4v1.9h4a3.1 3.1 0 010 6.2h-4V17h4a5 5 0 000-10z" /></svg>
          <span>{linkCopied ? 'copied' : 'link'}</span>
        </button>
      </div>
      <button class="backbtn" onclick={backToList}>back to results</button>
      {#if results.filter((r) => r.id !== watching.id).length}
        <p class="uplabel">up next</p>
        <section class="results">
          {#each results.filter((r) => r.id !== watching.id) as v (v.id)}
            <button class="row" onclick={() => watch(v)}>
              <img src={thumb(v.id)} alt="" loading="lazy" />
              <span class="txt">
                <span class="title">{v.title}</span>
                <span class="meta">{v.channel}{v.duration ? ` · ${v.duration}` : ''}</span>
              </span>
            </button>
          {/each}
        </section>
      {/if}
    </section>
  {:else if subsPage}
    <section class="subspage">
      <h1>subscriptions</h1>
      {#if !subsPage.list}
        <p class="empty">loading...</p>
      {:else if !subsPage.list.length}
        <p class="empty">no subscriptions yet - tap a channel name and hit subscribe</p>
      {:else}
        <div class="subslist">
          {#each subsPage.list as s2 (s2.id)}
            <div class="subrow">
              <button class="subgo" onclick={() => openChannel(s2.id, s2.name)}>{s2.name}</button>
              <button class="unsub" onclick={() => unsubFromPage(s2)}>unsubscribe</button>
            </div>
          {/each}
        </div>
      {/if}
      <button class="backbtn" onclick={closeSubs}>back</button>
    </section>
  {:else if plPage}
    <section class="chanpage">
      <div class="chan-head">
        <h1>{plPage.name || 'playlist'}</h1>
      </div>
      <p class="plsub">{#if plPage.channelId}<button class="linkbtn" onclick={() => openChannel(plPage.channelId, plPage.channel)}>{plPage.channel}</button>{:else}{plPage.channel}{/if}{plPage.count ? ` · ${plQ.trim() ? plTotal + ' of ' + plPage.count : plPage.count} videos` : ''}</p>
      {#if plPage.err}<p class="err" role="alert">{plPage.err}</p>{/if}
      {#if !plPage.items && !plPage.err}<p class="empty">loading the playlist...</p>{/if}
      {#if plPage.items}
        <div class="chan-sec">
          <div class="chan-sec-h">
            <h2>videos</h2>
            {#if plPage.items.length}
              <span class="plctl">
                <button class="playall" onclick={shufflePl}>shuffle</button>
                <button class="playall" class:on={plRev} onclick={plToggleRev} aria-pressed={plRev}>reverse</button>
                <button class="playall" onclick={playAllPl}>play all</button>
              </span>
            {/if}
          </div>
          {#if plPage.count > 6}
            <input class="plsearch" bind:value={plQ} oninput={plSearchInput} placeholder="search this playlist" enterkeyhint="search" autocapitalize="off" aria-label="search this playlist" />
          {/if}
          {#if plPage.items.length}
            <section class="results">
              {#each plPage.items as v (v.id)}
                <button class="row" onclick={() => playPlFrom(v)}>
                  <img src={thumb(v.id)} alt="" loading="lazy" />
                  <span class="txt">
                    <span class="title">{v.title}</span>
                    <span class="meta">{v.channel}{v.duration ? ` · ${v.duration}` : ''}</span>
                  </span>
                </button>
              {/each}
            </section>
            {#key plPage.items.length}
              {#if !plDone}<div class="plmore" use:plMore>loading more...</div>{/if}
            {/key}
          {:else}
            <p class="chan-none">{plQ.trim() ? 'no videos match that.' : 'nothing playable in this playlist.'}</p>
          {/if}
        </div>
      {/if}
      <button class="backbtn" onclick={closePlaylist}>back</button>
    </section>
  {:else if chanPage}
    <section class="chanpage" data-tab={chanTab}>
      {#if chanPage.info?.banner}
        <div class="cbanner"><img src={avatar(chanPage.info.banner)} alt="" /></div>
      {/if}
      <div class="chan-head cinfo">
        {#if chanPage.info?.avatar}<img class="cav" src={avatar(chanPage.info.avatar)} alt="" />{/if}
        <div class="cname">
          <h1>{chanPage.info?.name || chanPage.name || 'channel'}</h1>
          {#if chanPage.info}
            <p class="cmeta">{[chanPage.info.handle, chanPage.info.subs, chanPage.info.videos].filter(Boolean).join(' · ')}</p>
          {/if}
        </div>
        <button class="subbtn" class:subbed={subs.has(chanPage.id)} onclick={toggleSub} aria-pressed={subs.has(chanPage.id)}>
          {subs.has(chanPage.id) ? 'subbed' : 'subscribe'}
        </button>
      </div>
      {#if chanPage.info?.desc}
        <div class="cbio">
          <p class="cbiotxt" class:open={bioOpen}>{chanPage.info.desc}</p>
          {#if chanPage.info.desc.length > 140}<button class="linkbtn" onclick={() => (bioOpen = !bioOpen)}>{bioOpen ? 'less' : 'more'}</button>{/if}
        </div>
      {/if}
      <div class="chan-tabs" role="tablist">
        <button role="tab" aria-selected={chanTab === 'videos'} class:on={chanTab === 'videos'} onclick={() => (chanTab = 'videos')}>videos</button>
        {#if chanPage.shorts?.length}<button role="tab" aria-selected={chanTab === 'shorts'} class:on={chanTab === 'shorts'} onclick={() => (chanTab = 'shorts')}>shorts</button>{/if}
        {#if chanPage.playlists?.length}<button role="tab" aria-selected={chanTab === 'playlists'} class:on={chanTab === 'playlists'} onclick={() => (chanTab = 'playlists')}>playlists</button>{/if}
      </div>
      {#if chanPage.err}<p class="err" role="alert">{chanPage.err}</p>{/if}
      {#if !chanPage.videos && !chanPage.err}<p class="empty">loading the channel...</p>{/if}
      {#if chanPage.videos}
        <div class="chan-sec" data-t="videos">
          <div class="chan-sec-h">
            <h2>videos</h2>
            {#if chanPage.videos.length}<button class="playall" onclick={playAll}>play all</button>{/if}
          </div>
          {#if chanPage.videos.length}
            <section class="results">
              {#each chanPage.videos as v (v.id)}
                <button class="row" onclick={() => watch(v)}>
                  <img src={thumb(v.id)} alt="" loading="lazy" />
                  <span class="txt">
                    <span class="title">{v.title}</span>
                    <span class="meta">{v.duration}{v.views ? ` · ${v.views}` : ''}</span>
                  </span>
                </button>
              {/each}
            </section>
          {:else}
            <p class="chan-none">no videos on this channel.</p>
          {/if}
        </div>
      {/if}
      {#if chanPage.playlists && chanPage.playlists.length}
        <div class="chan-sec" data-t="playlists">
          <div class="chan-sec-h"><h2>playlists</h2></div>
          <div class="hist">
            {#each chanPage.playlists as pl (pl.id)}
              <button class="hcard" onclick={() => openPlaylist(pl.id, pl.title, chanPage.name)}>
                <span class="hthumb">{#if pl.thumbVid}<img src={thumb(pl.thumbVid)} alt="" loading="lazy" />{/if}</span>
                <span class="htitle">{pl.title}</span>
              </button>
            {/each}
          </div>
        </div>
      {/if}
      {#if chanPage.shorts}
        <div class="chan-sec" data-t="shorts">
          <div class="chan-sec-h">
            <h2>shorts</h2>
            {#if chanPage.shorts.length}<button class="playall" onclick={() => scrollChannelShorts(0)}>scroll their shorts</button>{/if}
          </div>
          {#if chanPage.shorts.length}
            <div class="hist">
              {#each chanPage.shorts as v, si (v.id)}
                <button class="hcard scard" onclick={() => scrollChannelShorts(si)}>
                  <span class="hthumb"><img class="sthumb" src={thumb(v.id)} alt="" loading="lazy" /></span>
                  <span class="htitle">{v.title}</span>
                </button>
              {/each}
            </div>
          {:else}
            <p class="chan-none">no shorts on this channel.</p>
          {/if}
        </div>
      {/if}
      <button class="backbtn" onclick={closeChannel}>back</button>
    </section>
  {:else}
    {#if !searched}
      <div class="chips">
        {#each chips as c}
          <button class="chip" onclick={() => chip(c)}>{c}</button>
        {/each}
      </div>
      {#if newSubs.length}
        <p class="hist-h">new from your subscriptions</p>
        <div class="hist">
          {#each newSubs as v (v.id)}
            <button class="hcard" onclick={() => watch(v)}>
              <span class="hthumb"><img src={thumb(v.id)} alt="" loading="lazy" /></span>
              <span class="htitle">{v.title}</span>
              <span class="hchan">{v.channel}</span>
            </button>
          {/each}
        </div>
      {/if}
      {#if later.length}
        <p class="hist-h">watch later</p>
        <div class="hist">
          {#each later as v (v.id)}
            <button class="hcard" onclick={() => openLater(v)}>
              <span class="hthumb">
                <img src={thumb(v.id)} alt="" loading="lazy" />
                <span class="hx" role="button" tabindex="-1" aria-label="remove from watch later" onclick={(e) => { e.stopPropagation(); toggleLater(v); }}>x</span>
              </span>
              <span class="htitle">{v.title}</span>
              <span class="hchan">{v.channel}</span>
            </button>
          {/each}
        </div>
      {/if}
      {#if history.length}
        <p class="hist-h">keep watching</p>
        <div class="hist">
          {#each history as v (v.id)}
            <button class="hcard" onclick={() => watch(v)}>
              <span class="hthumb">
                <img src={thumb(v.id)} alt="" loading="lazy" />
                <span class="hx" role="button" tabindex="-1" aria-label="remove from keep watching" onclick={(e) => removeHistory(v, e)}>x</span>
              </span>
              <span class="htitle">{v.title}</span>
              <span class="hchan">{v.channel}</span>
            </button>
          {/each}
        </div>
      {/if}
        {#if shorts.length}
        <div class="zone-h">
          <p class="hist-h">shorts for you</p>
          <button class="zone-open" onclick={() => openFeed(0)}>start scrolling</button>
        </div>
        <div class="hist">
          {#each shorts as v, i (v.id)}
            <button class="hcard scard" onclick={() => openFeed(i)}>
              <span class="hthumb"><img class="sthumb" src={thumb(v.id)} alt="" loading="lazy" /></span>
              <span class="htitle">{v.title}</span>
            </button>
          {/each}
        </div>
      {/if}
      {#if forYou.length}
        <p class="hist-h">for you</p>
        <div class="fygrid">
          {#each forYou as v (v.id)}
            <button class="hcard" onclick={() => watch(v)}>
              <span class="hthumb"><img src={thumb(v.id)} alt="" loading="lazy" /></span>
              <span class="htitle">{v.title}</span>
              <span class="hchan">{v.channel}</span>
            </button>
          {/each}
        </div>
      {/if}
  {/if}
    {#if searched}
      <div class="ktabs" role="tablist">
        {#each [['video', 'videos'], ['channel', 'channels'], ['playlist', 'playlists']] as [k, label]}
          <button role="tab" aria-selected={kind === k} class="ktab" class:on={kind === k} onclick={() => setKind(k)}>{label}</button>
        {/each}
      </div>
    {/if}
    {#if searched && kind === 'channel'}
      <section class="results">
        {#if kres.channel === null}<p class="empty">looking for channels...</p>{/if}
        {#each kres.channel || [] as c (c.id)}
          <button class="row crow" onclick={() => openChannel(c.id, c.name)}>
            {#if c.avatar}<img class="av" src={avatar(c.avatar)} alt="" loading="lazy" />{:else}<span class="av avph">{(c.name || '?')[0]}</span>{/if}
            <span class="txt">
              <span class="title">{c.name}</span>
              <span class="meta">{c.handle ? c.handle + ' · ' : ''}{c.subs}</span>
              {#if c.desc}<span class="meta cdesc">{c.desc}</span>{/if}
            </span>
          </button>
        {/each}
        {#if kres.channel && !kres.channel.length}<p class="empty">{kres.channelErr || 'no channels came up.'}</p>{/if}
      </section>
    {:else if searched && kind === 'playlist'}
      <section class="results">
        {#if kres.playlist === null}<p class="empty">looking for playlists...</p>{/if}
        {#each kres.playlist || [] as pl (pl.id)}
          <button class="row" onclick={() => openPlaylist(pl.id, pl.title, pl.channel)}>
            {#if pl.thumbVid}<img src={thumb(pl.thumbVid)} alt="" loading="lazy" />{:else}<span class="avph plph"></span>{/if}
            <span class="txt">
              <span class="title">{pl.title}</span>
              <span class="meta">{pl.channel}{pl.count ? ` · ${pl.count}` : ''}</span>
            </span>
          </button>
        {/each}
        {#if kres.playlist && !kres.playlist.length}<p class="empty">{kres.playlistErr || 'no playlists came up.'}</p>{/if}
      </section>
    {:else}
    <section class="results">
      {#each results as v (v.id)}
        <button class="row" onclick={() => watch(v)}>
          <img src={thumb(v.id)} alt="" loading="lazy" />
          <span class="txt">
            <span class="title">{v.title}</span>
            <span class="meta">{v.channel}{v.duration ? ` · ${v.duration}` : ''}</span>
          </span>
        </button>
      {:else}
        {#if searched && !busy && !error}
          <p class="empty">nothing came up. try different words.</p>
        {:else if !searched}
          <p class="empty">search it, watch it. that's the whole app.</p>
        {/if}
      {/each}
    </section>
    {/if}
  {/if}
  {#if feedOpen}
    <div class="feed">
      <button class="feed-back" onclick={closeFeed} aria-label="back to jetstream"><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7" /></svg></button>
      {#if feedSearchOpen || feedMode === 'search'}
        <form class="feed-search" onsubmit={searchShorts}>
          <input bind:value={feedQ} placeholder="search shorts" enterkeyhint="search" autocapitalize="off" aria-label="search shorts" />
        </form>
      {:else}
        <button class="feed-search-btn" onclick={() => (feedSearchOpen = true)} aria-label="search shorts"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg></button>
      {/if}
      {#if feedMode !== 'foryou'}
        <button class="feed-clear" onclick={backToForYou}>back to for you</button>
      {/if}
      {#if feedSearchErr}<p class="feed-err">{feedSearchErr}</p>{/if}
      {#if !shorts.length}
        <div class="feed-empty"><p>no shorts for that</p><span>try something else up top</span></div>
      {/if}
      <div class="feed-scroll" bind:this={feedWrap}>
        {#each shorts as v, i (v.id)}
          <section class="slide" data-idx={i}>
            <video playsinline loop preload="none" poster={thumb(v.id)} data-idx={i}
              onclick={() => slideTap(i)}
              ontimeupdate={(e) => onSlideTime(i, e)}
              onwaiting={() => onSlideWaiting(i)}
              onseeked={() => syncSlideAudio(i, true)}
              onplay={() => onSlidePlay(i)}
              onpause={() => onSlidePause(i)}
              onerror={() => onSlideErr(i)}></video>
            {#if heartAt === i}<div class="heart-pop" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" /></svg></div>{/if}
            {#if feedLoading[i]}
              <div class="slide-note"><span>loading...</span></div>
            {/if}
            {#if feedErr[i]}
              <button class="slide-err" onclick={() => retrySlide(i)}>
                <p>{feedErr[i]}</p><span>tap to retry</span>
              </button>
            {/if}
            {#if feedPlaying !== i && !feedErr[i] && !feedLoading[i]}
              <button class="slide-play" onclick={() => togglePlay(i)} aria-label="play">
                <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
              </button>
            {/if}
            <button class="slide-like" class:liked={liked.has(v.id)} onclick={() => toggleLike(i)} aria-label={liked.has(v.id) ? 'unlike' : 'like'}>
              <svg viewBox="0 0 24 24"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" /></svg>
            </button>
            <button class="slide-dislike" class:disliked={dislikedSet.has(v.id)} onclick={() => toggleDislike(i)} aria-label={dislikedSet.has(v.id) ? 'undo not interested' : 'not interested'}>
              <svg viewBox="0 0 24 24"><path d="M15 3H6c-.83 0-1.54.5-1.84 1.22l-3.02 7.05c-.09.23-.14.47-.14.73v2c0 1.1.9 2 2 2h6.31l-.95 4.57-.03.32c0 .41.17.79.44 1.06L9.83 23l6.59-6.59c.36-.36.58-.86.58-1.41V5c0-1.1-.9-2-2-2zm4 0v12h4V3h-4z" /></svg>
            </button>
            <div class="slide-prog" onclick={(e) => seekSlide(i, e)} role="slider" aria-label="seek" aria-valuenow={Math.round(progPct(i))}>
              <div class="slide-prog-fill" style={`width:${progPct(i)}%`}></div>
            </div>
            <div class="slide-meta">
              <p class="slide-title">{v.title}</p>
              {#if v.channelId}
                <button class="slide-chan" onclick={() => goChannelFromShort(v)}>{v.channel}</button>
              {:else}
                <p class="slide-chan">{v.channel}</p>
              {/if}
            </div>
          </section>
        {/each}
      </div>
    </div>
  {/if}
</main>

<style>
  main { max-width: 640px; margin: 0 auto; padding: 16px 14px 48px; }
  header { display: flex; align-items: center; gap: 10px; padding: 6px 6px 16px; }
  .home { width: 34px; height: 34px; display: grid; place-items: center; border-radius: 50%; }
  .home:hover { background: var(--rj-surface); }
  .home svg { width: 18px; height: 18px; fill: none; stroke: var(--rj-text-dim); stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .brand { font-size: 20px; font-weight: 700; letter-spacing: -0.02em; }
  .spacer { width: 34px; margin-left: auto; }
  .bar { display: flex; gap: 8px; margin-bottom: 18px; }
  .bar input {
    flex: 1; height: 48px; padding: 0 18px;
    font-size: 16px; color: var(--rj-text);
    background: var(--rj-surface); border: 1px solid transparent;
    border-radius: var(--rj-pill); outline: none;
    transition: border-color .15s, background .15s;
  }
  .bar input::placeholder { color: var(--rj-text-faint); }
  .bar input:focus { border-color: rgba(255,255,255,.24); background: var(--rj-surface-2); }
  .bar button {
    height: 48px; padding: 0 22px; border: none; border-radius: var(--rj-pill);
    font-size: 15px; font-weight: 700;
    color: var(--rj-accent-ink); background: var(--rj-accent);
  }
  .bar button:disabled { opacity: .5; }
  .chips { display: flex; flex-wrap: wrap; gap: 8px; margin: -4px 2px 16px; }
  .chip {
    height: 34px; padding: 0 16px; border: 1px solid var(--rj-border); border-radius: var(--rj-pill);
    background: none; color: var(--rj-text-dim); font-size: 13px;
  }
  .chip:hover { color: var(--rj-text); background: var(--rj-surface); }
  .err { margin: 0 6px 12px; color: var(--rj-danger); font-size: 13px; }
  .results { display: grid; gap: 4px; }
  .hist-h { font-size: 14px; font-weight: 700; color: var(--rj-text-dim); margin: 18px 2px 8px; }
  .hist { display: flex; gap: 10px; overflow-x: auto; padding-bottom: 6px; scrollbar-width: none; }
  .hist::-webkit-scrollbar { display: none; }
  .fygrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 10px; }
  .hcard { flex: 0 0 168px; display: flex; flex-direction: column; gap: 5px; background: var(--rj-surface); border: 1px solid transparent; border-radius: 14px; padding: 8px; color: var(--rj-text); text-align: left; }
  .hcard:hover { border-color: var(--rj-border); }
  .hthumb { position: relative; display: block; }
  .hcard img { width: 100%; aspect-ratio: 16/9; object-fit: cover; border-radius: 9px; background: #191c22; }
  .hx { position: absolute; top: 5px; right: 5px; width: 24px; height: 24px; display: grid; place-items: center; border-radius: 50%; background: rgba(0,0,0,0.65); color: #fff; font-size: 11px; cursor: pointer; }
  .hx:hover { background: var(--rj-danger); }
  .htitle { font-size: 13px; font-weight: 600; line-height: 1.25; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .hchan { font-size: 11.5px; color: var(--rj-text-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .row {
    display: flex; gap: 12px; align-items: center;
    padding: 8px; border: none; border-radius: var(--rj-radius);
    background: none; text-align: left; color: inherit;
    transition: background .12s;
  }
  .row:hover { background: var(--rj-hover); }
  .row:active { background: var(--rj-surface); }
  .row img { width: 120px; aspect-ratio: 16/9; object-fit: cover; border-radius: 10px; background: var(--rj-surface); flex: none; }
  .txt { display: grid; gap: 3px; min-width: 0; }
  .title {
    font-size: 14px; font-weight: 600; line-height: 1.3;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  }
  .meta { font-size: 12px; color: var(--rj-text-dim); }
  .uplabel { margin: 22px 4px 10px; font-size: 13px; font-weight: 600; color: var(--rj-text-dim); }
  .qbtn {
    padding: 1px 10px; border: 1px solid var(--rj-border); border-radius: var(--rj-pill);
    background: none; color: var(--rj-text); font-size: 12px; font-weight: 600;
    vertical-align: baseline;
  }
  .nerd { margin: 6px 0; padding: 10px 12px; background: var(--rj-surface); border: 1px solid var(--rj-border); border-radius: calc(var(--rj-radius) - 4px); font: 12px/1.55 var(--rj-mono); color: var(--rj-text-dim); white-space: pre-wrap; }
  .sumrow { margin: 6px 0 2px; }
  .sumcard { background: var(--rj-surface); border: 1px solid var(--rj-border); border-radius: var(--rj-radius); padding: 14px 16px; margin: 8px 0 12px; }
  .sumtl { margin: 0 0 8px; font-weight: 700; font-size: 15px; line-height: 1.4; }
  .sumcard ul { margin: 0 0 10px; padding-left: 18px; color: var(--rj-text-dim); font-size: 14px; line-height: 1.5; }
  .summ { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 8px; }
  .summ button { background: var(--rj-surface-2); border: 1px solid var(--rj-border); color: var(--rj-text); border-radius: var(--rj-pill); padding: 6px 12px; font-size: 13px; }
  .summ b { color: var(--rj-accent); font-variant-numeric: tabular-nums; margin-right: 4px; }
  .sumfoot { margin: 0; font-size: 11px; color: var(--rj-text-faint); }
  .qbtn { white-space: nowrap; }
  .qbtn:hover { background: var(--rj-surface); }
  .chanlink { background: none; border: none; padding: 0; color: var(--rj-text); font-size: 12px; font-weight: 600; }
  .chanlink:hover { text-decoration: underline; }
  .chan-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 18px 2px 4px; }
  .chan-head h1 { margin: 0; font-size: 20px; font-weight: 700; }
  .subbtn { flex: none; height: 34px; padding: 0 18px; border: none; border-radius: var(--rj-pill); background: var(--rj-accent); color: #0c0e14; font-size: 13px; font-weight: 700; }
  .subbtn.subbed { background: none; color: var(--rj-text-dim); border: 1px solid var(--rj-border); }
  .chan-sec { margin-top: 20px; }
  .chan-sec-h { display: flex; align-items: baseline; justify-content: space-between; margin: 0 2px 8px; }
  .chan-sec-h h2 { font-size: 14px; font-weight: 600; color: var(--rj-text-dim); margin: 0; }
  .chan-none { margin: 8px 2px; font-size: 13px; color: var(--rj-text-faint); }
  .cbanner { margin: 0 0 12px; border-radius: 16px; overflow: hidden; background: var(--rj-surface); aspect-ratio: 16/4.6; }
  .cbanner img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .cinfo { align-items: center; gap: 12px; }
  .cav { width: 56px; height: 56px; border-radius: 50%; object-fit: cover; flex: none; background: var(--rj-surface); }
  .cname { flex: 1; min-width: 0; }
  .cname h1 { margin: 0; }
  .cmeta { margin: 3px 0 0; font-size: 12px; color: var(--rj-text-dim); }
  .cbio { margin: 6px 2px 4px; }
  .cbiotxt { margin: 0 0 4px; font-size: 13px; line-height: 1.45; color: var(--rj-text-dim); white-space: pre-line; display: -webkit-box; -webkit-line-clamp: 3; line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
  .cbiotxt.open { display: block; -webkit-line-clamp: unset; line-clamp: unset; }
  .plmore { text-align: center; font-size: 12px; color: var(--rj-text-faint); padding: 18px 0 8px; }
  .plctl { display: flex; gap: 6px; }
  .playall.on { background: var(--rj-accent); color: #060608; border-color: var(--rj-accent); }
  .plsearch { width: 100%; box-sizing: border-box; height: 40px; margin: 0 0 10px; padding: 0 14px; border-radius: var(--rj-pill); border: 1px solid var(--rj-border); background: var(--rj-surface); color: var(--rj-text); font-size: 14px; }
  .home { background: none; border: 0; padding: 0; cursor: pointer; }
  .ktabs { display: flex; gap: 8px; margin: 0 2px 12px; }
  .ktab { height: 32px; padding: 0 14px; border: 1px solid var(--rj-border); border-radius: var(--rj-pill); background: none; color: var(--rj-text-dim); font-size: 13px; font-weight: 600; }
  .ktab.on { color: #060608; background: var(--rj-accent); border-color: var(--rj-accent); }
  .crow .av { width: 64px; height: 64px; border-radius: 50%; object-fit: cover; flex: none; background: var(--rj-surface); }
  .avph { display: grid; place-items: center; width: 64px; height: 64px; border-radius: 50%; background: var(--rj-surface); color: var(--rj-text-dim); font-weight: 800; font-size: 22px; text-transform: uppercase; flex: none; }
  .plph { width: 120px; height: 68px; border-radius: 10px; }
  .cdesc { display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .plsub { margin: -4px 2px 4px; font-size: 13px; color: var(--rj-text-dim); }
  .linkbtn { background: none; border: 0; padding: 0; color: var(--rj-accent); font: inherit; }
  .playall { height: 28px; padding: 0 12px; border: 1px solid var(--rj-border); border-radius: var(--rj-pill); background: none; color: var(--rj-text); font-size: 12px; font-weight: 600; }
  .playall:hover { background: var(--rj-surface); }
  .wactions { display: flex; gap: 8px; margin: 12px 4px 0; }
  .wlike { display: inline-flex; align-items: center; gap: 7px; height: 34px; padding: 0 16px; border: 1px solid var(--rj-border); border-radius: var(--rj-pill); background: none; color: var(--rj-text-dim); font-size: 13px; font-weight: 600; transition: color .15s, border-color .15s, background .15s; }
  .wlike svg { width: 16px; height: 16px; fill: currentColor; transition: transform .15s; }
  .wlike:hover { color: var(--rj-text); background: var(--rj-surface); }
  .wlike.liked { color: var(--rj-accent); border-color: var(--rj-accent); }
  .wlike.liked svg { transform: scale(1.08); }
  .empty { margin: 40px 0; text-align: center; font-size: 14px; color: var(--rj-text-faint); }
  .player h1 { font-size: 17px; font-weight: 600; margin: 14px 4px 4px; line-height: 1.35; }
  .player .meta { margin: 0 4px 16px; display: flex; align-items: center; gap: 2px; }
  .frame { position: relative; aspect-ratio: 16/9; background: var(--rj-surface); border-radius: var(--rj-radius); overflow: hidden; }
  .frame.portrait { aspect-ratio: 9/16; max-width: 380px; margin: 0 auto; }
  .frame video { position: absolute; inset: 0; width: 100%; height: 100%; background: #000; object-fit: contain; }
  .buffering {
    position: absolute; inset: 0; display: grid; place-items: center;
    background-size: cover; background-position: center;
  }
  .buffering span {
    padding: 8px 16px; border-radius: var(--rj-pill);
    background: rgba(0,0,0,.72); color: var(--rj-text-dim); font-size: 14px;
  }
  .vo { position: absolute; inset: 0; z-index: 3; display: flex; flex-direction: column; justify-content: space-between; transition: opacity .2s; -webkit-tap-highlight-color: transparent; background: linear-gradient(to bottom, rgba(0,0,0,.55), transparent 28%, transparent 62%, rgba(0,0,0,.7)); }
  .vo.hide { opacity: 0; }
  .vo.hide * { pointer-events: none; }
  .vo-top { padding: 10px 14px 0; }
  .vo-title { display: block; font-size: 14px; font-weight: 600; color: #fff; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .vo-mid { display: flex; align-items: center; justify-content: center; gap: 22px; }
  .vo-b { width: 44px; height: 44px; border: 0; border-radius: 50%; background: rgba(0,0,0,.45); color: #fff; display: grid; place-items: center; padding: 0; cursor: pointer; }
  .vo-b:disabled { opacity: .35; }
  .vo-b svg { width: 22px; height: 22px; fill: currentColor; }
  .vo-play { width: 62px; height: 62px; background: var(--rj-accent); color: #060608; }
  .vo-play svg { width: 30px; height: 30px; }
  .vo-sm { width: 34px; height: 34px; background: none; }
  .vo-sm svg { width: 20px; height: 20px; }
  .vo-bot { display: flex; align-items: center; gap: 8px; padding: 0 10px 8px; }
  .vo-t { font-size: 12px; color: #fff; font-variant-numeric: tabular-nums; min-width: 34px; text-align: center; }
  .vo-q.on, .qbtn.on { background: var(--rj-accent); color: #000; border-color: var(--rj-accent); }
  .vo-q { height: 24px; padding: 0 8px; border: 1px solid rgba(255,255,255,.4); border-radius: var(--rj-pill); background: none; color: #fff; font-size: 11px; font-weight: 700; }
  .vo-seek { flex: 1; min-width: 0; height: 28px; -webkit-appearance: none; appearance: none; background: transparent; margin: 0; }
  .vo-seek::-webkit-slider-runnable-track { height: 4px; border-radius: 2px; background: linear-gradient(to right, var(--rj-accent) var(--p), rgba(255,255,255,.3) var(--p)); }
  .vo-seek::-moz-range-track { height: 4px; border-radius: 2px; background: rgba(255,255,255,.3); }
  .vo-seek::-moz-range-progress { height: 4px; border-radius: 2px; background: var(--rj-accent); }
  .vo-seek::-webkit-slider-thumb { -webkit-appearance: none; width: 14px; height: 14px; margin-top: -5px; border-radius: 50%; background: var(--rj-accent); border: 0; }
  .vo-seek::-moz-range-thumb { width: 14px; height: 14px; border-radius: 50%; background: var(--rj-accent); border: 0; }
  .frame:fullscreen { border-radius: 0; background: #000; aspect-ratio: auto; max-width: none; }
  .frame:-webkit-full-screen { border-radius: 0; background: #000; }
  .stall { position: absolute; inset: 0; display: grid; place-items: center; background: rgba(0,0,0,.55); z-index: 2; }
  .stall > span { padding: 8px 16px; border-radius: var(--rj-pill); background: rgba(0,0,0,.72); color: var(--rj-text-dim); font-size: 14px; }
  .cut { display: grid; gap: 8px; justify-items: center; padding: 20px; text-align: center; }
  .cut p { margin: 0; font-size: 15px; font-weight: 600; }
  .cut .sub { font-size: 13px; font-weight: 400; color: var(--rj-text-dim); }
  .retry { height: 36px; padding: 0 18px; border: none; border-radius: var(--rj-pill); font-size: 14px; font-weight: 700; color: var(--rj-accent-ink); background: var(--rj-accent); margin-top: 6px; }
  .hdnote { margin: -10px 4px 14px; font-size: 12px; color: var(--rj-text-faint); }
  .backbtn {
    height: 40px; padding: 0 18px;
    border: 1px solid var(--rj-border); border-radius: var(--rj-pill);
    background: none; color: var(--rj-text-dim); font-size: 13px;
  }
  .backbtn:hover { color: var(--rj-text); }
  .scard { flex: 0 0 88px; height: 172px; overflow: hidden; }
  .scard .sthumb { height: 112px; aspect-ratio: 3/4; }
  .feed { position: fixed; inset: 0; z-index: 60; background: #000; }
  .feed-scroll { height: 100%; max-width: 430px; margin: 0 auto; overflow-y: auto; scroll-snap-type: y mandatory; scrollbar-width: none; }
  .feed-scroll::-webkit-scrollbar { display: none; }
  .slide { position: relative; height: 100%; scroll-snap-align: start; scroll-snap-stop: always; background: #000; }
  .slide video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
  .slide-prog { position: absolute; left: 0; right: 0; bottom: 0; height: 22px; cursor: pointer; z-index: 6; display: flex; align-items: flex-end; }
  .slide-prog::before { content: ''; position: absolute; left: 0; right: 0; bottom: 0; height: 3px; background: rgba(255,255,255,.25); }
  .slide-prog-fill { position: relative; height: 3px; background: var(--rj-accent); transition: width .2s linear; }
  .slide-meta { position: absolute; left: 14px; right: 14px; bottom: max(18px, env(safe-area-inset-bottom)); pointer-events: none; text-shadow: 0 1px 8px rgba(0,0,0,.8); }
  .slide-title { margin: 0 0 4px; font-size: 15px; font-weight: 600; color: #fff; }
  .slide-chan { margin: 0; font-size: 13px; color: rgba(255,255,255,.75); }
  button.slide-chan { display: block; padding: 2px 0; border: none; background: none; pointer-events: auto; cursor: pointer; text-align: left; text-shadow: inherit; }
  .slide-play { position: absolute; inset: 0; margin: auto; width: 74px; height: 74px; border: none; border-radius: 50%; background: rgba(0,0,0,.55); display: grid; place-items: center; }
  .slide-play svg { width: 34px; height: 34px; fill: #fff; }
  .slide-note { position: absolute; inset: 0; display: grid; place-items: center; }
  .slide-note span { padding: 8px 16px; border-radius: 999px; background: rgba(0,0,0,.7); color: rgba(255,255,255,.8); font-size: 14px; }
  .slide-err { position: absolute; inset: 0; display: grid; place-content: center; gap: 6px; padding: 20px; border: none; background: rgba(0,0,0,.6); color: #fff; text-align: center; }
  .slide-err p { margin: 0; font-size: 15px; font-weight: 600; }
  .slide-err span { font-size: 13px; color: rgba(255,255,255,.7); }
  .feed-back { position: absolute; top: max(12px, env(safe-area-inset-top)); left: 12px; z-index: 61; width: 38px; height: 38px; border: none; border-radius: 50%; background: rgba(0,0,0,.5); display: grid; place-items: center; }
  .feed-back svg { width: 20px; height: 20px; fill: none; stroke: #fff; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .zone-h { display: flex; align-items: baseline; justify-content: space-between; margin: 18px 2px 8px; }
  .zone-h .hist-h { margin: 0; }
  .zone-open { height: 28px; padding: 0 12px; border: 1px solid var(--rj-border); border-radius: var(--rj-pill); background: none; color: var(--rj-text-dim); font-size: 12px; }
  .zone-open:hover { color: var(--rj-text); background: var(--rj-surface); }
  .subs-link { background: none; border: none; color: var(--rj-accent); font-size: 15px; font-weight: 600; padding: 6px 10px; cursor: pointer; }
  .subspage h1 { margin: 18px 16px 12px; font-size: 24px; color: #fff; }
  .subspage .empty { margin: 12px 16px; color: rgba(255,255,255,.6); font-size: 14px; }
  .subslist { display: flex; flex-direction: column; gap: 2px; margin: 0 10px; }
  .subrow { display: flex; align-items: center; gap: 10px; padding: 10px 8px; border-radius: 12px; }
  .subrow:hover { background: rgba(255,255,255,.05); }
  .subgo { flex: 1; text-align: left; background: none; border: none; color: #fff; font-size: 15px; font-weight: 600; cursor: pointer; padding: 4px 6px; }
  .unsub { border: 1px solid rgba(255,255,255,.18); background: none; color: rgba(255,255,255,.75); font-size: 13px; padding: 6px 14px; border-radius: 999px; cursor: pointer; }
  .feed-search { position: absolute; top: max(12px, env(safe-area-inset-top)); left: 58px; right: 12px; z-index: 61; }
  .feed-search-btn { position: absolute; top: max(12px, env(safe-area-inset-top)); left: 58px; z-index: 61; width: 38px; height: 38px; border: none; border-radius: 50%; background: rgba(0,0,0,.5); display: grid; place-items: center; }
  .feed-search-btn svg { width: 20px; height: 20px; fill: none; stroke: #fff; stroke-width: 2; stroke-linecap: round; }
  .feed-search input { width: 100%; height: 38px; padding: 0 16px; border: none; border-radius: 999px; background: rgba(0,0,0,.5); color: #fff; font-size: 14px; outline: none; }
  .feed-search input::placeholder { color: rgba(255,255,255,.55); }
  .feed-search input:focus { background: rgba(0,0,0,.7); }
  .feed-clear { position: absolute; top: max(58px, calc(env(safe-area-inset-top) + 46px)); left: 58px; z-index: 61; height: 28px; padding: 0 12px; border: none; border-radius: 999px; background: rgba(0,0,0,.55); color: rgba(255,255,255,.8); font-size: 12px; }
  .feed-err { position: absolute; top: max(58px, calc(env(safe-area-inset-top) + 46px)); right: 14px; z-index: 61; margin: 0; padding: 5px 10px; border-radius: 999px; background: rgba(0,0,0,.6); color: #ffb4b4; font-size: 12px; }
  .feed-empty { position: absolute; inset: 0; z-index: 60; display: grid; place-content: center; gap: 6px; text-align: center; color: #fff; }
  .feed-empty p { margin: 0; font-size: 16px; font-weight: 600; }
  .feed-empty span { font-size: 13px; color: rgba(255,255,255,.65); }
  .slide-like { position: absolute; right: 14px; bottom: max(84px, calc(env(safe-area-inset-bottom) + 66px)); width: 46px; height: 46px; border: none; border-radius: 50%; background: rgba(0,0,0,.45); display: grid; place-items: center; z-index: 2; }
  .slide-like svg { width: 24px; height: 24px; fill: rgba(255,255,255,.85); transition: fill .15s, transform .15s; }
  .slide-like.liked svg { fill: var(--rj-accent); transform: scale(1.08); }
  .slide-dislike { position: absolute; right: 14px; bottom: max(140px, calc(env(safe-area-inset-bottom) + 122px)); width: 46px; height: 46px; border: none; border-radius: 50%; background: rgba(0,0,0,.45); display: grid; place-items: center; z-index: 2; }
  .slide-dislike svg { width: 22px; height: 22px; fill: rgba(255,255,255,.85); transition: fill .15s, transform .15s; }
  .slide-dislike.disliked svg { fill: var(--rj-accent); transform: scale(1.08); }
  .heart-pop { position: absolute; left: 50%; top: 45%; width: 96px; height: 96px; margin: -48px 0 0 -48px; z-index: 6; pointer-events: none; color: #ff4d6d; animation: heartpop 0.7s ease-out forwards; }
  .heart-pop svg { width: 100%; height: 100%; fill: currentColor; filter: drop-shadow(0 4px 14px rgba(0,0,0,0.5)); }
  @keyframes heartpop { 0% { transform: scale(0.4); opacity: 0; } 25% { transform: scale(1.15); opacity: 1; } 100% { transform: scale(1); opacity: 0; } }
  @media (min-width: 900px) {
    main { max-width: 1320px; padding: 22px 36px 72px; }
    .results { grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 8px 14px; }
    .bar { max-width: 760px; }
    .fygrid { grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 14px; }
    .hcard { flex-basis: 210px; }
  }
  @media (min-width: 900px) { .frame:not(.portrait):not(:fullscreen) { max-width: min(100%, calc((100dvh - 200px) * 16 / 9)); margin-left: auto; margin-right: auto; } }
  /* channel tabs */
  .chan-tabs { display: flex; gap: 4px; margin: 14px 0 6px; border-bottom: 1px solid var(--rj-line, rgba(255,255,255,.12)); position: sticky; top: 0; z-index: 5; background: var(--rj-bg, #0b0b0c); }
  .chan-tabs button { background: none; border: 0; color: var(--rj-dim, #999); font: inherit; font-weight: 600; padding: 12px 16px; border-bottom: 2px solid transparent; margin-bottom: -1px; cursor: pointer; text-transform: lowercase; }
  .chan-tabs button.on { color: var(--rj-text, #fff); border-bottom-color: var(--rj-accent, #d9f24b); }
  .chanpage[data-tab='videos'] .chan-sec:not([data-t='videos']),
  .chanpage[data-tab='shorts'] .chan-sec:not([data-t='shorts']),
  .chanpage[data-tab='playlists'] .chan-sec:not([data-t='playlists']) { display: none; }
  @media (min-width: 1000px) {
    .chanpage .results { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 18px 16px; }
    .chanpage .results .row { flex-direction: column; align-items: stretch; }
    .chanpage .results .row img { width: 100%; height: auto; aspect-ratio: 16/9; }
    .chanpage .hist { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 16px; overflow: visible; }
    .chanpage .hist .hcard { width: auto; }
  }
  .cbanner { max-height: 200px; overflow: hidden; border-radius: 14px; }
  .cbanner img { width: 100%; max-height: 200px; object-fit: cover; display: block; }
  @media (min-width: 1000px) { .cbanner, .cbanner img { max-height: 240px; } }
</style>
