<script>
  import '../../tokens.css';
  import { api } from '../../lib/api.js';
  let username = $state('');
  let password = $state('');
  let showPw = $state(false);
  let error = $state('');
  let busy = $state(false);
  let mode = $state('login');
  let note = $state('');
  function flip() { mode = mode === 'login' ? 'signup' : 'login'; error = ''; note = ''; }

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    error = '';
    busy = true;
    note = '';
    const r = await api(mode === 'login' ? '/api/auth/login' : '/api/auth/signup', { method: 'POST', body: { username, password } });
    busy = false;
    if (r.ok && r.data?.pending) { note = "request sent - you can log in once it's approved"; mode = 'login'; password = ''; return; }
    if (r.ok) { window.location.href = '/'; return; }
    error = r.data?.error || "that didn't work - try again";
  }
</script>

<main>
  <form class="card" onsubmit={submit}>
    <div class="brand">ramjet<span class="dot">.</span></div>
    <p class="tag">your corner of the web</p>
    <input bind:value={username} placeholder="username" autocomplete="username" autocapitalize="off" required minlength="2" />
    <input bind:value={password} type={showPw ? 'text' : 'password'} placeholder="password" autocomplete={mode === 'login' ? 'current-password' : 'new-password'} required minlength="6" />
    <button type="button" class="showpw" onclick={() => { showPw = !showPw; }}>{showPw ? 'hide password' : 'show password'}</button>
    {#if error}<p class="err" role="alert">{error}</p>{/if}
    {#if note}<p class="note" role="status">{note}</p>{/if}
    <button class="go" type="submit" disabled={busy}>{busy ? 'one sec...' : mode === 'login' ? 'log in' : 'request an account'}</button>
    <p class="fine">{mode === 'login' ? 'no account?' : 'already have one?'} <button type="button" class="flip" onclick={flip}>{mode === 'login' ? 'sign up' : 'log in'}</button></p>
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
    background: var(--rj-surface);
    border: 1px solid transparent;
    border-radius: var(--rj-pill);
    outline: none;
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
  .err { margin: 0; text-align: center; color: var(--rj-danger); font-size: 13px; }
  .note { margin: 0; text-align: center; color: var(--rj-accent); font-size: 13px; }
  .flip { background: none; border: 0; padding: 0; color: var(--rj-text-dim); font-size: 12px; text-decoration: underline; cursor: pointer; }
  .fine { margin: 6px 0 0; text-align: center; font-size: 12px; color: var(--rj-text-faint); }
  .showpw { align-self: flex-end; background: none; border: 0; color: var(--rj-text-dim); font-size: 12.5px; text-decoration: underline; padding: 2px 4px; margin-top: -4px; }
</style>
