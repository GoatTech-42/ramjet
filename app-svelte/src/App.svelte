<script>
	import { onMount } from "svelte";
	import { settings, tabs, activeTabId, status, applyTheme, applyCloak } from "./lib/rj/state.js";
	import * as bridge from "./lib/rj/bridge.js";
	import * as engine from "./lib/rj/engine.js";
	import { bootSync } from "./lib/rj/sync.js";
	import TabStrip from "./lib/TabStrip.svelte";
	import AddressBar from "./lib/AddressBar.svelte";
	import Home from "./views/Home.svelte";
	import SettingsView from "./views/SettingsView.svelte";
	import HistoryView from "./views/HistoryView.svelte";
	import DownloadsView from "./views/DownloadsView.svelte";
	let frameHostEl;
	let active = null;
	$: active = $tabs.find((t) => t.id === $activeTabId) || null;
	$: hasTabs = $tabs.length > 0;
	$: isPage = !!(active && active.page);
	$: hasFrameContent = !!(active && !active.page && (active.url || active.frame));
	$: showHome = !active || (!active.url && !active.page && !active.frame);
	$: if (typeof document !== "undefined") {
		document.body.classList.toggle("page-view", isPage);
		document.body.classList.toggle("in-flight", hasFrameContent);
	}
	onMount(() => {
		applyTheme(); applyCloak();
		bridge.registerEl("frameHost", frameHostEl);
		bridge.on("openSettings", () => engine.newPageTab("settings"));
		bootSync();
	});
</script>

<div class="shell">
	{#if !hasTabs}
		<header class="homebar">
			<svg class="mark" viewBox="0 0 64 64" aria-hidden="true"><path fill="var(--amber)" d="M11.6 39.6 L14.4 42.4 L4.7 50.7 L3.3 49.3 Z"/><path fill="var(--amber)" d="M20.6 48.6 L23.4 51.4 L15.7 57.7 L14.3 56.3 Z"/><path fill="var(--amber-deep)" d="M58 6 L12 22 L30 32 Z"/><path fill="var(--amber)" d="M58 6 L30 32 L40 50 Z"/></svg>
			<span class="word">goattech</span>
			<span class="hgap"></span>
			<button class="hbtn" aria-label="Downloads" title="Downloads" on:click={() => engine.newPageTab("downloads")}>
				<svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
			</button>
			<button class="hbtn" aria-label="Settings" title="Settings" on:click={() => engine.newPageTab("settings")}>
				<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2h.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06.06a2 2 0 0 1 2.83 0 2 2 0 0 1-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
			</button>
		</header>
	{:else}
		<TabStrip />
		<AddressBar />
	{/if}
	{#if showHome}
		<Home />
	{/if}
	{#if isPage}
		<div class="pageview">
			{#if active.page === "settings"}
				<SettingsView />
			{:else if active.page === "history"}
				<HistoryView />
			{:else if active.page === "downloads"}
				<DownloadsView />
			{/if}
		</div>
	{/if}
	{#if $status.msg}<div class="status" data-mode={$status.mode}>{$status.msg}</div>{/if}
	<div class="framehost" bind:this={frameHostEl} class:live={hasFrameContent}></div>
</div>

<style>
	.shell { min-height: 100dvh; display: flex; flex-direction: column; }
	.homebar { display: flex; align-items: center; gap: 10px; padding: calc(10px + var(--sat)) 14px 10px; }
	.mark { width: 24px; height: 24px; }
	.word { font-weight: 700; font-size: 15px; color: var(--color-muted); letter-spacing: .01em; }
	.hgap { flex: 1; }
	.hbtn { display: flex; align-items: center; justify-content: center; width: 34px; height: 34px; border: none; border-radius: 9px; background: none; color: var(--color-muted); cursor: pointer; }
	.hbtn:hover { background: var(--color-panel); color: var(--color-fg); }
	.pageview { position: fixed; inset: 84px 0 0 0; overflow-y: auto; background: var(--color-ink); z-index: 9; }
	.status {
		position: fixed; left: 50%; transform: translateX(-50%); bottom: calc(14px + var(--sab)); z-index: 60;
		background: var(--color-panel-2); border: 1px solid var(--color-edge); border-radius: 999px;
		padding: 8px 18px; font-size: 13px; color: var(--color-muted);
		box-shadow: 0 10px 30px rgba(0,0,0,.5);
	}
	.status[data-mode="busy"] { color: var(--amber); }
	.framehost { display: none; }
	.framehost.live { display: block; position: fixed; inset: 84px 0 0 0; background: #fff; overflow: hidden; z-index: 10; }
</style>
