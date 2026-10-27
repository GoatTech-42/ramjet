// Global shortcut guard for amp (space play/pause, n/p next/prev, arrows seek). Pure: pass the KeyboardEvent.
// Returns 'toggle' | 'next' | 'prev' | 'seek-fwd' | 'seek-back' | null. null = do nothing and do NOT preventDefault.
//
// Why Space is stricter than the letters: once song rows hold real buttons, a focused button must keep
// its native Space/Enter activation. n, p and the arrows are harmless on a focused button (and clicking a
// row leaves focus on it, so ignoring them there would break "tap a song, press n").
const TYPING = new Set(['INPUT', 'TEXTAREA', 'SELECT']);
const NATIVE_ACTIVATE = new Set(['BUTTON', 'A', 'SUMMARY']);
const ROLES_ACTIVATE = new Set(['button', 'link', 'menuitem', 'tab', 'checkbox', 'switch']);
const ROLES_OWN_KEYS = new Set(['slider', 'textbox', 'combobox', 'listbox', 'spinbutton', 'searchbox']);

function role(t) { return (t && (t.getAttribute ? t.getAttribute('role') : t.role)) || ''; }

export function keyAction(e) {
  if (!e || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return null;
  const t = e.target;
  if (t) {
    if (TYPING.has(t.tagName) || t.isContentEditable || ROLES_OWN_KEYS.has(role(t))) return null;
  }
  if (e.code === 'Space') {
    if (t && (NATIVE_ACTIVATE.has(t.tagName) || ROLES_ACTIVATE.has(role(t)))) return null;
    return 'toggle';
  }
  if (e.key === 'n') return 'next';
  if (e.key === 'p') return 'prev';
  if (e.key === 'ArrowRight') return 'seek-fwd';
  if (e.key === 'ArrowLeft') return 'seek-back';
  return null;
}
