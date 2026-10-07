<script>
  import '../../tokens.css';
  import AppFrame from '../../lib/AppFrame.svelte';
  import { onMount } from 'svelte';
  import { api } from '../../lib/api.js';

  const apps = [
    { name: 'browse', path: '/browse', desc: 'the whole web, through ramjet',
      icon: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM2.5 12h19M12 2c2.7 2.6 4 6 4 10s-1.3 7.4-4 10c-2.7-2.6-4-6-4-10s1.3-7.4 4-10z' },
    { name: 'jetstream', path: '/jetstream', desc: 'search it, watch it',
      icon: 'M4 6h16v12H4zM10 9.5l5 2.5-5 2.5z' },
    { name: 'amp', path: '/amp', desc: 'your music, one queue',
      icon: 'M9 18a3 3 0 1 1-2-2.8V5l11-2v12a3 3 0 1 1-2-2.8V7l-7 1.3z' },
    { name: 'sage', path: '/sage', desc: 'ask anything',
      icon: 'M12 3l2.2 5.6L20 11l-5.8 2.4L12 19l-2.2-5.6L4 11l5.8-2.4z' },
    { name: 'banter', path: '/banter', desc: 'chat with friends',
      icon: 'M4 5h16v11H9l-5 4z' },
    { name: 'settings', path: '/settings', desc: 'look, account, privacy',
      icon: 'M12 8.8a3.2 3.2 0 1 0 0 6.4 3.2 3.2 0 0 0 0-6.4zM19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z' },
  ];

  let user = $state('');
  const hr = new Date().getHours();
  const hello = hr < 5 ? 'up late' : hr < 12 ? 'good morning' : hr < 18 ? 'good afternoon' : 'good evening';
  // each tile picks up where you left off (device-local state, nothing fetched)
  let live = $state({});
  const trunc = (t, n) => (t.length > n ? t.slice(0, n - 1) + '...' : t);
  try {
    const next = {};
    const rec = JSON.parse(localStorage.getItem('amp-recent') || '[]')[0];
    if (rec?.title) next.amp = 'last played: ' + trunc(rec.title, 28);
    const conv = JSON.parse(localStorage.getItem('sage-conversation') || '[]').find((m) => m.role === 'user');
    if (conv?.content) next.sage = 'last: ' + trunc(conv.content, 30);
    const later = JSON.parse(localStorage.getItem('js-later') || '[]').length;
    if (later) next.jetstream = later + ' saved for later';
    const rs = JSON.parse(localStorage.getItem('rj-browse-recent') || '[]')[0];
    if (rs?.name) next.browse = 'last: ' + rs.name;
    live = next;
  } catch {}
  import { techOn } from '../../lib/tech.js';
  let skin = $state('');
  try { skin = JSON.parse(localStorage.getItem('rj-theme') || 'null')?.skin || ''; } catch {}
  let layout = $state('list');
  try { const l = localStorage.getItem('rj-layout'); if (l === 'grid' || l === 'dock') layout = l; } catch {}
  let sys = $state(null);
  const dur = (sec) => { const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60); return d ? d + 'd ' + h + 'h' : h ? h + 'h ' + m + 'm' : m + 'm'; };
  async function loadSys() { const t0 = performance.now(); const r = await api('/api/sys'); if (r.ok) sys = { ...r.data, rtt: Math.round(performance.now() - t0) }; }
  let unread = $state(0);
  // ---- desk (dock layout): arrangeable widgets ----
  const WIDGETS = [['clock', 'clock'], ['continue', 'continue watching'], ['banter', 'banter'], ['music', 'music'], ['sites', 'sites'], ['sage', 'ask sage'], ['cal', 'calendar'], ['notes', 'notes'], ['todo', 'to do'], ['focus', 'focus timer'], ['system', 'system']];
  const DEF_SIZE = { clock: 's', search: 'm', continue: 'm', banter: 's', music: 's', sites: 'm', sage: 'm', cal: 's', notes: 's', todo: 's', focus: 's', system: 's' };
  const DEF_HIDDEN = ['todo', 'focus'];
  let desk = $state({ order: WIDGETS.map((w) => w[0]), hidden: DEF_HIDDEN.slice(), size: {} });
  try {
    const d = JSON.parse(localStorage.getItem('rj-desk') || 'null');
    if (d && Array.isArray(d.order)) {
      const known = WIDGETS.map((w) => w[0]);
      const order = d.order.filter((k) => known.includes(k));
      const hidden = (d.hidden || []).filter((k) => known.includes(k));
      for (const k of known) if (!order.includes(k)) { order.push(k); if (DEF_HIDDEN.includes(k)) hidden.push(k); }
      desk = { order, hidden, size: d.size || {} };
    }
  } catch {}
  const saveDesk = () => { try { localStorage.setItem('rj-desk', JSON.stringify(desk)); } catch {} };
  let arranging = $state(false);
  const sz = (id) => desk.size[id] || DEF_SIZE[id] || 's';
  function cycleSize(id) { const o = ['s', 'm', 'l']; desk = { ...desk, size: { ...desk.size, [id]: o[(o.indexOf(sz(id)) + 1) % 3] } }; saveDesk(); }
  function hide(id) { desk = { ...desk, hidden: [...desk.hidden, id] }; saveDesk(); }
  function show(id) { desk = { ...desk, hidden: desk.hidden.filter((k) => k !== id) }; saveDesk(); }
  // drag to rearrange (arrange mode): grab the title bar, drop over another widget
  let dragId = $state('');
  function dstart(e, id) {
    if (!arranging) return; dragId = id;
    window.addEventListener('pointermove', dmove);
    const up = () => { window.removeEventListener('pointermove', dmove); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); dend(); };
    window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
  }
  function dmove(e) {
    if (!dragId) return;
    const el = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-wid]');
    const to = el?.getAttribute('data-wid');
    if (!to || to === dragId) return;
    const o = desk.order.filter((k) => k !== dragId); o.splice(o.indexOf(to) + (desk.order.indexOf(dragId) < desk.order.indexOf(to) ? 1 : 0), 0, dragId);
    desk = { ...desk, order: o };
  }
  function dend() { if (dragId) { dragId = ''; saveDesk(); } }
  // calendar
  const monthName = $derived(now.toLocaleDateString([], { month: 'long', year: 'numeric' }));
  const calCells = $derived((() => {
    const y = now.getFullYear(), m = now.getMonth();
    const first = new Date(y, m, 1).getDay(), days = new Date(y, m + 1, 0).getDate();
    const out = []; for (let i = 0; i < first; i++) out.push(0); for (let d = 1; d <= days; d++) out.push(d); return out;
  })());
  // notes + to do (device-local, synced with the account)
  let note = $state(''); try { note = localStorage.getItem('rj-note') || ''; } catch {}
  const saveNote = () => { try { localStorage.setItem('rj-note', note); } catch {} };
  let todos = $state([]); try { todos = JSON.parse(localStorage.getItem('rj-todo') || '[]'); } catch {}
  let todoIn = $state('');
  const saveTodos = () => { try { localStorage.setItem('rj-todo', JSON.stringify(todos.slice(0, 40))); } catch {} };
  function addTodo(e) { e.preventDefault(); const t = todoIn.trim(); if (!t) return; todos = [{ t: t.slice(0, 120), d: false }, ...todos]; todoIn = ''; saveTodos(); }
  function togTodo(i) { todos = todos.map((x, j) => (j === i ? { ...x, d: !x.d } : x)); saveTodos(); }
  function delTodo(i) { todos = todos.filter((_, j) => j !== i); saveTodos(); }
  // focus timer
  let fMode = $state('focus'); let fLeft = $state(25 * 60); let fRun = $state(false); let fTick = 0;
  const fmt = (n) => String(Math.floor(n / 60)).padStart(2, '0') + ':' + String(n % 60).padStart(2, '0');
  function fToggle() {
    if (fRun) { fRun = false; clearInterval(fTick); return; }
    fRun = true; fTick = setInterval(() => { fLeft -= 1; if (fLeft <= 0) { clearInterval(fTick); fRun = false; fSet(fMode === 'focus' ? 'break' : 'focus'); } }, 1000);
  }
  function fSet(m) { clearInterval(fTick); fRun = false; fMode = m; fLeft = (m === 'focus' ? 25 : 5) * 60; }
  let now = $state(new Date());
  const clockT = $derived(now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
  const clockMain = $derived(clockT.replace(/\s?(AM|PM)$/i, ''));
  const clockAp = $derived((clockT.match(/(AM|PM)$/i) || [''])[0].toLowerCase());
  const clockDate = $derived(now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }));
  let sq = $state(''); let smode = $state('web');
  import { readSearches, addSearch, clearSearches } from '../../lib/searchhist.js';
  let sfocus = $state(false), recentS = $state([]), recentSites = $state([]);
  function openDrop() {
    recentS = smode === 'web' ? readSearches('rj-browse-searches') : [];
    try { recentSites = smode === 'web' ? JSON.parse(localStorage.getItem('rj-browse-recent') || '[]').slice(0, 6) : []; } catch { recentSites = []; }
    sfocus = true;
  }
  function webGo(e) { e.preventDefault(); const v = sq.trim(); if (!v) return; try { addSearch('rj-browse-searches', v); sessionStorage.setItem('rj-open', v); } catch {} window.location.href = '/browse'; }
  function pickS(v) { sq = v; sfocus = false; if (smode === 'web') webGo({ preventDefault() {} }); else doSearch({ preventDefault() {} }); }
  function doSearch(e) {
    e.preventDefault();
    const v = sq.trim(); if (!v) return;
    try {
      if (smode === 'web') { addSearch('rj-browse-searches', v); sessionStorage.setItem('rj-open', v); window.location.href = '/browse'; }
      else if (smode === 'video') window.location.href = '/jetstream?q=' + encodeURIComponent(v);
      else { sessionStorage.setItem('rj-ask', v); window.location.href = '/sage'; }
    } catch {}
  }
  let cont = $state(null), rooms = $state(null), sites = $state(null), music = $state(null);
  const STARTERS = ['explain how a vpn works in plain words', 'give me a 20 minute dinner idea', 'help me plan a study schedule', 'what should i watch tonight?', 'write a short thank you text', 'quiz me on world capitals'];
  const starters = STARTERS.slice().sort(() => Math.random() - 0.5).slice(0, 3);
  const siteLetter = (s) => (s.name || s.url || '?').replace(/^https?:\/\/(www\.)?/, '').slice(0, 1);
  function openSite(s) { try { sessionStorage.setItem('rj-open', s.url); } catch {} window.location.href = '/browse'; }
  function askSage(t) { try { sessionStorage.setItem('rj-ask', t); } catch {} window.location.href = '/sage'; }
  // first-run card: a few one-tap steps that fill the apps up (list and grid layouts)
  let startOff = $state(false);
  try { startOff = localStorage.getItem('rj-start-off') === '1'; } catch {}
  const steps = $derived([
    { k: 'watch', t: 'watch something', d: 'start a video and it shows up here', href: '/jetstream', done: !!(cont && cont.length) },
    { k: 'play', t: 'play a song', d: 'amp remembers what you played', href: '/amp', done: !!music },
    { k: 'save', t: 'save a site', d: 'star a page in browse', href: '/browse', done: !!(sites && sites.length) },
    { k: 'friend', t: 'add a friend', d: 'banter is better with people', href: '/banter', done: !!(rooms && rooms.length) },
  ]);
  const loaded = $derived(cont !== null && music !== null && sites !== null && rooms !== null);
  const todo = $derived(steps.filter((x) => !x.done));
  function hideStart() { startOff = true; try { localStorage.setItem('rj-start-off', '1'); } catch {} }
  async function loadDesk() {
    try { const m = JSON.parse(localStorage.getItem('amp-recent') || '[]')[0]; music = m || false; } catch { music = false; }
    api('/api/apps/jetstream/history').then((r) => { cont = r.ok ? (r.data.items || []).slice(0, 3) : []; });
    api('/api/banter/state').then((r) => { rooms = r.ok ? (r.data.rooms || []).slice().sort((a, b) => b.last - a.last).slice(0, 3) : []; });
    api('/api/apps/browse/bookmarks').then((r) => {
      let list = r.ok ? (r.data.bookmarks || []).slice(0, 8) : [];
      if (!list.length) { try { list = JSON.parse(localStorage.getItem('rj-browse-recent') || '[]').slice(0, 8); } catch {} }
      sites = list;
    });
    if (techOn()) loadSys();
    setInterval(() => { now = new Date(); }, 20000);
  }
  onMount(async () => {
    const r = await api('/api/auth/me');
    if (!r.ok) { window.location.href = '/login'; return; }
    user = r.data.user;
    loadDesk();
    const u = await api('/api/banter/unread');
    if (u.ok && u.data.unread) { unread = u.data.unread; live = { ...live, banter: unread + ' unread' }; }
  });

  async function logout() {
    await api('/api/auth/logout', { method: 'POST' });
    window.location.href = '/login';
  }
</script>
{#snippet drop()}
              {#if sfocus && (recentS.length || recentSites.length)}
                <div class="sdrop" role="listbox">
                  {#if recentS.length}<p class="sdh">recent searches <button type="button" onmousedown={(e) => { e.preventDefault(); recentS = clearSearches('rj-browse-searches'); }}>clear</button></p>
                    {#each recentS.filter((r) => !sq || r.toLowerCase().includes(sq.toLowerCase())).slice(0, 6) as r}<button type="button" class="sdi" onmousedown={(e) => { e.preventDefault(); pickS(r); }}><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>{r}</button>{/each}{/if}
                  {#if recentSites.length && !sq}<p class="sdh">recent sites</p>
                    {#each recentSites as st}<button type="button" class="sdi" onmousedown={(e) => { e.preventDefault(); openSite(st); }}><b class="sdl">{siteLetter(st)}</b>{st.name}</button>{/each}{/if}
                </div>
              {/if}
{/snippet}

<AppFrame active="/">
<main class:desktop={layout === 'dock'} class:grid={layout === 'grid'}>
  <header class="home-heading">
    <a class="brand" href="/">ramjet<span>.</span></a>
    <div class="account"><button class="jump" onclick={() => window.rjPalette?.open()} aria-label="Open command palette">Jump to</button><a href="/settings">{user || 'Your account'}</a><button onclick={logout}>Log out</button></div>
  </header>
  <section class="welcome">
    <h1>{hello}{user ? ', ' + user : ''}.</h1>
    <p>Where do you want to go?</p>
  </section>
  <section class="search-area" aria-label="Search">
    <form class="sform" onsubmit={doSearch}>
      <label class="sr-only" for="home-search">Search Ramjet</label>
      <input id="home-search" bind:value={sq} placeholder={smode === 'web' ? 'Search the web or enter a site' : smode === 'video' ? 'Search videos' : 'Ask Sage anything'} autocomplete="off" onfocus={openDrop} onblur={() => setTimeout(() => (sfocus = false), 160)} />
      <button class="go" aria-label="Search">Search</button>
      {@render drop()}
    </form>
    <div class="chips" aria-label="Search mode">{#each [['web', 'Web'], ['video', 'Videos'], ['ask', 'Ask Sage']] as [k, n]}<button class="chip" class:on={smode === k} aria-pressed={smode === k} onclick={() => (smode = k)}>{n}</button>{/each}</div>
  </section>
  <section class="launcher" aria-label="Open an app">
    {#each apps as app}
      <a class="app-card" href={app.path} aria-label={app.name[0].toUpperCase() + app.name.slice(1)}>
        <span class="tile"><svg viewBox="0 0 24 24" aria-hidden="true"><path d={app.icon} /></svg></span>
        <span class="txt"><strong>{app.name[0].toUpperCase() + app.name.slice(1)}</strong><span>{live[app.name] || app.desc}</span></span>
        {#if app.name === 'banter' && unread}<span class="unread">{unread > 99 ? '99+' : unread}</span>{/if}
      </a>
    {/each}
  </section>
  {#if layout === 'dock'}
    <div class="deskbar">
      <button class="arr" class:on={arranging} onclick={() => (arranging = !arranging)}>{arranging ? 'done' : 'arrange'}</button>
    </div>
    <section class="desk">
      {#each desk.order.filter((k) => k !== 'search' && !desk.hidden.includes(k) && (k !== 'system' || techOn())) as id (id)}
        <article class="w w-{id} sz-{sz(id)}" class:drag={dragId === id} class:wig={arranging && dragId !== id} data-wid={id}>
          <header class="wh" onpointerdown={(e) => dstart(e, id)} class:grab={arranging}>
            <span>{WIDGETS.find((x) => x[0] === id)[1]}</span>
            {#if arranging}<span class="ctl"><button aria-label="change size" onpointerdown={(e) => e.stopPropagation()} onclick={() => cycleSize(id)}>{sz(id)}</button><button aria-label="hide" onpointerdown={(e) => e.stopPropagation()} onclick={() => hide(id)}>&times;</button></span>{/if}
          </header>
          {#if id === 'clock'}
            <p class="clk">{clockMain}<small>{clockAp}</small></p>
            <p class="cdate">{clockDate}</p>
          {:else if id === 'search'}
            <form class="sform" onsubmit={doSearch}>
              <input bind:value={sq} placeholder={smode === 'web' ? 'search the web or type a site' : smode === 'video' ? 'search videos' : 'ask sage anything'} autocomplete="off" onfocus={openDrop} onblur={() => setTimeout(() => (sfocus = false), 160)} />
              <button class="go" aria-label="go">&#8594;</button>
              {@render drop()}
            </form>
            <div class="chips">{#each [['web', 'web'], ['video', 'videos'], ['ask', 'ask sage']] as [k, n]}<button class="chip" class:on={smode === k} onclick={() => (smode = k)}>{n}</button>{/each}</div>
          {:else if id === 'continue'}
            {#if cont === null}<p class="mute">looking...</p>
            {:else if !cont.length}<p class="mute">nothing in progress. <a href="/jetstream">find something to watch</a></p>
            {:else}{#each cont as v}
              <a class="vrow" href={'/jetstream?v=' + v.id}><img src={'/api/apps/jetstream/thumb?id=' + v.id} alt="" loading="lazy" /><span class="vt"><b>{v.title}</b><i>{v.channel}{v.duration ? ' · ' + v.duration : ''}</i></span></a>
            {/each}{/if}
          {:else if id === 'banter'}
            {#if rooms === null}<p class="mute">looking...</p>
            {:else if !rooms.length}<p class="mute">no chats yet. <a href="/banter">add a friend</a></p>
            {:else}{#each rooms as r}
              <a class="brow" href="/banter"><span class="bav">{r.emoji || r.title.slice(0, 1)}</span><span class="vt"><b>{r.title}</b><i>{r.preview || 'say hi'}</i></span>{#if r.unread}<em class="bun">{r.unread}</em>{/if}</a>
            {/each}{/if}
          {:else if id === 'music'}
            {#if music === null}<p class="mute">looking...</p>
            {:else if !music}<p class="mute">nothing played yet. <a href="/amp">open amp</a></p>
            {:else}
              <a class="mrow" href="/amp">
                <span class="art">{#if music.art}<img src={music.art} alt="" referrerpolicy="no-referrer" onerror={(e) => (e.currentTarget.style.display = 'none')} />{/if}</span>
                <span class="vt"><b>{music.title}</b><i>{music.artist || 'last played'}</i></span><span class="pl">&#9654;</span>
              </a>
            {/if}
          {:else if id === 'sites'}
            {#if sites === null}<p class="mute">looking...</p>
            {:else if !sites.length}<p class="mute">star a page in browse and it shows up here.</p>
            {:else}<div class="sgrid">{#each sites as s}<button class="site" onclick={() => openSite(s)}><span class="sl">{siteLetter(s)}</span><span class="sn">{(s.name || s.url).replace(/^https?:\/\/(www\.)?/, '').slice(0, 16)}</span></button>{/each}</div>{/if}
          {:else if id === 'sage'}
            <div class="sprom">{#each starters as t}<button onclick={() => askSage(t)}>{t}</button>{/each}</div>
          {:else if id === 'cal'}
            <p class="cm">{monthName}</p>
            <div class="cg">{#each ['s','m','t','w','t','f','s'] as d}<i class="ch">{d}</i>{/each}{#each calCells as d}{#if d}<i class:today={d === now.getDate()}>{d}</i>{:else}<i></i>{/if}{/each}</div>
          {:else if id === 'notes'}
            <textarea class="nt" bind:value={note} oninput={saveNote} placeholder="jot something down" rows="5"></textarea>
          {:else if id === 'todo'}
            <form class="tf" onsubmit={addTodo}><input bind:value={todoIn} placeholder="add a task" autocomplete="off" /></form>
            <ul class="tl">{#each todos.slice(0, 8) as t, i}<li class:done={t.d}><button class="tk" aria-label="toggle" onclick={() => togTodo(i)}>{t.d ? '\u2713' : ''}</button><span>{t.t}</span><button class="tx" aria-label="remove" onclick={() => delTodo(i)}>&times;</button></li>{/each}</ul>
            {#if !todos.length}<p class="mute">nothing to do. nice.</p>{/if}
          {:else if id === 'focus'}
            <p class="fm">{fmt(fLeft)}</p>
            <div class="chips"><button class="chip" class:on={fMode === 'focus'} onclick={() => fSet('focus')}>focus</button><button class="chip" class:on={fMode === 'break'} onclick={() => fSet('break')}>break</button><button class="chip go2" onclick={fToggle}>{fRun ? 'pause' : 'start'}</button></div>
          {:else if id === 'system'}
            {#if sys}<dl class="sysl"><dt>version</dt><dd>{sys.version}</dd><dt>uptime</dt><dd>{dur(sys.uptime)}</dd><dt>load</dt><dd>{sys.load} / {sys.cpus}</dd><dt>cache</dt><dd>{sys.cacheMB} MB</dd><dt>latency</dt><dd>{sys.rtt} ms</dd></dl>{:else}<p class="mute">...</p>{/if}
          {/if}
        </article>
      {/each}
    </section>
    {#if arranging && desk.hidden.length}
      <p class="addback">hidden: {#each desk.hidden as h}<button class="chip" onclick={() => show(h)}>+ {WIDGETS.find((x) => x[0] === h)[1]}</button>{/each}</p>
    {/if}

  {:else}
    {#if cont === null || music === null}<p class="loading" role="status">Loading your recent activity...</p>{/if}
    {#if (cont && cont.length) || music}
      <section class="resume" aria-label="Recent activity">
        <h2>Pick up where you left off</h2>
        <div class="recent-list">
          {#if music}<a class="recent-row" href="/amp"><span class="art">{#if music.art}<img src={music.art} alt="" referrerpolicy="no-referrer" />{/if}</span><span class="vt"><b>{music.title}</b><i>{music.artist || 'Last played in Amp'}</i></span><span aria-hidden="true">↗</span></a>{/if}
          {#each (cont || []).slice(0, 3) as v}<a class="recent-row" href={'/jetstream?v=' + v.id}><img src={'/api/apps/jetstream/thumb?id=' + v.id} alt="" loading="lazy" /><span class="vt"><b>{v.title}</b><i>{v.channel}</i></span><span aria-hidden="true">↗</span></a>{/each}
        </div>
      </section>
    {/if}
    {#if loaded && !startOff && todo.length}
      <section class="setup" aria-label="Get started">
        <div class="section-heading"><h2>Make it yours</h2><button onclick={hideStart}>Hide</button></div>
        {#each todo.slice(0, 3) as st}<a href={st.href}><b>{st.t}</b><span>{st.d}</span><span aria-hidden="true">↗</span></a>{/each}
      </section>
    {/if}
  {/if}
  {#if sys && layout !== 'dock'}<details class="system"><summary>System details</summary><p>Version {sys.version} · uptime {dur(sys.uptime)} · load {sys.load}/{sys.cpus} · cache {sys.cacheMB} MB · {sys.rtt} ms</p></details>{/if}
</main>
</AppFrame>

<style>
  main { max-width: 1100px; margin: 0 auto; padding: 32px 40px 64px; }
  .home-heading { display: flex; justify-content: space-between; align-items: center; gap: 16px; }
  .brand { font-size: 24px; font-weight: 750; letter-spacing: -.06em; } .brand span { color: var(--rj-accent); }
  .account { display: flex; align-items: center; gap: 16px; font-size: 13px; color: var(--rj-text-dim); }
  button { color: var(--rj-text); } .account button, .section-heading button { border: 0; background: none; color: var(--rj-text-dim); padding: 10px 0; }
  .welcome { margin: 62px 0 28px; } h1 { font-size: clamp(28px, 3.4vw, 42px); letter-spacing: -.045em; font-weight: 600; margin: 0 0 10px; } .welcome p { color: var(--rj-text-dim); margin: 0; font-size: 17px; }
  .search-area { max-width: 740px; margin-bottom: 34px; } .sform { position: relative; display: flex; gap: 8px; padding: 7px; background: var(--rj-surface); border: 1px solid var(--rj-border); border-radius: 20px; box-shadow: 0 5px 20px rgba(0,0,0,.03); }
  .sform input { width: 0; flex: 1; min-width: 0; min-height: 44px; border: 0; background: none; color: var(--rj-text); padding: 0 12px; font-size: 16px; border-radius: 12px; } .sform input::placeholder { color: var(--rj-text-faint); }
  .go { background: var(--rj-accent); color: var(--rj-accent-ink); border: 0; border-radius: 13px; padding: 0 20px; font-weight: 600; }
  .chips { display: flex; gap: 8px; margin-top: 12px; } .chip { border: 1px solid var(--rj-border); background: transparent; color: var(--rj-text-dim); padding: 8px 14px; border-radius: 999px; font-size: 13px; } .chip.on { background: var(--rj-surface-2); color: var(--rj-text); }
  .launcher { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 12px; }
  .app-card { min-height: 128px; position: relative; display: flex; flex-direction: column; gap: 18px; padding: 22px; background: var(--rj-surface); border: 1px solid var(--rj-border); border-radius: 22px; transition: transform .15s; }
  .app-card:hover { background: var(--rj-hover); transform: translateY(-2px); } .app-card:active { transform: translateY(0); }
  .tile { color: var(--rj-accent); } .tile svg { width: 27px; height: 27px; fill: none; stroke: currentColor; stroke-width: 1.65; stroke-linejoin: round; stroke-linecap: round; }
  .txt { min-width: 0; display: grid; gap: 6px; } .txt strong { font-weight: 600; font-size: 17px; } .txt span { font-size: 13px; line-height: 1.5; color: var(--rj-text-dim); overflow-wrap: anywhere; }
  .unread { position: absolute; top: 20px; right: 20px; background: var(--rj-accent); color: var(--rj-accent-ink); padding: 4px 8px; border-radius: 999px; font-size: 12px; }
  h2 { font-size: 19px; font-weight: 600; letter-spacing: -.025em; margin: 0 0 18px; } .resume,.setup { margin-top: 36px; } .section-heading { display: flex; align-items: baseline; justify-content: space-between; }
  .recent-list { display: grid; gap: 1px; border: 1px solid var(--rj-border); border-radius: 18px; overflow: hidden; } .recent-row { display: flex; align-items: center; gap: 14px; min-width: 0; padding: 14px; background: var(--rj-surface); } .recent-row>img { width: 80px; height: 48px; object-fit: cover; border-radius: 8px; } .art { width: 48px; height: 48px; background: var(--rj-surface-2); border-radius: 8px; flex: none; } .art img { width: 100%; height: 100%; object-fit: cover; border-radius: inherit; }
  .vt { min-width: 0; flex: 1; display: grid; gap: 5px; } .vt b { font-size: 14px; font-weight: 550; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .vt i { font-size: 12px; color: var(--rj-text-dim); font-style: normal; }
  .setup>a { display: grid; grid-template-columns: 160px 1fr 20px; align-items: center; gap: 16px; border-top: 1px solid var(--rj-border); padding: 17px 0; } .setup b { font-size: 14px; font-weight: 550; } .setup a span { color: var(--rj-text-dim); font-size: 13px; }
  .system { margin-top: 24px; font-size: 13px; color: var(--rj-text-dim); } .loading { margin: 24px 0; font-size: 13px; color: var(--rj-text-dim); }
  .sr-only { position: absolute; width: 1px; height: 1px; clip-path: inset(50%); overflow: hidden; }
  .deskbar { display: flex; justify-content: flex-end; margin: 24px 0 12px; } .arr { background: var(--rj-surface); border: 1px solid var(--rj-border); border-radius: 12px; padding: 10px 16px; }
  .desk { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); gap: 14px; } .w { min-width: 0; border: 1px solid var(--rj-border); background: var(--rj-surface); border-radius: 18px; padding: 16px; } .sz-m { grid-column: span 2; } .sz-l { grid-column: span 4; } .wh { display: flex; gap: 8px; align-items: center; justify-content: space-between; color: var(--rj-text-dim); font-size: 13px; margin-bottom: 14px; } .grab { cursor: grab; touch-action: none; } .ctl { display: flex; gap: 6px; } .ctl button { border: 1px solid var(--rj-border); border-radius: 6px; background: var(--rj-surface-2); } .drag { opacity: .5; }
  .mute { color: var(--rj-text-dim); font-size: 13px; line-height: 1.6; } .mute a { color: var(--rj-accent); } .clk { font-size: 38px; letter-spacing: -.05em; margin: 10px 0; } .clk small { font-size: 14px; margin-left: 6px; } .cdate,.cm { font-size: 13px; color: var(--rj-text-dim); }
  .vrow,.brow,.mrow { display: flex; align-items: center; gap: 10px; padding: 9px 0; } .vrow img { width: 70px; border-radius: 8px; } .bav,.sl { width: 36px; height: 36px; display: grid; place-items: center; background: var(--rj-surface-2); border-radius: 10px; } .sgrid { display: grid; grid-template-columns: repeat(auto-fit,minmax(70px,1fr)); gap: 12px; } .site { display: grid; justify-items: center; gap: 8px; border: 0; background: none; font-size: 11px; } .sn { width: 100%; overflow: hidden; text-overflow: ellipsis; }
  .sprom { display: grid; gap: 8px; } .sprom button { text-align: left; font-size: 13px; line-height: 1.5; padding: 10px; background: var(--rj-surface-2); border: 0; border-radius: 10px; } .cg { display: grid; grid-template-columns: repeat(7,1fr); gap: 4px; text-align: center; } .cg i { font-style: normal; font-size: 12px; padding: 5px 0; } .cg .today { background: var(--rj-accent); color: var(--rj-accent-ink); border-radius: 7px; } .ch { color: var(--rj-text-dim); }
  .nt,.tf input { width: 100%; min-width: 0; padding: 10px; background: var(--rj-surface-2); color: var(--rj-text); border: 1px solid var(--rj-border); border-radius: 10px; font-size: 14px; } .nt { resize: vertical; } .tl { list-style: none; padding: 0; } .tl li { display: flex; align-items: center; gap: 7px; margin: 8px 0; font-size: 13px; } .tl li span { flex: 1; overflow-wrap: anywhere; } .tk,.tx { border: 1px solid var(--rj-border); background: var(--rj-surface-2); border-radius: 5px; min-width: 22px; height: 22px; } .done span { text-decoration: line-through; } .fm { font-size: 36px; margin: 8px 0; } .sysl { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; font-size: 12px; } .sysl dd { margin: 0; } .addback { display: flex; flex-wrap: wrap; gap: 8px; }
  .sdrop { position: absolute; top: calc(100% + 8px); left: 0; right: 0; z-index: 50; border: 1px solid var(--rj-border); background: var(--rj-surface); padding: 12px; border-radius: 16px; box-shadow: var(--rj-shadow); } .sdh { display: flex; justify-content: space-between; font-size: 12px; color: var(--rj-text-dim); } .sdh button { background: none; border: 0; color: var(--rj-text-dim); } .sdi { display: flex; gap: 10px; width: 100%; align-items: center; min-height: 44px; border: 0; background: none; text-align: left; } .sdi svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.5; }
  @media(max-width: 1000px) { main { padding: 28px 24px 48px; } .launcher { grid-template-columns: repeat(2,minmax(0,1fr)); } .desk { grid-template-columns: repeat(2,minmax(0,1fr)); } .sz-l { grid-column: span 2; } }
  @media(max-width: 760px) { :global(#rjp-b) { display: none !important; } .account .jump { font-size: 12px; } main { padding: 24px 20px 36px; } .welcome { margin-top: 40px; } .account { gap: 12px; } .app-card { padding: 18px; min-height: 148px; } .txt span { font-size: 12px; } .setup>a { grid-template-columns: 1fr 20px; gap: 7px; } .setup a span:first-of-type { grid-column: 1; grid-row: 2; } .setup a span:last-child { grid-column: 2; grid-row: 1 / span 2; } .go { padding: 0 14px; } .desk { grid-template-columns: minmax(0,1fr); } .sz-m,.sz-l { grid-column: auto; } }
</style>
