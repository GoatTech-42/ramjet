<script>
	import { onMount } from "svelte";
	import * as sync from "./rj/sync.js";
	let sites = null;
	let openHost = null;
	async function refresh() { sites = await sync.getSiteStorageData(); }
	onMount(refresh);
	async function clearHost(host) { await sync.clearSiteStorageHost(host); refresh(); }
	async function clearAll() {
		if (!confirm("clear ALL site storage? this logs you out of every site")) return;
		await sync.clearAllSiteStorage(); refresh();
	}
	async function editCookie(id, ev) { await sync.setCookieValue(id, ev.target.value); }
	async function delCookie(id) { await sync.deleteCookie(id); refresh(); }
	function editKey(host, k, ev) { sync.setSiteKey(host, k, ev.target.value); }
	function delKey(host, k) { sync.delSiteKey(host, k); refresh(); }
</script>

<div class="ss">
	{#if sites === null}
		<p class="muted">loading...</p>
	{:else if !sites.length}
		<p class="muted">nothing stored yet</p>
	{:else}
		{#each sites as s (s.host)}
			<div class="site">
				<div class="shead">
					<span class="host">{s.host}</span>
					<span class="muted smeta">{s.cookies.length} cookies · {s.kb} KB</span>
					<button class="mini" on:click={() => (openHost = openHost === s.host ? null : s.host)}>{openHost === s.host ? "hide" : "view"}</button>
					<button class="mini" on:click={() => clearHost(s.host)}>clear</button>
				</div>
				{#if openHost === s.host}
					<div class="detail">
						{#if s.cookies.length}
							<p class="muted sub">cookies</p>
							{#each s.cookies as c (c.id)}
								<div class="line">
									<span class="k">{c.name}</span>
									<input class="v" type="text" spellcheck="false" value={c.value || ""} on:change={(ev) => editCookie(c.id, ev)}>
									<button class="mini" on:click={() => delCookie(c.id)}>del</button>
								</div>
							{/each}
						{/if}
						{#if Object.keys(s.storage).length}
							<p class="muted sub">site data</p>
							{#each Object.keys(s.storage).sort() as k (k)}
								<div class="line">
									<span class="k">{k}</span>
									<input class="v" type="text" spellcheck="false" value={s.storage[k]} on:change={(ev) => editKey(s.host, k, ev)}>
									<button class="mini" on:click={() => delKey(s.host, k)}>del</button>
								</div>
							{/each}
						{/if}
					</div>
				{/if}
			</div>
		{/each}
		<button class="mini danger" on:click={clearAll}>clear all</button>
	{/if}
</div>

<style>
	.ss { margin-top: 4px; }
	.muted { color: var(--color-muted); font-size: 12.5px; }
	.site { border: 1px solid var(--color-edge); border-radius: 10px; padding: 9px 12px; margin-bottom: 8px; }
	.shead { display: flex; align-items: center; gap: 8px; }
	.host { font-size: 13.5px; font-weight: 700; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
	.smeta { flex: none; }
	.detail { margin-top: 10px; border-top: 1px solid var(--color-edge); padding-top: 8px; }
	.sub { margin: 8px 0 4px; font-weight: 700; text-transform: uppercase; font-size: 10.5px; letter-spacing: .06em; }
	.line { display: flex; align-items: center; gap: 8px; margin-bottom: 5px; }
	.k { flex: none; max-width: 38%; overflow: hidden; text-overflow: ellipsis; font-size: 12px; color: var(--color-fg); }
	.v { flex: 1; min-width: 0; background: var(--color-panel); border: 1px solid var(--color-edge); border-radius: 7px; color: var(--color-fg); padding: 5px 9px; font: inherit; font-size: 12px; outline: none; }
	.v:focus { border-color: var(--amber-deep); }
	.mini { background: none; border: 1px solid var(--color-edge); border-radius: 8px; color: var(--color-muted); font-size: 11.5px; padding: 3px 9px; cursor: pointer; flex: none; }
	.mini:hover { color: var(--amber); border-color: var(--amber-deep); }
	.danger { margin-top: 6px; }
	.danger:hover { color: #f87171; border-color: #b91c1c; }
</style>
