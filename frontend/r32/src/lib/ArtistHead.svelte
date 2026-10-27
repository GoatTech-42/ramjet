<script>
  // Header block for the artist view. The song list below it is the normal .list (rows, now-playing, + to save).
  import { summary } from './artist.js';
  let { page, artBad = {}, onback, onplay, onshuffle, onart, onalbum } = $props();
</script>

<section class="ahead" aria-label={'artist ' + page.name}>
  <button class="aback" data-testid="amp-artist-back" onclick={onback}>
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
      <p class="asub">{page.total} {page.total === 1 ? 'song' : 'songs'}{#if summary(page)}{' · '}{summary(page)}{/if}</p>
      {#if page.albums.length}
        <p class="aalb">{#each page.albums.slice(0, 4) as a, i}{#if i}{' · '}{/if}<button class="alb" data-testid="amp-artist-album" onclick={() => onalbum?.(a.name)}>{a.name}</button>{/each}</p>
      {/if}
    </div>
  </div>
  <div class="aact">
    <button class="aplay" data-testid="amp-artist-play-all" onclick={onplay}>play all</button>
    <button class="ashuf" data-testid="amp-artist-shuffle" onclick={onshuffle}>shuffle</button>
  </div>
</section>

<style>
  /* tokens only: nothing here hard-codes a colour, so the warm-dark / orange set applies as-is */
  .ahead { display: grid; gap: 12px; padding: 14px; border-radius: 14px; background: var(--rj-surface); border: 1px solid var(--rj-hairline); }
  .aback { justify-self: start; display: inline-flex; align-items: center; gap: 4px; min-height: 44px; padding: 0 10px 0 6px; border-radius: 10px; background: transparent; color: var(--rj-text-dim); border: 1px solid var(--rj-hairline); }
  .aback svg { width: 18px; height: 18px; }
  .abody { display: flex; gap: 14px; align-items: center; min-width: 0; }
  .aart { width: 96px; height: 96px; border-radius: 12px; object-fit: cover; background: var(--rj-surface-2); flex: none; }
  .ameta { min-width: 0; }
  .aname { margin: 0; font-size: 24px; line-height: 1.15; color: var(--rj-text); overflow-wrap: anywhere; }
  .asub, .aalb { margin: 4px 0 0; font-size: 13px; color: var(--rj-text-dim); }
  .aalb { color: var(--rj-text-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .alb { background: none; border: 0; padding: 0; color: inherit; font: inherit; text-decoration: underline; text-decoration-color: var(--rj-hairline-strong); cursor: pointer; }
  .aact { display: flex; gap: 8px; }
  .aact button { min-height: 44px; padding: 0 18px; border-radius: 10px; border: 1px solid var(--rj-hairline-strong); background: var(--rj-surface-2); color: var(--rj-text); }
  .aact .aplay { background: var(--rj-accent); color: var(--rj-accent-ink); border-color: transparent; font-weight: 600; }
  @media (max-width: 480px) { .aart { width: 72px; height: 72px; } .aname { font-size: 20px; } .aact button { flex: 1; } }
</style>
