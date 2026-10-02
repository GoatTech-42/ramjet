<script>
  import { readSearches, addSearch } from '../../lib/searchhist.js';
  import '../../tokens.css';
  import { onMount } from 'svelte';
  import { api } from '../../lib/api.js';

  let q = $state('');
  let sections = $state([]);
  let busy = $state(false);
  let error = $state('');
  let searched = $state(false);

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
  let view = $state('search'); // 'search' | 'playlist'
  let plId = $state('');
  let plName = $state('');
  let newPlName = $state('');
  let showNewPl = $state(false);
  let saveTarget = $state(null);
  let toast = $state('');
  let toastT = null;

  onMount(() => {
    loadPlaylists();
    // desktop keys (ignored while typing): space play/pause, n/p next/prev, arrows seek 5s
    const onKey = (e) => {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.ctrlKey || e.metaKey || e.altKey || !now) return;
      if (e.code === 'Space') { e.preventDefault(); toggle(); }
      else if (e.key === 'n') next();
      else if (e.key === 'p') prev();
      else if (e.key === 'ArrowRight' && el) { el.currentTime = Math.min((total || el.duration || 0), el.currentTime + 5); }
      else if (e.key === 'ArrowLeft' && el) { el.currentTime = Math.max(0, el.currentTime - 5); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
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

  async function createPlaylist(e) {
    e?.preventDefault();
    const name = newPlName.trim();
    if (!name) return;
    const r = await api('/api/apps/amp/playlists', { method: 'POST', body: { name } });
    if (!r.ok) { note(r.data?.error || 'could not make it'); return; }
    newPlName = '';
    note('playlist made');
    loadPlaylists();
  }

  async function openPlaylist(p) {
    const r = await api('/api/apps/amp/playlists/tracks?id=' + encodeURIComponent(p.id));
    if (!r.ok) { note(r.data?.error || 'could not open it'); return; }
    view = 'playlist'; plId = p.id; plName = r.data.playlist.name;
    sections = r.data.playlist.tracks || [];
    searched = true; error = '';
  }

  function backHome() {
    view = 'search'; plId = ''; plName = '';
    sections = []; searched = false; error = '';
    loadPlaylists();
  }

  async function movePl(i, dir) {
    const j = i + dir;
    if (j < 0 || j >= sections.length) return;
    const r = await api('/api/apps/amp/playlists/move', { method: 'POST', body: { id: plId, index: i, dir } });
    if (!r.ok) { note(r.data?.error || 'could not move it'); return; }
    const t = sections.splice(i, 1)[0]; sections.splice(j, 0, t); sections = sections;
  }

  async function removeFromPlaylist(i) {
    const r = await api('/api/apps/amp/playlists/remove', { method: 'POST', body: { id: plId, index: i } });
    if (!r.ok) { note(r.data?.error || 'could not remove it'); return; }
    sections.splice(i, 1);
    sections = sections;
  }

  let renaming = $state(false);
  let renameVal = $state('');

  function startRename() {
    renameVal = plName;
    renaming = true;
  }

  async function saveRename(e) {
    e?.preventDefault();
    const name = renameVal.trim();
    renaming = false;
    if (!name || name === plName) return;
    const r = await api('/api/apps/amp/playlists/rename', { method: 'POST', body: { id: plId, name } });
    if (!r.ok) { note(r.data?.error || 'could not rename it'); return; }
    plName = name;
    loadPlaylists();
  }

  async function deletePlaylist() {
    const r = await api('/api/apps/amp/playlists/delete', { method: 'POST', body: { id: plId } });
    if (!r.ok) { note(r.data?.error || 'could not delete it'); return; }
    note('playlist deleted');
    backHome();
  }

  async function saveTo(p) {
    const t = saveTarget;
    saveTarget = null;
    if (!t) return;
    const r = await api('/api/apps/amp/playlists/add', { method: 'POST', body: { id: p.id, track: t } });
    if (!r.ok) { note(r.data?.error || 'could not save it'); return; }
    note(r.data.already ? 'already in ' + p.name : 'saved to ' + p.name);
    loadPlaylists();
  }

  async function createAndSave(e) {
    e?.preventDefault();
    const name = newPlName.trim();
    if (!name || !saveTarget) return;
    const r = await api('/api/apps/amp/playlists', { method: 'POST', body: { name } });
    if (!r.ok) { note(r.data?.error || 'could not make it'); return; }
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
  let played = new Set();
  function cycleRepeat() { repeatMode = repeatMode === 'off' ? 'all' : repeatMode === 'all' ? 'one' : 'off'; }
  function cycleSleep() {
    sleepMin = sleepMin === 0 ? 15 : sleepMin === 15 ? 30 : sleepMin === 30 ? 60 : 0;
    clearTimeout(sleepT); sleepT = null;
    if (sleepMin) {
      const m = sleepMin;
      sleepT = setTimeout(() => { try { el?.pause(); } catch {} sleepMin = 0; sleepT = null; note('sleep timer: paused'); }, m * 60 * 1000);
      note('pausing in ' + m + ' minutes');
    }
  }
  // lock screen / headphone / control-center controls (this is what makes it a real player on a phone)
  function setSession() {
    if (!('mediaSession' in navigator) || !now) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: now.title || '', artist: now.artist || SRC_LABEL[now.src] || '',
        artwork: now.art ? [{ src: now.art, sizes: '512x512' }] : [],
      });
      const ms = navigator.mediaSession;
      ms.setActionHandler('play', () => toggle());
      ms.setActionHandler('pause', () => toggle());
      ms.setActionHandler('previoustrack', () => prev());
      ms.setActionHandler('nexttrack', () => next());
      ms.setActionHandler('seekto', (d) => { if (el && d.seekTime != null) el.currentTime = d.seekTime; });
    } catch {}
  }
  function setPos() {
    try { if ('mediaSession' in navigator && el && total) navigator.mediaSession.setPositionState({ duration: total, position: Math.min(el.currentTime, total), playbackRate: 1 }); } catch {}
  }

  let recentQ = $state(readSearches('amp-searches'));
  async function search(e) {
    e?.preventDefault();
    if (busy || !q.trim()) return;
    recentQ = addSearch('amp-searches', q);
    busy = true; error = ''; searched = false; sections = [];
    view = 'search'; plId = ''; plName = '';
    const r = await api(`/api/apps/amp/search?q=${encodeURIComponent(q.trim())}`);
    busy = false; searched = true;
    if (!r.ok) { error = r.data?.error || 'search broke - try again'; return; }
    const d = r.data.results || {};
    const flat = [];
    for (const src of ['youtube', 'soundcloud', 'audius']) {
      for (const it of d[src] || []) flat.push(it);
    }
    sections = flat;
    if (!flat.length) error = 'nothing found for that one';
  }

  function chip(c) { q = c; search(); }

  function playAt(i) {
    const item = sections[i];
    if (!item) return;
    queue = sections.slice(i).concat(sections.slice(0, i));
    played = new Set();
    start(item, 0);
  }

  function start(item, qi) {
    trackErr = '';
    now = { ...item, qi };
    played.add(qi);
    noteRecent(item);
    setSession();
    playing = false; loading = true;
    cur = 0; total = item.durSec || 0;
    if (!el) {
      el = new Audio();
      el.preload = 'auto';
      el.addEventListener('timeupdate', () => { cur = el.currentTime; if (Math.floor(cur) % 5 === 0) setPos(); if (el.duration && isFinite(el.duration)) total = el.duration; });
      el.addEventListener('ended', () => { if (repeatMode === 'one') { el.currentTime = 0; el.play().catch(() => {}); } else next(true); });
      el.addEventListener('play', () => { playing = true; });
      el.addEventListener('playing', () => { loading = false; trackErr = ''; errStreak = 0; });
      el.addEventListener('waiting', () => { loading = true; });
      el.addEventListener('canplay', () => { loading = false; });
      el.addEventListener('pause', () => { playing = false; });
      el.addEventListener('error', () => onTrackError());
    }
    el.src = item.stream;
    el.play().catch(() => { if (!el.error) trackErr = 'tap play to start it'; });
  }

  // when a track fails (usually youtube throttling), do what a real player
  // does: first try the same song from another source in the current list,
  // then skip ahead - only show an error when there is nowhere left to go.
  let errStreak = 0;
  const SRC_NAMES = { yt: 'youtube', sc: 'soundcloud', au: 'audius' };
  function normTitle(t) {
    return (t || '').toLowerCase()
      .replace(/\([^)]*\)|\[[^\]]*\]/g, '')
      .replace(/feat\.?.*$/, '')
      .replace(/[^a-z0-9 ]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  function onTrackError() {
    playing = false; loading = false;
    errStreak++;
    if (now && !now.__fellBack) {
      const want = normTitle(now.title);
      const alt = sections.find((x) => x.src !== now.src && x.stream && normTitle(x.title) === want)
        || sections.find((x) => x.src !== now.src && x.stream && want.length >= 8 && normTitle(x.title).startsWith(want.slice(0, Math.max(8, want.length - 6))));
      if (alt) {
        alt.__fellBack = true;
        queue[now.qi] = alt;
        note((now.src === 'yt' ? 'youtube throttled it' : 'that copy broke') + ' - playing the ' + (SRC_NAMES[alt.src] || alt.src) + ' copy instead');
        start(alt, now.qi);
        return;
      }
    }
    if (errStreak < 3 && now && now.qi + 1 < queue.length) {
      note('skipping one that would not play');
      next();
      return;
    }
    trackErr = now?.src === 'yt'
      ? "youtube is throttling this one - try the soundcloud or audius copy"
      : "this one can't be streamed";
  }

  function toggle() {
    if (!now || !el) return;
    if (el.paused) {
      if (el.error) { el.load(); loading = true; }
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

  function fmt(s) {
    s = Math.max(0, Math.floor(s || 0));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }
</script>

<svelte:head><title>amp - ramjet</title></svelte:head>

<div class="page" class:hasplayer={!!now}>
  <header class="top">
    <a class="back" href="/" aria-label="back to ramjet">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
    </a>
    <span class="brand">amp</span>
    <span class="tagline">every catalog, one player</span>
  </header>

  <main class="wrap">
    <form class="search" onsubmit={search}>
      <input bind:value={q} list="amp-recent-q" placeholder="song, artist, anything" autocomplete="off" />
      <datalist id="amp-recent-q">{#each recentQ as r}<option value={r}></option>{/each}</datalist>
      <button type="submit" disabled={busy}>{busy ? '...' : 'play'}</button>
    </form>
    <div class="chips">
      {#each chips as c}<button class="chip" onclick={() => chip(c)}>{c}</button>{/each}
    </div>

    {#if error}<p class="error">{error}</p>{/if}

    {#if !searched && !busy}
      {#if recents.length}
        <p class="home-h">recently played <button class="rc-clear" onclick={clearRecents}>clear</button></p>
        <div class="list">
          {#each recents as it, i (it.key)}
            <button class="row" class:active={now && now.key === it.key} onclick={() => playRecent(i)}>
              {#if it.art}<img src={it.art} alt="" loading="lazy" onerror={(e) => { e.currentTarget.style.visibility = 'hidden'; }} />{:else}<div class="noart"></div>{/if}
              <span class="meta">
                <span class="title">{it.title}</span>
                <span class="sub">{it.artist || SRC_LABEL[it.src]}</span>
              </span>
              <span class="dur">{it.dur}</span>
            </button>
          {/each}
        </div>
      {/if}
      {#if playlists.length}
        <p class="home-h">your playlists</p>
        <div class="pls">
          {#each playlists as p (p.id)}
            <button class="plrow" onclick={() => openPlaylist(p)}>
              {#if p.art}<img src={p.art} alt="" loading="lazy" onerror={(e) => { e.currentTarget.style.visibility = 'hidden'; }} />{:else}<div class="plart"></div>{/if}
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
        <form class="newpl" onsubmit={createPlaylist}>
          <input bind:value={newPlName} placeholder="name a new playlist" maxlength="40" autocomplete="off" />
          <button type="submit" disabled={!newPlName.trim()}>create</button>
        </form>
      {:else}
        <button class="newpl-open" onclick={() => { showNewPl = true; }}>+ new playlist</button>
      {/if}
    {/if}

    {#if view === 'playlist'}
      <div class="plhead">
        <button class="plback" onclick={backHome}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
          playlists
        </button>
        {#if renaming}
          <form class="plrename" onsubmit={saveRename}>
            <input bind:value={renameVal} maxlength="40" autocomplete="off" autofocus />
            <button type="submit">save</button>
          </form>
        {:else}
          <span class="pltitle">{plName}</span>
          <button class="pldel" onclick={startRename}>rename</button>
          <button class="pldel" onclick={deletePlaylist}>delete</button>
        {/if}
      </div>
      {#if sections.length}
        <div class="plplay">
          <button onclick={() => playAt(0)}>play all</button>
          <button onclick={() => { shuffleOn = true; playAt(Math.floor(Math.random() * sections.length)); }}>shuffle</button>
        </div>
      {/if}
      {#if !sections.length}<p class="plempty">nothing saved here yet - search for something and tap the + on a song</p>{/if}
    {/if}

    <div class="list">
      {#each sections as it, i (it.key)}
        <button class="row" class:active={now && now.key === it.key} onclick={() => playAt(i)}>
          {#if it.art}<img src={it.art} alt="" loading="lazy" onerror={(e) => { e.currentTarget.style.visibility = 'hidden'; }} />{:else}<div class="noart"></div>{/if}
          <span class="meta">
            <span class="title">{it.title}</span>
            <span class="sub">{it.artist || SRC_LABEL[it.src]}{#if it.album} · {it.album}{/if}</span>
            <span class="src">{SRC_LABEL[it.src]}</span>
          </span>
          <span class="dur">{it.dur}</span>
          {#if view === 'playlist'}
            {#if i > 0}<span class="rowact" role="button" tabindex="-1" aria-label="move up" onclick={(e) => { e.stopPropagation(); movePl(i, -1); }}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 15l6-6 6 6"/></svg></span>{/if}
            {#if i < sections.length - 1}<span class="rowact" role="button" tabindex="-1" aria-label="move down" onclick={(e) => { e.stopPropagation(); movePl(i, 1); }}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg></span>{/if}
            <span class="rowact" role="button" tabindex="-1" aria-label="remove from playlist" onclick={(e) => { e.stopPropagation(); removeFromPlaylist(i); }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M5 12h14"/></svg>
            </span>
          {:else}
            <span class="rowact" role="button" tabindex="-1" aria-label="save to playlist" onclick={(e) => { e.stopPropagation(); saveTarget = it; }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
            </span>
          {/if}
        </button>
      {/each}
    </div>
  </main>

  {#if saveTarget}
    <div class="overlay" onclick={() => { saveTarget = null; }}>
      <div class="sheet" onclick={(e) => e.stopPropagation()}>
        <p class="sheet-h">save to a playlist</p>
        <p class="sheet-sub">{saveTarget.title}</p>
        {#each playlists as p (p.id)}
          <button class="sheetrow" onclick={() => saveTo(p)}>
            <span class="plname">{p.name}</span>
            <span class="plcount">{p.count}</span>
          </button>
        {/each}
        {#if !playlists.length}<p class="sheet-sub">no playlists yet - name one below</p>{/if}
        <form class="newpl" onsubmit={createAndSave}>
          <input bind:value={newPlName} placeholder="name a new playlist" maxlength="40" autocomplete="off" />
          <button type="submit" disabled={!newPlName.trim()}>create</button>
        </form>
      </div>
    </div>
  {/if}

  {#if toast}<div class="toast">{toast}</div>{/if}

  {#if now}
    <div class="player">
      <button class="p-art" onclick={toggle}>
        {#key now.key}
          {#if now.art}<img src={now.art} alt="" onerror={(e) => { e.currentTarget.style.visibility = 'hidden'; }} />{:else}<div class="noart"></div>{/if}
        {/key}
      </button>
      <div class="p-meta">
        <span class="p-title">{now.title}</span>
        {#if now.artist}
          <button class="p-sub p-link" onclick={() => { showQ = false; window.scrollTo({ top: 0, behavior: 'smooth' }); chip(now.artist.split(/,|&| feat\.? /i)[0].trim()); }} aria-label={'search ' + now.artist}>{now.artist}</button>
        {:else}
          <span class="p-sub">{SRC_LABEL[now.src]}</span>
        {/if}
        <div class="bar" onclick={seek} role="slider" aria-label="seek" aria-valuenow={Math.round(cur)} aria-valuemax={Math.round(total)}>
          <div class="fill" style="width: {total ? (cur / total) * 100 : 0}%"></div>
        </div>
        <span class="times">{#if loading}loading...{:else}{fmt(cur)} / {fmt(total)}{/if}</span>
      </div>
      {#if trackErr}<p class="terr">{trackErr}</p>{/if}
      <div class="p-btns">
        <button onclick={prev} aria-label="previous">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h2v14H6zM20 5v14L9.5 12z"/></svg>
        </button>
        <button class="pp" onclick={toggle} aria-label={playing ? 'pause' : 'play'}>
          {#if playing}
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>
          {:else}
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
          {/if}
        </button>
        <button onclick={next} aria-label="next">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M16 5h2v14h-2zM4 5v14l10.5-7z"/></svg>
        </button>
      </div>
      {#if showQ}
        <div class="qsheet" role="list">
          <div class="qhead"><b>up next</b><button onclick={() => (showQ = false)} aria-label="close queue">close</button></div>
          {#each queue as t, i}
            {#if i >= (now?.qi ?? 0)}
              <div class="qrow" class:cur={i === now?.qi} role="listitem">
                <button class="qmain" onclick={() => start(queue[i], i)}>
                  <span class="qn">{i === now?.qi ? '\u25B6' : i - (now?.qi ?? 0)}</span>
                  <span class="qt"><span class="qtt">{t.title}</span><span class="qa">{t.artist || ''}</span></span>
                </button>
                {#if i > (now?.qi ?? 0)}
                  {#if i > (now?.qi ?? 0) + 1}<button class="qact" onclick={() => qMove(i)} aria-label="play next">next</button>{/if}
                  <button class="qact" onclick={() => qRemove(i)} aria-label="remove from queue">&times;</button>
                {/if}
              </div>
            {/if}
          {/each}
        </div>
      {/if}
      <div class="p-extra">
        <button class:on={shuffleOn} onclick={() => { shuffleOn = !shuffleOn; played = new Set(now ? [now.qi] : []); }} aria-pressed={shuffleOn} aria-label="shuffle">shuffle</button>
        <button class:on={repeatMode !== 'off'} onclick={cycleRepeat} aria-label="repeat">repeat{repeatMode === 'all' ? ' all' : repeatMode === 'one' ? ' one' : ''}</button>
        <button class:on={showQ} onclick={() => (showQ = !showQ)} aria-pressed={showQ} aria-label="queue">queue</button>
        <button class:on={sleepMin > 0} onclick={cycleSleep} aria-label="sleep timer">{sleepMin ? 'sleep ' + sleepMin + 'm' : 'sleep'}</button>
      </div>
    </div>
  {/if}
</div>

<style>
  .page { min-height: 100dvh; background: var(--rj-bg); color: var(--rj-text); padding-bottom: 24px; }
  .page.hasplayer { padding-bottom: 196px; }
  .top { display: flex; align-items: center; gap: 10px; padding: 14px 16px; max-width: 760px; margin: 0 auto; }
  .back { width: 38px; height: 38px; display: grid; place-items: center; border-radius: 12px; background: var(--rj-surface); color: var(--rj-text); }
  .back svg { width: 20px; height: 20px; }
  .brand { font-size: 22px; font-weight: 800; letter-spacing: 0.5px; color: var(--rj-accent); }
  .tagline { font-size: 13px; color: var(--rj-text-dim); }
  .wrap { max-width: 760px; margin: 0 auto; padding: 0 16px; }
  .search { display: flex; gap: 8px; min-width: 0; }
  .search input { flex: 1; min-width: 0; background: var(--rj-surface); border: 1px solid var(--rj-border); color: var(--rj-text); border-radius: 14px; padding: 13px 16px; font-size: 16px; outline: none; }
  .search input:focus { border-color: var(--rj-accent); }
  .search button { background: var(--rj-accent); color: var(--rj-accent-ink); border: 0; border-radius: 14px; padding: 0 22px; font-size: 15px; font-weight: 700; min-height: 44px; }
  .chips { display: flex; gap: 8px; flex-wrap: wrap; margin: 12px 0 4px; }
  .chip { background: var(--rj-surface); border: 1px solid var(--rj-border); color: var(--rj-text-dim); border-radius: 999px; padding: 8px 14px; font-size: 13px; min-height: 36px; }
  .chip:hover { color: var(--rj-text); border-color: var(--rj-accent); }
  .error { color: #ff7b72; font-size: 14px; padding: 10px 2px; }
  .empty { text-align: center; padding: 64px 20px; }
  .empty .big { font-size: 24px; font-weight: 800; margin: 0 0 10px; }
  .empty .dim { color: var(--rj-text-dim); font-size: 15px; margin: 0; }
  .list { display: flex; flex-direction: column; gap: 6px; margin-top: 10px; }
  .row { display: flex; align-items: center; gap: 12px; width: 100%; text-align: left; background: var(--rj-surface); border: 1px solid transparent; border-radius: 14px; padding: 8px; color: var(--rj-text); min-height: 44px; }
  .row:hover { border-color: var(--rj-border); }
  .row.active { border-color: var(--rj-accent); }
  .row img, .row .noart { width: 52px; height: 52px; border-radius: 10px; object-fit: cover; background: #191c22; flex: none; }
  .meta { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .title { font-size: 15px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .sub { font-size: 13px; color: var(--rj-text-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .src { font-size: 11px; color: var(--rj-text-dim); opacity: 0.7; }
  .dur { font-size: 13px; color: var(--rj-text-dim); flex: none; padding-right: 6px; }
  .home-h { font-size: 14px; font-weight: 700; color: var(--rj-text-dim); margin: 18px 2px 8px; }
  .pls { display: flex; flex-direction: column; gap: 6px; }
  .plrow { display: flex; align-items: center; gap: 12px; width: 100%; text-align: left; background: var(--rj-surface); border: 1px solid transparent; border-radius: 14px; padding: 8px; color: var(--rj-text); min-height: 44px; }
  .plrow:hover { border-color: var(--rj-border); }
  .plrow img, .plart { width: 52px; height: 52px; border-radius: 10px; object-fit: cover; background: #191c22; flex: none; }
  .plmeta { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .plname { font-size: 15px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .plcount { font-size: 13px; color: var(--rj-text-dim); flex: none; }
  .plgo { width: 18px; height: 18px; color: var(--rj-text-dim); flex: none; margin-right: 6px; }
  .newpl-open { margin-top: 14px; background: none; border: 1px dashed var(--rj-border); color: var(--rj-text-dim); border-radius: 14px; padding: 12px 16px; font-size: 14px; width: 100%; min-height: 44px; }
  .newpl-open:hover { color: var(--rj-text); border-color: var(--rj-accent); }
  .newpl { display: flex; gap: 8px; margin-top: 10px; }
  .newpl input { flex: 1; min-width: 0; background: var(--rj-surface); border: 1px solid var(--rj-border); color: var(--rj-text); border-radius: 14px; padding: 12px 16px; font-size: 15px; outline: none; }
  .newpl input:focus { border-color: var(--rj-accent); }
  .newpl button { background: var(--rj-surface); border: 1px solid var(--rj-border); color: var(--rj-text-dim); border-radius: 14px; padding: 0 18px; font-size: 14px; min-height: 44px; }
  .newpl button:not(:disabled):hover { color: var(--rj-text); border-color: var(--rj-accent); }
  .newpl button:disabled { opacity: 0.5; }
  .plhead { display: flex; align-items: center; gap: 10px; margin: 12px 0 4px; }
  .plback { display: flex; align-items: center; gap: 4px; background: none; border: 0; color: var(--rj-text-dim); font-size: 14px; padding: 6px 0; }
  .plback svg { width: 16px; height: 16px; }
  .plback:hover { color: var(--rj-text); }
  .pltitle { flex: 1; min-width: 0; font-size: 17px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pldel { background: none; border: 1px solid var(--rj-border); color: var(--rj-text-dim); border-radius: 999px; padding: 6px 12px; font-size: 12.5px; }
  .pldel:hover { color: var(--rj-danger); border-color: var(--rj-danger); }
  .plrename { flex: 1; min-width: 0; display: flex; gap: 6px; }
  .plrename input { flex: 1; min-width: 0; background: var(--rj-surface); border: 1px solid var(--rj-accent); color: var(--rj-text); border-radius: 10px; padding: 6px 10px; font-size: 15px; outline: none; }
  .plrename button { background: var(--rj-accent); color: var(--rj-accent-ink); border: 0; border-radius: 10px; padding: 0 14px; font-size: 13px; font-weight: 700; }
  .rc-clear { background: none; border: 0; color: var(--rj-text-dim); font-size: 12px; text-decoration: underline; padding: 4px 6px; margin-left: 6px; font-weight: 400; }
  .plempty { padding: 24px 4px; font-size: 14px; color: var(--rj-text-dim); }
  .rowact { width: 36px; height: 36px; flex: none; border-radius: 50%; background: none; color: var(--rj-text-dim); display: grid; place-items: center; cursor: pointer; }
  .rowact:hover { color: var(--rj-accent); background: var(--rj-surface-2); }
  .rowact svg { width: 18px; height: 18px; }
  .overlay { position: fixed; inset: 0; z-index: 40; background: rgba(0,0,0,0.6); display: flex; align-items: flex-end; justify-content: center; }
  .sheet { width: 100%; max-width: 560px; background: var(--rj-surface); border: 1px solid var(--rj-border); border-radius: 18px 18px 0 0; padding: 18px 16px calc(18px + env(safe-area-inset-bottom)); display: flex; flex-direction: column; gap: 8px; max-height: 70dvh; overflow-y: auto; }
  .sheet-h { margin: 0; font-size: 16px; font-weight: 700; }
  .sheet-sub { margin: -2px 0 4px; font-size: 13px; color: var(--rj-text-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .sheetrow { display: flex; justify-content: space-between; align-items: center; gap: 10px; width: 100%; text-align: left; background: var(--rj-bg); border: 1px solid var(--rj-border); border-radius: 12px; padding: 12px 14px; color: var(--rj-text); font-size: 15px; min-height: 44px; }
  .sheetrow:hover { border-color: var(--rj-accent); }
  .toast { position: fixed; left: 50%; transform: translateX(-50%); bottom: 204px; z-index: 50; background: var(--rj-surface-2); border: 1px solid var(--rj-border); color: var(--rj-text); border-radius: 999px; padding: 10px 18px; font-size: 14px; white-space: nowrap; box-shadow: 0 6px 24px rgba(0,0,0,0.4); }
  .player { position: fixed; left: 0; right: 0; bottom: 0; z-index: 20; display: flex; flex-wrap: wrap; gap: 12px; align-items: center; padding: 12px 16px calc(12px + env(safe-area-inset-bottom)); background: rgba(10, 11, 14, 0.92); backdrop-filter: blur(14px); border-top: 1px solid var(--rj-border); }
  .p-art { padding: 0; border: 0; background: none; flex: none; }
  .p-art img, .p-art .noart { width: 56px; height: 56px; border-radius: 12px; object-fit: cover; background: #191c22; display: block; }
  .p-meta { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
  .p-title { font-size: 15px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .plplay { display: flex; gap: 8px; margin: 4px 0 10px; }
  .plplay button { background: var(--rj-accent); color: var(--rj-accent-ink); border: 0; border-radius: 999px; padding: 0 20px; min-height: 40px; font-weight: 700; font-size: 14px; }
  .plplay button:last-child { background: var(--rj-surface); color: var(--rj-text); }
  .p-link { background: none; border: 0; padding: 0; text-align: left; font-family: inherit; cursor: pointer; }
  .p-sub { font-size: 12px; color: var(--rj-text-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bar { height: 18px; display: flex; align-items: center; cursor: pointer; }
  .bar::before { content: ''; position: absolute; }
  .bar { position: relative; }
  .bar > .fill { height: 4px; background: var(--rj-accent); border-radius: 2px; transition: width 0.15s linear; }
  .bar::after { content: ''; position: absolute; left: 0; right: 0; height: 4px; background: #2a2e38; border-radius: 2px; z-index: -1; }
  .times { font-size: 11px; color: var(--rj-text-dim); }
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
  .qhead { display: flex; justify-content: space-between; align-items: center; padding: 6px 4px 8px; font-size: 14px; }
  .qhead button { background: none; border: 0; color: var(--rj-text-dim); font-size: 13px; min-height: 36px; }
  .qrow { display: flex; gap: 4px; align-items: center; border-bottom: 1px solid var(--rj-border); color: var(--rj-text); }
  .qmain { display: flex; gap: 10px; flex: 1; min-width: 0; text-align: left; background: none; border: 0; color: inherit; padding: 9px 4px; min-height: 44px; align-items: center; }
  .qact { background: none; border: 0; color: var(--rj-text-dim); font-size: 13px; min-width: 40px; min-height: 44px; }
  .qrow.cur { color: var(--rj-accent); }
  .qn { width: 22px; text-align: center; font-size: 12px; color: var(--rj-text-dim); flex: none; }
  .qt { display: flex; flex-direction: column; min-width: 0; }
  .qtt, .qa { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .qa { font-size: 12px; color: var(--rj-text-dim); }
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
</style>
