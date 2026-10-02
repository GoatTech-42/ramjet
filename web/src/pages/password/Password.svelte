<script>
  import '../../tokens.css';
  import { api } from '../../lib/api.js';
  let current = $state('');
  let next = $state('');
  let msg = $state('');
  let ok = $state(false);
  let busy = $state(false);

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    msg = ''; ok = false; busy = true;
    const r = await api('/api/auth/change-password', { method: 'POST', body: { current, next } });
    busy = false;
    if (r.ok) { ok = true; msg = 'done - new password is live'; current = ''; next = ''; return; }
    msg = r.data?.error || "that didn't work - try again";
  }
</script>

<main>
  <form class="card" onsubmit={submit}>
    <div class="brand">ramjet<span class="dot">.</span></div>
    <p class="tag">change your password</p>
    <input bind:value={current} type="password" placeholder="current password" autocomplete="current-password" required />
    <input bind:value={next} type="password" placeholder="new password (6+ characters)" autocomplete="new-password" required minlength="6" />
    {#if msg}<p class:ok class="msg" role="alert">{msg}</p>{/if}
    <button class="go" type="submit" disabled={busy}>{busy ? 'saving...' : 'save password'}</button>
    <a class="back" href="/">back to the hub</a>
  </form>
</main>

<style>
  main { min-height: 100dvh; display: grid; place-items: center; padding: 20px; }
  .card { width: min(360px, 100%); display: grid; gap: 12px; }
  .brand { font-size: 32px; font-weight: 700; letter-spacing: -0.03em; text-align: center; }
  .dot { color: var(--rj-accent); }
  .tag { margin: -4px 0 14px; text-align: center; font-size: 14px; color: var(--rj-text-dim); }
  input {
    height: 52px; padding: 0 20px;
    font-size: 16px; color: var(--rj-text);
    background: var(--rj-surface); border: 1px solid transparent;
    border-radius: var(--rj-pill); outline: none;
    transition: border-color .15s, background .15s;
  }
  input::placeholder { color: var(--rj-text-faint); }
  input:focus { border-color: rgba(255,255,255,.24); background: var(--rj-surface-2); }
  .go {
    height: 52px; border: none; border-radius: var(--rj-pill);
    font-size: 16px; font-weight: 700;
    color: var(--rj-accent-ink); background: var(--rj-accent);
    transition: transform .1s, filter .15s;
  }
  .go:hover { filter: brightness(1.07); }
  .go:active { transform: translateY(1px); }
  .go:disabled { opacity: .5; cursor: default; }
  .msg { margin: 0; text-align: center; color: var(--rj-danger); font-size: 13px; }
  .msg.ok { color: var(--rj-accent); }
  .back { margin-top: 4px; text-align: center; font-size: 12px; color: var(--rj-text-faint); }
  .back:hover { color: var(--rj-text); }
</style>
