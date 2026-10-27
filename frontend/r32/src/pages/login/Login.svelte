<script>
  import '../../tokens.css';
  import { api, errCopy } from '../../lib/api.js';
  let username = $state('');
  let password = $state('');
  let showPw = $state(false);
  let error = $state('');
  let busy = $state(false);
  let mode = $state('login');
  let note = $state('');
  function flip() { mode = mode === 'login' ? 'signup' : 'login'; error = ''; note = ''; }

  // known auth outcomes map to reviewed local copy; anything else gets the shared status mapper
  const KNOWN = {
    'wrong username or password': 'wrong username or password.',
    'your account is waiting for approval - try again later': 'your account is waiting for approval.',
    'this account is turned off': 'this account is turned off.',
    'that name is taken': 'that name is taken.',
    'password needs 6+ characters': 'passwords need at least 6 characters.',
    'usernames are 2-24 chars: letters, numbers, . _ -': 'usernames are 2 to 24 characters: letters, numbers, . _ -',
  };
  const loginCopy = (r) => (r.status && KNOWN[r.data?.error]) || errCopy(r, "that didn't work. try again.");
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
    error = loginCopy(r);
  }
</script>

<main>
  <form class="card" data-testid="login-form" onsubmit={submit}>
    <div class="brand">ramjet<span class="dot">.</span></div>
    <p class="tag">your corner of the web</p>
    <input data-testid="login-username" bind:value={username} placeholder="username" aria-label="username" autocomplete="username" autocapitalize="off" required minlength="2" />
    <input data-testid="login-password" bind:value={password} type={showPw ? 'text' : 'password'} placeholder="password" aria-label="password" autocomplete={mode === 'login' ? 'current-password' : 'new-password'} required minlength="6" />
    <button type="button" class="showpw" data-testid="login-show-password" onclick={() => { showPw = !showPw; }}>{showPw ? 'hide password' : 'show password'}</button>
    {#if error}<p class="err" role="alert">{error}</p>{/if}
    {#if note}<p class="note" role="status">{note}</p>{/if}
    <button class="go" data-testid="login-submit" type="submit" disabled={busy}>{busy ? 'one sec...' : mode === 'login' ? 'log in' : 'request an account'}</button>
    <p class="fine">{mode === 'login' ? 'no account?' : 'already have one?'} <button type="button" class="flip" data-testid="login-flip" onclick={flip}>{mode === 'login' ? 'sign up' : 'log in'}</button></p>
  </form>
</main>

<style>
  /* login - c7 restyle: r32 token vocabulary kept, values swapped to the C7 ramp. paper via :root[data-skin='paper'], read by theme-boot before first paint. fonts = C7.1 build assets. */


  /* paper edge: token-aware selection highlight (global tokens.css selection is white-on-white on paper) */
  :global(body) ::selection { background: color-mix(in srgb, var(--rj-accent) 32%, transparent); }

  main { min-height: 100dvh; display: grid; place-items: center; padding: 20px; }
  .card { width: min(360px, 100%); display: grid; gap: 12px; }
  .brand { font-family: var(--rj-mono); font-size: 32px; font-weight: 800; letter-spacing: -0.03em; text-align: center; }
  .dot { color: var(--rj-accent); }
  .tag { margin: -4px 0 14px; text-align: center; font-family: var(--rj-mono); font-size: 12.5px; color: var(--rj-text-faint); }
  input {
    height: 52px; padding: 0 20px;
    font-size: 16px; color: var(--rj-text);
    background: var(--rj-surface);
    border: 1px solid var(--rj-hairline);
    border-radius: 10px;
    outline: none;
    transition: border-color .15s, background .15s;
  }
  input::placeholder { color: var(--rj-text-faint); }
  /* paper edge: keep webkit autofill on-token instead of the native light paint */
  input:-webkit-autofill { -webkit-box-shadow: 0 0 0 1000px var(--rj-surface) inset; -webkit-text-fill-color: var(--rj-text); caret-color: var(--rj-text); transition: background-color 9999s ease-out; }
  input:focus { border-color: var(--rj-hairline-strong); background: var(--rj-surface-2); }
  .go {
    height: 52px; border: none; border-radius: 10px;
    font-size: 16px; font-weight: 700;
    color: var(--rj-accent-ink); background: var(--rj-accent);
    transition: transform .1s, filter .15s;
  }
  .go:hover { filter: brightness(1.07); }
  .go:active { transform: translateY(1px); }
  .go:disabled { opacity: .5; cursor: default; }
  .err { margin: 0; text-align: center; color: var(--rj-danger); font-size: 13px; }
  .note { margin: 0; text-align: center; color: var(--rj-accent); font-size: 13px; }
  .flip { background: none; border: 0; padding: 0; color: var(--rj-text-dim); font-family: var(--rj-mono); font-size: 12px; text-decoration: underline; cursor: pointer; }
  .fine { margin: 6px 0 0; text-align: center; font-family: var(--rj-mono); font-size: 12px; color: var(--rj-text-faint); }
  .showpw { align-self: flex-end; justify-self: end; background: none; border: 0; color: var(--rj-text-dim); font-family: var(--rj-mono); font-size: 11.5px; text-decoration: underline; padding: 2px 4px; margin-top: -4px; }

  /* touch hit-slop: pseudo-element grows tap targets toward 44px on coarse/no-hover pointers, where layout/stacking allow; visual size and desktop unchanged. exceptions: see review notes */
  @media (hover: none), (pointer: coarse) {
    .showpw { position: relative; } .showpw::after { content: ''; position: absolute; left: 0; right: 0; top: -13px; bottom: -13px; }
    .flip { position: relative; } .flip::after { content: ''; position: absolute; left: 0; right: 0; top: -15px; bottom: -15px; }
  }
  input:focus-visible { outline: 2px solid var(--rj-text); outline-offset: 2px; }
  .err::before { content: "!"; display: inline-block; width: 1em; height: 1em; line-height: 1em; text-align: center; border: 1px solid currentColor; border-radius: 50%; margin-right: 6px; font-size: .85em; vertical-align: baseline; }
  @font-face { font-family: PS; src: url(/assets/IBMPlexSans-var-GRPhyGEp.woff2) format("woff2"); font-weight: 100 700; font-display: swap; }
  @font-face { font-family: PM; src: url(/assets/IBMPlexMono-400-normal-C-SBB-bw.woff2) format("woff2"); font-weight: 400; font-display: swap; }
  @font-face { font-family: PM; src: url(/assets/IBMPlexMono-500-normal-B772pXP5.woff2) format("woff2"); font-weight: 500; font-display: swap; }
  :global(body) { --rj-bg: #0a0a0a; --rj-surface: #141414; --rj-surface-2: #1f1f1f; --rj-border: rgba(255,255,255,.08); --rj-text: #f2f2f2; --rj-text-dim: #8f8f8f; --rj-text-faint: #8f8f8f; --rj-accent: #ffffff; --rj-accent-ink: #0a0a0a; --rj-danger: #ffffff; --rj-font: "PS", system-ui, "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif; --rj-mono: "PM", ui-monospace, monospace; --rj-hairline: rgba(255,255,255,.08); --rj-hairline-strong: #333333; }
  :global(:root[data-skin=paper] body) { --rj-bg: #f2f2f2; --rj-surface: #e8e8e8; --rj-surface-2: #d4d4d4; --rj-border: rgba(29,29,29,.1); --rj-text: #0a0a0a; --rj-text-dim: #626262; --rj-text-faint: #626262; --rj-accent: #0a0a0a; --rj-accent-ink: #f2f2f2; --rj-danger: #0a0a0a; --rj-hairline: rgba(29,29,29,.1); --rj-hairline-strong: #cdcdcd; }
  .err { font-weight: 600 }
</style>
