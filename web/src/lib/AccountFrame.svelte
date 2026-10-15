<script>
  let { title, description, children } = $props();
</script>
<main class="account-page">
  <section class="account-panel" aria-labelledby="account-title">
    <a class="wordmark" href="/" aria-label="Ramjet home">ramjet<span>.</span></a>
    <header>
      <h1 id="account-title">{title}</h1>
      <p>{description}</p>
    </header>
    {@render children()}
  </section>
</main>
<style>
  .account-page { min-height: 100dvh; display: grid; place-items: center; padding: max(32px, env(safe-area-inset-top)) 20px max(32px, env(safe-area-inset-bottom)); background: radial-gradient(ellipse at 50% 0, color-mix(in srgb, var(--rj-accent) 9%, transparent), transparent 65%); }
  .account-panel { width: min(440px, 100%); padding: 36px; background: var(--rj-glass); border: 1px solid var(--rj-border); border-radius: 28px; box-shadow: var(--rj-shadow); }
  @supports (backdrop-filter: blur(20px)) { .account-panel { backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); } }
  .wordmark { font-size: 23px; font-weight: 750; letter-spacing: -.06em; }
  .wordmark span { color: var(--rj-accent); }
  header { margin: 36px 0 28px; }
  h1 { font-size: 30px; font-weight: 650; letter-spacing: -.04em; margin: 0 0 10px; }
  p { color: var(--rj-text-dim); font-size: 15px; line-height: 1.6; margin: 0; }
  .account-panel :global(form) { display: grid; gap: 18px; }
  .account-panel :global(label) { display: grid; gap: 8px; font-size: 14px; font-weight: 550; }
  .account-panel :global(input) { width: 100%; min-height: 50px; padding: 12px 14px; border: 1px solid var(--rj-border); background: var(--rj-surface); color: var(--rj-text); border-radius: 12px; font-size: 16px; }
  .account-panel :global(input::placeholder) { color: var(--rj-text-faint); }
  .account-panel :global(.go) { min-height: 50px; padding: 12px 20px; border: 0; border-radius: 12px; background: var(--rj-accent); color: var(--rj-accent-ink); font-weight: 650; font-size: 15px; }
  .account-panel :global(.go:disabled) { opacity: .65; }
  .account-panel :global(.go:active) { transform: translateY(1px); }
  .account-panel :global(.showpw), .account-panel :global(.flip) { border: 0; background: none; color: var(--rj-accent); font-size: 14px; padding: 6px 0; text-align: left; }
  .account-panel :global(.showpw) { justify-self: start; margin-top: -12px; min-height: 32px; }
  .account-panel :global(.err), .account-panel :global(.msg) { margin: 0; color: var(--rj-danger); font-size: 14px; line-height: 1.5; }
  .account-panel :global(.note), .account-panel :global(.msg.ok) { margin: 0; color: var(--rj-text); font-size: 14px; line-height: 1.5; }
  .account-panel :global(.fine), .account-panel :global(.back) { margin: 0; color: var(--rj-text-dim); font-size: 14px; line-height: 1.5; text-align: center; }
  .account-panel :global(.back) { padding: 8px; }
  @media (max-width: 480px) { .account-panel { padding: 28px 24px; border-radius: 24px; } h1 { font-size: 28px; } }
</style>
