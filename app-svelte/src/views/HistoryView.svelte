<script>
	import { history, saveHistory, tabs, activeTabId } from "../lib/rj/state.js";
	import * as engine from "../lib/rj/engine.js";
	let q = "";
	let range = "hour";
	$: active = $tabs.find((t) => t.id === $activeTabId) || null;
	function histTime(ts) {
		const d = new Date(ts);
		const sameDay = d.toDateString() === new Date().toDateString();
		if (sameDay) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
		return d.toLocaleDateString([], { month: "short", day: "numeric" });
	}
	function hostOf(u) { try { return new URL(u).hostname; } catch (e) { return u; } }
	$: query = q.trim().toLowerCase();
	$: matches = ($history || []).filter((h) => !query || h.url.toLowerCase().includes(query) || (h.title || "").toLowerCase().includes(query));
	$: groups = (() => {
		const byHost = {};
		for (const h of matches) {
			const host = hostOf(h.url);
			if (!byHost[host]) byHost[host] = { host, entries: [], latest: 0 };
			byHost[host].entries.push(h);
			if (h.ts > byHost[host].latest) byHost[host].latest = h.ts;
		}
		return Object.values(byHost).sort((a, b) => b.latest - a.latest);
	})();
	function go(url) { engine.newTab(); engine.ignite(url); }
	function rm(entry) { saveHistory(($history || []).filter((x) => x !== entry)); }
	function clearSite(host) { saveHistory(($history || []).filter((h) => hostOf(h.url) !== host)); }
	function clearRange() {
		if (range === "all") { saveHistory([]); return; }
		let cutoff = 0;
		if (range === "hour") cutoff = Date.now() - 3600e3;
		else { const n = new Date(); cutoff = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime(); }
		saveHistory(($history || []).filter((h) => h.ts < cutoff));
	}
</script>

<div class="page">
	<header class="phead">
		<h2>History</h2>
		<button class="x" aria-label="Close" on:click={() => active && engine.closeTab(active)}>&times;</button>
	</header>
	<div class="tools">
		<input type="text" placeholder="search history" bind:value={q} autocomplete="off" spellcheck="false">
		<select bind:value={range} aria-label="Clear range">
			<option value="hour">last hour</option>
			<option value="day">today</option>
			<option value="all">all time</option>
		</select>
		<button class="act" on:click={clearRange}>clear</button>
	</div>
	{#if !groups.length}
		<p class="empty">nothing matches</p>
	{/if}
	{#each groups as g (g.host)}
		<div class="group">
			<div class="gsite">
				<span>{g.host} ({g.entries.length})</span>
				<button class="mini" on:click={() => clearSite(g.host)}>clear site</button>
			</div>
			{#each g.entries as h (h.ts + h.url)}
				<div class="entry">
					<button class="link" title={h.url} on:click={() => go(h.url)}>{h.title || h.url}</button>
					<span class="time">{histTime(h.ts)}</span>
					<button class="mini" aria-label="Remove" on:click={() => rm(h)}>&times;</button>
				</div>
			{/each}
		</div>
	{/each}
</div>

<style>
	.page { max-width: 760px; margin: 0 auto; padding: 18px 16px 60px; }
	.phead { display: flex; align-items: center; justify-content: space-between; }
	h2 { margin: 0; font-size: 19px; font-weight: 800; }
	.x { background: none; border: none; color: var(--color-muted); font-size: 24px; cursor: pointer; padding: 2px 8px; }
	.x:hover { color: var(--color-fg); }
	.tools { display: flex; gap: 8px; margin: 14px 0 18px; }
	.tools input { flex: 1; min-width: 0; background: var(--color-panel); border: 1px solid var(--color-edge); border-radius: 10px; color: var(--color-fg); padding: 9px 13px; font: inherit; font-size: 14px; outline: none; }
	.tools input:focus { border-color: var(--amber-deep); }
	.tools select { background: var(--color-panel); border: 1px solid var(--color-edge); border-radius: 10px; color: var(--color-fg); padding: 8px 10px; font: inherit; font-size: 13.5px; }
	.act { background: var(--color-panel); border: 1px solid var(--color-edge); border-radius: 10px; color: var(--color-fg); padding: 8px 16px; font: inherit; font-size: 13.5px; font-weight: 600; cursor: pointer; }
	.act:hover { border-color: var(--amber-deep); color: var(--amber); }
	.empty { color: var(--color-muted); font-size: 13.5px; text-align: center; margin-top: 30px; }
	.group { margin-bottom: 18px; }
	.gsite { display: flex; align-items: center; justify-content: space-between; color: var(--color-muted); font-size: 12.5px; font-weight: 700; padding: 6px 2px; border-bottom: 1px solid var(--color-edge); margin-bottom: 4px; }
	.entry { display: flex; align-items: center; gap: 10px; padding: 5px 2px; }
	.link { flex: 1; min-width: 0; background: none; border: none; color: var(--color-fg); font: inherit; font-size: 14px; text-align: left; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding: 3px 0; }
	.link:hover { color: var(--amber); }
	.time { color: var(--color-muted); font-size: 12px; flex: none; }
	.mini { background: none; border: 1px solid var(--color-edge); border-radius: 8px; color: var(--color-muted); font-size: 11.5px; padding: 3px 9px; cursor: pointer; flex: none; }
	.mini:hover { color: var(--amber); border-color: var(--amber-deep); }
</style>
