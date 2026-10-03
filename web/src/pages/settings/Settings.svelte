<script>
  import { readCfg, writeCfg } from '../../lib/autoclear.js';
  import { savingOn, setSaving } from '../../lib/searchhist.js';
  const ACCENTS = [['lime', '#d9f24b'], ['sky', '#5cc8ff'], ['coral', '#ff7a6b'], ['violet', '#b69cff'], ['mint', '#4be3b0'], ['amber', '#ffc447']];
  const BASES = [['black', '#000000'], ['graphite', '#121316'], ['midnight', '#0b0f1a'], ['warm', '#14110f']];
  const ROUNDS = ['sharp', 'soft', 'round'];
  let sec = $state('look'); let sub = $state('');
  const SECS = [['look','appearance'],['account','account'],['privacy','privacy & data'],['apps','apps'],['adv','advanced']];
  function pick(k) { sec = k; sub = ''; try { history.replaceState(null, '', '#' + k); window.scrollTo(0, 0); } catch {} }
  function onKey(e) { if (e.key === 'Escape' && sub) sub = ''; }
  const fromHash = () => { const h = location.hash.slice(1); if (SECS.some((x) => x[0] === h)) { sec = h; sub = ''; } };
  onMount(() => { fromHash(); window.addEventListener('hashchange', fromHash); });
  const setSaver = (v) => { saver = v; try { if (v === 'auto') localStorage.removeItem('rj-datasaver'); else localStorage.setItem('rj-datasaver', v); } catch {} };
  const setAc = (on) => { ac.on = on; saveAc(); };
  const flipTech = () => { tech = !tech; saveTech(); };
  const MODE_NAMES = ['ramjet', 'macos glass', 'terminal', 'paper'];
  const PVR = { sharp: 4, soft: 9, round: 15 };
  const PVF = { system: 'system-ui, sans-serif', mono: 'ui-monospace, Menlo, monospace', serif: 'ui-serif, Georgia, serif', round: 'ui-rounded, system-ui, sans-serif' };
  const pvBg = (v) => v.skin === 'glass' ? 'linear-gradient(180deg,#1a2650,#7d4a69 65%,#cf8450)' : (BASES.find((x) => x[0] === v.base) || BASES[0])[1];
  const isPreset = (v) => (look.tiles || 'color') === (v.tiles || 'color') && look.accent === v.accent && look.base === v.base && look.round === v.round && look.font === v.font && (look.skin || '') === (v.skin || '');
  const WALLS = [['none', 'none'], ['silk', 'silk dark'], ['silk-light', 'silk light'], ['golden', 'golden hour'], ['aurora', 'aurora'], ['dusk', 'dusk'], ['ember', 'ember'], ['ocean', 'ocean'], ['forest', 'forest'], ['grid', 'grid'], ['dots', 'dots']];
  let wall = $state('none');
  try { const w = localStorage.getItem('rj-wall'); if (w) wall = w; } catch {}
  function setWall(v) { wall = v; try { if (v === 'none') localStorage.removeItem('rj-wall'); else localStorage.setItem('rj-wall', v); } catch {} window.__rjWall?.(v); }
  const LAYOUTS = [['list', 'list'], ['grid', 'home screen'], ['dock', 'desktop + dock']];
  let layout = $state('list');
  try { const l = localStorage.getItem('rj-layout'); if (l === 'grid' || l === 'dock') layout = l; } catch {}
  function setLayout(v) { layout = v; try { if (v === 'list') localStorage.removeItem('rj-layout'); else localStorage.setItem('rj-layout', v); } catch {} }
  const FONTS = [['system', 'system'], ['mono', 'terminal'], ['serif', 'editorial'], ['round', 'soft']];
  const PRESETS = [
    ['ramjet', { accent: '#d9f24b', base: 'black', round: 'soft', font: 'system', wall: 'none', tiles: 'mono' }],
    ['ios', { accent: '#5cc8ff', base: 'graphite', round: 'round', font: 'system', wall: 'none', tiles: 'color' }],
    ['terminal', { accent: '#4be3b0', base: 'black', round: 'sharp', font: 'mono', wall: 'grid', tiles: 'mono' }],
    ['dusk', { accent: '#ff7a6b', base: 'warm', round: 'round', font: 'soft', wall: 'dusk', tiles: 'accent' }],
    ['paper', { accent: '#ffc447', base: 'warm', round: 'sharp', font: 'serif', wall: 'none', tiles: 'accent' }],
    ['aurora', { accent: '#b69cff', base: 'midnight', round: 'round', font: 'system', wall: 'aurora', tiles: 'accent' }],
    ['macos glass', { accent: '#4da3ff', base: 'black', round: 'soft', font: 'system', skin: 'glass', glass: 55, wall: 'silk', tiles: 'color' }],
  ];
  function setPreset(v) {
    const wasGlass = look.skin === 'glass';
    look = { ...v }; delete look.wall; try { localStorage.setItem('rj-theme', JSON.stringify(look)); } catch {} window.__rjTheme?.(look);
    setWall(v.wall || 'none');
    if (v.skin === 'glass') { if (!wasGlass) { try { localStorage.setItem('rj-layout-pre', layout); } catch {} } setLayout('dock'); }
    else if (wasGlass) { let pre = 'list'; try { pre = localStorage.getItem('rj-layout-pre') || 'list'; } catch {} setLayout(pre); }
  }
  let look = $state({ accent: '#d9f24b', base: 'black', round: 'soft', font: 'system' });
  try { const t = JSON.parse(localStorage.getItem('rj-theme') || 'null'); if (t) look = { ...look, ...t }; } catch {}
  function setLook(k, v) {
    look = { ...look, [k]: v };
    try { localStorage.setItem('rj-theme', JSON.stringify(look)); } catch {}
    window.__rjTheme?.(look);
  }
  function resetLook() {
    look = { accent: '#d9f24b', base: 'black', round: 'soft', font: 'system' };
    try { localStorage.removeItem('rj-theme'); } catch {}
    window.__rjTheme?.(null);
  }
  import { techOn, setTech } from '../../lib/tech.js';
  let tech = $state(techOn());
  let sysInfo = $state(null);
  function saveTech() { setTech(tech); }
  onMount(async () => { const r = await api('/api/sys'); if (r.ok) sysInfo = r.data; });
  let ac = $state(readCfg());
  function saveAc() { writeCfg(ac); }
  import { setCloak } from '../../lib/cloak.js';
  import '../../tokens.css';
  import { onMount } from 'svelte';
  import { api } from '../../lib/api.js';

  let user = $state('');
  let current = $state('');
  let next = $state('');
  let confirm = $state('');
  let msg = $state('');
  let ok = $state(false);
  let busy = $state(false);
  let admin = $state(false);
  let users = $state([]);
  let needApproval = $state(true);
  let admMsg = $state('');
  let armed = $state('');

  // data saver: auto (phones get the 720p low-data tier), on, or off. device-local.
  let saver = $state('auto');
  try { const v = localStorage.getItem('rj-datasaver'); if (v === 'on' || v === 'off') saver = v; } catch {}
  function cycleSaver() {
    saver = saver === 'auto' ? 'on' : saver === 'on' ? 'off' : 'auto';
    try { if (saver === 'auto') localStorage.removeItem('rj-datasaver'); else localStorage.setItem('rj-datasaver', saver); } catch {}
  }
  // tab cloak: reads as Google Docs on every app; device-local, off by default.
  let cloak = $state(true);
  try { cloak = localStorage.getItem('rj-cloak') !== '0'; } catch {}
  function toggleCloak() { cloak = !cloak; setCloak(cloak); }
  // ad blocker: on by default, device-local. applies the next time browse opens.
  let saveS = $state(savingOn());
  function toggleSaveS() { saveS = !saveS; setSaving(saveS); }
  let adblock = $state(true);
  let adInfo = $state(null);
  try { adblock = localStorage.getItem('rj-adblock') !== 'off'; } catch {}
  function toggleAds() {
    adblock = !adblock;
    try { if (adblock) localStorage.removeItem('rj-adblock'); else localStorage.setItem('rj-adblock', 'off'); } catch {}
  }
  onMount(async () => { const r = await api('/api/adblock-stats'); if (r.ok) adInfo = r.data; });
  let devConfirm = $state(false);
  let devMsg = $state('');
  function clearDevice() {
    if (!devConfirm) { devConfirm = true; setTimeout(() => { devConfirm = false; }, 4000); return; }
    devConfirm = false;
    for (const k of ['js-later', 'amp-recent', 'rj-browse-recent', 'js-searches', 'amp-searches', 'rj-browse-searches']) { try { localStorage.removeItem(k); } catch {} }
    devMsg = 'cleared recents and watch later on this device';
    setTimeout(() => { devMsg = ''; }, 3000);
  }

  async function loadUsers() {
    const r = await api('/api/admin/users');
    if (r.ok) { users = r.data.users || []; needApproval = !!r.data.requireApproval; }
  }
  onMount(async () => {
    const r = await api('/api/auth/me');
    if (!r.ok) { window.location.href = '/login'; return; }
    user = r.data.user;
    admin = !!r.data.admin;
    if (admin) loadUsers();
  });
  function flash(m) { admMsg = m; setTimeout(() => { admMsg = ''; }, 2500); }
  async function act(kind, name) {
    const r = await api('/api/admin/' + kind, { method: 'POST', body: { name } });
    flash(r.ok ? ({ approve: name + ' approved', ban: name + ' turned off', unban: name + ' turned back on', logout: name + ' signed out everywhere', remove: name + ' removed' })[kind] : (r.data?.error || 'that did not work'));
    loadUsers();
  }
  function confirmAct(kind, name) {
    const key = kind + ':' + name;
    if (armed !== key) { armed = key; setTimeout(() => { if (armed === key) armed = ''; }, 3500); return; }
    armed = '';
    act(kind, name);
  }
  async function toggleApproval() {
    const r = await api('/api/admin/config', { method: 'POST', body: { requireApproval: !needApproval } });
    if (r.ok) needApproval = !!r.data.requireApproval;
    flash(r.ok ? (needApproval ? 'new accounts now need your approval' : 'new accounts now join right away') : 'that did not save');
  }

  async function save(e) {
    e.preventDefault();
    if (busy) return;
    msg = ''; ok = false;
    if (next !== confirm) { msg = "new passwords don't match"; return; }
    busy = true;
    const r = await api('/api/auth/change-password', { method: 'POST', body: { current, next } });
    busy = false;
    if (r.ok) { ok = true; msg = 'done - new password is live'; current = ''; next = ''; confirm = ''; return; }
    msg = r.data?.error || "that didn't work - try again";
  }

  let sageMsg = $state('');
  let sageConfirm = $state(false);
  async function clearSage() {
    if (!sageConfirm) {
      sageConfirm = true;
      setTimeout(() => { sageConfirm = false; }, 4000);
      return;
    }
    sageConfirm = false;
    try { localStorage.removeItem('sage-conversation'); localStorage.removeItem('sage-conv-id'); } catch {}
    const r = await api('/api/apps/sage/conversations/clear', { method: 'POST' });
    sageMsg = r.ok ? 'all conversations deleted' : 'could not delete them - try again';
    setTimeout(() => sageMsg = '', 3000);
  }


  // per-app privacy, all in one place (Luke's call): jetstream watch history
  // pause + clear, amp playlists, browse bookmarks. sage is above.
  let jsPaused = $state(false);
  let jsCount = $state(0);
  let jsMsg = $state('');
  let jsConfirm = $state(false);
  onMount(async () => {
    const r = await api('/api/apps/jetstream/settings');
    if (r.ok) { jsPaused = !!r.data.paused; jsCount = r.data.count || 0; }
  });
  async function toggleJsPause() {
    const r = await api('/api/apps/jetstream/settings', { method: 'POST', body: { paused: !jsPaused } });
    if (r.ok) jsPaused = !!r.data.paused;
    jsMsg = r.ok ? (jsPaused ? 'history paused - your list is still there' : 'history is recording again') : 'that did not save - try again';
    setTimeout(() => jsMsg = '', 3000);
  }
  async function clearJsHistory() {
    if (!jsConfirm) { jsConfirm = true; setTimeout(() => { jsConfirm = false; }, 4000); return; }
    jsConfirm = false;
    const r = await api('/api/apps/jetstream/history/clear', { method: 'POST' });
    if (r.ok) jsCount = 0;
    jsMsg = r.ok ? 'watch history cleared - your feeds relearn from here' : 'could not clear it - try again';
    setTimeout(() => jsMsg = '', 3000);
  }

  let ampMsg = $state('');
  let ampConfirm = $state(false);
  async function clearAmp() {
    if (!ampConfirm) { ampConfirm = true; setTimeout(() => { ampConfirm = false; }, 4000); return; }
    ampConfirm = false;
    const r = await api('/api/apps/amp/playlists/clear', { method: 'POST' });
    ampMsg = r.ok ? 'all playlists deleted' : 'could not delete them - try again';
    setTimeout(() => ampMsg = '', 3000);
  }

  let bmMsg = $state('');
  let bmConfirm = $state(false);
  async function clearBm() {
    if (!bmConfirm) { bmConfirm = true; setTimeout(() => { bmConfirm = false; }, 4000); return; }
    bmConfirm = false;
    const r = await api('/api/apps/browse/bookmarks/clear', { method: 'POST' });
    bmMsg = r.ok ? 'all bookmarks cleared' : 'could not clear them - try again';
    setTimeout(() => bmMsg = '', 3000);
  }

  async function logout() {
    await api('/api/auth/logout', { method: 'POST' });
    window.location.href = '/login';
  }
</script>

<svelte:head><title>settings - ramjet</title></svelte:head>
<svelte:window onkeydown={onKey} />

<div class="page">
  <header class="top">
    <a class="back" href="/" aria-label="back to ramjet"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg></a>
    <span class="brand">settings</span>
    <span class="tagline">{user}</span>
  </header>

  <div class="shell">
    <nav class="snav" aria-label="settings sections">
      {#each SECS as [k, n]}<button class:on={sec === k} onclick={() => pick(k)}>{n}</button>{/each}
    </nav>

    <main class="pane">
    {#if sec === 'look' && sub === 'theme'}
      <div class="subtop"><button class="back2" onclick={() => (sub = '')}><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>appearance</button><h2>advanced theming</h2><button class="x" onclick={() => (sub = '')} aria-label="close advanced theming">done</button></div>
      <div class="cols">
      <section class="card"><h3>more styles</h3>
        <div class="seg wrapseg">{#each PRESETS.filter((p) => !MODE_NAMES.includes(p[0])) as [n, v]}<button class:on={isPreset(v)} onclick={() => setPreset(v)}>{n}</button>{/each}</div></section>
      <section class="card"><h3>wallpaper</h3><p class="hint">behind every page</p>
        <div class="walls">{#each WALLS as [k, n]}<button class="wp2" class:on={wall === k} onclick={() => setWall(k)}><i class="wc wall-{k}"></i><span>{n}</span></button>{/each}</div></section>
      <section class="card"><h3>surface</h3>
        <div class="seg"><button class:on={look.skin !== 'glass'} onclick={() => setLook('skin', '')}>flat</button><button class:on={look.skin === 'glass'} onclick={() => setLook('skin', 'glass')}>liquid glass</button></div>
        {#if look.skin === 'glass'}<label class="glr"><span>clear</span><input type="range" min="0" max="100" value={look.glass ?? 55} oninput={(e) => setLook('glass', +e.currentTarget.value)} /><span>opaque</span></label>{/if}</section>
      <section class="card"><h3>font</h3><div class="seg wrapseg">{#each FONTS as [k, n]}<button class:on={look.font === k} onclick={() => setLook('font', k)}>{n}</button>{/each}</div>
        <h3>corners</h3><div class="seg">{#each ROUNDS as r}<button class:on={look.round === r} onclick={() => setLook('round', r)}>{r}</button>{/each}</div></section>
      <section class="card"><h3>accent</h3><div class="dots">{#each ACCENTS as [n, c]}<button class="dot" class:on={look.accent === c} style="--c:{c}" aria-label={n} aria-pressed={look.accent === c} onclick={() => setLook('accent', c)}></button>{/each}</div>
        <h3>background</h3><div class="seg wrapseg">{#each BASES as [n, c]}<button class:on={look.base === n} onclick={() => setLook('base', n)}><i class="bd" style="--c:{c}"></i>{n}</button>{/each}</div></section>
      </div>
      <div class="foot"><button class="ghost" onclick={resetLook}>reset appearance</button><button class="primary" onclick={() => (sub = '')}>done</button></div>

    {:else if sec === 'look'}
      <h2 class="ph">appearance</h2>
      <section class="card"><h3>mode</h3>
        <div class="tiles">{#each PRESETS.filter((p) => MODE_NAMES.includes(p[0])) as [n, v]}
          <button class="tl" class:on={isPreset(v)} onclick={() => setPreset(v)} aria-pressed={isPreset(v)}>
            <span class="pv" style="--pb:{pvBg(v)};--pa:{v.accent};--pr:{PVR[v.round]}px;font-family:{PVF[v.font]}"><i class="pva"></i><i class="pvl"></i><i class="pvl s"></i><b>Aa</b></span>
            <span class="pn">{n}</span>
          </button>{/each}</div></section>
      <section class="card"><h3>home screen</h3>
        <div class="lays">{#each LAYOUTS as [k, n]}<button class="lay" class:on={layout === k} onclick={() => setLayout(k)}><span class="lp lp-{k}"><i></i><i></i><i></i><i></i></span><span>{n}</span></button>{/each}</div></section>
      <section class="card list">
        <button class="nav" onclick={() => (sub = 'theme')}><span class="rt"><b>advanced theming</b><small>wallpaper, glass, font, accent, corners</small></span><span class="chv">&rsaquo;</span></button>
        <button class="nav" onclick={resetLook}><span class="rt"><b>reset appearance</b><small>back to the default ramjet look</small></span></button>
      </section>

    {:else if sec === 'account'}
      <h2 class="ph">account</h2>
      <section class="card prof"><span class="avatar">{user.slice(0, 1)}</span><div><p class="name">{user}</p><p class="hint">ramjet account</p></div><button class="ghost" onclick={logout}>log out</button></section>
      <form class="card" onsubmit={save}>
        <h3>change password</h3>
        <input bind:value={current} type="password" placeholder="current password" autocomplete="current-password" required />
        <input bind:value={next} type="password" placeholder="new password (6+ characters)" autocomplete="new-password" required minlength="6" />
        <input bind:value={confirm} type="password" placeholder="new password again" autocomplete="new-password" required minlength="6" />
        {#if msg}<p class="msg" class:ok role="alert">{msg}</p>{/if}
        <button class="primary" type="submit" disabled={busy}>{busy ? 'saving...' : 'save password'}</button>
      </form>
      {#if admin}
      <section class="card">
        <h3>other accounts</h3>
        <div class="row"><span class="rt"><b>approve new accounts</b><small>{needApproval ? 'new accounts wait for you' : 'new accounts join right away'}</small></span>
          <button class="sw2" role="switch" aria-checked={needApproval} aria-label="approve new accounts" onclick={toggleApproval}><i></i></button></div>
        {#if admMsg}<p class="msg ok" role="status">{admMsg}</p>{/if}
        {#each users.filter((u) => u.name !== user) as u (u.name)}
          <div class="urow">
            <div class="uinfo"><span class="uname">{u.name}</span><span class="ustat" class:warn={u.status !== 'active'}>{u.status}</span></div>
            <div class="uacts">
              {#if u.status === 'pending'}
                <button class="mini yes" onclick={() => act('approve', u.name)}>approve</button>
                <button class="mini" class:armed={armed === 'remove:' + u.name} onclick={() => confirmAct('remove', u.name)}>{armed === 'remove:' + u.name ? 'sure?' : 'deny'}</button>
              {:else if u.status === 'banned'}
                <button class="mini yes" onclick={() => act('unban', u.name)}>turn on</button>
                <button class="mini" class:armed={armed === 'remove:' + u.name} onclick={() => confirmAct('remove', u.name)}>{armed === 'remove:' + u.name ? 'sure?' : 'remove'}</button>
              {:else}
                <button class="mini" onclick={() => act('logout', u.name)}>sign out</button>
                <button class="mini" class:armed={armed === 'ban:' + u.name} onclick={() => confirmAct('ban', u.name)}>{armed === 'ban:' + u.name ? 'sure?' : 'turn off'}</button>
              {/if}
            </div>
          </div>
        {:else}
          <p class="hint">no other accounts yet.</p>
        {/each}
      </section>
      {/if}

    {:else if sec === 'privacy'}
      <h2 class="ph">privacy &amp; data</h2>
      <section class="card list">
        <div class="row"><span class="rt"><b>tab cloak</b><small>tab reads as Google Docs. the ` key toggles it</small></span><button class="sw2" role="switch" aria-checked={cloak} aria-label="tab cloak" onclick={toggleCloak}><i></i></button></div>
        <div class="row"><span class="rt"><b>ad blocker</b><small>{adInfo ? adInfo.hosts.toLocaleString() + ' sites blocked list. ' : ''}applies next time browse opens</small></span><button class="sw2" role="switch" aria-checked={adblock} aria-label="ad blocker" onclick={toggleAds}><i></i></button></div>
        <div class="row"><span class="rt"><b>save my searches</b><small>off by default. when on, recent searches show under the search boxes. turning it off wipes them</small></span><button class="sw2" role="switch" aria-checked={saveS} aria-label="save my searches" onclick={toggleSaveS}><i></i></button></div>
        <div class="row"><span class="rt"><b>clear history when I leave</b><small>wipes watch history, browse history and recent songs after you are away</small></span><button class="sw2" role="switch" aria-checked={ac.on} aria-label="clear history when away" onclick={() => setAc(!ac.on)}><i></i></button></div>
        {#if ac.on}<div class="row"><span class="rt"><b>away for at least</b></span>
          <select bind:value={ac.mins} onchange={saveAc}><option value={5}>5 minutes</option><option value={30}>30 minutes</option><option value={120}>2 hours</option><option value={720}>12 hours</option></select></div>{/if}
      </section>
      <section class="card list">
        <button class="nav dng" class:armed={devConfirm} onclick={clearDevice}><span class="rt"><b>{devConfirm ? 'tap again to clear' : 'clear recents and searches'}</b><small>recent songs, sites, searches and watch later</small></span></button>
        {#if devMsg}<p class="msg ok" role="status">{devMsg}</p>{/if}
        <a class="nav" href="/api/auth/export" download><span class="rt"><b>export my data</b><small>history, likes, subs, playlists, bookmarks and chats in one file</small></span><span class="chv">&rsaquo;</span></a>
      </section>
      <p class="fine">auto-clear keeps likes, subscriptions, playlists, bookmarks, chats and banter. phones cannot tell a page when the app is swiped away, so it clears the next time you open ramjet after being away that long.</p>

    {:else if sec === 'apps'}
      <h2 class="ph">apps</h2>
      <div class="cols">
      <section class="card"><h3>jetstream</h3>
        <div class="row"><span class="rt"><b>save watch history</b><small>{jsCount ? jsCount + ' saved' : 'nothing saved'}. off stops new recordings</small></span><button class="sw2" role="switch" aria-checked={!jsPaused} aria-label="save watch history" onclick={toggleJsPause}><i></i></button></div>
        <div class="row"><span class="rt"><b>data saver</b><small>on = smaller video and thumbnails. auto: phones and metered or cellular connections. off = full quality. iPhone cant tell wifi from cellular, so set it to off for full-res on wifi.</small></span>
          <div class="seg sm">{#each ['auto', 'on', 'off'] as v}<button class:on={saver === v} onclick={() => setSaver(v)}>{v}</button>{/each}</div></div>
        {#if jsMsg}<p class="msg ok" role="status">{jsMsg}</p>{/if}
        <button class="dngb" class:armed={jsConfirm} onclick={clearJsHistory}>{jsConfirm ? 'tap again to clear' : 'clear watch history'}</button></section>
      <section class="card"><h3>amp</h3><p class="hint">playlists follow your account.</p>
        {#if ampMsg}<p class="msg ok" role="status">{ampMsg}</p>{/if}
        <button class="dngb" class:armed={ampConfirm} onclick={clearAmp}>{ampConfirm ? 'tap again to delete' : 'delete all playlists'}</button></section>
      <section class="card"><h3>browse</h3><p class="hint">bookmarks follow your account.</p>
        {#if bmMsg}<p class="msg ok" role="status">{bmMsg}</p>{/if}
        <button class="dngb" class:armed={bmConfirm} onclick={clearBm}>{bmConfirm ? 'tap again to clear' : 'clear all bookmarks'}</button></section>
      <section class="card"><h3>sage</h3><p class="hint">chats follow your account.</p>
        {#if sageMsg}<p class="msg ok" role="status">{sageMsg}</p>{/if}
        <button class="dngb" class:armed={sageConfirm} onclick={clearSage}>{sageConfirm ? 'tap again to delete' : 'delete all conversations'}</button></section>
      </div>

    {:else}
      <h2 class="ph">advanced</h2>
      <section class="card"><div class="row"><span class="rt"><b>technical details</b><small>system line on the hub, load time in browse, stats in jetstream</small></span><button class="sw2" role="switch" aria-checked={tech} aria-label="technical details" onclick={flipTech}><i></i></button></div>
        {#if sysInfo}<p class="mono">ramjet {sysInfo.version} · node {sysInfo.node.replace('v', '')} · {sysInfo.cpus} cpus · {sysInfo.memFreeMB} MB free · cache {sysInfo.cacheMB} MB</p>{/if}</section>
      <section class="card"><h3>keyboard shortcuts</h3>
      <dl class="keys">
        <dt>`</dt><dd>browse: hide / show the tab disguise</dd>
        <dt>alt + T</dt><dd>browse: new tab</dd>
        <dt>alt + W</dt><dd>browse: close tab</dd>
        <dt>alt + L</dt><dd>browse: focus the address bar</dd>
        <dt>alt + F</dt><dd>browse: find in page</dd>
        <dt>alt + Y</dt><dd>browse: history and recently closed</dd>
        <dt>alt + shift + T</dt><dd>browse: reopen closed tab</dd>
        <dt>space</dt><dd>amp: play / pause</dd>
        <dt>n / p</dt><dd>amp: next / previous</dd>
        <dt>&larr; / &rarr;</dt><dd>amp: back / forward 5 seconds</dd>
        <dt>enter</dt><dd>banter, sage: send (shift + enter for a new line)</dd>
      </dl></section>
    {/if}
    </main>
  </div>
</div>

<style>
  .page { min-height: 100dvh; }
  .top { display: flex; align-items: center; gap: 12px; padding: 14px 18px; max-width: 1360px; margin: 0 auto; }
  .back { width: 34px; height: 34px; border-radius: 50%; display: grid; place-items: center; background: var(--rj-surface-2); border: 1px solid var(--rj-border); color: var(--rj-text); }
  .back svg { width: 18px; height: 18px; }
  .brand { font-size: 20px; font-weight: 700; letter-spacing: -.01em; }
  .tagline { color: var(--rj-text-faint); font-size: 13px; }
  .shell { max-width: 1360px; margin: 0 auto; padding: 4px 18px 60px; display: grid; grid-template-columns: 220px minmax(0, 1fr); gap: 32px; align-items: start; }
  .snav { position: sticky; top: 16px; display: grid; gap: 2px; }
  .snav button { text-align: left; padding: 11px 14px; border-radius: 10px; border: 0; background: none; color: var(--rj-text-dim); font-size: 15px; }
  .snav button:hover { background: var(--rj-surface); color: var(--rj-text); }
  .snav button.on { background: var(--rj-surface-2); color: var(--rj-text); font-weight: 600; box-shadow: inset 2px 0 0 var(--rj-accent); }
  .pane { min-width: 0; display: grid; gap: 14px; align-content: start; }
  .ph { margin: 2px 2px 2px; font-size: 26px; letter-spacing: -.02em; }
  h3 { margin: 0 0 10px; font-size: 12px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--rj-text-faint); }
  .card { background: var(--rj-surface); border: 1px solid var(--rj-border); border-radius: var(--rj-radius); padding: 16px 18px; display: grid; gap: 10px; align-content: start; }
  .card.list { padding: 4px 18px; gap: 0; }
  .cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 14px; align-items: start; }
  .hint, .fine { margin: 0; color: var(--rj-text-faint); font-size: 13px; line-height: 1.45; }
  .fine { padding: 0 4px; }
  .row, .nav { display: flex; align-items: center; gap: 14px; padding: 13px 0; border: 0; border-bottom: 1px solid var(--rj-border); background: none; color: inherit; text-align: left; width: 100%; font-size: 15px; }
  .card.list > :last-child { border-bottom: 0; }
  .card > .row { padding: 6px 0; border: 0; }
  .rt { flex: 1; min-width: 0; display: grid; gap: 2px; }
  .rt b { font-weight: 500; }
  .rt small { color: var(--rj-text-faint); font-size: 12.5px; line-height: 1.35; }
  .nav { cursor: pointer; } .nav:hover .rt b { color: var(--rj-accent); }
  .chv { color: var(--rj-text-faint); font-size: 22px; }
  .nav.dng .rt b, .dngb { color: var(--rj-danger); }
  .nav.armed, .dngb.armed { background: color-mix(in srgb, var(--rj-danger) 16%, transparent); }
  .dngb { border: 1px solid color-mix(in srgb, var(--rj-danger) 45%, transparent); background: none; border-radius: 10px; padding: 11px 14px; font-size: 14px; justify-self: start; }
  .sw2 { position: relative; flex: none; width: 46px; height: 28px; border-radius: 99px; border: 0; background: var(--rj-surface-2); box-shadow: inset 0 0 0 1px var(--rj-border); transition: background .18s; padding: 0; }
  .sw2 i { position: absolute; top: 3px; left: 3px; width: 22px; height: 22px; border-radius: 50%; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.4); transition: transform .18s; }
  .sw2[aria-checked=true] { background: var(--rj-accent); }
  .sw2[aria-checked=true] i { transform: translateX(18px); }
  .seg { display: inline-flex; background: var(--rj-surface-2); border-radius: 11px; padding: 3px; gap: 2px; max-width: 100%; }
  .seg.wrapseg { flex-wrap: wrap; display: flex; }
  .seg button { border: 0; background: none; color: var(--rj-text-dim); padding: 8px 14px; border-radius: 8px; font-size: 14px; display: inline-flex; align-items: center; gap: 7px; }
  .seg button.on { background: var(--rj-bg); color: var(--rj-text); box-shadow: 0 0 0 1px var(--rj-border), 0 1px 3px rgba(0,0,0,.35); }
  .seg.sm button { padding: 6px 11px; font-size: 13px; }
  .bd { width: 12px; height: 12px; border-radius: 50%; background: var(--c); box-shadow: 0 0 0 1px var(--rj-border); }
  select { background: var(--rj-surface-2); color: var(--rj-text); border: 1px solid var(--rj-border); border-radius: 9px; padding: 8px 10px; font: inherit; font-size: 14px; }
  input[type=password] { background: var(--rj-surface-2); border: 1px solid var(--rj-border); color: var(--rj-text); border-radius: 10px; padding: 12px 14px; font-size: 15px; }
  input:focus-visible, button:focus-visible, select:focus-visible, a:focus-visible { outline: 2px solid var(--rj-accent); outline-offset: 2px; }
  .primary { background: var(--rj-accent); color: var(--rj-accent-ink); border: 0; border-radius: 10px; padding: 11px 18px; font-weight: 600; font-size: 15px; justify-self: start; }
  .ghost { background: none; border: 1px solid var(--rj-border); color: var(--rj-text); border-radius: 10px; padding: 9px 14px; font-size: 14px; }
  .msg { margin: 0; font-size: 13px; color: var(--rj-danger); } .msg.ok { color: var(--rj-accent); }
  .prof { grid-template-columns: auto 1fr auto; align-items: center; }
  .avatar { width: 46px; height: 46px; border-radius: 50%; display: grid; place-items: center; background: var(--rj-accent); color: var(--rj-accent-ink); font-weight: 700; font-size: 19px; text-transform: uppercase; }
  .name { margin: 0; font-size: 17px; font-weight: 600; }
  .mono { margin: 8px 0 0; font-family: var(--rj-mono); font-size: 12px; color: var(--rj-text-faint); }
  .tiles { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
  .tl { background: none; border: 2px solid transparent; border-radius: 14px; padding: 6px; color: var(--rj-text-dim); display: grid; gap: 8px; }
  .tl.on { border-color: var(--rj-accent); color: var(--rj-text); }
  .pv { position: relative; display: block; aspect-ratio: 4 / 3; border-radius: calc(var(--pr) + 4px); background: var(--pb); overflow: hidden; box-shadow: inset 0 0 0 1px rgba(255,255,255,.1); }
  .pv .pva { position: absolute; left: 10%; top: 14%; width: 26%; height: 14%; border-radius: var(--pr); background: var(--pa); }
  .pv .pvl { position: absolute; left: 10%; top: 40%; width: 80%; height: 11%; border-radius: var(--pr); background: rgba(255,255,255,.14); }
  .pv .pvl.s { top: 58%; width: 55%; }
  .pv b { position: absolute; right: 10%; bottom: 10%; font-size: 15px; color: #fff; }
  .pn { font-size: 13.5px; text-align: center; }
  .lays { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
  .lay { background: none; border: 2px solid transparent; border-radius: 14px; padding: 8px; color: var(--rj-text-dim); display: grid; gap: 8px; justify-items: center; font-size: 13.5px; }
  .lay.on { border-color: var(--rj-accent); color: var(--rj-text); }
  .lp { width: 100%; max-width: 220px; aspect-ratio: 4 / 3; border-radius: 10px; background: var(--rj-surface-2); display: grid; gap: 5px; padding: 9px; box-shadow: inset 0 0 0 1px var(--rj-border); }
  .lp i { background: var(--rj-text-faint); opacity: .55; border-radius: 4px; }
  .lp-list { grid-template-rows: repeat(4, 1fr); }
  .lp-grid { grid-template-columns: repeat(3, 1fr); grid-template-rows: repeat(2, 1fr); } .lp-grid i { border-radius: 30%; } .lp-grid i:nth-child(4) { display: none; }
  .lp-dock { grid-template-columns: repeat(2, 1fr); grid-template-rows: 1fr 1fr 10px; } .lp-dock i:nth-child(3) { grid-column: span 2; grid-row: 3; border-radius: 6px; background: var(--rj-accent); opacity: .8; } .lp-dock i:nth-child(4) { display: none; }
  .subtop { display: flex; align-items: center; gap: 12px; padding: 8px 0; }
  .subtop h2 { margin: 0; font-size: 20px; flex: 1; }
  .back2 { display: inline-flex; align-items: center; gap: 4px; background: var(--rj-surface-2); border: 1px solid var(--rj-border); color: var(--rj-text); border-radius: 99px; padding: 7px 14px 7px 8px; font-size: 14px; }
  .x { background: var(--rj-accent); color: var(--rj-accent-ink); border: 0; border-radius: 99px; padding: 8px 16px; font-weight: 600; font-size: 14px; }
  .foot { display: flex; gap: 10px; justify-content: space-between; }
  .walls { display: grid; grid-template-columns: repeat(auto-fill, minmax(104px, 1fr)); gap: 10px; }
  .wp2 { background: none; border: 2px solid transparent; border-radius: 12px; padding: 4px; color: var(--rj-text-dim); display: grid; gap: 6px; font-size: 12.5px; text-align: center; }
  .wp2.on { border-color: var(--rj-accent); color: var(--rj-text); }
  .wp2 .wc { display: block; position: relative; height: 54px; border-radius: 8px; background-color: var(--rj-surface-2); box-shadow: inset 0 0 0 1px var(--rj-border); }
  .dots { display: flex; gap: 12px; flex-wrap: wrap; }
  .dot { width: 34px; height: 34px; border-radius: 50%; background: var(--c); border: 2px solid transparent; box-shadow: 0 0 0 2px var(--rj-bg) inset; }
  .dot.on { border-color: var(--rj-text); }
  .glr { display: grid; grid-template-columns: auto 1fr auto; gap: 10px; align-items: center; font-size: 13px; color: var(--rj-text-faint); }
  .glr input { accent-color: var(--rj-accent); }
  .urow { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 0; border-top: 1px solid var(--rj-border); }
  .uinfo { display: flex; gap: 10px; align-items: center; } .uname { font-weight: 500; } .ustat { font-size: 12px; color: var(--rj-text-faint); } .ustat.warn { color: #ffc447; }
  .uacts { display: flex; gap: 6px; }
  .mini { background: none; border: 1px solid var(--rj-border); color: var(--rj-text); border-radius: 8px; padding: 6px 11px; font-size: 13px; }
  .mini.yes { background: var(--rj-accent); color: var(--rj-accent-ink); border-color: transparent; } .mini.armed { border-color: var(--rj-danger); color: var(--rj-danger); }
  .keys { display: grid; grid-template-columns: max-content 1fr; gap: 8px 18px; margin: 0; font-size: 14px; }
  .keys dt { font-family: var(--rj-mono); background: var(--rj-surface-2); padding: 2px 8px; border-radius: 6px; justify-self: start; } .keys dd { margin: 0; color: var(--rj-text-dim); }
  @media (max-width: 820px) {
    .shell { grid-template-columns: minmax(0, 1fr); gap: 12px; padding: 0 14px 90px; }
    .snav { position: sticky; top: 0; z-index: 10; display: flex; gap: 6px; overflow-x: auto; padding: 8px 0; background: color-mix(in srgb, var(--rj-bg) 90%, transparent); backdrop-filter: blur(12px); }
    .snav button { flex: none; white-space: nowrap; padding: 8px 14px; border-radius: 99px; background: var(--rj-surface); font-size: 14px; }
    .snav button.on { box-shadow: none; background: var(--rj-accent); color: var(--rj-accent-ink); }
    .tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .cols { grid-template-columns: minmax(0, 1fr); }
    .ph { font-size: 22px; }
    .subtop { top: 50px; }
  }
</style>
