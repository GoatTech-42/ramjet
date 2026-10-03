<script>
  // themed "recent searches" list shown under a search box (replaces the browser's own datalist,
  // which iOS draws its own way). only shows when the user has chosen to save searches.
  let { items = [], query = '', focused = false, onpick, onclear } = $props();
  const shown = $derived(items.filter((r) => !query || r.toLowerCase().includes(query.toLowerCase())).filter((r) => r.toLowerCase() !== query.trim().toLowerCase()).slice(0, 6));
</script>

{#if focused && shown.length}
  <div class="rdrop" role="listbox">
    <p class="rh">recent searches <button type="button" onmousedown={(e) => { e.preventDefault(); onclear && onclear(); }} ontouchstart={(e) => { e.preventDefault(); onclear && onclear(); }}>clear</button></p>
    {#each shown as r (r)}
      <button type="button" class="ri" onmousedown={(e) => { e.preventDefault(); onpick(r); }} ontouchstart={(e) => { e.preventDefault(); onpick(r); }}><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg><span>{r}</span></button>
    {/each}
  </div>
{/if}

<style>
  .rdrop { position: absolute; z-index: 60; left: 0; right: 0; top: calc(100% + 6px); padding: 6px; background: linear-gradient(var(--rj-surface-2, #2f2f2f), var(--rj-surface-2, #2f2f2f)), #101012; border: 1px solid var(--rj-border); border-radius: calc(var(--rj-radius, 16px) + 2px); box-shadow: 0 14px 40px rgba(0, 0, 0, .5); text-align: left; }
  .rh { display: flex; justify-content: space-between; margin: 6px 10px 2px; font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--rj-text-faint); }
  .rh button { background: none; border: 0; padding: 0; color: var(--rj-text-dim); font: inherit; font-size: 11px; text-transform: lowercase; }
  .ri { display: flex; align-items: center; gap: 10px; width: 100%; min-height: 42px; padding: 0 10px; border: 0; background: none; color: var(--rj-text); font: inherit; font-size: 15px; border-radius: calc(var(--rj-radius, 16px) - 4px); text-align: left; }
  .ri:hover, .ri:active { background: var(--rj-surface); }
  .ri svg { width: 16px; height: 16px; fill: none; stroke: var(--rj-text-dim); stroke-width: 2; stroke-linecap: round; flex: none; }
  .ri span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
