<script>
	import { downloads, tabs, activeTabId } from "../lib/rj/state.js";
	import * as engine from "../lib/rj/engine.js";
	$: active = $tabs.find((t) => t.id === $activeTabId) || null;
	function fmtSize(n) {
		if (!n) return "";
		const u = ["B", "KB", "MB", "GB"];
		let i = 0;
		while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
		return (n >= 100 ? Math.round(n) : n.toFixed(1)) + " " + u[i];
	}
	function hostOf(url) { try { return new URL(url).hostname; } catch (e) { return ""; } }
	function metaText(d) {
		const got = fmtSize(d.received);
		if (d.state === "done") return fmtSize(d.size || d.received) + " - done";
		if (d.state === "paused") return got + (d.size ? " of " + fmtSize(d.size) : "") + " - paused";
		if (d.state === "error") return "failed - " + (d.error || "unknown");
		if (d.state === "interrupted") return "interrupted - retry to restart";
		return got + (d.size ? " of " + fmtSize(d.size) : "");
	}
	function pct(d) { return d.state === "done" ? 100 : d.size ? Math.min(100, (d.received / d.size) * 100) : 0; }
	$: hasFinished = ($downloads || []).some((d) => d.state !== "downloading");
</script>

<div class="page">
	<header class="phead">
		<h2>Downloads</h2>
		<button class="x" aria-label="Close" on:click={() => active && engine.closeTab(active)}>&times;</button>
	</header>
	{#if !($downloads || []).length}
		<p class="empty">nothing downloaded yet</p>
	{/if}
	{#each $downloads as d (d.id)}
		<div class="row">
			<div class="main">
				<div class="name" title={d.name}>{d.name}</div>
				<div class="meta">{hostOf(d.url) ? hostOf(d.url) + " - " : ""}{metaText(d)}</div>
				{#if d.state === "downloading" || d.state === "paused"}
					<div class="bar" class:indet={d.state === "downloading" && !d.size}><div class="fill" style="width:{pct(d)}%"></div></div>
				{/if}
			</div>
			<div class="acts">
				{#if d.state === "downloading"}
					<button class="act" on:click={() => engine.dlPause(d)}>pause</button>
					<button class="mini" on:click={() => engine.dlForget(d)}>cancel</button>
				{:else if d.state === "paused"}
					<button class="act" on:click={() => engine.dlResume(d)}>resume</button>
					<button class="mini" on:click={() => engine.dlForget(d)}>cancel</button>
				{:else if d.state === "done"}
					<button class="act" on:click={() => engine.dlSave(d)}>save</button>
					<button class="act" on:click={() => engine.dlOpenTab(d)}>open in tab</button>
					<button class="mini" on:click={() => engine.dlForget(d)}>remove</button>
				{:else}
					<button class="act" on:click={() => engine.dlResume(d)}>retry</button>
					<button class="mini" on:click={() => engine.dlForget(d)}>remove</button>
				{/if}
			</div>
		</div>
	{/each}
	{#if hasFinished}
		<button class="act clear" on:click={() => engine.dlClearFinished()}>clear finished</button>
	{/if}
</div>

<style>
	.page { max-width: 760px; margin: 0 auto; padding: 18px 16px 60px; }
	.phead { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
	h2 { margin: 0; font-size: 19px; font-weight: 800; }
	.x { background: none; border: none; color: var(--color-muted); font-size: 24px; cursor: pointer; padding: 2px 8px; }
	.x:hover { color: var(--color-fg); }
	.empty { color: var(--color-muted); font-size: 13.5px; text-align: center; margin-top: 30px; }
	.row { display: flex; align-items: center; gap: 14px; padding: 12px 4px; border-bottom: 1px solid var(--color-edge); }
	.main { flex: 1; min-width: 0; }
	.name { font-size: 14px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.meta { color: var(--color-muted); font-size: 12px; margin-top: 2px; }
	.bar { height: 4px; background: var(--color-edge); border-radius: 99px; margin-top: 8px; overflow: hidden; }
	.fill { height: 100%; background: var(--amber); border-radius: 99px; transition: width .25s; }
	.bar.indet .fill { width: 40% !important; animation: slide 1.1s ease-in-out infinite alternate; }
	@keyframes slide { from { margin-left: 0; } to { margin-left: 60%; } }
	.acts { display: flex; gap: 6px; flex: none; }
	.act { background: var(--color-panel); border: 1px solid var(--color-edge); border-radius: 9px; color: var(--color-fg); padding: 6px 13px; font: inherit; font-size: 12.5px; font-weight: 600; cursor: pointer; }
	.act:hover { border-color: var(--amber-deep); color: var(--amber); }
	.mini { background: none; border: 1px solid var(--color-edge); border-radius: 9px; color: var(--color-muted); font-size: 11.5px; padding: 5px 10px; cursor: pointer; }
	.mini:hover { color: var(--amber); border-color: var(--amber-deep); }
	.clear { margin-top: 16px; }
</style>
