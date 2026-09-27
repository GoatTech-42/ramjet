<script>
	import { onMount } from "svelte";
	import { tabs, activeTabId, bookmarks, saveBookmarks, settings, saveSettings, applyCloak, effectivePageMode, downloads } from "./rj/state.js";
	import * as engine from "./rj/engine.js";
	import * as bridge from "./rj/bridge.js";
	let inputEl;
	let active = null;
	$: active = $tabs.find((t) => t.id === $activeTabId) || null;
	$: curUrl = active && active.url ? active.url : "";
	$: starred = curUrl && ($bookmarks || []).some((b) => b.url === curUrl);
	$: dlActive = ($downloads || []).filter((d) => d.state === "downloading").length;
	onMount(() => { bridge.registerEl("address", inputEl); });
	function nav(kind) {
		if (!active || !active.frame) return;
		try {
			const w = active.frame.frame.contentWindow;
			if (kind === "back") w.history.back();
			else if (kind === "fwd") w.history.forward();
			else if (kind === "reload") w.location.reload();
		} catch (e) {}
	}
	function go() {
		const dest = engine.resolveInput(inputEl.value);
		if (dest) engine.ignite(dest);
	}
	function star() {
		if (!curUrl) return;
		if (starred) saveBookmarks(($bookmarks || []).filter((b) => b.url !== curUrl));
		else saveBookmarks([...($bookmarks || []), { url: curUrl, title: active.title || curUrl, ts: Date.now() }]);
	}
	function cloak() {
		const s = { ...$settings };
		if (s.cloak === "off") { s.cloak = s.lastCloak || "docs"; }
		else { s.lastCloak = s.cloak; s.cloak = "off"; }
		saveSettings(s); applyCloak();
	}
</script>

<form class="abar" on:submit|preventDefault={go} autocomplete="off" spellcheck="false">
	<div class="nbtn-row">
		<button type="button" class="nb" aria-label="Back" on:click={() => nav("back")}>&#8592;</button>
		<button type="button" class="nb" aria-label="Forward" on:click={() => nav("fwd")}>&#8594;</button>
		<button type="button" class="nb" aria-label="Reload" on:click={() => nav("reload")}>&#10227;</button>
		<button type="button" class="nb" aria-label="Home" on:click={() => engine.newTab()}>
			<svg viewBox="0 0 64 64" width="17" height="17" aria-hidden="true"><path fill="var(--amber)" d="M11.6 39.6 L14.4 42.4 L4.7 50.7 L3.3 49.3 Z"/><path fill="var(--amber)" d="M20.6 48.6 L23.4 51.4 L15.7 57.7 L14.3 56.3 Z"/><path fill="var(--amber-deep)" d="M58 6 L12 22 L30 32 Z"/><path fill="var(--amber)" d="M58 6 L30 32 L40 50 Z"/></svg>
		</button>
	</div>
	<input bind:this={inputEl} type="text" inputmode="url" placeholder="type a url or search" aria-label="Address or search" value={curUrl && !curUrl.startsWith("/") ? curUrl : ""}>
	<div class="nbtn-row">
		<button type="button" class="nb" class:starred aria-label="Bookmark" on:click={star}>{starred ? "★" : "☆"}</button>
		<button type="button" class="nb dlb" aria-label="Downloads" title="Downloads" on:click={() => engine.newPageTab("downloads")}>
			<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
			{#if dlActive}<span class="dlbadge">{dlActive}</span>{/if}
		</button>
		<button type="button" class="nb" class:on={$settings.cloak !== "off"} aria-label="Cloak" title="Tab cloak" on:click={cloak}>
			<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>
		</button>
		<button type="button" class="nb" aria-label="Settings" on:click={() => bridge.openSettings()}>
			<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2h.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
		</button>
		<a class="nb" href="/auth/logout" aria-label="Lock" title="Lock">
			<svg viewBox="0 0 14 16" width="14" height="16" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="1.5" y="7" width="11" height="8" rx="1.5"/><path d="M4 7V4.5a3 3 0 0 1 6 0V7"/></svg>
		</a>
	</div>
</form>

<style>
	.abar { display: flex; align-items: center; gap: 4px; padding: 5px 8px 8px; background: var(--color-panel-2); border-bottom: 1px solid var(--color-edge); }
	.nbtn-row { display: flex; align-items: center; gap: 1px; flex: none; }
	.nb {
		display: flex; align-items: center; justify-content: center;
		min-width: 32px; height: 32px; border: none; border-radius: 9px;
		background: none; color: var(--color-muted); font-size: 15px; cursor: pointer; text-decoration: none;
	}
	.nb:hover { background: rgba(255,255,255,.08); color: var(--color-fg); }
	.nb.starred { color: var(--amber); }
	.nb.on { color: var(--amber); }
	.dlb { position: relative; }
	.dlbadge { position: absolute; top: 2px; right: 2px; background: var(--amber); color: #14100a; font-size: 9.5px; font-weight: 800; border-radius: 99px; min-width: 14px; height: 14px; display: flex; align-items: center; justify-content: center; padding: 0 3px; }
	input {
		flex: 1; min-width: 0; background: var(--color-panel); color: var(--color-fg);
		border: 1px solid var(--color-edge); border-radius: 999px;
		padding: 8px 16px; font: inherit; font-size: 13.5px; outline: none;
		transition: border-color .15s, box-shadow .15s;
	}
	input:focus { border-color: var(--amber-deep); box-shadow: 0 0 0 3px color-mix(in srgb, var(--amber) 13%, transparent); }
</style>
