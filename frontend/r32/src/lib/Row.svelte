<script>
  // One song row for list, recents and playlist views.
  // Pattern: a sibling "stretched" play button covers the row (position:absolute; inset:0). The artist, album
  // and action controls are real <button>s above it. No interactive element is nested in another, every control
  // is in the tab order, and the visual layout is the same flex row as before.
  let { item, active = false, mode = 'list', index = 0, count = 1, artBad = {}, srcLabel = {},
        onplay, onartist, onalbum, onsave, onmove, onremove, onart } = $props();
  const who = $derived(item.artist || srcLabel[item.src] || '');
</script>

<div class="row" class:active>
  <button class="rowplay" data-testid="amp-row-play" onclick={onplay} aria-current={active ? 'true' : undefined}
    aria-label={'play ' + item.title + (item.artist ? ' by ' + item.artist : '')}></button>
  <div class="rowart">
    {#if item.art && !artBad[item.art]}<img src={item.art} alt="" loading="lazy" onerror={() => onart?.(item.art)} />{:else}<div class="noart"></div>{/if}
  </div>
  <span class="meta">
    <span class="title">{item.title}</span>
    <span class="sub">
      {#if item.artist && onartist}<button class="lnk" data-testid="amp-row-artist" onclick={() => onartist(item.artist)}>{item.artist}</button>{:else}{who}{/if}{#if item.album && mode === 'list'}<span class="rowalb">
        {' · '}{#if onalbum}<button class="lnk" data-testid="amp-row-album" onclick={() => onalbum(item.artist, item.album)}>{item.album}</button>{:else}{item.album}{/if}</span>{/if}
    </span>
    {#if mode === 'list'}<span class="src">{srcLabel[item.src]}</span>{/if}
  </span>
  <span class="dur">{item.dur}</span>
  {#if mode === 'playlist'}
    {#if index > 0}<button class="rowact" data-testid="amp-row-up" aria-label="move up" onclick={() => onmove?.(-1)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 15l6-6 6 6"/></svg></button>{/if}
    {#if index < count - 1}<button class="rowact" data-testid="amp-row-down" aria-label="move down" onclick={() => onmove?.(1)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg></button>{/if}
    <button class="rowact" data-testid="amp-row-remove" aria-label="remove from playlist" onclick={() => onremove?.()}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M5 12h14"/></svg>
    </button>
  {:else if mode === 'list'}
    <button class="rowact" data-testid="amp-row-save" aria-label="save to playlist" onclick={() => onsave?.()}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
    </button>
  {/if}
</div>

<style>
  .row { position: relative; display: flex; align-items: center; gap: 12px; width: 100%; text-align: left; background: var(--rj-surface); border: 1px solid var(--rj-hairline); border-radius: 10px; padding: 8px; color: var(--rj-text); min-height: 44px; }
  .row:hover { border-color: var(--rj-hairline-strong); }
  .row.active { border-color: var(--rj-hairline-strong); }
  .row.active .title { color: var(--rj-accent); }
  .rowplay { position: absolute; inset: 0; width: 100%; border: 0; border-radius: inherit; background: none; cursor: pointer; padding: 0; }
  .rowplay:focus-visible, .lnk:focus-visible, .rowact:focus-visible { outline: 2px solid var(--rj-accent); outline-offset: 2px; }
  /* visible content sits above-but-through the play button; only the real controls take pointer events */
  .rowart, .meta, .dur { position: relative; pointer-events: none; }
  .rowart img, .rowart .noart { display: block; width: 52px; height: 52px; border-radius: 8px; object-fit: cover; background: var(--rj-surface-2); flex: none; }
  .meta { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .title { font-size: 15px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .sub { font-family: IBM Plex Mono, ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--rj-text-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .src { font-family: IBM Plex Mono, ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: var(--rj-text-faint); }
  .dur { font-family: IBM Plex Mono, ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--rj-text-faint); flex: none; padding-right: 6px; }
  .lnk { position: relative; z-index: 1; pointer-events: auto; background: none; border: 0; padding: 0; color: inherit; font: inherit; cursor: pointer; text-decoration: underline; text-decoration-color: var(--rj-hairline-strong); text-underline-offset: 2px; }
  .lnk:hover { color: var(--rj-text); }
  .rowact { position: relative; z-index: 1; border: 0; width: 44px; height: 44px; flex: none; border-radius: 50%; background: none; color: var(--rj-text-dim); display: grid; place-items: center; cursor: pointer; padding: 0; }
  .rowact:hover { color: var(--rj-text); background: var(--rj-surface-2); }
  .rowact svg { width: 18px; height: 18px; }
  @media (hover: none), (pointer: coarse) {
    .lnk::after { content: ''; position: absolute; left: -4px; right: -4px; top: -10px; bottom: -10px; }
    .rowact::after { content: ''; position: absolute; inset: -4px; }
  }
  @media (max-width: 479px) { .rowalb { display: none; } }
</style>
