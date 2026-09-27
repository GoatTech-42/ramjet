<script>
	import { onMount } from "svelte";
	import { meInfo, syncState } from "./rj/state.js";
	import * as sync from "./rj/sync.js";
	let admin = null;
	$: if ($meInfo && $meInfo.role === "admin" && !admin) loadAdmin();
	async function loadAdmin() { admin = await sync.adminLoad(); }
	onMount(() => { if ($meInfo && $meInfo.role === "admin") loadAdmin(); });
	$: stateText = !$meInfo || !$meInfo.user ? "" : !$meInfo.syncEnabled ? "sync off" : ($syncState || "locked");
	async function toggleSync() { await sync.syncToggle(); }
	async function unlock() {
		const pw = prompt("password to unlock your encrypted data:");
		if (!pw) return;
		const ok = await sync.unlockSync(pw);
		if (!ok) alert("could not unlock - wrong password?");
	}
	async function changePw() {
		const oldPw = prompt("current password:");
		if (!oldPw) return;
		const newPw = prompt("new password (4+ chars):");
		if (!newPw || newPw.length < 4) { alert("new password too short"); return; }
		const r = await sync.changePassword(oldPw, newPw);
		alert(r.ok ? "password changed" : "failed: " + (r.error || "unknown"));
	}
	async function adminAct(action, username) { await sync.adminAction(action, username); loadAdmin(); }
	async function setConfig(key, ev) { await sync.adminConfig(key, ev.target.checked); }
</script>

{#if !$meInfo || !$meInfo.user}
	<p class="muted">not signed in</p>
{:else}
	<div class="row between">
		<span class="who">{$meInfo.user}{$meInfo.role === "admin" ? " (admin)" : ""}</span>
		<span class="state">{stateText}</span>
	</div>
	<label class="check"><input type="checkbox" checked={!!$meInfo.syncEnabled} on:change={toggleSync}> sync cookies + site data for this account</label>
	<div class="row btns">
		{#if $syncState === "locked" || ($meInfo.syncEnabled && !$syncState)}
			<button class="mini" on:click={unlock}>unlock sync</button>
		{/if}
		<button class="mini" on:click={changePw}>change password</button>
		<button class="mini" on:click={() => sync.signOut()}>sign out</button>
	</div>
{/if}

{#if $meInfo && $meInfo.role === "admin"}
	<h3 class="admh">Admin</h3>
	{#if admin}
		{#each admin.users as u (u.username)}
			<div class="row between urow">
				<span class="who">{u.username} - {u.status}{u.role === "admin" ? " (admin)" : ""}</span>
				<span class="acts">
					{#if u.username !== $meInfo.user}
						{#if u.status === "pending"}<button class="mini" on:click={() => adminAct("approve", u.username)}>approve</button><button class="mini" on:click={() => adminAct("deny", u.username)}>deny</button>{/if}
						{#if u.status === "denied"}<button class="mini" on:click={() => adminAct("approve", u.username)}>approve</button>{/if}
						<button class="mini" on:click={() => adminAct("sync-toggle", u.username)}>{u.syncEnabled ? "sync: on" : "sync: off"}</button>
						<button class="mini" on:click={() => adminAct("remove", u.username)}>remove</button>
					{/if}
				</span>
			</div>
		{/each}
		<label class="check"><input type="checkbox" checked={!!admin.requireApproval} on:change={(ev) => setConfig("requireApproval", ev)}> Require approval for new accounts</label>
		<label class="check"><input type="checkbox" checked={admin.adblock !== false} on:change={(ev) => setConfig("adblock", ev)}> Block ads &amp; trackers (global)</label>
	{:else}
		<p class="muted">loading...</p>
	{/if}
{/if}

<style>
	.muted { color: var(--color-muted); font-size: 13px; }
	.row { display: flex; align-items: center; gap: 8px; }
	.between { justify-content: space-between; }
	.who { font-size: 14px; font-weight: 600; }
	.state { color: var(--color-muted); font-size: 12px; }
	.check { display: flex; align-items: center; gap: 8px; margin-top: 10px; font-size: 13.5px; cursor: pointer; }
	.check input { accent-color: var(--amber); width: 16px; height: 16px; }
	.btns { margin-top: 10px; flex-wrap: wrap; }
	.mini { background: none; border: 1px solid var(--color-edge); border-radius: 8px; color: var(--color-muted); font-size: 11.5px; padding: 4px 10px; cursor: pointer; }
	.mini:hover { color: var(--amber); border-color: var(--amber-deep); }
	.admh { margin: 22px 0 8px; font-size: 14px; font-weight: 800; }
	.urow { padding: 6px 0; border-bottom: 1px solid var(--color-edge); }
	.acts { display: flex; gap: 5px; flex-wrap: wrap; }
</style>
