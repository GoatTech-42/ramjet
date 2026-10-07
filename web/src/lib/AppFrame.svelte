<script>
  import { apps } from './apps.js';
  let { active = '/', children } = $props();
</script>
<div class="workspace">
  <a class="skip" href="#workspace-content">Skip to content</a>
  <nav class="app-nav" aria-label="Apps">
    {#each apps as app}
      <a href={app.path} class:active={active === app.path} aria-current={active === app.path ? 'page' : undefined} aria-label={app.name} title={app.name}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d={app.icon} /></svg>
        <span>{app.name}</span>
      </a>
    {/each}
  </nav>
  <div id="workspace-content" class="workspace-content" tabindex="-1">{@render children()}</div>
</div>
<style>
  .workspace { padding-left: 108px; }
  .workspace-content { min-width: 0; }
  .app-nav { position: fixed; z-index: 80; left: 14px; top: 18px; bottom: 18px; width: 80px; display: flex; flex-direction: column; gap: 7px; align-items: stretch; padding: 12px 6px; background: var(--rj-glass); border: 1px solid var(--rj-border); border-radius: 26px; box-shadow: var(--rj-shadow); }
  @supports (backdrop-filter: blur(24px)) { .app-nav { backdrop-filter: blur(24px) saturate(150%); -webkit-backdrop-filter: blur(24px) saturate(150%); } }
  .app-nav a { display: grid; justify-items: center; align-content: center; gap: 7px; min-height: 66px; border-radius: 18px; color: var(--rj-text-dim); font-size: 10px; font-weight: 550; }
  .app-nav a:first-child { margin-bottom: 18px; }
  .app-nav a:last-child { margin-top: auto; }
  .app-nav a:hover { background: var(--rj-hover); }
  .app-nav a.active { background: var(--rj-surface-2); color: var(--rj-accent); box-shadow: inset 0 0 0 1px var(--rj-border); }
  svg { width: 23px; height: 23px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linejoin: round; stroke-linecap: round; }
  .skip { position: fixed; top: -100px; left: 120px; z-index: 120; background: var(--rj-surface); padding: 12px; border: 1px solid var(--rj-border); border-radius: 12px; }
  .skip:focus { top: 12px; }
  @media (max-width: 760px) {
    .workspace { padding-left: 0; padding-bottom: calc(84px + env(safe-area-inset-bottom)); }
    .app-nav { top: auto; bottom: max(10px, env(safe-area-inset-bottom)); left: 10px; right: 10px; width: auto; flex-direction: row; gap: 0; padding: 6px; border-radius: 22px; }
    .app-nav a { flex: 1; min-width: 0; min-height: 54px; font-size: 9px; gap: 5px; border-radius: 16px; }
    .app-nav a:first-child, .app-nav a:last-child { margin: 0; }
    svg { width: 21px; height: 21px; }
    .skip { left: 12px; }
  }
  @media (prefers-reduced-transparency: reduce) { .app-nav { background: var(--rj-surface); backdrop-filter: none; } }
</style>
