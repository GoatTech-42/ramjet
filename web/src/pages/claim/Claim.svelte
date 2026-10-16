<script>
  import '../../tokens.css';
  import AccountFrame from '../../lib/AccountFrame.svelte';
  import { api } from '../../lib/api.js';
  let name = $state('');
  let msg = $state('');
  let ok = $state(false);
  let busy = $state(false);

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    msg = ''; ok = false; busy = true;
    const r = await api('/api/auth/claim-username', { method: 'POST', body: { name } });
    busy = false;
    if (r.ok) { ok = true; msg = `yours now - you're ${r.data.user}`; return; }
    msg = r.data?.error || "that didn't work - try again";
  }
</script>

<AccountFrame title="Your name here" description="Choose the username people will know you by.">
  <form onsubmit={submit}>
    <label>New username<input bind:value={name} autocomplete="off" autocapitalize="off" required minlength="2" maxlength="24" aria-describedby="username-help" /></label>
    <p class="fine" id="username-help">2-24 characters: letters, numbers, . _ -</p>
    {#if msg}<p class:ok class="msg" role={ok ? 'status' : 'alert'}>{msg}</p>{/if}
    <button class="go" type="submit" disabled={busy}>{busy ? 'Claiming...' : 'Claim username'}</button>
    <a class="back" href="/">Back to home</a>
  </form>
</AccountFrame>
