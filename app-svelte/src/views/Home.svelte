<script>
	import { onMount, onDestroy } from "svelte";
	import { bookmarks } from "../lib/rj/state.js";
	import * as engine from "../lib/rj/engine.js";
	let now = new Date();
	let who = "";
	let timer;
	function tick() { now = new Date(); }
	onMount(() => {
		timer = setInterval(tick, 5000);
		fetch("/auth/me").then((r) => (r.ok ? r.json() : null)).then((d) => { who = (d && (d.user || d.username)) || ""; }).catch(() => {});
	});
	onDestroy(() => clearInterval(timer));
	$: h = now.getHours();
	$: greet = h < 5 ? "up late" : h < 12 ? "good morning" : h < 17 ? "good afternoon" : h < 22 ? "good evening" : "good night";
	$: hh = h % 12 || 12;
	$: mm = String(now.getMinutes()).padStart(2, "0");
	$: ampm = h >= 12 ? "pm" : "am";
	$: dateStr = now.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
	function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ""); } catch (e) { return ""; } }
	$: links = ($bookmarks || []).slice(0, 8).map((b) => ({ url: b.url, host: hostOf(b.url) })).filter((x) => x.host);
</script>

<main class="nt">
	<p class="nt-mark">ram<em>jet</em> <span class="nt-tag">a web proxy that butts through.</span></p>
	<div class="nt-clockwrap">
		<p class="nt-clock">{hh}:{mm}<small>{ampm}</small></p>
		<p class="nt-date">{dateStr}</p>
		<p class="nt-greet">{greet}{who ? ", " + who : ""}</p>
	</div>
	<form class="nt-search" autocomplete="off" spellcheck="false" on:submit|preventDefault={(e) => {
		const q = e.target.querySelector("input").value.trim();
		if (!q) return;
		const dest = engine.resolveInput(q);
		if (dest) engine.ignite(dest);
	}}>
		<input type="text" inputmode="url" placeholder="search the web or type a url" aria-label="Search the web or type a URL">
		<button type="submit" aria-label="Go">&#8594;</button>
	</form>
	{#if links.length}
		<div class="nt-links">
			{#each links as l}
				<a class="nt-link" href={l.url} on:click={(e) => { e.preventDefault(); engine.ignite(l.url); }}><span class="nt-letter">{l.host[0].toUpperCase()}</span><span class="nt-host">{l.host}</span></a>
			{/each}
		</div>
	{/if}
</main>

<style>
	.nt { display: flex; flex-direction: column; align-items: center; justify-content: center; flex: 1; padding: 40px 20px; gap: 18px; }
	.nt-mark { font-weight: 800; font-size: 30px; letter-spacing: -.02em; margin: 0; }
	.nt-mark em { font-style: normal; color: var(--amber); }
	.nt-tag { display: block; font-size: 13px; font-weight: 500; color: var(--color-muted); letter-spacing: 0; margin-top: 4px; }
	.nt-clockwrap { text-align: center; }
	.nt-clock { font-size: 56px; font-weight: 800; letter-spacing: -.03em; margin: 0; font-variant-numeric: tabular-nums; }
	.nt-clock small { font-size: 20px; color: var(--color-muted); margin-left: 6px; font-weight: 600; }
	.nt-date { margin: 2px 0 0; color: var(--color-muted); font-size: 14px; }
	.nt-greet { margin: 6px 0 0; color: var(--amber); font-size: 14px; font-weight: 600; }
	.nt-search { display: flex; gap: 8px; width: min(560px, 92vw); }
	.nt-search input {
		flex: 1; background: var(--color-panel); color: var(--color-fg);
		border: 1px solid var(--color-edge); border-radius: 999px;
		padding: 12px 20px; font: inherit; font-size: 15px; outline: none;
		transition: border-color .18s, box-shadow .18s;
	}
	.nt-search input:focus { border-color: var(--amber-deep); box-shadow: 0 0 0 4px color-mix(in srgb, var(--amber) 14%, transparent); }
	.nt-search button {
		background: var(--amber); color: #14100a; border: none; border-radius: 999px;
		width: 48px; font-size: 19px; cursor: pointer; font-weight: 700;
	}
	.nt-links { display: flex; flex-wrap: wrap; gap: 10px; justify-content: center; }
	.nt-link {
		display: flex; align-items: center; gap: 9px; text-decoration: none;
		background: var(--color-panel); border: 1px solid var(--color-edge);
		border-radius: 999px; padding: 8px 15px 8px 9px; font-size: 13.5px; color: var(--color-fg);
		transition: border-color .15s, transform .15s;
	}
	.nt-link:hover { border-color: var(--amber-deep); transform: translateY(-1px); }
	.nt-letter { width: 26px; height: 26px; border-radius: 50%; background: linear-gradient(135deg, var(--amber), var(--amber-deep)); color: #14100a; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 800; }
</style>
