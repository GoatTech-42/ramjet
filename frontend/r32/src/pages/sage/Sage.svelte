<script>
  import '../../tokens.css';
  import { api, errCopy } from '../../lib/api.js';
  import { dialog } from '../../lib/dialog.js';

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
    if (!r.ok) { error = "this chat couldn't open."; return; }
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
    if (r.ok) loadConvs(); else error = errCopy(r, "this chat couldn't be renamed.");
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
        headers: { 'content-type': 'application/json', 'x-ramjet-js': '1' },
        credentials: 'same-origin',
        body: JSON.stringify({ messages: messages.slice(-20), stream: true, style: style === 'normal' ? '' : style }),
        signal: ctl.signal,
      });
      const type = res.headers.get('content-type') || '';
      if (!type.includes('text/event-stream')) {
        // plain json: an error, or the non-streaming provider
        let data = null; try { data = await res.json(); } catch {}
        finish();
        if (gen !== myGen) return;
        if (!res.ok || !data?.ok) {
          error = res.status === 429 && typeof data?.error === 'string' && data.error ? data.error : errCopy({ status: res.status, data }, "sage couldn't reply."); // 429 cap line stays verbatim (house lowercase), everything else is mapped
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
      if (!started) { error = "sage couldn't reply."; scrollDown(); return; }
      { const i = messages.length - 1; const words = text.trim().split(/\s+/).length; metas = { ...metas, [i]: { first: ((tFirst - tAsk) / 1000).toFixed(1), total: ((performance.now() - tAsk) / 1000).toFixed(1), words } }; }
      save(); persist();
    } catch (e) {
      finish();
      if (gen !== myGen) return;
      if (started) { save(); persist(); return; } // stopped or cut: keep what typed
      if (e?.name === 'AbortError') return;
      error = "sage couldn't reply."; scrollDown();
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

{#snippet convlist()}
        <p class="sheet-h">your chats</p>
        <button class="newchat" data-testid="sage-new-chat" onclick={newChat}>new chat</button>
        {#if convs.length > 5}<input class="convq" data-testid="sage-conv-search" type="search" placeholder="search your chats" bind:value={convQ} />{/if}
        {#each shownConvs as c (c.id)}
          <div class="convrow">
            <button class="convopen" data-testid="sage-conv-row" onclick={() => openConv(c)}>
              <span class="convtitle">{c.title}</span>
              <span class="convmeta">{c.count} {c.count === 1 ? 'message' : 'messages'}</span>
            </button>
            <button class="convdel convren" data-testid="sage-conv-rename" aria-label="rename conversation" onclick={(e) => renameConv(c, e)}>&#9998;</button>
            <button class="convdel" data-testid="sage-conv-delete" aria-label="delete conversation" onclick={(e) => deleteConv(c, e)}>x</button>
          </div>
        {:else}
          <p class="convempty">{convQ.trim() ? 'no chats match' : 'no chats yet. ask sage something to start.'}</p>
        {/each}
{/snippet}

<div class="page">
  <aside class="side"><div class="sidein">{@render convlist()}</div></aside>
  <header class="top">
    <a class="back" data-testid="sage-back" href="/" aria-label="back to ramjet">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
    </a>
    <span class="brand">sage</span>
    <span class="tagline">ask anything</span>
    <button class="chatsbtn stylebtn" data-testid="sage-length" onclick={cycleStyle} aria-label="answer length" title="answer length: brief, normal or deep">length: {style}</button>
    {#if messages.length}<button class="chatsbtn copyall" data-testid="sage-copy-chat" onclick={copyChat} aria-label="copy whole chat" title="copy whole chat">{chatCopied ? 'copied' : 'copy'}</button>{/if}
    <button class="chatsbtn" data-testid="sage-chats" onclick={() => { sheetOpen = true; loadConvs(); }}>chats</button>
  </header>

  {#if sheetOpen}
    <div class="overlay" onclick={() => { sheetOpen = false; }}>
      <div class="sheet" role="dialog" aria-modal="true" aria-label="your chats" tabindex="-1" use:dialog={() => { sheetOpen = false; }} onclick={(e) => e.stopPropagation()}>
        {@render convlist()}
      </div>
    </div>
  {/if}

  <main class="list" bind:this={listEl}>
    {#if !messages.length && !thinking}
      <div class="empty">
        <p class="big" data-testid="sage-hero">what's on your mind?</p>
        <div class="starters">
          {#each starters as s}<button class="starter" data-testid="sage-starter" onclick={() => send(s)}>{s}</button>{/each}
        </div>
      </div>
    {/if}

    {#each messages as m, i}
      <div class="msg" class:mine={m.role === 'user'}>
        <div class="bubble">{@html md(m.content)}</div>
        {#if m.role === 'user' && !thinking && !streaming}
          <div class="acts"><button data-testid="sage-edit" onclick={() => editMsg(i)}>edit</button></div>
        {/if}
        {#if m.role === 'assistant' && !(streaming && i === messages.length - 1)}
          <div class="acts">
            <button data-testid="sage-copy" onclick={() => copyMsg(i)}>{copiedAt === i ? 'copied' : 'copy'}</button>
            {#if metas[i] && techOn()}<span class="tmeta">first word {metas[i].first}s · {metas[i].words} words · {metas[i].total}s total · {(metas[i].words / Math.max(0.1, metas[i].total - metas[i].first)).toFixed(0)} w/s</span>{/if}
            {#if i === messages.length - 1}<button data-testid="sage-redo" onclick={regen}>try again</button>{/if}
          </div>
        {/if}
      </div>
    {/each}

    {#if thinking}
      <div class="msg"><div class="bubble thinking-bubble"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div></div>
    {/if}
    {#if error}<p class="error">{error}{#if messages.at(-1)?.role === 'user' && error !== 'slow down a bit.' && error !== "this device can't do that" && error !== "this part isn't ready yet."} <button class="retrylink" data-testid="sage-retry" onclick={retry}>try again</button>{/if}</p>{/if}
  </main>

  <form class="composer" onsubmit={(e) => { e.preventDefault(); if (streaming) stop(); else send(); }}>
    <textarea
      data-testid="sage-input"
      bind:value={draft}
      bind:this={taEl}
      oninput={grow}
      onkeydown={onKey}
      placeholder="ask sage anything"
      rows="1"
      aria-label="message sage"
    ></textarea>
    <button type="submit" data-testid="sage-send" disabled={streaming ? false : thinking || !draft.trim()} aria-label={streaming ? 'stop' : 'send'}>
      {#if streaming}
        <svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
      {:else}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>
      {/if}
    </button>
  </form>
</div>

<style>
  /* C7.2 ledger restyle: rj tokens remapped to the C7 ramp, scoped to .page so tokens.css and the other pages are untouched. dark default, paper via :root[data-skin='paper'] (read-only from the hub's stored skin). fonts = the C7 hashed assets; Box confirms the three names against the staged manifest */
  .page { --rj-bg: #0a0a0a; --rj-surface: #141414; --rj-surface-2: #1f1f1f; --rj-hover: #1f1f1f; --rj-border: rgba(255,255,255,.08); --rj-strong: #434343; --rj-text: #f2f2f2; --rj-text-dim: #8f8f8f; --rj-text-faint: #8f8f8f; --rj-accent: #ffffff; --rj-accent-ink: #0a0a0a; --rj-danger: #ffffff; --rj-radius: 10px; --rj-font: "PS", system-ui, "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif; --rj-mono: "PM", ui-monospace, monospace; --their-code: rgba(255,255,255,.08); --mine-bg: #ededed; --mine-ink: #111111; --mine-code: rgba(17,17,17,.12); }
  :global(:root[data-skin='paper']) .page { --rj-bg: #f2f2f2; --rj-surface: #e8e8e8; --rj-surface-2: #d4d4d4; --rj-hover: #e9e9e9; --rj-border: rgba(29,29,29,.1); --rj-strong: #a9a9a9; --rj-text: #0a0a0a; --rj-text-dim: #626262; --rj-text-faint: #626262; --rj-accent: #0a0a0a; --rj-accent-ink: #f2f2f2; --rj-danger: #0a0a0a; --their-code: rgba(29,29,29,.08); --mine-bg: #1d1d1d; --mine-ink: #f3f3f3; --mine-code: rgba(243,243,243,.16); }

  /* paper edge: token-aware selection highlight (global tokens.css selection is white-on-white on paper) */
  .page ::selection { background: color-mix(in srgb, var(--rj-accent) 32%, transparent); }

  @font-face { font-family: PS; src: url(/assets/IBMPlexSans-var-GRPhyGEp.woff2) format("woff2"); font-weight: 100 700; font-display: swap; }
  @font-face { font-family: PM; src: url(/assets/IBMPlexMono-400-normal-C-SBB-bw.woff2) format("woff2"); font-weight: 400; font-display: swap; }
  @font-face { font-family: PM; src: url(/assets/IBMPlexMono-500-normal-B772pXP5.woff2) format("woff2"); font-weight: 500; font-display: swap; }
  :global(body) { background: #111111; }
  :global(:root[data-skin='paper']) :global(body) { background: #f3f3f3; }
  .page { height: 100dvh; display: flex; flex-direction: column; background: var(--rj-bg); color: var(--rj-text); font-family: var(--rj-font); }
  .top { display: flex; align-items: center; gap: 10px; padding: 14px 16px; max-width: 760px; margin: 0 auto; width: 100%; }
  .back { width: 38px; height: 38px; display: grid; place-items: center; border-radius: 8px; background: none; color: var(--rj-text-dim); flex: none; }
  .back svg { width: 20px; height: 20px; }
  .brand { font-family: var(--rj-mono); font-size: 15px; font-weight: 500; color: var(--rj-text); }
  .tagline { font-family: var(--rj-mono); font-size: 12px; color: var(--rj-text-faint); }
  .list { flex: 1; overflow-y: auto; padding: 8px 16px 16px; max-width: 760px; margin: 0 auto; width: 100%; display: flex; flex-direction: column; gap: 10px; }
  .empty { text-align: center; padding: 56px 20px; margin: auto 0; }
  .empty .big { font-size: 22px; font-weight: 600; letter-spacing: -0.01em; margin: 0 0 20px; }
  .starters { display: flex; flex-direction: column; max-width: 420px; margin: 0 auto; }
  .starter { background: none; border: 0; border-bottom: 1px solid var(--rj-border); color: var(--rj-text-dim); padding: 12px 4px; font-size: 14px; text-align: left; }
  .starter:hover { color: var(--rj-text); }
  .msg { display: flex; flex-wrap: wrap; animation: msgin .18s ease-out; }
  @keyframes msgin { 0% { opacity: 0; transform: translateY(5px); } }
  .convq { width: 100%; box-sizing: border-box; margin: 4px 0 8px; background: var(--rj-bg); border: 1px solid var(--rj-border); color: var(--rj-text); border-radius: 10px; padding: 10px 12px; font-size: 16px; outline: none; }
  .acts { width: 100%; display: flex; gap: 14px; padding: 4px 6px 0; }
  .acts button { background: none; border: 0; padding: 2px 0; font-family: var(--rj-mono); font-size: 11px; color: var(--rj-text-faint); cursor: pointer; }
  .acts button:hover { color: var(--rj-text); }
  .msg.mine { justify-content: flex-end; }
  .bubble { max-width: 82%; padding: 11px 15px; border-radius: 10px; font-size: 15px; line-height: 1.5; white-space: pre-wrap; word-wrap: break-word; background: var(--rj-surface); }
  .msg.mine .bubble { background: var(--mine-bg); color: var(--mine-ink); border-bottom-right-radius: 4px; }
  .msg:not(.mine) .bubble { border-bottom-left-radius: 4px; }
  .bubble :global(.li) { display: block; padding-left: 14px; position: relative; }
  .bubble :global(.li)::before { content: ''; position: absolute; left: 2px; top: 0.62em; width: 5px; height: 5px; border-radius: 50%; background: currentColor; opacity: 0.7; }
  .bubble :global(code) { background: var(--their-code); border-radius: 5px; padding: 1px 5px; font-size: 13.5px; }
  .msg.mine .bubble :global(code) { background: var(--mine-code); }
  .thinking-bubble { display: flex; gap: 5px; align-items: center; padding: 14px 16px; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--rj-text-dim); animation: blink 1.2s infinite; }
  .dot:nth-child(2) { animation-delay: 0.2s; }
  .dot:nth-child(3) { animation-delay: 0.4s; }
  @keyframes blink { 0%, 60%, 100% { opacity: 0.25; } 30% { opacity: 1; } }
  @media (prefers-reduced-motion: reduce) { .dot, .msg { animation: none; } }
  @media (min-width: 1000px) { .bubble { max-width: 74%; } }
  .error { color: var(--rj-danger); font-size: 14px; text-align: center; margin: 4px 0; }
  .error { font-weight: 600 }
  .error::before { content: "!"; display: inline-block; width: 1em; height: 1em; line-height: 1em; text-align: center; border: 1px solid currentColor; border-radius: 50%; margin-right: 6px; font-size: .85em; vertical-align: baseline; }
  .retrylink { margin-left: 5px; background: none; border: none; color: var(--rj-text); font-size: 14px; text-decoration: underline; padding: 0; cursor: pointer; }
  .chatsbtn { margin-left: auto; background: none; border: 1px solid var(--rj-border); color: var(--rj-text-dim); border-radius: 999px; padding: 6px 12px; font-family: var(--rj-mono); font-size: 12px; }
  .chatsbtn { white-space: nowrap; flex: none; }
  .stylebtn { margin-left: auto; }
  @media (max-width: 520px) { .top .tagline { display: none; } .top { gap: 6px; } .chatsbtn { padding: 7px 10px; font-size: 12.5px; } }
  .chatsbtn.copyall, .stylebtn + .chatsbtn { margin-left: 0; }
  .chatsbtn:hover { color: var(--rj-text); border-color: var(--rj-strong); }
  .overlay { position: fixed; inset: 0; z-index: 40; background: rgba(0,0,0,0.6); display: flex; align-items: flex-end; justify-content: center; }
  .sheet { width: 100%; max-width: 560px; background: var(--rj-surface); border: 1px solid var(--rj-border); border-radius: 10px 10px 0 0; padding: 18px 16px calc(18px + env(safe-area-inset-bottom)); display: flex; flex-direction: column; gap: 8px; max-height: 70dvh; overflow-y: auto; }
  .sheet-h { margin: 0; font-size: 15px; font-weight: 600; }
  .newchat { background: var(--rj-accent); color: var(--rj-accent-ink); border: 0; border-radius: 10px; padding: 12px; font-size: 15px; font-weight: 600; }
  .convrow { display: flex; align-items: center; gap: 10px; width: 100%; text-align: left; background: none; border: 0; border-bottom: 1px solid var(--rj-border); padding: 11px 6px; color: var(--rj-text); min-height: 44px; }
  .convrow:hover { background: var(--rj-hover); }
  /* rename and delete show on hover or keyboard focus for pointer devices; touch keeps them visible (no hover there) */
  @media (hover: hover) and (pointer: fine) {
    .convrow .convdel { opacity: 0; }
    .convrow:hover .convdel, .convrow:focus-within .convdel { opacity: 1; }
  }
  .convopen { flex: 1; min-width: 0; display: flex; align-items: center; gap: 10px; text-align: left; background: none; border: 0; padding: 0; color: inherit; font: inherit; min-height: 44px; cursor: pointer; }
  .convtitle { flex: 1; min-width: 0; font-size: 14px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .convmeta { font-family: var(--rj-mono); font-size: 11px; color: var(--rj-text-faint); flex: none; }
  .convdel { width: 28px; height: 28px; flex: none; display: grid; place-items: center; border-radius: 50%; color: var(--rj-text-dim); font-size: 12px; cursor: pointer; }
  .convdel:hover { color: var(--rj-danger); background: var(--rj-surface-2); }
  .convren:hover { color: var(--rj-text); }
  .tmeta { font: 11px var(--rj-mono); color: var(--rj-text-faint); margin-left: 8px; align-self: center; }
  .convempty { text-align: center; color: var(--rj-text-faint); font-family: var(--rj-mono); font-size: 12px; padding: 14px 0; }
  .composer { display: flex; gap: 8px; padding: 12px 16px calc(12px + env(safe-area-inset-bottom)); max-width: 760px; margin: 0 auto; width: 100%; }
  .composer textarea { flex: 1; min-width: 0; background: var(--rj-surface); border: 1px solid var(--rj-border); color: var(--rj-text); border-radius: 10px; padding: 13px 16px; font-size: 16px; font-family: inherit; outline: none; resize: none; min-height: 48px; max-height: 120px; }
  .composer textarea:focus { border-color: var(--rj-strong); }
  .composer button { width: 48px; height: 48px; border-radius: 50%; border: 0; background: var(--rj-accent); color: var(--rj-accent-ink); display: grid; place-items: center; flex: none; }
  .composer button:disabled { opacity: .4; }
  .composer button svg { width: 20px; height: 20px; }
  @media (min-width: 1000px) { .top, .list, .composer { max-width: 860px; } }
  .side { display: none; }
  @media (min-width: 1000px) {
    .page { display: grid; grid-template-columns: 290px minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr) auto; }
    .side { display: block; grid-row: 1 / span 3; grid-column: 1; border-right: 1px solid var(--rj-border); background: none; overflow-y: auto; }
    .sidein { padding: 22px 14px; display: flex; flex-direction: column; gap: 8px; }
    .sidein .sheet-h { padding: 0 6px; font-family: var(--rj-mono); font-size: 12px; font-weight: 400; color: var(--rj-text-faint); }
    .page > .top, .page > .list, .page > .composer { grid-column: 2; max-width: 900px; }
    .page > .overlay { display: none; }
    .sidein .newchat { background: none; border: 1px solid var(--rj-border); color: var(--rj-text); font-weight: 500; }
    .sidein .newchat:hover { border-color: var(--rj-strong); } .bubble { max-width: 82%; }
    .chatsbtn:not(.stylebtn):not(.copyall) { display: none; }
  }
  @media (min-width: 1500px) { .page { grid-template-columns: 320px minmax(0, 1fr); } .page > .top, .page > .list, .page > .composer { max-width: 980px; } .list { font-size: 17px; } }

  /* touch hit-slop: pseudo-element grows tap targets toward 44px on coarse/no-hover pointers, where layout/stacking allow; visual size and desktop unchanged. exceptions: see review notes */
  @media (hover: none), (pointer: coarse) {
    .back { position: relative; } .back::after { content: ''; position: absolute; inset: -3px; }
    .chatsbtn { position: relative; } .chatsbtn::after { content: ''; position: absolute; left: 0; right: 0; top: -7px; bottom: -7px; }
    .acts button { position: relative; } .acts button::after { content: ''; position: absolute; left: -2px; right: -2px; top: -13px; bottom: -13px; }
  }
  .convq:focus-visible, .composer textarea:focus-visible { outline: 2px solid var(--rj-text); outline-offset: 2px; }
</style>
