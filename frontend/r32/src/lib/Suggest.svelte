<script>
  // live "youtube search suggestions" dropdown under the jetstream search box.
  // same idiom as Recent.svelte: mousedown/touchstart + preventDefault so a tap
  // lands before the input's blur hides the list. parent feeds items from
  // /api/apps/jetstream/suggest and owns the query/fetch/keyboard state.
  let { items = [], focused = false, hi = -1, onpick } = $props();
  const shown = $derived(items.slice(0, 8));
</script>

{#if focused && shown.length}
  <div class="sdrop" role="listbox" id="js-sugg-list" aria-label="search suggestions">
    <p class="sh">suggestions</p>
    {#each shown as s, i (s)}
      <button type="button" tabindex="-1" class="si" class:hot={i === hi} role="option" id="js-sugg-opt-{i}" aria-selected={i === hi}
        onmousedown={(e) => { e.preventDefault(); onpick && onpick(s); }}
        ontouchstart={(e) => { e.preventDefault(); onpick && onpick(s); }}>
        <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg><span>{s}</span>
      </button>
    {/each}
  </div>
{/if}

<style>
  .sdrop { position: absolute; z-index: 60; left: 0; right: 0; top: calc(100% + 6px); padding: 6px; background: linear-gradient(var(--rj-surface-2, #2f2f2f), var(--rj-surface-2, #2f2f2f)), #101012; border: 1px solid var(--rj-border); border-radius: calc(var(--rj-radius, 16px) + 2px); box-shadow: 0 14px 40px rgba(0, 0, 0, .5); text-align: left; }
  .sh { margin: 6px 10px 2px; font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--rj-text-faint); }
  .si { display: flex; align-items: center; gap: 10px; width: 100%; min-height: 42px; padding: 0 10px; border: 0; background: none; color: var(--rj-text); font: inherit; font-size: 15px; border-radius: calc(var(--rj-radius, 16px) - 4px); text-align: left; }
  .si:hover, .si:active, .si.hot { background: var(--rj-surface); }
  .si svg { width: 16px; height: 16px; fill: none; stroke: var(--rj-text-dim); stroke-width: 2; stroke-linecap: round; flex: none; }
  .si span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
