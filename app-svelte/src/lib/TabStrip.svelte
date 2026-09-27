<script>
	import { tabs, activeTabId } from "./rj/state.js";
	import * as engine from "./rj/engine.js";
	export let onHome;
	function close(e, tab) { e.stopPropagation(); engine.closeTab(tab); }
</script>

<div class="strip" role="tablist">
	<div class="tabs">
		{#each $tabs as tab (tab.id)}
			<button
				class="tab" class:on={$activeTabId === tab.id} role="tab" aria-selected={$activeTabId === tab.id}
				on:click={() => engine.setActiveTab(tab)} title={tab.title || tab.url || "new tab"}>
				{#if tab.icon}<img class="favi" src={tab.icon} alt="" />{/if}
				<span class="tt">{tab.title || (tab.page ? tab.page : tab.url ? (() => { try { return new URL(tab.url).hostname; } catch (e) { return tab.url; } })() : "new tab")}</span>
				<span class="x" role="button" aria-label="Close tab" on:click={(e) => close(e, tab)}>&times;</span>
			</button>
		{/each}
	</div>
	<button class="add" aria-label="New tab" on:click={() => { engine.newTab(); if (onHome) onHome(); }}>+</button>
</div>

<style>
	.strip { display: flex; align-items: flex-end; gap: 4px; padding: 6px 8px 0; background: var(--color-ink); }
	.tabs { display: flex; gap: 4px; overflow-x: auto; flex: 1; min-width: 0; scrollbar-width: none; }
	.tabs::-webkit-scrollbar { display: none; }
	.tab {
		display: flex; align-items: center; gap: 8px; max-width: 200px; min-width: 0;
		background: var(--color-panel); border: 1px solid rgba(255,255,255,.05); border-bottom: none;
		border-radius: 10px 10px 0 0; padding: 8px 10px; cursor: pointer;
		color: var(--color-muted); font-size: 13px; flex: none;
	}
	.tab.on { background: var(--color-panel-2); color: var(--color-fg); border-color: var(--color-edge); }
	.favi { width: 15px; height: 15px; border-radius: 3px; flex: none; }
	.tt { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; min-width: 0; text-align: left; }
	.x { flex: none; width: 18px; height: 18px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 13px; line-height: 1; }
	.x:hover { background: rgba(255,255,255,.14); color: #fff; }
	.add { flex: none; width: 30px; height: 30px; margin-bottom: 2px; border: none; border-radius: 8px; background: none; color: var(--color-muted); font-size: 19px; cursor: pointer; }
	.add:hover { background: var(--color-panel); color: var(--color-fg); }
</style>
