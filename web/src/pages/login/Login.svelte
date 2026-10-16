<script>
  import '../../tokens.css';
  import AccountFrame from '../../lib/AccountFrame.svelte';
  import { api } from '../../lib/api.js';
  let username = $state('');
  let password = $state('');
  let showPw = $state(false);
  let error = $state('');
  let busy = $state(false);
  // /signup is a real path (shareable, refresh-safe) - it just opens the
  // same card with the signup side up
  let mode = $state(location.pathname === '/signup' ? 'signup' : 'login');
  let note = $state('');
  function flip() {
    mode = mode === 'login' ? 'signup' : 'login';
    error = ''; note = '';
    history.replaceState(null, '', mode === 'login' ? '/login' : '/signup');
  }

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

<AccountFrame title={mode === 'login' ? 'Welcome back' : 'Make yourself at home'} description={mode === 'login' ? 'Sign in to your corner of the web.' : 'Request an account to join Ramjet.'}>
  <form onsubmit={submit}>
    <label>Username<input bind:value={username} autocomplete="username" autocapitalize="off" required minlength="2" /></label>
    <label>Password<input bind:value={password} type={showPw ? 'text' : 'password'} autocomplete={mode === 'login' ? 'current-password' : 'new-password'} required minlength="6" /></label>
    <button type="button" class="showpw" aria-pressed={showPw} onclick={() => { showPw = !showPw; }}>{showPw ? 'Hide password' : 'Show password'}</button>
    {#if error}<p class="err" role="alert">{error}</p>{/if}
    {#if note}<p class="note" role="status">{note}</p>{/if}
    <button class="go" type="submit" disabled={busy}>{busy ? 'Signing in...' : mode === 'login' ? 'Log in' : 'Request account'}</button>
    <p class="fine">{mode === 'login' ? 'New here?' : 'Already have an account?'} <button type="button" class="flip" onclick={flip}>{mode === 'login' ? 'Sign up' : 'Log in'}</button></p>
  </form>
</AccountFrame>
