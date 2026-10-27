// svelte action for sheets: dialog semantics live in the markup (role/aria-modal/aria-label); this adds
// focus in on open, Tab trap, Esc to close, and focus restore to the trigger on close.
const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
export function dialog(node, close) {
  const trigger = document.activeElement;
  let onClose = close;
  const items = () => [...node.querySelectorAll(FOCUSABLE)].filter((x) => x.offsetParent !== null);
  queueMicrotask(() => { (items()[0] || node).focus?.(); });
  function onKey(e) {
    if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); onClose && onClose(); return; }
    if (e.key !== 'Tab') return;
    const f = items();
    if (!f.length) { e.preventDefault(); return; }
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  node.addEventListener('keydown', onKey);
  return {
    update(c) { onClose = c; },
    destroy() { node.removeEventListener('keydown', onKey); if (trigger && trigger.isConnected) trigger.focus?.(); },
  };
}
