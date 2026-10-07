// Keep keyboard interaction inside a mounted sheet and return to its opener.
export function modal(node, close) {
  const opener = document.activeElement;
  const changed = [];
  let child = node;
  for (let parent = child.parentElement; parent; child = parent, parent = parent.parentElement) {
    for (const sibling of parent.children) {
      if (sibling !== child && sibling instanceof HTMLElement && !sibling.inert && !['SCRIPT', 'STYLE', 'LINK'].includes(sibling.tagName)) {
        sibling.inert = true;
        changed.push(sibling);
      }
    }
    if (parent === document.body) break;
  }
  const targets = () => [...node.querySelectorAll('button:not(:disabled),a[href],input:not(:disabled),textarea:not(:disabled),select:not(:disabled),summary,[tabindex="0"]')].filter(el => el.getClientRects().length);
  const focus = () => (targets()[0] || node).focus();
  queueMicrotask(focus);
  function key(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    if (e.key === 'Tab') {
      const els = targets();
      const first = els[0] || node, last = els.at(-1) || node;
      if (!els.length || (e.shiftKey && document.activeElement === first) || (!e.shiftKey && document.activeElement === last)) {
        e.preventDefault(); (e.shiftKey ? last : first).focus();
      }
    }
  }
  function contain(e) { if (!node.contains(e.target)) focus(); }
  document.addEventListener('keydown', key, true);
  document.addEventListener('focusin', contain);
  return {
    update(value) { close = value; },
    destroy() {
      document.removeEventListener('keydown', key, true);
      document.removeEventListener('focusin', contain);
      changed.forEach(el => { el.inert = false; });
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    }
  };
}
