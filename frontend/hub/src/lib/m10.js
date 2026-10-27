// M10 perf-gate seam (bench rig v0.2, SHELL-INTEGRATION.md).
// Test builds only: VITE_M10=1 + runner-installed probe at globalThis.__ramjetM10.
// Production build (VITE_M10 unset): the guarded dynamic import is dead code -
// no instrumentation in the measured manifest. One gated invocation per page.
let hooks = null
let currentOp = null

export async function initM10() {
  if (!import.meta.env.VITE_M10) return null
  const probe = import.meta.env.VITE_M10 ? (globalThis.__ramjetM10 ?? null) : null
  if (!probe) return null
  const { createM10Hooks } = await import('./m10-shell-hooks.mjs')
  hooks = createM10Hooks(probe)
  return hooks
}

// omnibox: call at the real Enter/click/submit handler, after validating the
// destination, before starting proxy work. Requires the trusted event.
export function m10Invoke(event) {
  if (!hooks) return null
  try { currentOp = hooks.invoke(event) } catch { currentOp = null } // rig discipline: one op per measured page
  return currentOp
}
export function m10CurrentOp() { return currentOp }
// assertions must come from actual response/view state, never assumed
export function m10PrimaryRendered(id, { responseSucceeded, isErrorPage, overlayBlocksInput }) {
  if (hooks && id != null) hooks.primaryContentRendered(id, { responseSucceeded, isErrorPage, overlayBlocksInput })
}
export function m10InputVerified(id, kind) {
  if (hooks && id != null) hooks.inputVerified(id, { inputOccurred: true, observedEffect: true, kind })
}
export function m10Usable(id) { if (hooks && id != null) hooks.usable(id) }

// local interactions (<100ms paint gate): begin at trusted handler entry,
// feedbackCommitted after the task-relevant DOM feedback is committed.
export function m10BeginLocal(label, event) {
  if (!import.meta.env.VITE_M10) return null
  if (!globalThis.__ramjetM10) return null
  try { return globalThis.__ramjetM10.beginLocal(label, event) } catch { return null }
}
export function m10Feedback(id) {
  if (import.meta.env.VITE_M10 && id != null && globalThis.__ramjetM10) { try { globalThis.__ramjetM10.feedbackCommitted(id) } catch { /* unknown action */ } }
}
