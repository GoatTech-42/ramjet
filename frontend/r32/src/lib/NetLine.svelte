<script>
  import { subscribe } from './classc.js';
  let s = $state({ filtered: false });
  $effect(() => subscribe((v) => { s = v; }));
</script>
{#if s.filtered}<span class="netline">{s.always ? 'requests go through home' : 'this network may block sites, so requests go through home'}</span>{/if}
<style>
  .netline { font-size: 12px; color: var(--rj-text-faint); text-transform: lowercase; }
</style>
