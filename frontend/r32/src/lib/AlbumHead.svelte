<script>
  import { runtime } from './album.js';
  let { page, artBad = {}, onback, onplay, onshuffle, onartist, onart } = $props();
</script>

<section class="ahead" aria-label={'album ' + page.name}>
  <button class="aback" data-testid="amp-album-back" onclick={onback}>
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
    back
  </button>
  <div class="abody">
    {#if page.art && !artBad[page.art]}
      <img class="aart" src={page.art} alt="" onerror={() => onart?.(page.art)} />
    {:else}
      <div class="aart noart"></div>
    {/if}
    <div class="ameta">
      <h1 class="aname">{page.name}</h1>
      <button class="alink" data-testid="amp-album-artist" onclick={onartist}>{page.artist}</button>
      <p class="asub">{page.total} {page.total === 1 ? 'song' : 'songs'} found{#if page.durSec}{' · '}{runtime(page.durSec)}{/if}</p>
    </div>
  </div>
  <div class="aact">
    <button class="aplay" data-testid="amp-album-play-all" onclick={onplay}>play all</button>
    <button class="ashuf" data-testid="amp-album-shuffle" onclick={onshuffle}>shuffle</button>
  </div>
</section>

<style>
  .ahead { display: grid; gap: 12px; padding: 14px; border-radius: 14px; background: var(--rj-surface); border: 1px solid var(--rj-hairline); }
  .aback { justify-self: start; display: inline-flex; align-items: center; gap: 4px; min-height: 44px; padding: 0 10px 0 6px; border-radius: 10px; background: transparent; color: var(--rj-text-dim); border: 1px solid var(--rj-hairline); }
  .aback svg { width: 18px; height: 18px; }
  .abody { display: flex; gap: 14px; align-items: center; min-width: 0; }
  .aart { width: 96px; height: 96px; border-radius: 12px; object-fit: cover; background: var(--rj-surface-2); flex: none; }
  .ameta { min-width: 0; }
  .aname { margin: 0; font-size: 24px; line-height: 1.15; color: var(--rj-text); overflow-wrap: anywhere; }
  .alink { display: block; min-height: 44px; padding: 0; background: none; border: 0; color: var(--rj-accent); text-align: left; font-size: 15px; }
  .asub { margin: 0; font-size: 13px; color: var(--rj-text-dim); }
  .aact { display: flex; gap: 8px; }
  .aact button { min-height: 44px; padding: 0 18px; border-radius: 10px; border: 1px solid var(--rj-hairline-strong); background: var(--rj-surface-2); color: var(--rj-text); }
  .aact .aplay { background: var(--rj-accent); color: var(--rj-accent-ink); border-color: transparent; font-weight: 600; }
  @media (max-width: 480px) { .aart { width: 72px; height: 72px; } .aname { font-size: 20px; } .aact button { flex: 1; } }
</style>
