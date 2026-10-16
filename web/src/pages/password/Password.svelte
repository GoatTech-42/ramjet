<script>
  import '../../tokens.css';
  import AccountFrame from '../../lib/AccountFrame.svelte';
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

<AccountFrame title="Change password" description="Keep your account yours.">
  <form onsubmit={submit}>
    <label>Current password<input bind:value={current} type="password" autocomplete="current-password" required /></label>
    <label>New password<input bind:value={next} type="password" autocomplete="new-password" required minlength="6" aria-describedby="password-help" /></label>
    <p class="fine" id="password-help">Use at least 6 characters.</p>
    {#if msg}<p class:ok class="msg" role={ok ? 'status' : 'alert'}>{msg}</p>{/if}
    <button class="go" type="submit" disabled={busy}>{busy ? 'Saving...' : 'Save password'}</button>
    <a class="back" href="/">Back to home</a>
  </form>
</AccountFrame>
