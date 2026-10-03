<script>
  import '../../tokens.css';
  import { onMount, tick } from 'svelte';
  import { api } from '../../lib/api.js';

  const B = '/api/banter/';
  let me = $state(''), rooms = $state([]), friends = $state([]), incoming = $state([]), outgoing = $state([]);
  let loaded = $state(false), err = $state('');
  let cur = $state(null);
  let msgs = $state([]), lastId = 0, listEl, composer = $state('');
  let sheet = $state(''), sheetErr = $state('');
  let draftName = $state(''), draftCode = $state(''), addName = $state('');
  let members = $state([]), person = $state('');
  let gifQ = $state(''), gifs = $state([]), pollQ = $state(''), pollOpts = $state(['', '']);
  let tab = $state('chats');
  let sending = false;
  let replyTo = $state(null), selMsg = $state(0), pollN = 0;

  const call = (path, body) => api(B + path, body ? { method: 'POST', body } : {});
  const initial = (s) => (s || '?').trim().slice(0, 1).toUpperCase();
  const hue = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
  const ago = (t) => {
    if (!t) return '';
    const d = (Date.now() - t) / 1000;
    if (d < 60) return 'now';
    if (d < 3600) return Math.floor(d / 60) + 'm';
    if (d < 86400) return Math.floor(d / 3600) + 'h';
    return Math.floor(d / 86400) + 'd';
  };
  const clock = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const totalUnread = $derived(rooms.reduce((a, r) => a + (r.unread || 0), 0));
  const sorted = $derived([...rooms].sort((a, b) => b.last - a.last));
  const groups = $derived(sorted.filter((r) => r.kind === 'group'));
  const dms = $derived(sorted.filter((r) => r.kind === 'dm'));
  const relOf = (n) => (friends.includes(n) ? 'friends' : incoming.includes(n) ? 'incoming' : outgoing.includes(n) ? 'sent' : 'none');
  const proxied = (u) => B + 'gifimg?u=' + encodeURIComponent(u);

  async function loadState() {
    const r = await call('state');
    if (!r.ok) { err = (r.data && r.data.error) || 'could not load'; loaded = true; return; }
    const d = r.data;
    me = d.me; rooms = d.rooms; friends = d.friends; incoming = d.incoming; outgoing = d.outgoing;
    if (cur) { const f = rooms.find((x) => x.id === cur.id); if (f) cur = f; else cur = null; }
    loaded = true;
  }
  async function openRoom(r) {
    cur = r; msgs = []; lastId = 0; sheet = ''; replyTo = null; selMsg = 0; readSent = 0;
    history.replaceState(null, '', '#' + r.id);
    await pull(true);
  }
  function closeRoom() { cur = null; msgs = []; history.replaceState(null, '', location.pathname); loadState(); }
  async function pull(scroll) {
    if (!cur) return;
    const id = cur.id;
    const r = await call('msgs?room=' + id + '&after=' + lastId);
    if (!r.ok || !cur || cur.id !== id) return;
    if (r.data.msgs.length) {
      const stick = !listEl || listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 140;
      msgs = [...msgs, ...r.data.msgs];
      lastId = msgs[msgs.length - 1].id;
      markRead();
      if (scroll || stick) { await tick(); if (listEl) listEl.scrollTop = listEl.scrollHeight; }
    }
  }
  let readSent = 0;
  function markRead() {
    if (!cur || !msgs.length) return;
    const top = msgs[msgs.length - 1].id;
    if (top <= readSent && cur.unread === 0) return;
    readSent = top;
    call('read', { room: cur.id, upto: top });
    rooms = rooms.map((r) => (r.id === cur.id ? { ...r, unread: 0 } : r));
    cur = { ...cur, unread: 0 };
  }
  async function reloadAll() {
    const r = await call('msgs?room=' + cur.id + '&after=0');
    if (r.ok) { msgs = r.data.msgs; if (msgs.length) lastId = msgs[msgs.length - 1].id; }
  }
  function flash(t) { err = t; setTimeout(() => { if (err === t) err = ''; }, 3500); }
  async function post(body) {
    if (!cur || sending) return false;
    sending = true;
    const r = await call('msg', { room: cur.id, ...(replyTo ? { reply: replyTo.id } : {}), ...body });
    sending = false;
    if (!r.ok) { flash((r.data && r.data.error) || 'did not send'); return false; }
    replyTo = null;
    await pull(true);
    return true;
  }

  let selRect = $state(null);
  const selM = $derived(selMsg ? msgs.find((x) => x.id === selMsg) : null);
  $effect(() => {
    const id = selMsg;
    if (!id) { selRect = null; return; }
    tick().then(() => {
      const el = document.querySelector('[data-mid="' + id + '"] .bub, [data-mid="' + id + '"] .img');
      const r = el ? el.getBoundingClientRect() : null;
      selRect = r ? { top: r.top, left: r.left, right: r.right, bottom: r.bottom, width: r.width, height: r.height } : { top: 200, left: 24, right: 224, bottom: 260, width: 200, height: 60 };
    });
  });
  function ovPos() {
    const r = selRect; if (!r) return '';
    const vw = window.innerWidth, vh = window.innerHeight;
    const mine = selM && selM.from === me;
    const menuH = 4 + (selM && selM.type === 'text' ? 46 : 0) * 1 + 46 + (selM && selM.from === me && selM.type !== 'invite' ? 46 : 0) + (selM && selM.type === 'text' ? 46 : 0);
    // preview keeps its place unless the stack would leave the screen
    let top = r.top, h = Math.min(r.height, vh * 0.4);
    const need = 56 + 10 + h + 10 + menuH + 12;
    let shift = 0;
    if (top - 66 < 12) shift = 12 + 66 - top;
    if (top + shift + h + 10 + menuH + 12 > vh) shift = Math.min(shift, 0) - ((top + shift + h + 10 + menuH + 12) - vh);
    if (top + shift - 66 < 12) shift = 12 + 66 - top;
    top = top + shift;
    const w = Math.min(r.width, vw - 24);
    const left = mine ? Math.max(12, r.right - w) : Math.min(r.left, vw - 12 - w);
    const mw = 220, mleft = mine ? Math.min(vw - 12 - mw, Math.max(12, r.right - mw)) : Math.max(12, Math.min(r.left, vw - 12 - mw));
    const ew = 6 * 42 + 16, eleft = mine ? Math.max(12, Math.min(vw - 12 - ew, r.right - ew)) : Math.max(12, Math.min(r.left, vw - 12 - ew));
    return `--pt:${top}px;--ph:${h}px;--pl:${left}px;--pw:${w}px;--mt:${top + h + 10}px;--ml:${mleft}px;--et:${top - 56 - 10}px;--el:${eleft}px;`;
  }
  async function copyMsg(m) { try { await navigator.clipboard.writeText(m.text || ''); flash('copied'); } catch { flash('could not copy'); } selMsg = 0; }
  function ovKey(e) { if (e.key === 'Escape' && selMsg) selMsg = 0; }
  let editing = $state(null);
  function startEdit(m) { editing = { id: m.id }; replyTo = null; composer = m.text; selMsg = 0; tick().then(() => { const t = document.querySelector('.composer textarea'); if (t) { t.focus(); t.setSelectionRange(t.value.length, t.value.length); } }); }
  let lpT = 0, lpFired = false;
  const lpStart = (m) => { lpFired = false; clearTimeout(lpT); lpT = setTimeout(() => { lpFired = true; selMsg = m.id; try { navigator.vibrate?.(8); } catch {} }, 420); };
  const lpEnd = () => clearTimeout(lpT);
  const tapSel = (m) => { if (lpFired) { lpFired = false; return; } selMsg = selMsg === m.id ? 0 : m.id; };
  async function sendText() {
    const t = composer.trim();
    if (!t) return;
    if (editing) {
      const e = editing; editing = null; composer = '';
      const r = await call('editmsg', { room: cur.id, msg: e.id, text: t });
      if (!r.ok) { flash((r.data && r.data.error) || 'could not edit'); composer = t; return; }
      await reloadAll(); return;
    }
    composer = '';
    if (!(await post({ type: 'text', text: t }))) composer = t;
  }
  function onKey(e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendText(); } }

  async function pickPhoto(e) {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    const bmp = await createImageBitmap(f).catch(() => null);
    if (!bmp) { flash('could not read that image'); return; }
    let scale = Math.min(1, 1280 / Math.max(bmp.width, bmp.height)), q = 0.8, data = '';
    for (let i = 0; i < 7; i++) {
      const c = document.createElement('canvas');
      c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      data = c.toDataURL('image/webp', q).split(',')[1];
      if (data.length * 0.75 < 430 * 1024) break;
      scale *= 0.8; q = Math.max(0.5, q - 0.08);
    }
    if (data.length * 0.75 >= 440 * 1024) { flash('image too big'); return; }
    await post({ type: 'image', data });
  }
  let gifTimer;
  function gifInput() {
    clearTimeout(gifTimer);
    gifTimer = setTimeout(async () => {
      if (!gifQ.trim()) { gifs = []; return; }
      const r = await call('gifsearch?q=' + encodeURIComponent(gifQ.trim()));
      gifs = r.ok ? r.data.gifs : [];
      if (!r.ok) sheetErr = (r.data && r.data.error) || 'gif search failed';
    }, 350);
  }
  async function sendGif(g) { sheet = ''; await post({ type: 'gif', url: g.full }); }
  async function sendPoll() {
    const opts = pollOpts.map((o) => o.trim()).filter(Boolean);
    if (!pollQ.trim() || opts.length < 2) { sheetErr = 'a question and two options'; return; }
    sheet = '';
    await post({ type: 'poll', question: pollQ.trim(), options: opts });
    pollQ = ''; pollOpts = ['', ''];
  }
  const EMOJI = ['\u2764\ufe0f', '\ud83d\ude02', '\ud83d\udc4d', '\ud83d\ude2e', '\ud83d\ude22', '\ud83d\udd25'];
  async function react(m, e) {
    selMsg = 0;
    const r = await call('react', { room: cur.id, msg: m.id, emoji: e });
    if (!r.ok) { flash((r.data && r.data.error) || 'could not react'); return; }
    await reloadAll();
  }
  async function delMsg(m) {
    if (!confirm('delete this message for everyone?')) return;
    selMsg = 0;
    const r = await call('delmsg', { room: cur.id, msg: m.id });
    if (!r.ok) { flash((r.data && r.data.error) || 'could not delete'); return; }
    await reloadAll();
  }
  function startReply(m) {
    replyTo = { id: m.id, from: m.from, text: m.type === 'text' ? m.text : m.type === 'image' ? 'photo' : m.type === 'gif' ? 'gif' : m.type === 'poll' ? 'poll' : '' };
    selMsg = 0;
    tick().then(() => document.querySelector('.composer textarea')?.focus());
  }
  async function vote(m, i) { await call('vote', { room: cur.id, msg: m.id, option: i }); await reloadAll(); }

  async function createGroup() {
    if (!draftName.trim()) return;
    const r = await call('group', { name: draftName.trim() });
    if (!r.ok) { sheetErr = (r.data && r.data.error) || 'failed'; return; }
    draftName = ''; sheetErr = ''; tab = 'chats';
    await loadState(); openRoom(r.data.room);
  }
  async function joinGroup(code) {
    const c = (code || draftCode).trim();
    if (!c) return;
    const r = await call('join', { code: c });
    if (!r.ok) { sheetErr = (r.data && r.data.error) || 'no group with that code'; return; }
    draftCode = ''; sheetErr = ''; tab = 'chats';
    await loadState(); openRoom(r.data.room);
  }
  function showPerson(n) { if (n === me) return; person = n; sheet = 'person'; sheetErr = ''; }
  async function rel(action) {
    const r = await call(action, { user: person });
    if (!r.ok) { sheetErr = (r.data && r.data.error) || 'failed'; return; }
    sheetErr = ''; await loadState();
  }
  async function addFriend() {
    const n = addName.trim();
    if (!n) return;
    const isCode = /^[A-Za-z0-9]{8}$/.test(n) && n === n.toUpperCase() && /\d|[A-F]/.test(n) && !friends.includes(n.toLowerCase());
    const r = await call('friend', isCode ? { code: n } : { user: n.toLowerCase() });
    if (!r.ok) { flash((r.data && r.data.error) || 'could not add'); return; }
    addName = ''; flash('request sent - they have to accept before you can message'); await loadState();
  }
  let myCode = $state('');
  async function showCode() { const r = await call('mycode'); if (r.ok) myCode = r.data.code; }
  async function resetCode() { const r = await call('mycode', { reset: true }); if (r.ok) myCode = r.data.code; }
  async function cancelReq(n) { await call('cancel', { user: n }); loadState(); }
  async function openDm(n) {
    const r = await call('dm', { user: n });
    if (!r.ok) { sheetErr = (r.data && r.data.error) || 'add them first'; return; }
    await loadState(); tab = 'dms'; openRoom(r.data.room);
  }
  async function showGroup() {
    const r = await call('members?room=' + cur.id);
    if (r.ok) members = r.data.members;
    sheet = 'group'; sheetErr = '';
  }
  async function leaveGroup() {
    if (!confirm('leave ' + cur.title + '?')) return;
    await call('leave', { room: cur.id }); sheet = ''; closeRoom();
  }
  async function delRoom() {
    if (!confirm('delete ' + cur.title + ' for everyone?')) return;
    await call('delete', { room: cur.id }); sheet = ''; closeRoom();
  }
  async function inviteTo(n) {
    const r = await call('invite', { room: cur.id, user: n });
    sheetErr = r.ok ? 'invite sent to ' + n : (r.data && r.data.error) || 'failed';
  }

  onMount(() => {
    loadState().then(() => {
      const r = rooms.find((x) => x.id === location.hash.slice(1));
      if (r) openRoom(r);
    });
    const t = setInterval(() => { if (cur) { pull(false); if (++pollN % 3 === 0) reloadAll(); } else if (loaded) loadState(); }, 3000);
    return () => clearInterval(t);
  });
</script>

<svelte:window onkeydown={ovKey} />
<svelte:head><title>{totalUnread ? '(' + totalUnread + ') ' : ''}banter - ramjet</title></svelte:head>

<div class="app" class:inchat={cur}>
  <aside class="side">
    <header class="top">
      <a class="back" href="/" aria-label="back to ramjet"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg></a>
      <span class="brand">banter</span>
      <button class="pill" onclick={() => { sheet = 'new'; sheetErr = ''; }}>new</button>
    </header>
    {#if !loaded}
      <p class="hint">loading</p>
    {:else}
      <nav class="tabs">
        <button class:on={tab === 'chats'} onclick={() => (tab = 'chats')}>groups{#if groups.reduce((a, r) => a + (r.unread || 0), 0)}<i class="badge">{groups.reduce((a, r) => a + (r.unread || 0), 0)}</i>{/if}</button>
        <button class:on={tab === 'dms'} onclick={() => (tab = 'dms')}>messages{#if dms.reduce((a, r) => a + (r.unread || 0), 0)}<i class="badge">{dms.reduce((a, r) => a + (r.unread || 0), 0)}</i>{/if}</button>
        <button class:on={tab === 'people'} onclick={() => (tab = 'people')}>people{#if incoming.length}<i class="badge">{incoming.length}</i>{/if}</button>
      </nav>
      <div class="rows">
        {#if tab !== 'people'}
          {#each tab === 'chats' ? groups : dms as r (r.id)}
            <button class="row" class:active={cur && cur.id === r.id} onclick={() => openRoom(r)}>
              <span class="av" style="--h:{hue(r.title)}">{r.emoji || initial(r.title)}</span>
              <span class="rtx"><span class="rn" class:unr={r.unread > 0}>{r.title}</span>{#if r.preview}<span class="rp" class:unr={r.unread > 0}>{r.preview}</span>{/if}</span>
              <span class="rt">{ago(r.last)}</span>
              {#if r.unread > 0}<i class="badge un">{r.unread > 99 ? '99+' : r.unread}</i>{/if}
            </button>
          {:else}
            <p class="hint">{tab === 'chats' ? 'no groups yet. make one, or join with a code' : 'no messages yet. add a friend in people'}</p>
          {/each}
        {:else}
          <div class="addrow">
            <input class="field" placeholder="username or friend code" bind:value={addName} onkeydown={(e) => e.key === 'Enter' && addFriend()} />
            <button class="mini" onclick={addFriend}>add</button>
          </div>
          {#each incoming as n}
            <div class="row static"><span class="av" style="--h:{hue(n)}">{initial(n)}</span><span class="rn">{n} wants to be friends</span><button class="mini" onclick={async () => { await call('accept', { user: n }); loadState(); }}>accept</button><button class="mini alt" onclick={async () => { await call('decline', { user: n }); loadState(); }}>decline</button></div>
          {/each}
          {#each friends as n}
            <button class="row" onclick={() => showPerson(n)}><span class="av" style="--h:{hue(n)}">{initial(n)}</span><span class="rn">{n}</span></button>
          {/each}
          {#each outgoing as n}
            <div class="row static"><span class="av" style="--h:{hue(n)}">{initial(n)}</span><span class="rn dim">{n} (requested)</span><button class="mini alt" onclick={() => cancelReq(n)}>cancel</button></div>
          {/each}
          {#if !friends.length && !incoming.length && !outgoing.length}<p class="hint">add someone by their username or friend code. they have to accept before anyone can message</p>{/if}
          <div class="mycode">
            {#if myCode}<p class="hint">your friend code: <b class="code">{myCode}</b></p><button class="mini alt" onclick={resetCode}>new code</button>
            {:else}<button class="mini alt" onclick={showCode}>show my friend code</button>{/if}
          </div>
        {/if}
      </div>
    {/if}
  </aside>

  <section class="chat">
    {#if cur}
      <header class="top">
        <button class="back" onclick={closeRoom} aria-label="back to chats"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg></button>
        <span class="av sm" style="--h:{hue(cur.title)}">{cur.emoji || initial(cur.title)}</span>
        <span class="brand">{cur.title}</span>
        {#if cur.kind === 'group'}<button class="pill" onclick={showGroup}>group</button>{/if}
      </header>
      <div class="list" bind:this={listEl}>
        {#each msgs as m, k (m.id)}
          {@const mine = m.from === me}
          {@const first = k === 0 || msgs[k - 1].from !== m.from || msgs[k - 1].type === 'note'}
          {#if m.type === 'note'}
            <p class="note">{m.text}</p>
          {:else}
          <div class="m" class:mine class:first class:sel={selMsg === m.id} data-mid={m.id}>
            {#if first && !mine && cur.kind === 'group'}<button class="who" onclick={() => showPerson(m.from)}>{m.from}</button>{/if}
            {#if m.type === 'deleted'}
              <div class="bub gone">message deleted</div>
            {:else if m.type === 'text'}
              {#if m.reply}<button class="quote" onclick={() => document.querySelector('[data-mid="' + m.reply.id + '"]')?.scrollIntoView({ block: 'center', behavior: 'smooth' })}><b>{m.reply.from === me ? 'you' : m.reply.from}</b> {m.reply.text}</button>{/if}
              <div class="bub" role="presentation" onclick={() => tapSel(m)} ontouchstart={() => lpStart(m)} ontouchend={lpEnd} ontouchmove={lpEnd} oncontextmenu={(e) => { e.preventDefault(); selMsg = m.id; }}>{m.text}</div>
              {#if m.edited}<span class="edt">edited</span>{/if}
            {:else if m.type === 'image'}
              <img class="img" role="presentation" onclick={() => tapSel(m)} ontouchstart={() => lpStart(m)} ontouchend={lpEnd} ontouchmove={lpEnd} oncontextmenu={(e) => { e.preventDefault(); selMsg = m.id; }} src={B + 'media?id=' + m.media} alt="" loading="lazy" />
            {:else if m.type === 'gif'}
              <img class="img" role="presentation" onclick={() => tapSel(m)} ontouchstart={() => lpStart(m)} ontouchend={lpEnd} ontouchmove={lpEnd} oncontextmenu={(e) => { e.preventDefault(); selMsg = m.id; }} src={proxied(m.url)} alt="gif" loading="lazy" />
            {:else if m.type === 'poll'}
              {@const total = Object.keys(m.votes || {}).length}
              <div class="poll">
                <p class="pq">{m.question}</p>
                {#each m.options as o, oi}
                  {@const n = Object.values(m.votes || {}).filter((v) => v === oi).length}
                  <button class="po" class:picked={(m.votes || {})[me] === oi} onclick={() => vote(m, oi)}>
                    <span class="bar" style="width:{total ? (n / total) * 100 : 0}%"></span>
                    <span class="pt">{o}</span><span class="pn">{n}</span>
                  </button>
                {/each}
              </div>
            {:else if m.type === 'invite'}
              <div class="poll">
                <p class="pq">{mine ? 'you invited them to' : m.from + ' invited you to'} {m.group}</p>
                {#if !mine}<button class="go sm" onclick={() => joinGroup(m.code)}>join</button>{/if}
              </div>
            {/if}
            {#if m.reacts}
              <span class="rxs">{#each Object.entries(m.reacts) as [e, who]}<button class="rx" class:mine={who.includes(me)} onclick={() => react(m, e)} aria-label="{e} {who.length}">{e}<b>{who.length}</b></button>{/each}</span>
            {/if}
            {#if selMsg !== m.id && m.type !== 'deleted' && m.type !== 'invite'}<span class="hov">
              <button onclick={() => startReply(m)} aria-label="reply">reply</button>
              {#if mine && m.type === 'text'}<button onclick={() => startEdit(m)} aria-label="edit">edit</button>{/if}
              {#if mine}<button class="dng" onclick={() => delMsg(m)} aria-label="delete">delete</button>{/if}
              <button onclick={() => (selMsg = m.id)} aria-label="react">&#9786;</button>
            </span>{/if}
            <span class="ts">{clock(m.ts)}</span>
          </div>
          {/if}
        {:else}
          <p class="hint mid">say something</p>
        {/each}
      </div>
      {#if selM && selRect && selM.type !== 'deleted'}
        <div class="ov" style={ovPos()} role="dialog" aria-label="message actions">
          <button class="ov-bd" aria-label="close" onclick={() => (selMsg = 0)}></button>
          <div class="ov-emo">{#each EMOJI as e}<button onclick={() => react(selM, e)} aria-label="react {e}" class:on={selM.reacts?.[e]?.includes(me)}>{e}</button>{/each}</div>
          <div class="ov-prev" class:mine={selM.from === me}>
            {#if selM.type === 'text'}<div class="bub">{selM.text}</div>
            {:else if selM.type === 'image'}<img class="img" src={B + 'media?id=' + selM.media} alt="" />
            {:else if selM.type === 'gif'}<img class="img" src={proxied(selM.url)} alt="gif" />
            {:else}<div class="bub">{selM.question || selM.group || 'message'}</div>{/if}
          </div>
          <div class="ov-menu">
            <button onclick={() => startReply(selM)}><span>reply</span><svg viewBox="0 0 24 24"><path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 6 6v3"/></svg></button>
            {#if selM.type === 'text'}<button onclick={() => copyMsg(selM)}><span>copy</span><svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg></button>{/if}
            {#if selM.from === me && selM.type === 'text'}<button onclick={() => startEdit(selM)}><span>edit</span><svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg></button>{/if}
            {#if selM.from === me && selM.type !== 'invite'}<button class="dng" onclick={() => delMsg(selM)}><span>delete</span><svg viewBox="0 0 24 24"><path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/></svg></button>{/if}
          </div>
        </div>
      {/if}
      {#if err}<p class="bad bar-err">{err}</p>{/if}
      {#if editing}<div class="replychip"><span>editing your message</span><button aria-label="cancel edit" onclick={() => { editing = null; composer = ''; }}>&times;</button></div>{/if}
      {#if replyTo}<div class="replychip"><span>replying to <b>{replyTo.from === me ? 'yourself' : replyTo.from}</b>{replyTo.text ? ': ' + replyTo.text.slice(0, 50) : ''}</span><button aria-label="cancel reply" onclick={() => (replyTo = null)}>&times;</button></div>{/if}
      <div class="composer">
        <label class="ic" aria-label="photo"><input type="file" accept="image/*" hidden onchange={pickPhoto} /><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="1.6"/><path d="M21 16l-5-5-8 9"/></svg></label>
        <button class="ic" aria-label="gif" onclick={() => { sheet = 'gif'; gifQ = ''; gifs = []; sheetErr = ''; }}>gif</button>
        <button class="ic" aria-label="poll" onclick={() => { sheet = 'poll'; sheetErr = ''; }}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 20V10M12 20V4M19 20v-7"/></svg></button>
        <textarea rows="1" placeholder="message" bind:value={composer} onkeydown={onKey}></textarea>
        <button class="send" onclick={sendText} disabled={!composer.trim()} aria-label="send"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg></button>
      </div>
    {:else}
      <div class="none"><p class="big">pick a chat</p><p class="hint">or start one with new</p></div>
    {/if}
  </section>
</div>

{#if sheet}
  <div class="overlay" onclick={() => (sheet = '')}>
    <div class="sheet" onclick={(e) => e.stopPropagation()}>
      {#if sheet === 'new'}
        <p class="sh">new group</p>
        <input class="field" placeholder="group name" maxlength="40" bind:value={draftName} onkeydown={(e) => e.key === 'Enter' && createGroup()} />
        <button class="go" onclick={createGroup}>make it</button>
        <p class="sh">join with a code</p>
        <input class="field" placeholder="code" bind:value={draftCode} onkeydown={(e) => e.key === 'Enter' && joinGroup()} />
        <button class="go alt" onclick={() => joinGroup()}>join</button>
      {:else if sheet === 'group'}
        <p class="sh">{cur.title}</p>
        {#if cur.code}<p class="code">invite code <b>{cur.code}</b></p>{/if}
        {#each members as mb}
          <button class="row" onclick={() => showPerson(mb.name)}><span class="av sm" style="--h:{hue(mb.name)}">{initial(mb.name)}</span><span class="rn">{mb.name}{mb.owner ? ' (owner)' : ''}</span></button>
        {/each}
        {#if friends.filter((f) => !members.find((mb) => mb.name === f)).length}
          <p class="sh">invite a friend</p>
          {#each friends.filter((f) => !members.find((mb) => mb.name === f)) as f}
            <div class="row static"><span class="av sm" style="--h:{hue(f)}">{initial(f)}</span><span class="rn">{f}</span><button class="mini" onclick={() => inviteTo(f)}>invite</button></div>
          {/each}
        {/if}
        {#if cur.owner}<button class="go danger" onclick={delRoom}>delete group</button>{:else}<button class="go danger" onclick={leaveGroup}>leave group</button>{/if}
      {:else if sheet === 'person'}
        <p class="sh">{person}</p>
        {#if relOf(person) === 'friends'}<button class="go" onclick={() => openDm(person)}>message</button><button class="go alt" onclick={() => rel('unfriend')}>unfriend</button>
        {:else if relOf(person) === 'incoming'}<button class="go" onclick={() => rel('accept')}>accept request</button><button class="go alt" onclick={() => rel('decline')}>decline</button>
        {:else if relOf(person) === 'sent'}<p class="hint">request sent</p>
        {:else}<button class="go" onclick={() => rel('friend')}>add friend</button>{/if}
      {:else if sheet === 'gif'}
        <input class="field" placeholder="search gifs" bind:value={gifQ} oninput={gifInput} />
        <div class="gifs">{#each gifs as g}<button class="gif" onclick={() => sendGif(g)}><img src={proxied(g.tiny)} alt="" /></button>{/each}</div>
      {:else if sheet === 'poll'}
        <p class="sh">new poll</p>
        <input class="field" placeholder="question" maxlength="120" bind:value={pollQ} />
        {#each pollOpts as _, i}<input class="field" placeholder="option {i + 1}" maxlength="40" bind:value={pollOpts[i]} />{/each}
        {#if pollOpts.length < 6}<button class="mini" onclick={() => (pollOpts = [...pollOpts, ''])}>+ option</button>{/if}
        <button class="go" onclick={sendPoll}>post poll</button>
      {/if}
      {#if sheetErr}<p class="bad">{sheetErr}</p>{/if}
    </div>
  </div>
{/if}

<style>
  .app { display: grid; grid-template-columns: 340px minmax(0, 1fr); height: 100dvh; width: 100%; overflow: hidden; }
  .side, .chat { display: flex; flex-direction: column; min-height: 0; min-width: 0; background: var(--rj-bg); }
  .side { border-right: 1px solid var(--rj-border); }
  .top { display: flex; align-items: center; gap: 10px; padding: calc(10px + env(safe-area-inset-top)) 14px 10px; border-bottom: 1px solid var(--rj-border); }
  .brand { font-weight: 700; font-size: 17px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .back { width: 34px; height: 34px; border-radius: 50%; display: grid; place-items: center; background: none; border: 0; color: var(--rj-text); }
  .back svg { width: 20px; height: 20px; }
  .pill { background: var(--rj-accent); color: var(--rj-accent-ink); border: 0; border-radius: var(--rj-pill); padding: 7px 16px; font-weight: 700; font-size: 14px; }
  .tabs { display: flex; gap: 6px; padding: 10px 14px 4px; }
  .tabs button { background: var(--rj-surface); color: var(--rj-text-dim); border: 0; border-radius: var(--rj-pill); padding: 7px 14px; font-size: 13.5px; }
  .tabs button.on { background: var(--rj-text); color: #000; font-weight: 600; }
  .rtx { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .rtx .rn { flex: none; }
  .rp { font-size: 13px; color: var(--rj-text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rn.unr, .rp.unr { color: var(--rj-text); font-weight: 700; }
  .badge.un { margin-left: 0; }
  .bub.gone { background: none; border: 1px dashed var(--rj-border); color: var(--rj-text-dim); font-style: italic; font-size: 14px; }
  .quote { display: block; max-width: 100%; text-align: left; border: 0; border-left: 3px solid var(--rj-accent); background: var(--rj-surface-2, var(--rj-surface)); color: var(--rj-text-dim); border-radius: 8px; padding: 5px 10px; margin-bottom: 3px; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .quote b { color: var(--rj-text); font-weight: 600; }
  .mycode { display: flex; align-items: center; gap: 10px; padding: 14px 8px; flex-wrap: wrap; }
  .mycode .hint { margin: 0; padding: 0; }
  .code { font-family: ui-monospace, monospace; letter-spacing: 2px; color: var(--rj-accent); user-select: all; }
  .mini.alt { background: none; border: 1px solid var(--rj-border); color: var(--rj-text); }
  .rxs { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 3px; }
  .rx { display: inline-flex; align-items: center; gap: 4px; height: 26px; padding: 0 9px; border: 1px solid var(--rj-border); border-radius: var(--rj-pill); background: var(--rj-surface); color: var(--rj-text); font-size: 14px; }
  .rx b { font-size: 12px; font-weight: 600; color: var(--rj-text-dim); }
  .rx.mine { border-color: var(--rj-accent); }
  .emo { display: flex; gap: 2px; margin-top: 4px; padding: 3px 6px; background: var(--rj-surface); border: 1px solid var(--rj-border); border-radius: var(--rj-pill); }
  .emo button { width: 36px; height: 36px; border: 0; background: none; font-size: 20px; border-radius: 50%; }
  .macts { display: flex; gap: 6px; margin-top: 3px; }
  .macts button { height: 28px; padding: 0 12px; border: 1px solid var(--rj-border); border-radius: var(--rj-pill); background: none; color: var(--rj-text); font-size: 12px; font-weight: 600; }
  .macts .dng { color: #ff6b6b; }
  .replychip { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 0 10px; padding: 6px 12px; border-left: 3px solid var(--rj-accent); background: var(--rj-surface); border-radius: 8px; font-size: 13px; color: var(--rj-text-dim); }
  .replychip span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .replychip b { color: var(--rj-text); }
  .replychip button { border: 0; background: none; color: var(--rj-text-dim); font-size: 20px; line-height: 1; }
  .badge { font-style: normal; background: var(--rj-accent); color: var(--rj-accent-ink); border-radius: 9px; padding: 0 6px; margin-left: 6px; font-size: 11px; font-weight: 700; }
  .rows { flex: 1; overflow-y: auto; padding: 6px 8px calc(14px + env(safe-area-inset-bottom)); }
  .row { display: flex; align-items: center; gap: 12px; width: 100%; padding: 10px 8px; border: 0; border-radius: 14px; background: none; color: var(--rj-text); text-align: left; }
  .row:hover, .row.active { background: var(--rj-hover); }
  .row.active { background: var(--rj-surface); }
  .row.static { cursor: default; }
  .rn { flex: 1; font-size: 15.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rt { color: var(--rj-text-faint); font-size: 12px; }
  .av { width: 44px; height: 44px; border-radius: 50%; display: grid; place-items: center; font-weight: 700; font-size: 18px; color: #fff; background: hsl(var(--h) 38% 32%); flex: none; }
  .av.sm { width: 32px; height: 32px; font-size: 14px; }
  .hint { color: var(--rj-text-faint); font-size: 14px; padding: 18px 14px; margin: 0; }
  .hint.mid { text-align: center; padding-top: 40px; }
  .gate { padding: 28px 18px; display: flex; flex-direction: column; gap: 12px; }
  .big { font-size: 22px; font-weight: 700; margin: 0; }
  .field { background: var(--rj-surface); border: 1px solid var(--rj-border); color: var(--rj-text); border-radius: 14px; padding: 13px 14px; font-size: 16px; width: 100%; outline: none; }
  .field:focus { border-color: color-mix(in srgb, var(--rj-accent) 50%, transparent); }
  .go { background: var(--rj-accent); color: var(--rj-accent-ink); border: 0; border-radius: var(--rj-pill); padding: 13px; font-weight: 700; font-size: 15px; width: 100%; }
  .go.alt { background: var(--rj-surface-2); color: var(--rj-text); }
  .go.danger { background: none; color: var(--rj-danger); border: 1px solid var(--rj-border); }
  .go.sm { width: auto; padding: 8px 20px; }
  .mini { background: var(--rj-surface-2); color: var(--rj-text); border: 0; border-radius: var(--rj-pill); padding: 6px 14px; font-size: 13px; }
  .bad { color: var(--rj-danger); font-size: 13.5px; margin: 4px 0; }
  .bar-err { padding: 0 16px; }

  .list { flex: 1; overflow-y: auto; padding: 14px 14px 6px; display: flex; flex-direction: column; gap: 3px; }
  .m { display: flex; flex-direction: column; align-items: flex-start; max-width: 82%; }
  .m.first { margin-top: 10px; }
  .m.mine { align-self: flex-end; align-items: flex-end; }
  .who { background: none; border: 0; color: var(--rj-text-faint); font-size: 12px; padding: 0 4px 3px; }
  .bub { background: var(--rj-surface); border-radius: 18px; padding: 9px 14px; font-size: 15.5px; line-height: 1.4; white-space: pre-wrap; overflow-wrap: anywhere; }
  .m.mine .bub { background: var(--rj-accent); color: var(--rj-accent-ink); }
  .img { max-width: min(260px, 100%); border-radius: 16px; display: block; }
  .ts { font-size: 10.5px; color: var(--rj-text-faint); padding: 2px 6px 0; opacity: 0; height: 0; overflow: hidden; transition: opacity 0.15s; }
  .m:hover .ts { opacity: 1; height: auto; }
  .poll { background: var(--rj-surface); border-radius: 18px; padding: 12px; min-width: 230px; display: flex; flex-direction: column; gap: 6px; }
  .pq { margin: 0 0 4px; font-weight: 600; }
  .po { position: relative; overflow: hidden; display: flex; justify-content: space-between; border: 1px solid var(--rj-border); background: var(--rj-surface-2); color: var(--rj-text); border-radius: 12px; padding: 9px 12px; font-size: 14.5px; }
  .po.picked { border-color: var(--rj-accent); }
  .bar { position: absolute; inset: 0 auto 0 0; background: color-mix(in srgb, var(--rj-accent) 18%, transparent); }
  .pt, .pn { position: relative; }
  .composer { display: flex; align-items: flex-end; gap: 8px; padding: 8px 12px calc(10px + env(safe-area-inset-bottom)); border-top: 1px solid var(--rj-border); }
  .composer textarea { flex: 1; min-width: 0; resize: none; background: var(--rj-surface); border: 0; color: var(--rj-text); border-radius: 20px; padding: 11px 15px; font: inherit; font-size: 16px; max-height: 120px; outline: none; }
  .ic { width: 38px; height: 38px; border-radius: 50%; border: 0; background: none; color: var(--rj-text-dim); display: grid; place-items: center; font-size: 13px; font-weight: 700; flex: none; cursor: pointer; }
  .ic svg { width: 22px; height: 22px; }
  .send { width: 40px; height: 40px; border-radius: 50%; border: 0; background: var(--rj-accent); color: var(--rj-accent-ink); display: grid; place-items: center; flex: none; }
  .send:disabled { opacity: 0.3; }
  .send svg { width: 20px; height: 20px; }
  .none { margin: auto; text-align: center; }
  .none .hint { padding-top: 6px; }

  .overlay { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.6); display: flex; align-items: flex-end; justify-content: center; z-index: 10; }
  .sheet { background: var(--rj-surface); width: min(480px, 100%); max-height: 80dvh; overflow-y: auto; border-radius: 22px 22px 0 0; padding: 18px 16px calc(20px + env(safe-area-inset-bottom)); display: flex; flex-direction: column; gap: 10px; }
  @media (min-width: 700px) { .overlay { align-items: center; } .sheet { border-radius: 22px; } }
  .sh { margin: 6px 0 0; font-weight: 700; font-size: 17px; }
  .code { margin: 0; color: var(--rj-text-dim); } .code b { color: var(--rj-accent); font-family: var(--rj-mono); font-size: 17px; }
  .bio { margin: 0; color: var(--rj-text-dim); }
  .gifs { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
  .gif { padding: 0; border: 0; border-radius: 10px; overflow: hidden; background: var(--rj-surface-2); aspect-ratio: 1; }
  .gif img { width: 100%; height: 100%; object-fit: cover; display: block; }

  @media (max-width: 699px) {
    .app { grid-template-columns: minmax(0, 1fr); }
    .app.inchat .side { display: none; }
    .app:not(.inchat) .chat { display: none; }
  }
  @media (min-width: 700px) { .chat .back { display: none; } }
  .addrow { display: flex; gap: 8px; padding: 6px 8px 10px; align-items: center; }
  .rn.dim { color: var(--rj-text-faint); }
  .note { text-align: center; color: var(--rj-text-faint); font-size: 12.5px; margin: 8px 0 2px; }
  .edt { font-size: 10.5px; color: var(--rj-text-faint); padding: 1px 6px 0; }
  .m { position: relative; }
  .hov { display: none; position: absolute; top: -14px; gap: 2px; padding: 2px; background: var(--rj-surface); border: 1px solid var(--rj-border); border-radius: var(--rj-pill); z-index: 3; box-shadow: 0 4px 14px rgba(0,0,0,.35); }
  .m.mine .hov { right: 0; } .m:not(.mine) .hov { left: 0; }
  .hov button { height: 26px; padding: 0 10px; border: 0; background: none; color: var(--rj-text); font-size: 12px; font-weight: 600; border-radius: var(--rj-pill); }
  .hov button:hover { background: var(--rj-hover); } .hov .dng { color: #ff6b6b; }
  @media (hover: hover) and (pointer: fine) { .m:hover .hov { display: inline-flex; } }

  .ov { position: fixed; inset: 0; z-index: 60; }
  .ov-bd { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; padding: 0; background: color-mix(in srgb, var(--rj-bg) 55%, transparent); -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px); animation: ovf .16s ease-out; }
  .ov-emo { position: absolute; top: var(--et); left: var(--el); display: flex; gap: 2px; padding: 6px 8px; background: var(--rj-surface-2, var(--rj-surface)); border: 1px solid var(--rj-border); border-radius: 999px; box-shadow: 0 10px 30px rgba(0,0,0,.45); -webkit-backdrop-filter: blur(var(--rj-g-blur, 0px)); backdrop-filter: blur(var(--rj-g-blur, 0px)); animation: ovp .18s cubic-bezier(.2,1.2,.4,1); transform-origin: bottom center; }
  .ov-emo button { width: 40px; height: 40px; border: 0; background: none; font-size: 24px; border-radius: 50%; transition: transform .12s; }
  .ov-emo button:hover, .ov-emo button:active { transform: scale(1.28); background: var(--rj-hover); }
  .ov-emo button.on { background: color-mix(in srgb, var(--rj-accent) 28%, transparent); }
  .ov-prev { position: absolute; top: var(--pt); left: var(--pl); width: var(--pw); max-height: var(--ph); overflow: hidden; pointer-events: none; display: flex; }
  .ov-prev.mine { justify-content: flex-end; }
  .ov-prev .bub { max-width: 100%; box-shadow: 0 8px 28px rgba(0,0,0,.4); }
  .ov-prev .img { max-width: 100%; max-height: var(--ph); border-radius: var(--rj-radius, 14px); box-shadow: 0 8px 28px rgba(0,0,0,.4); }
  .ov-menu { position: absolute; top: var(--mt); left: var(--ml); width: 220px; background: var(--rj-surface-2, var(--rj-surface)); border: 1px solid var(--rj-border); border-radius: calc(var(--rj-radius, 14px) + 2px); overflow: hidden; box-shadow: 0 14px 40px rgba(0,0,0,.5); -webkit-backdrop-filter: blur(var(--rj-g-blur, 0px)); backdrop-filter: blur(var(--rj-g-blur, 0px)); animation: ovp .18s ease-out; transform-origin: top center; }
  .ov-menu button { display: flex; width: 100%; align-items: center; justify-content: space-between; min-height: 46px; padding: 0 16px; border: 0; background: none; color: var(--rj-text); font: inherit; font-size: 15.5px; text-align: left; }
  .ov-menu button + button { border-top: 1px solid var(--rj-border); }
  .ov-menu button:hover, .ov-menu button:active { background: var(--rj-hover); }
  .ov-menu svg { width: 19px; height: 19px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; opacity: .85; }
  .ov-menu .dng { color: #ff6b6b; }
  @keyframes ovf { from { opacity: 0; } to { opacity: 1; } }
  @keyframes ovp { from { opacity: 0; transform: scale(.9); } to { opacity: 1; transform: none; } }
  /* banter wide v2 */
  @media (min-width: 1100px) {
    .chat .list { padding-left: max(24px, calc((100% - 940px) / 2)); padding-right: max(24px, calc((100% - 940px) / 2)); }
    .chat .composer, .chat .replychip { width: 100%; max-width: 940px; margin-left: auto; margin-right: auto; }
    .chat .bub { max-width: 620px; font-size: 15.5px; }
  }
  @media (min-width: 1600px) { .app { grid-template-columns: 380px 1fr; } }
</style>
