<script>
	import { onMount } from "svelte";
	import {
		settings, saveSettings, bookmarks, saveBookmarks, history, saveHistory,
		tabs, activeTabId, THEMES, ENGINES, CLOAKS, DEFAULTS,
		applyTheme, applyCloak, effectivePageMode,
	} from "../lib/rj/state.js";
	import * as engine from "../lib/rj/engine.js";
	import AccountSection from "../lib/AccountSection.svelte";
	import SiteStorage from "../lib/SiteStorage.svelte";

	let page = "appearance";
	let changelog = null;
	$: active = $tabs.find((t) => t.id === $activeTabId) || null;

	const PAGES = [
		["appearance", "appearance"], ["search", "search"], ["startup", "startup"],
		["data", "data saver"], ["cloak", "cloak & panic"], ["privacy", "privacy"],
		["bookmarks", "bookmarks"], ["account", "account"], ["about", "about"],
	];
	function set(k, v) { saveSettings({ ...$settings, [k]: v }); }
	function setTheme(t) {
		const s = { ...$settings, theme: t };
		if (t === "custom" && !s.customAccent) s.customAccent = "#ffa028";
		saveSettings(s); applyTheme();
	}
	function setAccent(v) { saveSettings({ ...$settings, theme: "custom", customAccent: v }); applyTheme(); }
	function setZoom(v) { set("zoom", v); engine.applyZoom(); }
	function setCloak(v) {
		const s = { ...$settings, cloak: v };
		if (v !== "off") s.lastCloak = v;
		saveSettings(s); applyCloak();
	}
	function setPageMode(v) { saveSettings({ ...$settings, pageMode: v, pageModeExplicit: true }); }
	function setPanicUrl(v) { set("panicUrl", v.trim() || DEFAULTS.panicUrl); }
	function bmDel(b) { saveBookmarks(($bookmarks || []).filter((x) => x.url !== b.url)); }
	function bmOpen(b) { engine.newTab(); engine.ignite(b.url); }
	function histOpen(h) { engine.newTab(); engine.ignite(h.url); }
	function hostOf(u) { try { return new URL(u).hostname; } catch (e) { return u; } }

	const esc = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	function renderChangelog(md) {
		let html = "", inList = false;
		for (const raw of md.split("\n")) {
			const line = raw.trim();
			if (line.startsWith("## ")) {
				if (inList) { html += "</ul>"; inList = false; }
				html += "<h4>" + esc(line.slice(3)) + "</h4>";
			} else if (line.startsWith("- ")) {
				if (!inList) { html += "<ul>"; inList = true; }
				html += "<li>" + esc(line.slice(2)) + "</li>";
			} else if (line && !line.startsWith("# ")) {
				if (inList) { html += "</ul>"; inList = false; }
				html += "<p>" + esc(line) + "</p>";
			}
		}
		if (inList) html += "</ul>";
		return html || '<p class="muted">no changelog yet</p>';
	}
	async function loadChangelog() {
		if (changelog !== null) return;
		try {
			const res = await fetch("/CHANGELOG.md", { cache: "no-store" });
			if (!res.ok) throw new Error("no changelog");
			changelog = renderChangelog(await res.text());
		} catch (e) { changelog = '<p class="muted">no changelog yet</p>'; }
	}
	$: if (page === "about") loadChangelog();
</script>

<div class="setwrap">
	<header class="phead">
		<h2>Settings</h2>
		<button class="x" aria-label="Close" on:click={() => active && engine.closeTab(active)}>&times;</button>
	</header>
	<div class="setbody">
		<nav class="snav">
			{#each PAGES as [key, label]}
				<button type="button" class:on={page === key} on:click={() => (page = key)}>{label}</button>
			{/each}
		</nav>
		<div class="scol">
			{#if page === "appearance"}
				<section>
					<h3>Appearance</h3>
					<select value={$settings.zoom} on:change={(e) => setZoom(e.target.value)} aria-label="Zoom" style="margin-bottom:14px">
						{#each ["80", "90", "100", "110", "125", "150"] as z}
							<option value={z}>Zoom {z}%</option>
						{/each}
					</select>
					<div class="swatches">
						{#each Object.keys(THEMES) as t}
							<button type="button" class:on={$settings.theme === t} style="--sw:{THEMES[t][0]}" on:click={() => setTheme(t)}>{t}</button>
						{/each}
						<button type="button" class:on={$settings.theme === "custom"} style="--sw:{$settings.customAccent || "#ffa028"}" on:click={() => setTheme("custom")}>custom</button>
					</div>
					{#if $settings.theme === "custom"}
						<label class="check">Accent color <input type="color" value={$settings.customAccent || "#ffa028"} on:input={(e) => setAccent(e.target.value)}></label>
					{/if}
				</section>
			{:else if page === "search"}
				<section>
					<h3>Search engine</h3>
					<select value={$settings.engine} on:change={(e) => set("engine", e.target.value)}>
						{#each Object.keys(ENGINES) as k}
							<option value={k}>{ENGINES[k][0]}</option>
						{/each}
						<option value="custom">custom</option>
					</select>
					{#if $settings.engine === "custom"}
						<div class="stack">
							<input type="text" placeholder="name" spellcheck="false" aria-label="Engine name" value={$settings.customEngineName || ""} on:change={(e) => set("customEngineName", e.target.value.trim())}>
							<input type="text" inputmode="url" placeholder="search url, %s where the query goes" spellcheck="false" aria-label="Engine search URL" value={$settings.customEngineUrl || ""} on:change={(e) => set("customEngineUrl", e.target.value.trim())}>
						</div>
					{/if}
				</section>
			{:else if page === "startup"}
				<section>
					<h3>Startup</h3>
					<label class="check"><input type="checkbox" checked={$settings.restoreTabs !== false} on:change={(e) => set("restoreTabs", e.target.checked)}> Reopen tabs from last session</label>
				</section>
			{:else if page === "data"}
				<section>
					<h3>Data saver</h3>
					<label class="check"><input type="checkbox" checked={!!$settings.lowData} on:change={(e) => set("lowData", e.target.checked)}> Low data mode</label>
					<p class="muted small">images load as you scroll, no autoplay, no background preloading. phones only.</p>
				</section>
			{:else if page === "cloak"}
				<section>
					<h3>Tab cloak</h3>
					<button class="act" on:click={() => engine.popOutFullPage()}>pop out full page</button>
					<select value={effectivePageMode()} on:change={(e) => setPageMode(e.target.value)} style="margin-top:10px">
						<option value="embedded">Open sites in the app</option>
						<option value="full">Open sites full-page (with bar)</option>
						<option value="fullbare">Open sites full-page (no bar)</option>
					</select>
					<select value={$settings.cloak} on:change={(e) => setCloak(e.target.value)} style="margin-top:10px">
						{#each Object.keys(CLOAKS) as k}
							<option value={k}>{k === "off" ? "Off" : CLOAKS[k][0]}</option>
						{/each}
					</select>
				</section>
				<section>
					<h3>Panic key</h3>
					<div class="rowline">
						<select value={$settings.panicKey} on:change={(e) => set("panicKey", e.target.value)}>
							<option value="`">` (backtick)</option>
							<option value="F9">F9</option>
							<option value="Pause">Pause</option>
						</select>
						<input type="text" inputmode="url" spellcheck="false" placeholder="https://example.com" aria-label="Panic destination" value={$settings.panicUrl} on:change={(e) => setPanicUrl(e.target.value)}>
					</div>
				</section>
			{:else if page === "privacy"}
				<section>
					<h3>History <button class="mini" on:click={() => engine.newPageTab("history")}>full page</button> <button class="mini" on:click={() => saveHistory([])}>clear</button></h3>
					<ul class="plist">
						{#if !($history || []).length}
							<li class="muted">nothing yet - where you fly shows up here</li>
						{/if}
						{#each ($history || []).slice(0, 20) as h (h.ts + h.url)}
							<li><button class="plink" title={h.url} on:click={() => histOpen(h)}>{hostOf(h.url)}</button></li>
						{/each}
					</ul>
					<label class="check"><input type="checkbox" checked={!!$settings.clearOnExit} on:change={(e) => set("clearOnExit", e.target.checked)}> Clear history when ramjet closes</label>
					<label class="check"><input type="checkbox" checked={!!$settings.clearCookiesOnExit} on:change={(e) => set("clearCookiesOnExit", e.target.checked)}> Clear cookies when ramjet closes</label>
				</section>
				<section>
					<h3>Site storage</h3>
					<SiteStorage />
				</section>
			{:else if page === "bookmarks"}
				<section>
					<h3>Bookmarks</h3>
					<ul class="plist">
						{#if !($bookmarks || []).length}
							<li class="muted">no bookmarks yet - star a page while flying</li>
						{/if}
						{#each $bookmarks as b (b.url)}
							<li class="bmrow">
								<button class="plink" title={b.url} on:click={() => bmOpen(b)}>{hostOf(b.url)}</button>
								<button class="mini" title="Remove" on:click={() => bmDel(b)}>&times;</button>
							</li>
						{/each}
					</ul>
				</section>
			{:else if page === "account"}
				<section>
					<h3>Account</h3>
					<AccountSection />
				</section>
			{:else if page === "about"}
				<section>
					<h3>What's new</h3>
					<div class="clog">{@html changelog || '<p class="muted">loading...</p>'}</div>
				</section>
				<section>
					<h3>Shortcuts</h3>
					<ul class="keys">
						<li><span class="kbd">/</span> or <span class="kbd">ctrl k</span> focus the bar</li>
						<li><span class="kbd">`</span> panic</li>
						<li><span class="kbd">esc</span> close this panel</li>
						<li><span class="kbd">enter</span> ignite</li>
						<li><span class="kbd">ctrl l</span> focus the bar</li>
						<li><span class="kbd">ctrl f</span> find in page</li>
						<li><span class="kbd">alt &#8592;&#8594;</span> back / forward</li>
					</ul>
				</section>
				<p class="ver">ramjet v2 (svelte)</p>
			{/if}
		</div>
	</div>
</div>

<style>
	.setwrap { max-width: 860px; margin: 0 auto; padding: 18px 16px 60px; }
	.phead { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
	h2 { margin: 0; font-size: 19px; font-weight: 800; }
	.x { background: none; border: none; color: var(--color-muted); font-size: 24px; cursor: pointer; padding: 2px 8px; }
	.x:hover { color: var(--color-fg); }
	.setbody { display: flex; gap: 22px; align-items: flex-start; }
	.snav { display: flex; flex-direction: column; gap: 2px; flex: none; min-width: 128px; }
	.snav button { background: none; border: none; color: var(--color-muted); font: inherit; font-size: 13.5px; text-align: left; padding: 7px 12px; border-radius: 9px; cursor: pointer; }
	.snav button:hover { color: var(--color-fg); background: rgba(255,255,255,.05); }
	.snav button.on { color: var(--amber); background: rgba(255,160,40,.09); font-weight: 700; }
	.scol { flex: 1; min-width: 0; }
	section { margin-bottom: 26px; }
	h3 { margin: 0 0 10px; font-size: 14px; font-weight: 800; }
	select { background: var(--color-panel); border: 1px solid var(--color-edge); border-radius: 10px; color: var(--color-fg); padding: 8px 10px; font: inherit; font-size: 13.5px; width: 100%; max-width: 340px; }
	input[type="text"] { background: var(--color-panel); border: 1px solid var(--color-edge); border-radius: 10px; color: var(--color-fg); padding: 9px 13px; font: inherit; font-size: 13.5px; outline: none; width: 100%; max-width: 340px; }
	input[type="text"]:focus { border-color: var(--amber-deep); }
	.stack { display: flex; flex-direction: column; gap: 7px; margin-top: 9px; }
	.rowline { display: flex; gap: 8px; }
	.rowline select { flex: none; width: auto; }
	.rowline input { flex: 1; }
	.swatches { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
	.swatches button { background: var(--color-panel); border: 1px solid var(--color-edge); border-radius: 999px; color: var(--color-fg); font: inherit; font-size: 13px; padding: 7px 15px 7px 11px; cursor: pointer; display: inline-flex; align-items: center; gap: 8px; }
	.swatches button::before { content: ""; width: 14px; height: 14px; border-radius: 50%; background: var(--sw); }
	.swatches button.on { border-color: var(--amber-deep); color: var(--amber); font-weight: 700; }
	.check { display: flex; align-items: center; gap: 8px; margin-top: 10px; font-size: 13.5px; cursor: pointer; }
	.check input { accent-color: var(--amber); width: 16px; height: 16px; }
	.muted { color: var(--color-muted); font-size: 13px; }
	.small { font-size: 12.5px; margin-top: 6px; }
	.act { background: var(--color-panel); border: 1px solid var(--color-edge); border-radius: 10px; color: var(--color-fg); padding: 8px 16px; font: inherit; font-size: 13.5px; font-weight: 600; cursor: pointer; display: block; margin-bottom: 2px; }
	.act:hover { border-color: var(--amber-deep); color: var(--amber); }
	.mini { background: none; border: 1px solid var(--color-edge); border-radius: 8px; color: var(--color-muted); font-size: 11.5px; padding: 3px 9px; cursor: pointer; }
	.mini:hover { color: var(--amber); border-color: var(--amber-deep); }
	.plist { list-style: none; margin: 0 0 10px; padding: 0; }
	.plist li { padding: 3px 0; }
	.bmrow { display: flex; align-items: center; gap: 8px; }
	.plink { background: none; border: none; color: var(--color-fg); font: inherit; font-size: 13.5px; cursor: pointer; padding: 3px 0; text-align: left; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.plink:hover { color: var(--amber); }
	.keys { list-style: none; margin: 0; padding: 0; color: var(--color-muted); font-size: 13px; }
	.keys li { padding: 4px 0; }
	.kbd { background: var(--color-panel); border: 1px solid var(--color-edge); border-radius: 6px; padding: 1px 7px; font-size: 11.5px; color: var(--color-fg); font-family: var(--mono, monospace); }
	.ver { color: var(--color-muted); font-size: 12px; margin-top: 20px; }
	.clog { font-size: 13.5px; }
	.clog :global(h4) { margin: 14px 0 6px; font-size: 13px; }
	.clog :global(ul) { margin: 6px 0; padding-left: 20px; }
	.clog :global(p) { margin: 6px 0; }
	.clog :global(.muted) { color: var(--color-muted); }
	@media (max-width: 640px) {
		.setbody { flex-direction: column; gap: 14px; }
		.snav { flex-direction: row; flex-wrap: wrap; }
	}
</style>
