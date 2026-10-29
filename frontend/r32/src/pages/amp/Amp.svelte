<script>
  import { readSearches, addSearch, clearSearches } from '../../lib/searchhist.js';
  import Recent from '../../lib/Recent.svelte';
  import ArtistHead from '../../lib/ArtistHead.svelte';
  import AlbumHead from '../../lib/AlbumHead.svelte';
  import Row from '../../lib/Row.svelte';
  import { keyAction } from '../../lib/keys.js';
  import { buildAlbumPage, albumQuery } from '../../lib/album.js';
  import { buildArtistPage, primaryArtist } from '../../lib/artist.js';
import { whyStopped as probeWhy, handleTrackError } from '../../lib/amp-error-logic.mjs';
  import { makeMore, moreBump, moreFirstPage, moreCapture, moreApply } from '../../lib/amp-more.mjs';
  let qf = $state(false);
  import '../../tokens.css';
  import { onMount, tick } from 'svelte';
  import { dialog } from '../../lib/dialog.js';
  import { saveQueue, loadQueue } from '../../lib/queue-persist.js';
  import { encodeShare, decodeShare, importPlaylist } from '../../lib/share.js';
  import { api, errCopy } from '../../lib/api.js';

  let q = $state('');
  let sections = $state([]);
  let busy = $state(false);
  let error = $state('');
  let srcEmpty = $state([]); // sources that answered with nothing, shown as 'nothing from <source>'
  let soft = $state(''); // an honest 'still rebuilding' empty state, not an error banner
  let artBad = $state({}); // art urls that failed or answered 204: keep the placeholder
  let searched = $state(false);
  let searchedQ = $state('');
  const more = makeMore(); // continuation { gen, cursor }: a late page applies only if the generation is unchanged
  let auBusy = $state(false);
  let auNote = $state('');
  let auRetry = $state(false);

  // the queue is whatever was below the tapped row - tap a song and the
  // rest of the list plays after it, like dropping a needle on a list
  let queue = $state([]);
  let now = $state(null); // { ...item, qi }
  let playing = $state(false);
  let cur = $state(0);
  let total = $state(0);
  let trackErr = $state('');
  let loading = $state(false);

  // playlists live on the server per account - they follow you anywhere
  let playlists = $state([]);
  let view = $state('search'); // 'search' | 'playlist' | 'artist' | 'album'
  let artistPage = $state(null);
  let albumPage = $state(null);
  let plId = $state('');
  let plName = $state('');
  let newPlName = $state('');
  let showNewPl = $state(false);
  let saveTarget = $state(null);
  let toast = $state('');
  let toastT = null;

  onMount(() => {
    loadPlaylists();
    restoreSession();
    // desktop keys (ignored while typing): space play/pause, n/p next/prev, arrows seek 5s
    const onKey = (e) => {
      const a = keyAction(e);
      if (!a || !now) return;
      if (a === 'toggle') { e.preventDefault(); toggle(); }
      else if (a === 'next') next();
      else if (a === 'prev') prev();
      else if (a === 'seek-fwd' && el) { el.currentTime = Math.min((total || el.duration || 0), el.currentTime + 5); }
      else if (a === 'seek-back' && el) { el.currentTime = Math.max(0, el.currentTime - 5); }
    };
    window.addEventListener('keydown', onKey);
    // DIV-21: tab hidden/shown or page leaving - the UI must say what the element is really doing, and the position is saved
    const onVis = () => { syncUi(); checkSleep(); if (document.visibilityState === 'hidden') persist(); };
    const onHide = () => { syncUi(); persist(); };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('pagehide', onHide);
    // infinite scroll: near the list end, continue audius - the only source with a real cursor. first-page-only sources simply end.
    const onScroll = () => { if (searched && view === 'search' && more.cursor && !auBusy && window.innerHeight + window.scrollY > document.documentElement.scrollHeight - 900) moreAudius(); };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => { window.removeEventListener('keydown', onKey); document.removeEventListener('visibilitychange', onVis); window.removeEventListener('pagehide', onHide); window.removeEventListener('scroll', onScroll); };
  });

  function note(msg) {
    toast = msg;
    clearTimeout(toastT);
    toastT = setTimeout(() => { toast = ''; }, 2500);
  }

  async function loadPlaylists() {
    const r = await api('/api/apps/amp/playlists');
    if (r.ok) playlists = r.data.playlists || [];
  }

  const PL_CAP = 20;
  const CAP_COPY = 'you have 20 playlists already. delete one first.', DUP_COPY = 'you already have a playlist with that name.';
  const nameTaken = (n) => playlists.some((p) => String(p.name || '').trim().toLowerCase() === n.trim().toLowerCase());
  // fixed local copy for the known create refusals; the server text is only matched, never shown
  const createErr = (r) => {
    const m = String((r && r.data && r.data.error) || '');
    if (r && r.status === 400 && /twenty/i.test(m)) return CAP_COPY;
    if (r && r.status === 400 && /already have one|called that/i.test(m)) return DUP_COPY;
    return errCopy(r, "playlist couldn't be created.");
  };
  // "name (2)", "name (3)" ... within the 40 character limit
  const uniqueName = (base, tryN = 1) => {
    base = String(base || '').trim() || 'imported playlist';
    const suf = (i) => ' (' + i + ')', fit = (i) => Array.from(base).slice(0, 40 - suf(i).length).join('').trimEnd() + suf(i);   // 40 code points, never splitting an emoji
    let i = Math.max(2, tryN), n = tryN > 1 ? fit(i) : base;   // tryN > 1 forces that suffix even if a stale list says the plain name is free
    while (nameTaken(n) && i < 50) { n = fit(i); i++; }   // a taken plain name tries (2) first, then (3)...
    return n;
  };

  async function createPlaylist(e) {
    e?.preventDefault();
    const name = newPlName.trim();
    if (!name) return;
    if (playlists.length >= PL_CAP) { note(CAP_COPY); return; }
    if (nameTaken(name)) { note(DUP_COPY); return; }
    const r = await api('/api/apps/amp/playlists', { method: 'POST', body: { name } });
    if (!r.ok) { note(createErr(r)); return; }
    newPlName = '';
    note('playlist made');
    loadPlaylists();
  }

  let plGen = 0; // bumped on every playlist open and on leaving: only the newest response may apply
  async function openPlaylist(p) {
    const g = ++plGen;
    moreBump(more);   // a late continuation page must never land on the playlist's list
    const r = await api('/api/apps/amp/playlists/tracks?id=' + encodeURIComponent(p.id));
    if (g !== plGen) return;
    if (!r.ok) { note(errCopy(r, "playlist couldn't open.")); return; }
    view = 'playlist'; plId = p.id; plName = r.data.playlist.name;
    sections = r.data.playlist.tracks || [];
    searched = true; error = '';
  }

  function backHome() {
    plGen++;
    moreBump(more);
    view = 'search'; plId = ''; plName = ''; artistPage = null; albumPage = null;
    sections = []; searched = false; error = '';
    loadPlaylists();
  }

  // playlist mutations are index-based on the server, so they run one at a time and find their row by key (stable identity) right
  // before sending: a list that shifted or changed under an earlier call can never make a later call hit the wrong song.
  let mutP = Promise.resolve();
  const serial = (fn) => (mutP = mutP.then(fn, fn));
  function movePl(i, dir) {
    const id = plId, key = sections[i]?.key, g = plGen;   // captured at click time: leaving and reopening the playlist bumps plGen
    if (!key) return;
    return serial(async () => {
      if (plId !== id || g !== plGen) return;
      const k = sections.findIndex((x) => x.key === key), j = k + dir;
      if (k < 0 || j < 0 || j >= sections.length) return;
      const r = await api('/api/apps/amp/playlists/move', { method: 'POST', body: { id, index: k, dir } });
      if (!r.ok) { note(errCopy(r, "song couldn't be moved.")); return; }
      if (g !== plGen || plId !== id) return; // user left this playlist mid-request: the server moved it, the local list is not ours
      const k2 = sections.findIndex((x) => x.key === key); if (k2 !== k) return;
      const t = sections.splice(k, 1)[0]; sections.splice(j, 0, t); sections = sections;
    });
  }

  function removeFromPlaylist(i) {
    const id = plId, key = sections[i]?.key, g = plGen;   // captured at click time
    if (!key) return;
    return serial(async () => {
      if (plId !== id || g !== plGen) return;
      const k = sections.findIndex((x) => x.key === key);
      if (k < 0) return;
      const r = await api('/api/apps/amp/playlists/remove', { method: 'POST', body: { id, index: k } });
      if (!r.ok) { note(errCopy(r, "song couldn't be removed.")); return; }
      if (g !== plGen || plId !== id) return;
      const k2 = sections.findIndex((x) => x.key === key); if (k2 < 0) return;
      sections.splice(k2, 1);
      sections = sections;
    });
  }

  let renaming = $state(false);
  let renameVal = $state('');

  function startRename() {
    renameVal = plName;
    renaming = true;
  }

  async function saveRename(e) {
    e?.preventDefault();
    const name = renameVal.trim(), id = plId;
    renaming = false;
    if (!name || name === plName) return;
    const r = await api('/api/apps/amp/playlists/rename', { method: 'POST', body: { id, name } });
    if (!r.ok) { note(errCopy(r, "playlist couldn't be renamed.")); return; }
    if (plId === id) plName = name;   // the user may have left this playlist while it saved
    loadPlaylists();
  }

  async function deletePlaylist() {
    const id = plId;
    if (!id) return;
    const r = await api('/api/apps/amp/playlists/delete', { method: 'POST', body: { id } });
    if (!r.ok) { note(errCopy(r, "playlist couldn't be deleted.")); return; }
    note('playlist deleted');
    if (plId === id) backHome(); else loadPlaylists();   // only leave the view if it is still the deleted playlist
  }

  async function saveTo(p) {
    const t = saveTarget;
    saveTarget = null;
    if (!t) return;
    const r = await api('/api/apps/amp/playlists/add', { method: 'POST', body: { id: p.id, track: t } });
    if (!r.ok) { note(r.status === 400 && /this playlist is full/i.test(String(r.data?.error || '')) ? 'that playlist is full (100 songs).' : errCopy(r, "song couldn't be saved.")); return; }
    note(r.data.already ? 'already in ' + p.name : 'saved to ' + p.name);
    loadPlaylists();
  }

  async function createAndSave(e) {
    e?.preventDefault();
    const name = newPlName.trim();
    if (!name || !saveTarget) return;
    if (playlists.length >= PL_CAP) { note(CAP_COPY); return; }
    if (nameTaken(name)) { note(DUP_COPY); return; }
    const r = await api('/api/apps/amp/playlists', { method: 'POST', body: { name } });
    if (!r.ok) { note(createErr(r)); return; }
    newPlName = '';
    await saveTo(r.data.playlist);
  }

  // quick searches: artists you actually played lately, then the defaults
  const DEFAULT_CHIPS = ['daft punk', 'lofi girl', 'tyler the creator', 'deadmau5'];
  const chips = $derived.by(() => {
    const out = recentQ.slice(0, 4).map((x) => x.toLowerCase());
    for (const r of recents) {
      const a = String(r.artist || '').split(/,|&| feat/i)[0].trim().toLowerCase();
      if (a && a.length < 30 && !out.includes(a)) out.push(a);
      if (out.length >= 4) break;
    }
    for (const d of DEFAULT_CHIPS) { if (out.length >= 4) break; if (!out.includes(d)) out.push(d); }
    return out;
  });
  const SRC_LABEL = { yt: 'youtube music', sc: 'soundcloud', au: 'audius' };

  let el = null; // the one audio element

  // recently played: this device only, newest first, one tap to clear
  let recents = $state([]);
  try { recents = JSON.parse(localStorage.getItem('amp-recent') || '[]').slice(0, 10); } catch {}
  function noteRecent(item) {
    const { key, title, artist, album, art, src, stream, dur, durSec } = item;
    if (!key || !stream) return;
    recents = [{ key, title, artist, album, art, src, stream, dur, durSec }, ...recents.filter((r) => r.key !== key)].slice(0, 10);
    try { localStorage.setItem('amp-recent', JSON.stringify(recents)); } catch {}
  }
  function clearRecents() { recents = []; try { localStorage.removeItem('amp-recent'); } catch {} }
  function playRecent(i) {
    queue = recents.slice(i).concat(recents.slice(0, i));
    played = new Set();
    start(queue[0], 0);
  }

  // player extras: shuffle, repeat (off / all / one), sleep timer. all of it is
  // per-session; the queue itself is untouched so toggling never loses your place.
  let shuffleOn = $state(false);
  let repeatMode = $state('off');
  let sleepMin = $state(0);
  let showQ = $state(false);
  function qRemap(f) { played = new Set([...played].map(f).filter((x) => x >= 0)); }
  function qRemove(i) {
    if (!now || i <= now.qi || i >= queue.length) return;
    queue = queue.filter((_, k) => k !== i);
    qRemap((x) => (x === i ? -1 : x > i ? x - 1 : x));
  }
  function qMove(i) {
    if (!now || i <= now.qi + 1 || i >= queue.length) return;
    const t = queue[i], dest = now.qi + 1;
    const q = queue.slice(); q.splice(i, 1); q.splice(dest, 0, t); queue = q;
    qRemap((x) => (x === i ? dest : x >= dest && x < i ? x + 1 : x));
  }
  let sleepT = null;
  let sleepAt = 0; // DIV-20: absolute deadline (ms); a throttled background timer cannot make it late
  let played = new Set();
  function cycleRepeat() { repeatMode = repeatMode === 'off' ? 'all' : repeatMode === 'all' ? 'one' : 'off'; }
  function cycleSleep() {
    sleepMin = sleepMin === 0 ? 15 : sleepMin === 15 ? 30 : sleepMin === 30 ? 60 : 0;
    clearTimeout(sleepT); sleepT = null; sleepAt = 0;
    if (sleepMin) {
      const m = sleepMin;
      sleepAt = Date.now() + m * 60 * 1000;
      sleepT = setTimeout(checkSleep, m * 60 * 1000);   // still a timer, but the deadline decides: timeupdate and visibilitychange re-check it
      note('pausing in ' + m + ' minutes');
    }
  }
  function checkSleep() {
    if (!sleepAt || Date.now() < sleepAt) return;
    clearTimeout(sleepT); sleepT = null; sleepAt = 0;
    try { el?.pause(); } catch {}
    sleepMin = 0; note('sleep timer: paused');
  }
  // DIV-21: make the UI reflect the element, never the other way round. No autoresume after an interruption.
  function syncUi() {
    if (!el) return;
    playing = !el.paused && !el.ended;
    if (el.paused) loading = false;
    cur = el.currentTime || 0;
  }
  // DIV-25: {track, position} saved with the queue so a reload comes back paused where it was
  let restorePos = 0, lastSave = 0;
  function persist(pos) {
    if (!now) return;
    try { saveQueue(localStorage, { queue, qi: now.qi, pos: pos ?? (el && el.readyState > 0 ? el.currentTime : restorePos), shuffleOn, repeatMode }, Date.now()); } catch {}
    lastSave = Date.now();
  }
  function restoreSession() {
    if (now) return;
    let r = null;
    try { r = loadQueue(localStorage, Date.now()); } catch {}
    if (!r) return;
    queue = r.queue; shuffleOn = r.shuffleOn; repeatMode = r.repeatMode;
    now = { ...r.queue[r.qi], qi: r.qi }; played = new Set([r.qi]);
    total = now.durSec || 0; cur = r.pos; restorePos = r.pos; playing = false; loading = false;
    // no Audio element yet: autoplay is blocked without a gesture and a yt stream would spend bandwidth on load. the first tap resumes (toggle).
    setSession();
  }

  // share + import (client-only; there is no bulk route, songs are added one at a time)
  let showImport = $state(false), impText = $state(''), impBusy = $state(false), impDone = $state(0), impTotal = $state(0), impMsg = $state(''), impCtl = null;
  let shareCode = $state('');
  const impDecoded = $derived(impText.trim() ? decodeShare(impText) : null);
  const impPreview = $derived(!impDecoded ? '' : !impDecoded.ok ? impDecoded.error : `${impDecoded.tracks.length} song${impDecoded.tracks.length === 1 ? '' : 's'}` + (impDecoded.dropped + impDecoded.duplicates ? `, ${impDecoded.dropped + impDecoded.duplicates} skipped` : '') + (impDecoded.truncated ? `, ${impDecoded.truncated} over the limit` : ''));
  const IMP_STOP = { gone: "that playlist isn't there anymore.", 'too-large': 'that playlist is too big to import.', rate: 'slow down a bit.', full: 'that playlist is full (100 songs).', errors: "some songs couldn't be added.", aborted: 'import cancelled.', error: 'import stopped.' };
  let impEl = $state(null);
  async function openImport() { showImport = true; await tick(); impEl?.focus(); }
  async function closeImport() { showImport = false; impText = ''; impMsg = ''; await tick(); document.querySelector('[data-testid=amp-import-open]')?.focus(); }
  function impKey(e) { if (e.key === 'Escape') { e.stopPropagation(); if (impBusy) impCtl && impCtl.abort(); else closeImport(); } }
  async function runImport() {
    if (!impDecoded || !impDecoded.ok || impBusy) return;
    impBusy = true; impMsg = ''; impDone = 0; impTotal = impDecoded.tracks.length; impCtl = new AbortController();
    if (playlists.length >= PL_CAP) { impBusy = false; impCtl = null; impMsg = CAP_COPY; return; }
    // a shared name that already exists here (same account, or imported twice) gets " (2)", " (3)" instead of failing
    let res, tryN = 1;
    try {
    for (let k = 0; k < 4; k++) {
      if (impCtl && impCtl.signal.aborted) { res = { stopped: 'aborted', added: 0, already: 0, failed: 0, total: impDecoded.tracks.length, error: '' }; break; }   // cancelled: no new create
      const dec = { ...impDecoded, name: uniqueName(impDecoded.name, tryN) };
      res = await importPlaylist(api, dec, { signal: impCtl.signal, onProgress: (d, t) => { impDone = d; impTotal = t; } });
      if (res.stopped === 'create' && /already have one|called that/i.test(res.error || '')) { tryN += 1; await loadPlaylists(); continue; }   // the next pass re-checks abort before creating anything   // lost a race on the name: next suffix
      break;
    }
    } catch { res = { stopped: 'error', error: '', added: 0, already: 0, failed: 0, total: impDecoded.tracks.length }; }   // unknown state: a playlist may exist, so refresh the list below
    finally { impBusy = false; impCtl = null; }   // whatever threw, the sheet never stays stuck busy
    if (res.stopped === 'create') {
      impMsg = /twenty/i.test(res.error) ? CAP_COPY : /already have one|called that/i.test(res.error || '') ? DUP_COPY : "couldn't create the playlist.";
      return;
    }
    await loadPlaylists();
    const n = res.added + res.already;
    if (res.stopped === 'error') { impMsg = 'import stopped. check your playlists.'; return; }   // unknown failure: the real count is not known, so none is claimed
    if (res.stopped) { impMsg = `imported ${n} of ${res.total} songs. ${IMP_STOP[res.stopped] || ''}`.trim(); return; }
    showImport = false; impText = '';
    note(`imported ${n} song${n === 1 ? '' : 's'}${res.failed ? `, ${res.failed} couldn't be added` : ''}`);
  }
  async function sharePlaylist() {
    const code = encodeShare(plName, sections);
    try { await navigator.clipboard.writeText(code); shareCode = ''; note('code copied'); }
    catch { shareCode = code; }
  }
  // lock screen / headphone / control-center controls (this is what makes it a real player on a phone)
  function setSession() {
    if (!('mediaSession' in navigator) || !now) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: now.title || '', artist: now.artist || SRC_LABEL[now.src] || '',
        artwork: now.art && !artBad[now.art] ? [{ src: now.art, sizes: '512x512' }] : [],   // DIV-23
      });
      const ms = navigator.mediaSession;
      ms.setActionHandler('play', () => toggle());
      ms.setActionHandler('pause', () => toggle());
      ms.setActionHandler('previoustrack', () => prev());
      ms.setActionHandler('nexttrack', () => next());
      ms.setActionHandler('seekto', (d) => { if (el && d.seekTime != null) el.currentTime = d.seekTime; });
    } catch {}
  }
  $effect(() => { if (now && now.art && artBad[now.art]) setSession(); }); // DIV-23: art that failed after the session was set drops off the lock screen too
  function setPos() {
    try { if ('mediaSession' in navigator && el && total) navigator.mediaSession.setPositionState({ duration: total, position: Math.min(el.currentTime, total), playbackRate: 1 }); } catch {}
  }

  let recentQ = $state(readSearches('amp-searches'));
  async function search(e) {
    e?.preventDefault();
    if (busy || !q.trim()) return;
    plGen++;   // a playlist open still in flight must not reopen over this search
    recentQ = addSearch('amp-searches', q);
    busy = true; error = ''; soft = ''; srcEmpty = []; searched = false; sections = [];
    searchedQ = q.trim(); moreBump(more); auNote = ''; auRetry = false;
    view = 'search'; plId = ''; plName = ''; artistPage = null; albumPage = null;
    const r = await api(`/api/apps/amp/search?q=${encodeURIComponent(q.trim())}`);
    busy = false; searched = true;
    if (r.status === 501) { soft = errCopy(r, "this part isn't ready yet."); return; }
    if (!r.ok) { error = errCopy(r, "search couldn't load."); return; }
    const d = r.data.results || {};
    const flat = [];
    for (const src of ['youtube', 'soundcloud', 'audius']) {
      for (const it of d[src] || []) flat.push(it);
    }
    sections = flat;
    srcEmpty = ['youtube', 'soundcloud', 'audius'].filter((k) => !(d[k] || []).length);
    moreFirstPage(more, r.data.next);   // yt/sc cursors are null by contract - nothing to continue for them
  }

  // more songs: continue audius only. a cursored answer carries just audius rows; a short or empty page ends the cursor (next.audius null).
  async function moreAudius() {
    if (busy || auBusy || !more.cursor || !searched || view !== 'search') return;
    const cq = searchedQ, cap = moreCapture(more);
    auBusy = true; auNote = ''; auRetry = false;
    const r = await api(`/api/apps/amp/search?q=${encodeURIComponent(cq)}&cursor=${encodeURIComponent(cap.cursor)}`);
    auBusy = false;
    const d = moreApply(more, cap, r.status, r.data);
    if (d.type === 'stale') return;   // a newer search or view moved on - drop the late page, even when the same query re-minted the same cursor
    if (d.type === 'end') { auNote = errCopy(r, 'those results stopped answering.'); return; }   // no retry: an unrecognized cursor fails identically
    if (d.type === 'error') { auNote = errCopy(r, "couldn't load more songs."); auRetry = true; return; }
    const have = new Set(sections.map((it) => it.key));
    const add = d.rows.filter((it) => !have.has(it.key));
    if (add.length) sections = [...sections, ...add];
  }

  function chip(c) { q = c; search(); }

  // artist page = a search for the name, narrowed to rows credited to that exact artist. No new route.
  async function openArtist(name) {
    const a = primaryArtist(name);
    if (!a || busy) return;   // search() ignores calls while busy, so sections would be stale
    plGen++;   // a playlist open still in flight must not reopen over this page
    q = a;
    await search();
    if (error || soft) return;
    const page = buildArtistPage(sections, a);
    if (!page.total) { note('no songs listed for this artist. showing search results.'); return; }
    artistPage = page;
    sections = page.tracks;
    srcEmpty = ['youtube', 'soundcloud', 'audius'].filter((k, i) => !page.counts[['yt', 'sc', 'au'][i]]);
    view = 'artist';
  }

  // album page = search "<artist> <album>", narrowed to rows with exactly that album credited to the artist.
  // yt rows are the only ones with an album, so this is a youtube music page. Order is relevance, not track number.
  async function openAlbum(artist, album) {
    plGen++;   // a playlist open still in flight must not reopen over this page
    const who = primaryArtist(artist);
    if (!who || !String(album || '').trim() || busy) return;
    q = albumQuery(who, album);
    await search();
    if (error || soft) return;
    const page = buildAlbumPage(sections, who, album);
    if (!page.total) { note('no songs found for this album. showing search results.'); return; }
    albumPage = page;
    sections = page.tracks;
    srcEmpty = [];
    view = 'album';
  }

  function playAt(i) {
    const item = sections[i];
    if (!item) return;
    queue = sections.slice(i).concat(sections.slice(0, i));
    played = new Set();
    start(item, 0);
  }

  const reduceMotion = () => { try { if (localStorage.getItem('rj-reduce-motion') === '1') return true; } catch {} return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches; };
  let seekH = null;   // one-shot resume seek; a different song must never inherit it
  function start(item, qi) {
    if (seekH && el) { el.removeEventListener('loadedmetadata', seekH); seekH = null; }
    trackErr = ''; retried = false; errGen++;
    now = { ...item, qi };
    played.add(qi);
    noteRecent(item);
    setSession();
    playing = false; loading = true;
    cur = 0; total = item.durSec || 0;
    ensureEl(); el.preload = 'auto'; lastPos = 0; restorePos = 0;
    el.src = item.stream;
    el.play().catch(() => { if (!el.error) trackErr = 'tap play to start it'; });
    persist(0);
  }

  let lastPos = 0;
  function ensureEl() {
    if (el) return;
      el = new Audio();
      el.preload = 'auto';
      el.addEventListener('timeupdate', () => {
        cur = el.currentTime; if (el.duration && isFinite(el.duration)) total = el.duration;
        const t = Date.now(); if (t - lastPos >= 5000) { lastPos = t; setPos(); }   // DIV-22: total first, then at most one lock-screen update per 5s
        checkSleep(); if (t - lastSave >= 5000) persist();
      });
      el.addEventListener('ended', () => { if (repeatMode === 'one') { el.currentTime = 0; el.play().catch(() => {}); } else next(true); });
      el.addEventListener('play', () => { syncUi(); });
      el.addEventListener('playing', () => { loading = false; trackErr = ''; errStreak = 0; }); // retried resets only in start(): a track that plays then errors again must not loop retry forever
      el.addEventListener('waiting', () => { loading = true; });
      el.addEventListener('canplay', () => { loading = false; });
      el.addEventListener('pause', () => { syncUi(); persist(); });
      el.addEventListener('error', () => onTrackError());
  }

  // when a track fails (usually youtube throttling), do what a real player
  // does: first try the same song from another source in the current list,
  // then skip ahead - only show an error when there is nowhere left to go.
  let errStreak = 0;
  let errGen = 0;        // per-attempt generation: only the newest error probe may act
  let retried = false;   // one same-track retry on a network or element hiccup, then fallback/skip
  // the audio element can't show a response body, so on failure ask the stream route once why.
  // decision logic lives in lib/amp-error-logic.mjs (unit-tested with goldens).
  async function onTrackError() {
    playing = false; loading = false;
    if (!now || !now.stream) return;
    const item = now;
    const g = ++errGen;
    const why = await probeWhy(item.stream, { fetchFn: (u, o) => fetch(u, o) });
    if (now !== item || g !== errGen) return;   // user moved on, or a newer error superseded this probe
    const r = handleTrackError({ now, sections, queue, errStreak, retried }, why);
    errStreak = r.errStreak; retried = r.retried;
    if (r.action === 'show-bandwidth') { trackErr = r.trackErr; return; }
    if (r.action === 'retry') { loading = true; el.src = item.stream; el.play().catch(() => {}); return; }
    if (r.action === 'fallback') {
      const alt = queue.concat(sections).find((x) => x.key === r.altKey);
      if (alt) { alt.__fellBack = true; queue[now.qi] = alt; note(r.note); start(alt, now.qi); return; }
    }
    if (r.action === 'skip') { note(r.note); next(); return; }
    trackErr = r.trackErr;
  }

  function toggle() {
    if (!now) return;
    if (!el || !el.src) {   // restored session, first tap: start the song and seek to the saved spot once metadata lands
      const at = restorePos, item = now, qi = now.qi;
      start(item, qi);
      if (at > 0) { restorePos = at; const url = el.src; seekH = () => { seekH = null; if (el.src === url) { try { el.currentTime = at; } catch {} } }; el.addEventListener('loadedmetadata', seekH, { once: true }); }
      return;
    }
    if (el.paused) {
      if (el.error) { errStreak = 0; el.load(); loading = true; }   // DIV-24: a manual reload is a fresh attempt
      el.play().catch(() => { if (!el.error) trackErr = 'tap play to start it'; });
    } else el.pause();
  }

  function next(auto) {
    if (!now) return;
    if (shuffleOn && queue.length > 1) {
      let pool = queue.map((_, i) => i).filter((i) => !played.has(i));
      if (!pool.length) {
        if (auto === true && repeatMode === 'off') return;
        played = new Set([now.qi]);
        pool = queue.map((_, i) => i).filter((i) => i !== now.qi);
      }
      const pi = pool[Math.floor(Math.random() * pool.length)];
      start(queue[pi], pi);
      return;
    }
    const ni = now.qi + 1;
    if (ni < queue.length) start(queue[ni], ni);
    else if (repeatMode === 'all' && queue.length) start(queue[0], 0);
  }

  function prev() {
    if (!now) return;
    if (el && el.currentTime > 4) { el.currentTime = 0; return; }
    const pi = now.qi - 1;
    if (pi >= 0) start(queue[pi], pi);
  }

  function seek(e) {
    if (!el || !total) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    el.currentTime = ratio * total;
  }

  function seekKey(e) {
    if (!el || !total) return;
    const step = e.shiftKey ? 15 : 5;
    let t = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') t = el.currentTime + step;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') t = el.currentTime - step;
    else if (e.key === 'Home') t = 0;
    else if (e.key === 'End') t = total;
    if (t === null) return;
    e.preventDefault();
    el.currentTime = Math.min(total, Math.max(0, t));
  }

  function fmt(s) {
    s = Math.max(0, Math.floor(s || 0));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }
</script>

<svelte:head><title>amp - ramjet</title></svelte:head>

<div class="page" class:hasplayer={!!now}>
  <header class="top">
    <a class="back" data-testid="amp-back" href="/" aria-label="back to ramjet">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
    </a>
    <span class="brand">amp</span>
    <span class="tagline">every catalog, one player</span>
  </header>

  <main class="wrap">
    <form class="search" data-testid="amp-search-form" onsubmit={search}>
      <input data-testid="amp-search-input" bind:value={q} onfocus={() => (qf = true)} onblur={() => setTimeout(() => (qf = false), 150)} placeholder="song, artist, anything" aria-label="search songs" autocomplete="off" />
      <Recent items={recentQ} query={q} focused={qf} onpick={(r) => { q = r; qf = false; search({ preventDefault() {} }); }} onclear={() => (recentQ = clearSearches('amp-searches'))} />
      <button type="submit" data-testid="amp-search-go" disabled={busy} aria-busy={busy}>play</button>
    </form>
    <div class="chips">
      {#each chips as c}<button class="chip" data-testid={"amp-chip-" + c} onclick={() => chip(c)}>{c}</button>{/each}
    </div>

    {#if error}<p class="error">{error}{#if error !== 'slow down a bit.' && error !== "this device can't do that" && error !== "this part isn't ready yet."} <button class="retrylink" data-testid="amp-search-retry" onclick={search}>try again</button>{/if}</p>{/if}
    {#if soft}<p class="dim">{soft}</p>{/if}
    {#if searched && !error && !soft}{#each srcEmpty as s}<p class="dim">no results from {s}</p>{/each}{/if}

    {#if !searched && !busy}
      {#if recents.length}
        <p class="home-h">recently played <button class="rc-clear" data-testid="amp-recents-clear" onclick={clearRecents}>clear</button></p>
        <div class="list">
          {#each recents as it, i (it.key)}
            <Row item={it} mode="recent" active={!!now && now.key === it.key} {artBad} srcLabel={SRC_LABEL}
              onplay={() => playRecent(i)} onartist={openArtist} onart={(u) => { artBad[u] = true; }} />
          {/each}
        </div>
      {/if}
      {#if playlists.length}
        <p class="home-h">your playlists</p>
        <div class="pls">
          {#each playlists as p (p.id)}
            <button class="plrow" data-testid="amp-playlist-open" onclick={() => openPlaylist(p)}>
              {#if p.art && !artBad[p.art]}<img src={p.art} alt="" loading="lazy" onerror={() => { artBad[p.art] = true; }} />{:else}<div class="plart"></div>{/if}
              <span class="plmeta">
                <span class="plname">{p.name}</span>
                <span class="plcount">{p.count} {p.count === 1 ? 'song' : 'songs'}</span>
              </span>
              <svg class="plgo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>
            </button>
          {/each}
        </div>
      {:else}
        <div class="empty">
          <p class="big">one search, three catalogs.</p>
          <p class="dim">youtube music, soundcloud and audius at once. tap a song and the list plays through.</p>
        </div>
      {/if}
      {#if showNewPl || newPlName}
        <form class="newpl" data-testid="amp-newpl-form" onsubmit={createPlaylist}>
          <input data-testid="amp-newpl-input" aria-label="new playlist name" bind:value={newPlName} placeholder="name a new playlist" maxlength="40" autocomplete="off" />
          <button type="submit" data-testid="amp-newpl-create" disabled={!newPlName.trim()}>create playlist</button>
        </form>
      {:else}
        <button class="newpl-open" data-testid="amp-newpl-open" onclick={() => { showNewPl = true; }}>+ new playlist</button>
      {/if}
      {#if showImport}
        <div class="imp" data-testid="amp-import-form" role="group" aria-label="import a playlist" onkeydown={impKey}>
          <textarea data-testid="amp-import-text" bind:this={impEl} aria-label="playlist code" placeholder="paste a playlist code" rows="3" bind:value={impText} disabled={impBusy}></textarea>
          {#if impPreview}<p class="impline" data-testid="amp-import-preview">{impPreview}</p>{/if}
          {#if impBusy}<p class="impline" data-testid="amp-import-progress" role="status">{impDone} / {impTotal}</p>{/if}
          {#if impMsg}<p class="impline" data-testid="amp-import-msg" role="status">{impMsg}</p>{/if}
          <div class="impbtns">
            {#if impBusy}<button data-testid="amp-import-cancel" aria-label="cancel import" onclick={() => impCtl && impCtl.abort()}>cancel</button>
            {:else}<button class="primary" data-testid="amp-import-go" aria-label="import playlist" disabled={!impDecoded || !impDecoded.ok} onclick={runImport}>import</button><button class="quiet" data-testid="amp-import-close" aria-label="close import" onclick={closeImport}>close</button>{/if}
          </div>
        </div>
      {:else}
        <button class="newpl-open" data-testid="amp-import-open" onclick={openImport}>import a playlist code</button>
      {/if}
    {/if}

    {#if view === 'playlist'}
      <div class="plhead">
        <button class="plback" data-testid="amp-playlist-back" onclick={backHome}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
          playlists
        </button>
        {#if renaming}
          <form class="plrename" onsubmit={saveRename}>
            <input data-testid="amp-rename-input" aria-label="playlist name" bind:value={renameVal} maxlength="40" autocomplete="off" autofocus />
            <button type="submit" data-testid="amp-rename-save">save</button>
          </form>
        {:else}
          <span class="pltitle">{plName}</span>
          {#if sections.length}<button class="pldel" data-testid="amp-playlist-share" onclick={sharePlaylist}>share</button>{/if}
          <button class="pldel" data-testid="amp-playlist-rename" onclick={startRename}>rename</button>
          <button class="pldel" data-testid="amp-playlist-delete" onclick={deletePlaylist}>delete</button>
        {/if}
      </div>
      {#if sections.length}
        <div class="plplay">
          <button data-testid="amp-play-all" onclick={() => playAt(0)}>play all</button>
          <button data-testid="amp-shuffle-all" onclick={() => { shuffleOn = true; playAt(Math.floor(Math.random() * sections.length)); }}>shuffle</button>
        </div>
      {/if}
      {#if shareCode}<textarea class="sharebox" data-testid="amp-share-code" aria-label="playlist code" readonly rows="3" onfocus={(e) => e.currentTarget.select()}>{shareCode}</textarea>{/if}
      {#if !sections.length}<p class="plempty">no songs yet. search and choose 'save to playlist'.</p>{/if}
    {/if}

    {#if view === 'artist' && artistPage}
      <ArtistHead page={artistPage} {artBad} onback={backHome} onplay={() => playAt(0)} onshuffle={() => { shuffleOn = true; playAt(Math.floor(Math.random() * sections.length)); }} onart={(u) => { artBad[u] = true; }} onalbum={(n) => openAlbum(artistPage.name, n)} />
    {/if}
    {#if view === 'album' && albumPage}
      <AlbumHead page={albumPage} {artBad} onback={backHome} onplay={() => playAt(0)} onshuffle={() => { shuffleOn = true; playAt(Math.floor(Math.random() * sections.length)); }} onart={(u) => { artBad[u] = true; }} onartist={() => openArtist(albumPage.artist)} />
    {/if}

    <div class="list">
      {#each sections as it, i (it.key)}
        <Row item={it} mode={view === 'playlist' ? 'playlist' : 'list'} index={i} count={sections.length} active={!!now && now.key === it.key} {artBad} srcLabel={SRC_LABEL}
          onplay={() => playAt(i)} onartist={openArtist} onalbum={openAlbum} onsave={() => { saveTarget = it; }}
          onmove={(d) => movePl(i, d)} onremove={() => removeFromPlaylist(i)} onart={(u) => { artBad[u] = true; }} />
      {/each}
    </div>
    {#if view === 'search' && searched}
      {#if auBusy}<p class="dim" data-testid="amp-more-loading">loading more songs...</p>{/if}
      {#if auNote}<p class="dim" data-testid="amp-more-note">{auNote} {#if auRetry}<button class="retrylink" data-testid="amp-more-retry" onclick={moreAudius}>try again</button>{/if}</p>{/if}
    {/if}
  </main>

  {#if saveTarget}
    <div class="overlay" onclick={() => { saveTarget = null; }}>
      <div class="sheet" role="dialog" aria-modal="true" aria-label="save to a playlist" tabindex="-1" use:dialog={() => { saveTarget = null; }} onclick={(e) => e.stopPropagation()}>
        <p class="sheet-h">save to a playlist</p>
        <p class="sheet-sub">{saveTarget.title}</p>
        {#each playlists as p (p.id)}
          <button class="sheetrow" data-testid="amp-save-target" onclick={() => saveTo(p)}>
            <span class="plname">{p.name}</span>
            <span class="plcount">{p.count}</span>
          </button>
        {/each}
        {#if !playlists.length}<p class="sheet-sub">no playlists yet. name one below.</p>{/if}
        <form class="newpl" data-testid="amp-save-newpl-form" onsubmit={createAndSave}>
          <input data-testid="amp-save-newpl-input" aria-label="new playlist name" bind:value={newPlName} placeholder="name a new playlist" maxlength="40" autocomplete="off" />
          <button type="submit" data-testid="amp-save-newpl-create" disabled={!newPlName.trim()}>create playlist</button>
        </form>
      </div>
    </div>
  {/if}

  {#if toast}<div class="toast">{toast}</div>{/if}

  {#if now}
    <div class="player">
      <button class="p-art" data-testid="amp-bar-art" onclick={toggle} aria-label={playing ? 'pause' : 'play'}>
        {#key now.key}
          {#if now.art && !artBad[now.art]}<img src={now.art} alt="" onerror={() => { artBad[now.art] = true; }} />{:else}<div class="noart"></div>{/if}
        {/key}
      </button>
      <div class="p-meta">
        <span class="p-title">{now.title}</span>
        {#if now.artist}
          <button class="p-sub p-link" data-testid="amp-bar-artist" onclick={() => { showQ = false; window.scrollTo({ top: 0, behavior: reduceMotion() ? 'auto' : 'smooth' }); openArtist(now.artist); }} aria-label={'view artist ' + now.artist}>{now.artist}</button>
        {:else}
          <span class="p-sub">{SRC_LABEL[now.src]}</span>
        {/if}
        <div class="bar" data-testid="amp-seek" onclick={seek} onkeydown={seekKey} tabindex="0" role="slider" aria-label="seek" aria-orientation="horizontal" aria-valuemin="0" aria-valuenow={Math.round(cur)} aria-valuemax={Math.round(total)} aria-valuetext={fmt(cur) + " of " + fmt(total)}>
          <div class="fill" style="width: {total ? (cur / total) * 100 : 0}%"></div>
        </div>
        <span class="times">{#if loading}loading{:else}{fmt(cur)} / {fmt(total)}{/if}</span>
      </div>
      {#if trackErr}<p class="terr">{trackErr}{#if trackErr !== 'the streaming limit has been reached.' && trackErr !== 'slow down a bit.' && trackErr !== 'tap play to start it'} <button class="retrylink" data-testid="amp-track-retry" onclick={() => { trackErr = ''; toggle(); }}>try again</button>{/if}</p>{/if}
      <div class="p-btns">
        <button data-testid="amp-prev" onclick={prev} aria-label="previous">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h2v14H6zM20 5v14L9.5 12z"/></svg>
        </button>
        <button class="pp" data-testid="amp-playpause" onclick={toggle} aria-label={playing ? 'pause' : 'play'}>
          {#if playing}
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>
          {:else}
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
          {/if}
        </button>
        <button data-testid="amp-next" onclick={next} aria-label="next">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M16 5h2v14h-2zM4 5v14l10.5-7z"/></svg>
        </button>
      </div>
      {#if showQ}
        <div class="qsheet" role="list">
          <div class="qhead"><b>up next</b><button data-testid="amp-queue-close" onclick={() => (showQ = false)} aria-label="close queue">close</button></div>
          {#each queue as t, i}
            {#if i >= (now?.qi ?? 0)}
              <div class="qrow" class:cur={i === now?.qi} role="listitem">
                <button class="qmain" data-testid="amp-queue-item" onclick={() => start(queue[i], i)}>
                  <span class="qn">{i === now?.qi ? '\u25B6' : i - (now?.qi ?? 0)}</span>
                  <span class="qt"><span class="qtt">{t.title}</span><span class="qa">{t.artist || ''}</span></span>
                </button>
                {#if i > (now?.qi ?? 0)}
                  {#if i > (now?.qi ?? 0) + 1}<button class="qact" data-testid="amp-queue-next" onclick={() => qMove(i)} aria-label="play next">next</button>{/if}
                  <button class="qact" data-testid="amp-queue-remove" onclick={() => qRemove(i)} aria-label="remove from queue">&times;</button>
                {/if}
              </div>
            {/if}
          {/each}
        </div>
      {/if}
      <div class="p-extra">
        <button data-testid="amp-shuffle" class:on={shuffleOn} onclick={() => { shuffleOn = !shuffleOn; played = new Set(now ? [now.qi] : []); }} aria-pressed={shuffleOn} aria-label="shuffle">shuffle</button>
        <button data-testid="amp-repeat" class:on={repeatMode !== 'off'} onclick={cycleRepeat} aria-label="repeat">repeat{repeatMode === 'all' ? ' all' : repeatMode === 'one' ? ' one' : ''}</button>
        <button data-testid="amp-queue" class:on={showQ} onclick={() => (showQ = !showQ)} aria-pressed={showQ} aria-label="queue">queue</button>
        <button data-testid="amp-sleep" class:on={sleepMin > 0} onclick={cycleSleep} aria-label="sleep timer">{sleepMin ? 'sleep ' + sleepMin + 'm' : 'sleep'}</button>
      </div>
    </div>
  {/if}
</div>

<style>

  /* amp - c7 restyle: keep r32's token vocabulary, swap the values underneath. paper skin re-remaps under :root[data-skin='paper'] */


  /* paper edge: token-aware selection highlight (global tokens.css selection is white-on-white on paper) */
  .page ::selection { background: color-mix(in srgb, var(--rj-accent) 32%, transparent); }

  @font-face { font-family: IBM Plex Sans; src: url(/assets/IBMPlexSans-var-GRPhyGEp.woff2) format("woff2"); font-weight: 100 900; font-style: normal; font-display: swap; }
  @font-face { font-family: IBM Plex Mono; src: url(/assets/IBMPlexMono-400-normal-C-SBB-bw.woff2) format("woff2"); font-weight: 400; font-style: normal; font-display: swap; }
  @font-face { font-family: IBM Plex Mono; src: url(/assets/IBMPlexMono-500-normal-B772pXP5.woff2) format("woff2"); font-weight: 500; font-style: normal; font-display: swap; }
  .page { --rj-bg: #0a0a0a; --rj-surface: #141414; --rj-surface-2: #1f1f1f; --rj-text: #f2f2f2; --rj-text-dim: #8f8f8f; --rj-text-faint: #8f8f8f; --rj-border: rgba(255,255,255,.08); --rj-accent: #ffffff; --rj-accent-ink: #0a0a0a; --rj-danger: #ffffff; --rj-hairline: rgba(255,255,255,.08); --rj-hairline-strong: #333333; min-height: 100dvh; background: var(--rj-bg); color: var(--rj-text); padding-bottom: 24px; font-family: IBM Plex Sans, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif }
  .page {  }
  :root[data-skin='paper'] .page {
    --rj-bg: #f2f2f2; --rj-surface: #e8e8e8; --rj-surface-2: #d4d4d4; --rj-text: #0a0a0a; --rj-text-dim: #626262; --rj-text-faint: #626262;
    --rj-border: rgba(29,29,29,.1); --rj-accent: #0a0a0a; --rj-accent-ink: #f2f2f2; --rj-danger: #0a0a0a;
    --rj-hairline: rgba(29,29,29,.1); --rj-hairline-strong: #cdcdcd;
  }
  .page.hasplayer { padding-bottom: 196px; }
  .top { display: flex; align-items: center; gap: 10px; padding: 14px 16px; max-width: 760px; margin: 0 auto; }
  .back { width: 38px; height: 38px; display: grid; place-items: center; border-radius: 10px; background: var(--rj-surface); color: var(--rj-text); border: 1px solid var(--rj-hairline); }
  .back svg { width: 20px; height: 20px; }
  .brand { font-family: IBM Plex Mono, ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 22px; font-weight: 800; letter-spacing: 0.5px; color: var(--rj-text); }
  .tagline { font-family: IBM Plex Mono, ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--rj-text-faint); }
  .wrap { max-width: 760px; margin: 0 auto; padding: 0 16px; }
  .search { display: flex; gap: 8px; min-width: 0; }
  .search input { flex: 1; min-width: 0; background: var(--rj-surface); border: 1px solid var(--rj-border); color: var(--rj-text); border-radius: 10px; padding: 13px 16px; font-size: 16px; outline: none; }
  .search input:focus { border-color: var(--rj-hairline-strong); }
  .search button { background: var(--rj-accent); color: var(--rj-accent-ink); border: 0; border-radius: 10px; padding: 0 22px; font-size: 15px; font-weight: 700; min-height: 44px; }
  .chips { display: flex; gap: 8px; flex-wrap: wrap; margin: 12px 0 4px; }
  .chip { background: var(--rj-surface); border: 1px solid var(--rj-hairline); color: var(--rj-text-dim); border-radius: 999px; padding: 8px 14px; font-family: IBM Plex Mono, ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; min-height: 36px; }
  .chip:hover { color: var(--rj-text); border-color: var(--rj-hairline-strong); }
  .error { color: var(--rj-danger); font-size: 14px; padding: 10px 2px; }
  .error { font-weight: 600 }
  .error::before { content: "!"; display: inline-block; width: 1em; height: 1em; line-height: 1em; text-align: center; border: 1px solid currentColor; border-radius: 50%; margin-right: 6px; font-size: .85em; vertical-align: baseline; }
  .empty { text-align: center; padding: 64px 20px; }
  .empty .big { font-size: 22px; font-weight: 600; letter-spacing: -0.01em; margin: 0 0 10px; }
  .empty .dim { color: var(--rj-text-faint); font-family: IBM Plex Mono, ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; margin: 0; }
  .list { display: flex; flex-direction: column; gap: 6px; margin-top: 10px; }
  .home-h { font-family: IBM Plex Mono, ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; font-weight: 500; letter-spacing: 0.04em; color: var(--rj-text-faint); margin: 18px 2px 8px; }
  .pls { display: flex; flex-direction: column; gap: 6px; }
  .plrow { display: flex; align-items: center; gap: 12px; width: 100%; text-align: left; background: var(--rj-surface); border: 1px solid var(--rj-hairline); border-radius: 10px; padding: 8px; color: var(--rj-text); min-height: 44px; }
  .plrow:hover { border-color: var(--rj-hairline-strong); }
  .plrow img, .plart { width: 52px; height: 52px; border-radius: 8px; object-fit: cover; background: var(--rj-surface-2); flex: none; }
  .plmeta { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .plname { font-size: 15px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .plcount { font-family: IBM Plex Mono, ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--rj-text-faint); flex: none; }
  .plgo { width: 18px; height: 18px; color: var(--rj-text-dim); flex: none; margin-right: 6px; }
  .newpl-open { margin-top: 14px; background: none; border: 1px dashed var(--rj-hairline-strong); color: var(--rj-text-dim); border-radius: 10px; padding: 12px 16px; font-size: 14px; width: 100%; min-height: 44px; }
  .imp { margin-top: 10px; display: flex; flex-direction: column; gap: 8px; }
  .imp textarea, .sharebox { width: 100%; box-sizing: border-box; background: var(--rj-surface); border: 1px solid var(--rj-border); color: var(--rj-text); border-radius: 10px; padding: 12px 16px; font: inherit; font-size: 16px; resize: vertical; }
  .sharebox { margin-top: 10px; }
  .impline { margin: 0; font-size: 13px; color: var(--rj-text-dim); }
  .retrylink { background: none; border: 0; padding: 0; font: inherit; color: inherit; text-decoration: underline; cursor: pointer; }
  .retrylink:focus-visible { outline: 2px solid var(--rj-text); outline-offset: 2px; }
  .impbtns { display: flex; gap: 8px; }
  .impbtns button { background: var(--rj-surface); border: 1px solid var(--rj-hairline); color: var(--rj-text-dim); border-radius: 10px; padding: 0 18px; font-size: 14px; min-height: 44px; }
  .impbtns button.primary, .newpl button[type=submit] { background: var(--rj-accent); border-color: var(--rj-accent); color: var(--rj-accent-ink); font-weight: 600; }
  .newpl button[type=submit]:not(:disabled):hover { color: var(--rj-accent-ink); }
  .impbtns button.quiet { background: none; border-color: transparent; }
  .impbtns button:disabled, .newpl button:disabled { opacity: .5; }
  .imp textarea:focus-visible, .sharebox:focus-visible, .impbtns button:focus-visible { outline: 2px solid var(--rj-accent); outline-offset: 2px; }
  .newpl-open:hover { color: var(--rj-text); border-color: var(--rj-hairline-strong); }
  .newpl { display: flex; gap: 8px; margin-top: 10px; }
  .newpl input { flex: 1; min-width: 0; background: var(--rj-surface); border: 1px solid var(--rj-border); color: var(--rj-text); border-radius: 10px; padding: 12px 16px; font-size: 15px; outline: none; }
  .newpl input:focus { border-color: var(--rj-hairline-strong); }
  .newpl button { background: var(--rj-surface); border: 1px solid var(--rj-hairline); color: var(--rj-text-dim); border-radius: 10px; padding: 0 18px; font-size: 14px; min-height: 44px; }
  .newpl button:not(:disabled):hover { color: var(--rj-text); border-color: var(--rj-hairline-strong); }
  .newpl button:disabled { opacity: 0.5; }
  .plhead { display: flex; align-items: center; gap: 10px; margin: 12px 0 4px; }
  .plback { display: flex; align-items: center; gap: 4px; background: none; border: 0; color: var(--rj-text-dim); font-size: 14px; padding: 6px 0; }
  .plback svg { width: 16px; height: 16px; }
  .plback:hover { color: var(--rj-text); }
  .pltitle { flex: 1; min-width: 0; font-size: 17px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pldel { background: none; border: 1px solid var(--rj-border); color: var(--rj-text-dim); border-radius: 999px; padding: 6px 12px; font-size: 12.5px; }
  .pldel:hover { color: var(--rj-danger); border-color: var(--rj-danger); }
  .plrename { flex: 1; min-width: 0; display: flex; gap: 6px; }
  .plrename input { flex: 1; min-width: 0; background: var(--rj-surface); border: 1px solid var(--rj-hairline-strong); color: var(--rj-text); border-radius: 10px; padding: 6px 10px; font-size: 15px; outline: none; }
  .plrename button { background: var(--rj-accent); color: var(--rj-accent-ink); border: 0; border-radius: 10px; padding: 0 14px; font-size: 13px; font-weight: 700; }
  .rc-clear { background: none; border: 0; color: var(--rj-text-dim); font-size: 12px; text-decoration: underline; padding: 4px 6px; margin-left: 6px; font-weight: 400; }
  .plempty { padding: 24px 4px; font-family: IBM Plex Mono, ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--rj-text-faint); }
  .overlay { position: fixed; inset: 0; z-index: 40; background: rgba(0,0,0,0.6); display: flex; align-items: flex-end; justify-content: center; }
  .sheet { width: 100%; max-width: 560px; background: var(--rj-surface); border: 1px solid var(--rj-border); border-radius: 18px 18px 0 0; padding: 18px 16px calc(18px + env(safe-area-inset-bottom)); display: flex; flex-direction: column; gap: 8px; max-height: 70dvh; overflow-y: auto; }
  .sheet-h { margin: 0; font-size: 16px; font-weight: 700; }
  .sheet-sub { margin: -2px 0 4px; font-size: 13px; color: var(--rj-text-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .sheetrow { display: flex; justify-content: space-between; align-items: center; gap: 10px; width: 100%; text-align: left; background: var(--rj-bg); border: 1px solid var(--rj-hairline); border-radius: 10px; padding: 12px 14px; color: var(--rj-text); font-size: 15px; min-height: 44px; }
  .sheetrow:hover { border-color: var(--rj-hairline-strong); }
  .toast { position: fixed; left: 50%; transform: translateX(-50%); bottom: 204px; z-index: 50; background: var(--rj-surface-2); border: 1px solid var(--rj-hairline-strong); color: var(--rj-text); border-radius: 999px; padding: 10px 18px; font-family: IBM Plex Mono, ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; white-space: nowrap; }
  @keyframes toastin { 0% { opacity: 0; transform: translate(-50%) translateY(10px); } }
  .toast { animation: toastin .2s cubic-bezier(.2,1,.3,1); }
  @media (prefers-reduced-motion: reduce) { .toast { animation: none; } }
  .player { position: fixed; left: 0; right: 0; bottom: 0; z-index: 20; display: flex; flex-wrap: wrap; gap: 12px; align-items: center; padding: 12px 16px calc(12px + env(safe-area-inset-bottom)); background: var(--rj-surface); border-top: 1px solid var(--rj-hairline); }
  .p-art { padding: 0; border: 0; background: none; flex: none; }
  .p-art img, .p-art .noart { width: 56px; height: 56px; border-radius: 10px; object-fit: cover; background: var(--rj-surface-2); display: block; }
  .p-meta { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
  .p-title { font-size: 15px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .plplay { display: flex; gap: 8px; margin: 4px 0 10px; }
  .plplay button { background: var(--rj-accent); color: var(--rj-accent-ink); border: 0; border-radius: 999px; padding: 0 20px; min-height: 40px; font-weight: 700; font-size: 14px; }
  .plplay button:last-child { background: var(--rj-surface); color: var(--rj-text); }
  .p-link { background: none; border: 0; padding: 0; text-align: left; font-family: inherit; cursor: pointer; }
  .p-sub { font-family: IBM Plex Mono, ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; color: var(--rj-text-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bar { height: 18px; display: flex; align-items: center; cursor: pointer; }
  .bar::before { content: ''; position: absolute; left: 0; right: 0; top: 50%; height: 44px; transform: translateY(-50%); } /* 44px effective target */
  .bar:focus-visible { outline: 2px solid var(--rj-text); outline-offset: 3px; border-radius: 4px; }
  .bar { position: relative; }
  .bar > .fill { height: 4px; background: var(--rj-accent); border-radius: 2px; transition: width 0.15s linear; }
  .bar::after { content: ''; position: absolute; left: 0; right: 0; height: 4px; background: var(--rj-hairline); border-radius: 2px; z-index: -1; }
  .times { font-family: IBM Plex Mono, ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: var(--rj-text-faint); }
  .terr { flex-basis: 100%; order: 4; margin: -4px 0 0; font-size: 12.5px; color: var(--rj-danger); }
  .p-btns { display: flex; gap: 4px; align-items: center; flex: none; }
  .p-btns button { width: 44px; height: 44px; border-radius: 50%; border: 0; background: none; color: var(--rj-text); display: grid; place-items: center; }
  .p-btns button svg { width: 22px; height: 22px; }
  .p-btns .pp { background: var(--rj-accent); color: var(--rj-accent-ink); }
  .p-extra { flex-basis: 100%; order: 6; display: flex; gap: 8px; margin-top: -2px; }
  .p-extra button { flex: 1; min-height: 36px; border-radius: 999px; border: 1px solid var(--rj-border); background: var(--rj-surface); color: var(--rj-text-dim); font-size: 13px; font-weight: 600; }
  .p-extra button.on { color: var(--rj-accent-ink); background: var(--rj-accent); border-color: var(--rj-accent); }
  .p-btns .pp svg { width: 24px; height: 24px; }
  .qsheet { position: fixed; left: 0; right: 0; bottom: 196px; max-height: 50dvh; overflow-y: auto; background: var(--rj-surface); border-top: 1px solid var(--rj-border); border-radius: 16px 16px 0 0; padding: 8px 12px; max-width: 760px; margin: 0 auto; z-index: 30; }
  .qhead { display: flex; justify-content: space-between; align-items: center; padding: 6px 4px 8px; font-family: IBM Plex Mono, ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; }
  .qhead button { background: none; border: 0; color: var(--rj-text-dim); font-size: 13px; min-height: 36px; }
  .qrow { display: flex; gap: 4px; align-items: center; border-bottom: 1px solid var(--rj-hairline); color: var(--rj-text); }
  .qmain { display: flex; gap: 10px; flex: 1; min-width: 0; text-align: left; background: none; border: 0; color: inherit; padding: 9px 4px; min-height: 44px; align-items: center; }
  .qact { background: none; border: 0; color: var(--rj-text-dim); font-size: 13px; min-width: 40px; min-height: 44px; }
  .qrow.cur { color: var(--rj-accent); }
  .qn { width: 22px; text-align: center; font-family: IBM Plex Mono, ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: var(--rj-text-faint); flex: none; }
  .qt { display: flex; flex-direction: column; min-width: 0; }
  .qtt, .qa { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .qa { font-family: IBM Plex Mono, ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; color: var(--rj-text-dim); }
  @media (min-width: 1000px) { .top, .wrap { max-width: 1040px; } }
  /* amp desktop v2 */
  @media (min-width: 1100px) {
    .wrap { max-width: 1240px; padding-bottom: 150px; }
    .search { max-width: 760px; margin-left: auto; margin-right: auto; }
    .chips { justify-content: center; }
        .wrap .list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px 20px; }
    .wrap .pls { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px 16px; }
    .home-h { margin-top: 28px; }
    .wrap .empty { padding: 60px 0; text-align: center; }
  }
  @media (min-width: 1700px) {
    .wrap { max-width: 1560px; }
    .wrap .list { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .wrap .pls { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  }
  form.search { position: relative; }

  /* touch hit-slop: pseudo-element grows tap targets toward 44px on coarse/no-hover pointers, where layout/stacking allow; visual size and desktop unchanged. exceptions: see review notes */
  @media (hover: none), (pointer: coarse) {
    .chip { position: relative; } .chip::after { content: ''; position: absolute; left: 0; right: 0; top: -4px; bottom: -4px; }
    .rc-clear { position: relative; } .rc-clear::after { content: ''; position: absolute; left: -1px; right: -1px; top: -11px; bottom: -11px; }
  }
  .newpl input, .plrename input, .search input { font-size: 16px; }
  .search input:focus-visible, .newpl input:focus-visible, .plrename input:focus-visible { outline: 2px solid var(--rj-text); outline-offset: 2px; }
</style>
