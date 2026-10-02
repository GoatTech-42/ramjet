<script>
  import '../../tokens.css';
  import { api } from '../../lib/api.js';

  // the open conversation boots from localStorage instantly; every exchange
  // also saves to the account so it is on every device
  const STORE_KEY = 'sage-conversation';
  const ID_KEY = 'sage-conv-id';
  let messages = $state([]);
  let convId = $state('');
  try { messages = JSON.parse(localStorage.getItem(STORE_KEY) || '[]'); } catch {}
  try { convId = localStorage.getItem(ID_KEY) || ''; } catch {}

  let convs = $state([]);
  let convQ = $state('');
  const shownConvs = $derived(convQ.trim() ? convs.filter((c) => (c.title || '').toLowerCase().includes(convQ.trim().toLowerCase())) : convs);
  let sheetOpen = $state(false);
  let gen = 0; // bumps whenever the open chat changes - stale replies die

  async function loadConvs() {
    const r = await api('/api/apps/sage/conversations');
    if (r.ok) convs = r.data.conversations || [];
  }
  loadConvs();

  async function persist() {
    if (!messages.length) return;
    const r = await api('/api/apps/sage/conversations', {
      method: 'POST',
      body: { id: convId || undefined, messages },
    });
    if (r.ok && r.data.id) {
      convId = r.data.id;
      try { localStorage.setItem(ID_KEY, convId); } catch {}
      loadConvs();
    }
  }

  async function openConv(c) {
    gen++;
    const r = await api('/api/apps/sage/conversations/messages?id=' + encodeURIComponent(c.id));
    if (!r.ok) { error = 'could not open that one'; return; }
    messages = r.data.conversation.messages || [];
    convId = c.id;
    try { localStorage.setItem(STORE_KEY, JSON.stringify(messages)); localStorage.setItem(ID_KEY, convId); } catch {}
    sheetOpen = false; error = '';
    scrollDown();
  }

  function newChat() {
    gen++;
    messages = []; convId = ''; error = '';
    try { localStorage.removeItem(STORE_KEY); localStorage.removeItem(ID_KEY); } catch {}
    sheetOpen = false;
  }

  async function deleteConv(c, e) {
    e.stopPropagation();
    await api('/api/apps/sage/conversations/delete', { method: 'POST', body: { id: c.id } });
    if (convId === c.id) newChat();
    sheetOpen = true; // newChat closes it when it is the open one
    loadConvs();
  }

  async function renameConv(c, e) {
    e.stopPropagation();
    const n = (prompt('rename this chat', c.title) || '').trim();
    if (!n || n === c.title) return;
    const r = await api('/api/apps/sage/conversations/rename', { method: 'POST', body: { id: c.id, title: n } });
    if (r.ok) loadConvs(); else error = (r.data && r.data.error) || 'could not rename';
  }

  let draft = $state('');
  let thinking = $state(false);
  let error = $state('');
  let listEl = $state(null);
  let taEl = $state(null);

  function grow() {
    if (!taEl) return;
    taEl.style.height = 'auto';
    taEl.style.height = Math.min(120, taEl.scrollHeight) + 'px';
  }

  const starters = [
    'explain black holes like i\'m twelve',
    'give me a dinner idea with chicken and rice',
    'what\'s the difference between tcp and udp?',
    'write a haiku about mondays',
  ];

  // a restored conversation opens at the bottom, like any messenger
  if (messages.length) scrollDown();
  try { const h = sessionStorage.getItem('rj-ask'); if (h) { sessionStorage.removeItem('rj-ask'); setTimeout(() => send(h), 350); } } catch {}

  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(messages.slice(-40))); } catch {}
  }

  function scrollDown() {
    requestAnimationFrame(() => { if (listEl) listEl.scrollTop = listEl.scrollHeight; });
  }

  // streamed reply: tokens land in the last bubble as they arrive. a stopped
  // or cut reply keeps what already typed out.
  let streaming = $state(false);
  let ctl = null;
  function stop() { try { ctl?.abort(); } catch {} }
  import { techOn } from '../../lib/tech.js';
  let metas = $state({}); // technical readout per assistant message index (not saved with the chat)
  async function ask() {
    const tAsk = performance.now(); let tFirst = 0;
    thinking = true;
    const myGen = gen; // a reply only lands in the chat it started in
    ctl = new AbortController();
    let started = false;
    let text = '';
    const finish = () => { thinking = false; streaming = false; };
    try {
      const res = await fetch('/api/apps/sage/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ messages: messages.slice(-20), stream: true, style }),
        signal: ctl.signal,
      });
      const type = res.headers.get('content-type') || '';
      if (!type.includes('text/event-stream')) {
        // plain json: an error, or the non-streaming provider
        let data = null; try { data = await res.json(); } catch {}
        finish();
        if (gen !== myGen) return;
        if (!res.ok || !data?.ok) {
          error = (data?.error || "couldn't reach the model").replace(/\s*-?\s*try again\.?\s*$/i, '');
          scrollDown(); return;
        }
        messages = [...messages, { role: 'assistant', content: data.reply }];
        save(); scrollDown(); persist(); return;
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '', errMsg = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const ev = buf.slice(0, i); buf = buf.slice(i + 2);
          if (!ev.startsWith('data:')) continue;
          let o; try { o = JSON.parse(ev.slice(5)); } catch { continue; }
          if (o.error) errMsg = o.error;
          if (o.t && gen === myGen) {
            text += o.t;
            if (!started) { started = true; tFirst = performance.now(); thinking = false; streaming = true; messages = [...messages, { role: 'assistant', content: text }]; }
            else messages[messages.length - 1].content = text;
            scrollDown();
          }
        }
      }
      finish();
      if (gen !== myGen) return;
      if (!started) { error = (errMsg || "the model said nothing").replace(/\s*-?\s*try again\.?\s*$/i, ''); scrollDown(); return; }
      { const i = messages.length - 1; const words = text.trim().split(/\s+/).length; metas = { ...metas, [i]: { first: ((tFirst - tAsk) / 1000).toFixed(1), total: ((performance.now() - tAsk) / 1000).toFixed(1), words } }; }
      save(); persist();
    } catch (e) {
      finish();
      if (gen !== myGen) return;
      if (started) { save(); persist(); return; } // stopped or cut: keep what typed
      if (e?.name === 'AbortError') return;
      error = "couldn't reach the model"; scrollDown();
    }
  }

  let copiedAt = $state(-1);
  async function copyMsg(i) {
    try { await navigator.clipboard.writeText(messages[i].content); }
    catch {
      const ta = document.createElement('textarea'); ta.value = messages[i].content; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch {} ta.remove();
    }
    copiedAt = i; setTimeout(() => { if (copiedAt === i) copiedAt = -1; }, 1500);
  }
  // answer length: brief / normal / deep, remembered on this device
  let style = $state('normal');
  try { const v = localStorage.getItem('sage-style'); if (v === 'brief' || v === 'deep') style = v; } catch {}
  function cycleStyle() {
    style = style === 'normal' ? 'brief' : style === 'brief' ? 'deep' : 'normal';
    try { localStorage.setItem('sage-style', style); } catch {}
  }
  let chatCopied = $state(false);
  async function copyChat() {
    const text = messages.map((m) => (m.role === 'user' ? 'you: ' : 'sage: ') + m.content).join('\n\n');
    try { await navigator.clipboard.writeText(text); }
    catch {
      const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch {} ta.remove();
    }
    chatCopied = true; setTimeout(() => { chatCopied = false; }, 1500);
  }
  function regen() {
    if (thinking || streaming || messages.at(-1)?.role !== 'assistant') return;
    messages = messages.slice(0, -1);
    error = ''; save();
    ask();
  }

  async function send(text) {
    const content = (text ?? draft).trim();
    if (!content || thinking || streaming) return;
    if (content.length > 4000) { error = 'keep messages under 4,000 characters'; scrollDown(); return; }
    draft = ''; error = '';
    if (taEl) taEl.style.height = '';
    messages = [...messages, { role: 'user', content }];
    save(); scrollDown(); persist();
    await ask();
  }

  function editMsg(i) {
    if (thinking || streaming || messages[i]?.role !== 'user') return;
    draft = messages[i].content;
    messages = messages.slice(0, i);
    error = ''; save(); persist();
    setTimeout(() => { if (taEl) { taEl.focus(); taEl.style.height = 'auto'; taEl.style.height = Math.min(taEl.scrollHeight, 160) + 'px'; } }, 0);
  }

  function retry() {
    if (thinking || messages.at(-1)?.role !== 'user') return;
    error = '';
    ask();
  }

  function onKey(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  }


  // tiny markdown: the model answers with **bold**, `code` and * bullets.
  // escape first (the text is untrusted), then upgrade the marks.
  function md(text) {
    let h = String(text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    h = h.replace(/`([^`]+)`/g, '<code>$1</code>');
    h = h.replace(/^[*-] (.+)$/gm, '<span class="li">$1</span>');
    return h;
  }
</script>

<svelte:head><title>sage - ramjet</title></svelte:head>

<div class="page">
  <header class="top">
    <a class="back" href="/" aria-label="back to ramjet">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
    </a>
    <span class="brand">sage</span>
    <span class="tagline">ask anything</span>
    <button class="chatsbtn stylebtn" onclick={cycleStyle} aria-label="answer length" title="answer length: brief, normal or deep">length: {style}</button>
    {#if messages.length}<button class="chatsbtn copyall" onclick={copyChat} aria-label="copy whole chat" title="copy whole chat">{chatCopied ? 'copied' : 'copy'}</button>{/if}
    <button class="chatsbtn" onclick={() => { sheetOpen = true; loadConvs(); }}>chats</button>
  </header>

  {#if sheetOpen}
    <div class="overlay" onclick={() => { sheetOpen = false; }}>
      <div class="sheet" onclick={(e) => e.stopPropagation()}>
        <p class="sheet-h">your chats</p>
        <button class="newchat" onclick={newChat}>new chat</button>
        {#if convs.length > 5}<input class="convq" type="search" placeholder="search your chats" bind:value={convQ} />{/if}
        {#each shownConvs as c (c.id)}
          <button class="convrow" onclick={() => openConv(c)}>
            <span class="convtitle">{c.title}</span>
            <span class="convmeta">{c.count} {c.count === 1 ? 'message' : 'messages'}</span>
            <span class="convdel convren" role="button" tabindex="-1" aria-label="rename conversation" onclick={(e) => renameConv(c, e)}>&#9998;</span>
            <span class="convdel" role="button" tabindex="-1" aria-label="delete conversation" onclick={(e) => deleteConv(c, e)}>x</span>
          </button>
        {:else}
          <p class="convempty">{convQ.trim() ? 'no chats match' : 'nothing yet - ask sage something and it saves here'}</p>
        {/each}
      </div>
    </div>
  {/if}

  <main class="list" bind:this={listEl}>
    {#if !messages.length && !thinking}
      <div class="empty">
        <p class="big">what's on your mind?</p>
        <div class="starters">
          {#each starters as s}<button class="starter" onclick={() => send(s)}>{s}</button>{/each}
        </div>
      </div>
    {/if}

    {#each messages as m, i}
      <div class="msg" class:mine={m.role === 'user'}>
        <div class="bubble">{@html md(m.content)}</div>
        {#if m.role === 'user' && !thinking && !streaming}
          <div class="acts"><button onclick={() => editMsg(i)}>edit</button></div>
        {/if}
        {#if m.role === 'assistant' && !(streaming && i === messages.length - 1)}
          <div class="acts">
            <button onclick={() => copyMsg(i)}>{copiedAt === i ? 'copied' : 'copy'}</button>
            {#if metas[i] && techOn()}<span class="tmeta">first word {metas[i].first}s · {metas[i].words} words · {metas[i].total}s total · {(metas[i].words / Math.max(0.1, metas[i].total - metas[i].first)).toFixed(0)} w/s</span>{/if}
            {#if i === messages.length - 1}<button onclick={regen}>redo</button>{/if}
          </div>
        {/if}
      </div>
    {/each}

    {#if thinking}
      <div class="msg"><div class="bubble thinking-bubble"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div></div>
    {/if}
    {#if error}<p class="error">{error}{#if messages.at(-1)?.role === 'user'} <button class="retrylink" onclick={retry}>try again</button>{/if}</p>{/if}
  </main>

  <form class="composer" onsubmit={(e) => { e.preventDefault(); if (streaming) stop(); else send(); }}>
    <textarea
      bind:value={draft}
      bind:this={taEl}
      oninput={grow}
      onkeydown={onKey}
      placeholder="ask sage anything"
      rows="1"
      aria-label="message sage"
    ></textarea>
    <button type="submit" disabled={streaming ? false : thinking || !draft.trim()} aria-label={streaming ? 'stop' : 'send'}>
      {#if streaming}
        <svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
      {:else}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>
      {/if}
    </button>
  </form>
</div>

<style>
  .page { height: 100dvh; display: flex; flex-direction: column; background: var(--rj-bg); color: var(--rj-text); }
  .top { display: flex; align-items: center; gap: 10px; padding: 14px 16px; max-width: 760px; margin: 0 auto; width: 100%; }
  .back { width: 38px; height: 38px; display: grid; place-items: center; border-radius: 12px; background: var(--rj-surface); color: var(--rj-text); flex: none; }
  .back svg { width: 20px; height: 20px; }
  .brand { font-size: 22px; font-weight: 800; letter-spacing: 0.5px; color: var(--rj-accent); }
  .tagline { font-size: 13px; color: var(--rj-text-dim); }
  .list { flex: 1; overflow-y: auto; padding: 8px 16px 16px; max-width: 760px; margin: 0 auto; width: 100%; display: flex; flex-direction: column; gap: 10px; }
  .empty { text-align: center; padding: 56px 20px; margin: auto 0; }
  .empty .big { font-size: 24px; font-weight: 800; margin: 0 0 20px; }
  .starters { display: flex; flex-direction: column; gap: 8px; max-width: 420px; margin: 0 auto; }
  .starter { background: var(--rj-surface); border: 1px solid var(--rj-border); color: var(--rj-text-dim); border-radius: 14px; padding: 13px 16px; font-size: 14px; text-align: left; }
  .starter:hover { color: var(--rj-text); border-color: var(--rj-accent); }
  .msg { display: flex; flex-wrap: wrap; }
  .convq { width: 100%; box-sizing: border-box; margin: 4px 0 8px; background: var(--rj-bg); border: 1px solid var(--rj-border); color: var(--rj-text); border-radius: 12px; padding: 10px 12px; font-size: 16px; outline: none; }
  .acts { width: 100%; display: flex; gap: 14px; padding: 4px 6px 0; }
  .acts button { background: none; border: 0; padding: 2px 0; font-size: 12px; color: var(--rj-text-faint); cursor: pointer; }
  .acts button:hover { color: var(--rj-text); }
  .msg.mine { justify-content: flex-end; }
  .bubble { max-width: 82%; padding: 11px 15px; border-radius: 16px; font-size: 15px; line-height: 1.5; white-space: pre-wrap; word-wrap: break-word; background: var(--rj-surface); border: 1px solid var(--rj-border); }
  .msg.mine .bubble { background: var(--rj-accent); color: var(--rj-accent-ink); border: 0; border-bottom-right-radius: 6px; }
  .msg:not(.mine) .bubble { border-bottom-left-radius: 6px; }
  .bubble :global(.li) { display: block; padding-left: 14px; position: relative; }
  .bubble :global(.li)::before { content: ''; position: absolute; left: 2px; top: 0.62em; width: 5px; height: 5px; border-radius: 50%; background: currentColor; opacity: 0.7; }
  .bubble :global(code) { background: rgba(255, 255, 255, 0.09); border-radius: 5px; padding: 1px 5px; font-size: 13.5px; }
  .msg.mine .bubble :global(code) { background: rgba(0, 0, 0, 0.14); }
  .thinking-bubble { display: flex; gap: 5px; align-items: center; padding: 14px 16px; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--rj-text-dim); animation: blink 1.2s infinite; }
  .dot:nth-child(2) { animation-delay: 0.2s; }
  .dot:nth-child(3) { animation-delay: 0.4s; }
  @keyframes blink { 0%, 60%, 100% { opacity: 0.25; } 30% { opacity: 1; } }
  .error { color: #ff7b72; font-size: 14px; text-align: center; margin: 4px 0; }
  .retrylink { margin-left: 5px; background: none; border: none; color: var(--rj-accent); font-size: 14px; text-decoration: underline; padding: 0; cursor: pointer; }
  .chatsbtn { margin-left: auto; background: none; border: 1px solid var(--rj-border); color: var(--rj-text-dim); border-radius: 999px; padding: 7px 14px; font-size: 13px; }
  .chatsbtn { white-space: nowrap; flex: none; }
  .stylebtn { margin-left: auto; }
  @media (max-width: 520px) { .top .tagline { display: none; } .top { gap: 6px; } .chatsbtn { padding: 7px 10px; font-size: 12.5px; } }
  .chatsbtn.copyall, .stylebtn + .chatsbtn { margin-left: 0; }
  .chatsbtn:hover { color: var(--rj-text); border-color: var(--rj-accent); }
  .overlay { position: fixed; inset: 0; z-index: 40; background: rgba(0,0,0,0.6); display: flex; align-items: flex-end; justify-content: center; }
  .sheet { width: 100%; max-width: 560px; background: var(--rj-surface); border: 1px solid var(--rj-border); border-radius: 18px 18px 0 0; padding: 18px 16px calc(18px + env(safe-area-inset-bottom)); display: flex; flex-direction: column; gap: 8px; max-height: 70dvh; overflow-y: auto; }
  .sheet-h { margin: 0; font-size: 16px; font-weight: 700; }
  .newchat { background: var(--rj-accent); color: var(--rj-accent-ink); border: 0; border-radius: 12px; padding: 12px; font-size: 15px; font-weight: 700; }
  .convrow { display: flex; align-items: center; gap: 10px; width: 100%; text-align: left; background: var(--rj-bg); border: 1px solid var(--rj-border); border-radius: 12px; padding: 12px 14px; color: var(--rj-text); min-height: 44px; }
  .convrow:hover { border-color: var(--rj-accent); }
  .convtitle { flex: 1; min-width: 0; font-size: 14.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .convmeta { font-size: 12px; color: var(--rj-text-dim); flex: none; }
  .convdel { width: 28px; height: 28px; flex: none; display: grid; place-items: center; border-radius: 50%; color: var(--rj-text-dim); font-size: 12px; cursor: pointer; }
  .convdel:hover { color: var(--rj-danger); background: var(--rj-surface-2); }
  .convren:hover { color: var(--rj-accent); }
  .tmeta { font: 11px var(--rj-mono); color: var(--rj-text-faint); margin-left: 8px; align-self: center; }
  .convempty { text-align: center; color: var(--rj-text-dim); font-size: 14px; padding: 14px 0; }
  .composer { display: flex; gap: 8px; padding: 12px 16px calc(12px + env(safe-area-inset-bottom)); max-width: 760px; margin: 0 auto; width: 100%; }
  .composer textarea { flex: 1; min-width: 0; background: var(--rj-surface); border: 1px solid var(--rj-border); color: var(--rj-text); border-radius: 16px; padding: 13px 16px; font-size: 16px; font-family: inherit; outline: none; resize: none; min-height: 48px; max-height: 120px; }
  .composer textarea:focus { border-color: var(--rj-accent); }
  .composer button { width: 48px; height: 48px; border-radius: 50%; border: 0; background: var(--rj-accent); color: var(--rj-accent-ink); display: grid; place-items: center; flex: none; }
  .composer button:disabled { opacity: 0.4; }
  .composer button svg { width: 20px; height: 20px; }
  @media (min-width: 1000px) { .top, .list, .composer { max-width: 860px; } .bubble { max-width: 74%; } }
</style>
