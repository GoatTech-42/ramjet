<script>
  import '../../tokens.css';
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
  const WIDGETS = [['clock', 'clock'], ['search', 'quick search'], ['continue', 'continue watching'], ['banter', 'banter'], ['music', 'music'], ['sites', 'sites'], ['sage', 'ask sage'], ['cal', 'calendar'], ['notes', 'notes'], ['todo', 'to do'], ['focus', 'focus timer'], ['system', 'system']];
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
  function doSearch(e) {
    e.preventDefault();
    const v = sq.trim(); if (!v) return;
    try {
      if (smode === 'web') { sessionStorage.setItem('rj-open', v); window.location.href = '/browse'; }
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

<main class="lay-{layout}" class:glass={skin === 'glass'}>
  {#if skin === 'glass' && layout === 'dock'}
    <nav class="menubar"><span class="mb-l"><b>ramjet</b>{#each apps as a}<a href={a.path}>{a.name}</a>{/each}</span><span class="mb-r"><span>{now.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} {clockT}</span><a href="/settings">{user}</a><button onclick={logout}>log out</button></span></nav>
  {/if}
  
  <header>
    <div class="brand">ramjet<span class="dot">.</span></div>
    <div class="me">
      <button class="out" onclick={logout}>log out</button>
      <a class="avatar" href="/settings" aria-label="settings" title="settings"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg></a>
    </div>
  </header>

  {#if user}<p class="hello">{hello}, {user}</p>{/if}
  {#if layout === 'list'}
  <form class="lsearch" onsubmit={(e) => { e.preventDefault(); const v = sq.trim(); if (v) { sessionStorage.setItem('rj-open', v); window.location.href = '/browse'; } }}><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg><input bind:value={sq} placeholder="search the web or type a site" aria-label="search the web" autocomplete="off" /></form>
  {/if}

  {#if layout === 'dock'}
    <div class="deskbar">
      <button class="arr" class:on={arranging} onclick={() => (arranging = !arranging)}>{arranging ? 'done' : 'arrange'}</button>
    </div>
    <section class="desk">
      {#each desk.order.filter((k) => !desk.hidden.includes(k) && (k !== 'system' || techOn())) as id (id)}
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
              <input bind:value={sq} placeholder={smode === 'web' ? 'search the web or type a site' : smode === 'video' ? 'search videos' : 'ask sage anything'} autocomplete="off" />
              <button class="go" aria-label="go">&#8594;</button>
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
  {/if}
  {#if layout === 'grid'}
    <div class="hs-top"><p class="hs-time">{clockMain}</p><p class="hs-date">{clockDate}</p></div>
  {/if}
  <section class="list">
    {#each apps as app}
      <a class="row" data-app={app.name} href={app.path}>
        <span class="tile">{#if app.name === 'banter' && unread}<i class="ub">{unread > 99 ? '99+' : unread}</i>{/if}<svg viewBox="0 0 24 24" aria-hidden="true"><path d={app.icon} /></svg></span>
        <span class="txt">
          <span class="name">{app.name}</span>
          <span class="desc">{live[app.name] || app.desc}</span>
        </span>
        <svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7" /></svg>
      </a>
    {/each}
  </section>

  {#if layout !== 'dock' && ((cont && cont.length) || music)}
    <section class="strip" aria-label="pick up where you left off">
      <p class="sh">pick up where you left off</p>
      <div class="sc">
        {#if music}<a class="sk music" href="/amp"><span class="sart">{#if music.art}<img src={music.art} alt="" referrerpolicy="no-referrer" onerror={(e) => (e.currentTarget.style.display = 'none')} />{/if}</span><span class="sk-t"><b>{music.title}</b><i>{music.artist || 'last played in amp'}</i></span></a>{/if}
        {#each (cont || []).slice(0, 3) as v}<a class="sk" href={'/jetstream?v=' + v.id}><img src={'/api/apps/jetstream/thumb?id=' + v.id} alt="" loading="lazy" /><span class="sk-t"><b>{v.title}</b><i>{v.channel}</i></span></a>{/each}
      </div>
    </section>
  {/if}
  {#if layout === 'grid'}
    <form class="hs-search" onsubmit={(e) => { e.preventDefault(); const v = sq.trim(); if (v) { sessionStorage.setItem('rj-open', v); window.location.href = '/browse'; } }}>
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>
      <input bind:value={sq} placeholder="search" aria-label="search the web" autocomplete="off" />
    </form>
    <p class="hs-dots" aria-hidden="true"><i class="on"></i><i></i></p>
  {/if}

  {#if sys}
    <p class="sys" aria-label="system details">ramjet {sys.version} · node {sys.node.replace('v', '')} · up {dur(sys.uptime)} · load {sys.load}/{sys.cpus} · cache {sys.cacheMB} MB · {sys.rtt} ms</p>
  {/if}
  <footer>built by luke</footer>
</main>

<style>
  main { max-width: 640px; margin: 0 auto; padding: 16px 14px 48px; }
  header { display: flex; justify-content: space-between; align-items: center; padding: 6px 6px 18px; }
  .brand { font-size: 22px; font-weight: 700; letter-spacing: -0.03em; }
  .dot { color: var(--rj-accent); }
  .me { display: flex; align-items: center; gap: 10px; }
  .avatar {
    width: 34px; height: 34px; display: grid; place-items: center;
    border-radius: 50%; background: var(--rj-surface-2);
    color: var(--rj-text); font-size: 14px; font-weight: 600; text-transform: uppercase;
  }
  .out { background: none; border: none; color: var(--rj-text-faint); font-size: 13px; padding: 6px 8px; border-radius: 10px; }
  .out:hover { color: var(--rj-text); background: var(--rj-surface); }
  .hello { margin: 0 6px 14px; font-size: 15px; color: var(--rj-text-dim); }
  .list { display: grid; gap: 4px; }
  .row {
    display: flex; align-items: center; gap: 14px;
    padding: 12px; border-radius: var(--rj-radius);
    transition: background .12s;
  }
  .row:hover { background: var(--rj-hover); }
  .row:active { background: var(--rj-surface); }
  .tile { position: relative;
    width: 44px; height: 44px; flex: none;
    display: grid; place-items: center;
    background: var(--rj-surface); border-radius: 14px;
  }
  .ub { position: absolute; top: -5px; right: -5px; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px; background: var(--rj-accent); color: #000; font: 700 11px/18px system-ui; font-style: normal; text-align: center; }
  .tile svg { width: 22px; height: 22px; fill: none; stroke: var(--rj-text); stroke-width: 1.6; stroke-linejoin: round; stroke-linecap: round; }
  .txt { display: grid; gap: 1px; min-width: 0; }
  .name { font-size: 15px; font-weight: 600; }
  .desc { font-size: 13px; color: var(--rj-text-dim); }
  .chev { margin-left: auto; width: 16px; height: 16px; flex: none; fill: none; stroke: var(--rj-text-faint); stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  /* layouts: list (default), grid (home screen), dock (desktop with a dock) */
  .lay-grid .list { grid-template-columns: repeat(3, 1fr); gap: 18px 8px; margin-top: 14px; }
  .lay-grid .row { flex-direction: column; text-align: center; gap: 8px; padding: 8px 4px; }
  .lay-grid .tile { width: 64px; height: 64px; border-radius: calc(var(--rj-radius) + 4px); }
  .lay-grid .tile svg { width: 30px; height: 30px; }
  .lay-grid .desc, .lay-grid .chev { display: none; }
  .lay-grid .txt { justify-items: center; }
  .lay-dock main, main.lay-dock { padding-bottom: 130px; }
  .lay-dock .hello { font-size: 28px; font-weight: 700; color: var(--rj-text); margin: 18px 6px 18px; }
  main.lay-dock { max-width: 1360px; padding-left: 28px; padding-right: 28px; }
  @media (max-width: 640px) { main.lay-dock { padding-left: 14px; padding-right: 14px; } }
  .deskbar { display: flex; justify-content: flex-end; margin: -6px 6px 8px; }
  .arr { background: none; border: 1px solid var(--rj-border); color: var(--rj-text-dim); font-size: 12px; padding: 5px 12px; border-radius: 999px; }
  .arr.on { background: var(--rj-accent); color: var(--rj-accent-ink, #000); border-color: transparent; }
  .desk { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; grid-auto-flow: dense; align-items: stretch; }
  .sz-s { grid-column: span 1; } .sz-m, .sz-l { grid-column: span 2; }
  @media (min-width: 900px) { .desk { grid-template-columns: repeat(12, 1fr); gap: 14px; } .sz-s { grid-column: span 4; } .sz-m { grid-column: span 8; } .sz-l { grid-column: span 12; } }
  .w { background: color-mix(in srgb, var(--rj-surface) 82%, transparent); border: 1px solid var(--rj-border); border-radius: calc(var(--rj-radius) + 2px); padding: 14px 16px 16px; backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); min-width: 0; margin: 0; display: flex; flex-direction: column; transition: transform .15s, box-shadow .15s; }
  .w:hover { transform: translateY(-1px); }
  .w.drag { opacity: .85; transform: scale(1.02); z-index: 5; box-shadow: 0 18px 40px rgba(0,0,0,.45); }
  .wig > :not(.wh) { animation: wig .45s ease-in-out infinite alternate; }
  @keyframes wig { from { transform: rotate(-.35deg); } to { transform: rotate(.35deg); } }
  @media (prefers-reduced-motion: reduce) { .wig > :not(.wh) { animation: none; } }
  .wh.grab { cursor: grab; touch-action: none; user-select: none; }
  .wh { padding: 0; display: flex; justify-content: space-between; align-items: center; min-height: 22px; margin-bottom: 8px; font-size: 12px; color: var(--rj-text-faint); }
  .ctl { display: flex; gap: 4px; }
  .ctl button { width: 26px; height: 26px; border-radius: 8px; border: none; background: var(--rj-surface-2); color: var(--rj-text); font-size: 16px; line-height: 1; }
  .lay-dock footer { display: none; }
  main.lay-dock::after { content: ''; position: fixed; left: 0; right: 0; bottom: 0; height: 150px; pointer-events: none; z-index: 4; background: linear-gradient(transparent, color-mix(in srgb, var(--rj-bg) 88%, transparent)); }
  .sform input::placeholder { color: var(--rj-text-dim); opacity: .85; }
  .clk { margin: 0; font-size: 54px; font-weight: 700; letter-spacing: -0.04em; line-height: 1; }
  .clk small { font-size: 18px; font-weight: 500; color: var(--rj-text-dim); margin-left: 6px; letter-spacing: 0; }
  .cdate { margin: 8px 0 0; color: var(--rj-text-dim); font-size: 14px; }
  .sform { display: flex; gap: 8px; }
  .sform input { flex: 1; min-width: 0; background: var(--rj-surface-2); border: 1px solid transparent; border-radius: 12px; padding: 11px 13px; color: var(--rj-text); font-size: 16px; font-family: inherit; }
  .sform input:focus { outline: none; border-color: var(--rj-accent); }
  .go { width: 42px; border: none; border-radius: 12px; background: var(--rj-accent); color: var(--rj-accent-ink, #000); font-size: 18px; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
  .chip { border: 1px solid var(--rj-border); background: none; color: var(--rj-text-dim); font-size: 12px; padding: 5px 11px; border-radius: 999px; }
  .chip.on { background: var(--rj-surface-2); color: var(--rj-text); border-color: var(--rj-accent); }
  .mute { margin: 0; font-size: 13px; color: var(--rj-text-faint); }
  .mute a { color: var(--rj-accent); }
  .vrow, .brow, .mrow { display: flex; align-items: center; gap: 12px; padding: 7px 0; min-width: 0; }
  .vrow img { width: 88px; aspect-ratio: 16/9; object-fit: cover; border-radius: 8px; background: var(--rj-surface-2); flex: none; }
  .vt { display: grid; gap: 2px; min-width: 0; flex: 1; }
  .vt b { font-size: 14px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .vt i { font-style: normal; font-size: 12px; color: var(--rj-text-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bav { width: 34px; height: 34px; flex: none; display: grid; place-items: center; border-radius: 50%; background: var(--rj-surface-2); font-size: 15px; font-weight: 600; text-transform: uppercase; }
  .bun { font-style: normal; background: var(--rj-accent); color: var(--rj-accent-ink, #000); font: 700 11px/18px system-ui; min-width: 18px; padding: 0 5px; text-align: center; border-radius: 9px; }
  .art { width: 52px; height: 52px; flex: none; border-radius: 10px; background: var(--rj-surface-2); overflow: hidden; }
  .art img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .pl { width: 34px; height: 34px; border-radius: 50%; display: grid; place-items: center; background: var(--rj-accent); color: var(--rj-accent-ink, #000); font-size: 12px; flex: none; }
  .sgrid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px 6px; }
  .site { background: none; border: none; display: grid; justify-items: center; gap: 5px; color: var(--rj-text-dim); min-width: 0; padding: 0; }
  .sl { width: 42px; height: 42px; display: grid; place-items: center; border-radius: 13px; background: var(--rj-surface-2); color: var(--rj-text); font-weight: 600; text-transform: uppercase; }
  .sn { font-size: 11px; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sprom { display: grid; gap: 6px; }
  .sprom button { text-align: left; background: var(--rj-surface-2); border: none; color: var(--rj-text-dim); padding: 10px 12px; border-radius: 12px; font-size: 13px; font-family: inherit; }
  .sprom button:hover { color: var(--rj-text); }
  .sysl { display: grid; grid-template-columns: auto 1fr; gap: 4px 14px; margin: 0; font: 12px var(--rj-mono); }
  .sysl dt { color: var(--rj-text-faint); } .sysl dd { margin: 0; text-align: right; }
  .addback { margin: 12px 6px 0; font-size: 12px; color: var(--rj-text-faint); display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
  .widgets { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; margin: 0 0 20px; }
  .widget { display: grid; gap: 4px; padding: 14px; border-radius: var(--rj-radius); background: var(--rj-surface); border: 1px solid var(--rj-border); }
  .wn { font-size: 12px; color: var(--rj-text-faint); text-transform: lowercase; }
  .wv { font-size: 14px; line-height: 1.35; }
  .lay-dock .list { z-index: 6; position: fixed; left: 50%; transform: translateX(-50%); bottom: calc(14px + env(safe-area-inset-bottom)); display: flex; gap: 6px; padding: 10px 12px; background: color-mix(in srgb, var(--rj-surface) 88%, transparent); backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); border: 1px solid var(--rj-border); border-radius: calc(var(--rj-radius) + 8px); z-index: 10; }
  .lay-dock .row { flex-direction: column; padding: 4px 8px; gap: 4px; }
  .lay-dock .tile { background: var(--rj-surface-2); }
  .lay-dock .name { font-size: 11px; font-weight: 500; }
  .lay-dock .desc, .lay-dock .chev { display: none; }
  .lay-dock .txt { justify-items: center; }
  .sys { margin: 30px 0 0; text-align: center; font: 11px/1.5 var(--rj-mono); color: var(--rj-text-faint); }
  footer { margin-top: 40px; text-align: center; font-size: 12px; color: var(--rj-text-faint); }
  .cm { margin: 0 0 8px; font-weight: 600; font-size: 14px; }
  .cg { display: grid; grid-template-columns: repeat(7, 1fr); gap: 3px; text-align: center; font-size: 12px; color: var(--rj-text-dim); }
  .cg i { font-style: normal; padding: 5px 0; border-radius: 50%; }
  .cg .ch { color: var(--rj-text-faint); font-size: 10px; }
  .cg .today { background: var(--rj-accent); color: var(--rj-accent-ink, #000); font-weight: 700; }
  .nt { width: 100%; flex: 1; min-height: 110px; resize: none; background: color-mix(in srgb, var(--rj-accent) 10%, var(--rj-surface-2)); border: none; border-radius: 12px; padding: 12px; color: var(--rj-text); font: 14px/1.5 var(--rj-font); }
  .nt:focus { outline: none; }
  .tf input { width: 100%; background: var(--rj-surface-2); border: none; border-radius: 10px; padding: 9px 12px; color: var(--rj-text); font-size: 14px; margin-bottom: 6px; }
  .tl { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
  .tl li { display: flex; align-items: center; gap: 10px; padding: 5px 0; font-size: 14px; }
  .tl li span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tl li.done span { color: var(--rj-text-faint); text-decoration: line-through; }
  .tk { width: 20px; height: 20px; border-radius: 50%; border: 1.5px solid var(--rj-text-faint); background: none; color: var(--rj-accent-ink, #000); font-size: 12px; line-height: 1; padding: 0; }
  .done .tk { background: var(--rj-accent); border-color: var(--rj-accent); }
  .tx { background: none; border: none; color: var(--rj-text-faint); font-size: 18px; }
  .fm { margin: 0 0 10px; font-size: 44px; font-weight: 700; letter-spacing: -0.03em; font-variant-numeric: tabular-nums; }
  .go2 { background: var(--rj-accent); color: var(--rj-accent-ink, #000); border-color: transparent; font-weight: 600; }
  .tl { grid-template-columns: minmax(0, 1fr); }
  .tl li { min-width: 0; }
  @media (max-width: 899px) { .sz-s .clk { font-size: 38px; } .sz-s .clk small { font-size: 14px; margin-left: 3px; } .sz-s .fm { font-size: 34px; } }
  main.lay-dock { padding-bottom: calc(150px + env(safe-area-inset-bottom)); }
  /* home screen: iOS-style, big colored icons, no widgets */
  main.lay-grid { max-width: 560px; padding-top: 10px; }
  .lay-grid .hello { display: none; }
  .hs-top { text-align: center; margin: 6px 0 26px; }
  .hs-time { margin: 0; font-size: 64px; font-weight: 600; letter-spacing: -.03em; line-height: 1; color: var(--rj-text); }
  .hs-date { margin: 6px 0 0; font-size: 16px; font-weight: 500; color: var(--rj-text-dim); }
  .lay-grid .list { grid-template-columns: repeat(4, 1fr); gap: 22px 6px; margin-top: 8px; }
  .lay-grid .row { padding: 0; gap: 7px; background: none; border: 0; }
  .lay-grid .tile { width: 68px; height: 68px; border-radius: 22%; position: relative; box-shadow: inset 0 1px 0 rgba(255,255,255,.4), inset 0 -2px 4px rgba(0,0,0,.18), 0 4px 10px rgba(0,0,0,.35); }
  .lay-grid .tile svg { width: 32px; height: 32px; stroke: #fff; filter: drop-shadow(0 1px 1px rgba(0,0,0,.25)); }
  .lay-grid .name { font-size: 12.5px; font-weight: 500; color: var(--rj-text); text-shadow: 0 1px 3px rgba(0,0,0,.6); }
  .lay-grid .row:active .tile { transform: scale(.92); }
  .lay-grid .row[data-app=browse] .tile { background: linear-gradient(180deg, #4db3ff, #0a64e0); }
  .lay-grid .row[data-app=jetstream] .tile { background: linear-gradient(180deg, #ff6b5e, #d02a1f); }
  .lay-grid .row[data-app=amp] .tile { background: linear-gradient(180deg, #ff5c7f, #cf1f4a); }
  .lay-grid .row[data-app=sage] .tile { background: linear-gradient(180deg, #c779ff, #7a36c9); }
  .lay-grid .row[data-app=settings] .tile { background: linear-gradient(180deg, #9aa0ab, #5b616c); }
  .lay-grid .row[data-app=banter] .tile { background: linear-gradient(180deg, #4bdc6e, #1f9d3d); }
  .hs-search { display: flex; align-items: center; gap: 8px; width: min(78%, 320px); margin: 44px auto 0; padding: 0 16px; height: 40px; border-radius: 99px; background: color-mix(in srgb, var(--rj-surface-2) 80%, transparent); border: 1px solid var(--rj-border); color: var(--rj-text-faint); backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); }
  .hs-search input { flex: 1; min-width: 0; background: none; border: 0; outline: 0; color: var(--rj-text); font: inherit; font-size: 15px; text-align: center; }
  .hs-dots { display: flex; justify-content: center; gap: 7px; margin: 16px 0 0; }
  .hs-dots i { width: 7px; height: 7px; border-radius: 50%; background: var(--rj-text-faint); opacity: .5; } .hs-dots i.on { opacity: 1; background: var(--rj-text); }
  @media (min-width: 900px) { main.lay-grid { max-width: 760px; } .lay-grid .list { grid-template-columns: repeat(5, 1fr); gap: 34px 10px; } .lay-grid .tile { width: 84px; height: 84px; } .lay-grid .tile svg { width: 40px; height: 40px; } .lay-grid .name { font-size: 14px; } .hs-time { font-size: 84px; } }
  .lsearch { display: flex; align-items: center; gap: 10px; margin: 2px 6px 14px; padding: 0 16px; height: 44px; border-radius: 99px; background: var(--rj-surface); border: 1px solid var(--rj-border); color: var(--rj-text-faint); }
  .lsearch input { flex: 1; min-width: 0; background: none; border: 0; outline: 0; color: var(--rj-text); font: inherit; font-size: 15px; }
  .strip { margin: 22px 0 0; }
  .sh { margin: 0 6px 10px; font-size: 12px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--rj-text-faint); }
  .sc { display: flex; gap: 10px; overflow-x: auto; padding: 2px 6px 6px; scroll-snap-type: x proximity; }
  .sk { flex: none; width: 170px; scroll-snap-align: start; display: grid; gap: 7px; padding: 8px; border-radius: var(--rj-radius); background: var(--rj-surface); border: 1px solid var(--rj-border); }
  .sk img, .sk .sart { width: 100%; aspect-ratio: 16 / 9; object-fit: cover; border-radius: calc(var(--rj-radius) - 6px); background: var(--rj-surface-2); display: block; }
  .sk .sart { position: relative; overflow: hidden; } .sk .sart img { position: absolute; inset: 0; height: 100%; aspect-ratio: auto; }
  .sk.music .sart { background: linear-gradient(135deg, #ff5c7f, #7a36c9); }
  .sk-t { display: grid; gap: 1px; min-width: 0; padding: 0 2px 2px; }
  .sk-t b { font-size: 13px; font-weight: 600; line-height: 1.25; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .sk-t i { font-style: normal; font-size: 11.5px; color: var(--rj-text-faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .lay-grid .strip { margin-top: 30px; } .lay-grid .sh { text-align: center; }
  .lay-grid .sc { justify-content: safe center; }
  .lay-grid .hs-search { margin-top: 26px; }
</style>
