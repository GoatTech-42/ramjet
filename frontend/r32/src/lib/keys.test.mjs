import test from 'node:test';
import assert from 'node:assert/strict';
import { keyAction } from './keys.js';

const ev = (o = {}, t = { tagName: 'BODY' }) => ({ key: '', code: '', target: t, ...o });
const SPACE = { key: ' ', code: 'Space' };
const el = (tagName, extra = {}) => ({ tagName, ...extra });
const withRole = (tagName, r) => ({ tagName, getAttribute: (k) => (k === 'role' ? r : null) });

test('plain keys on the page body', () => {
  assert.equal(keyAction(ev(SPACE)), 'toggle');
  assert.equal(keyAction(ev({ key: 'n' })), 'next');
  assert.equal(keyAction(ev({ key: 'p' })), 'prev');
  assert.equal(keyAction(ev({ key: 'ArrowRight' })), 'seek-fwd');
  assert.equal(keyAction(ev({ key: 'ArrowLeft' })), 'seek-back');
  assert.equal(keyAction(ev({ key: 'x' })), null);
});
test('typing targets ignore everything', () => {
  for (const t of [el('INPUT'), el('TEXTAREA'), el('SELECT'), el('DIV', { isContentEditable: true })]) {
    for (const k of [SPACE, { key: 'n' }, { key: 'p' }, { key: 'ArrowLeft' }, { key: 'ArrowRight' }]) assert.equal(keyAction(ev(k, t)), null, t.tagName + ' ' + (k.key));
  }
});
test('Space on a focused button, link or button-like role is left to native activation', () => {
  for (const t of [el('BUTTON'), el('A'), el('SUMMARY'), withRole('SPAN', 'button'), withRole('SPAN', 'link'), withRole('DIV', 'tab')]) assert.equal(keyAction(ev(SPACE, t)), null, t.tagName);
});
test('n / p / arrows still work with a button focused (focus stays on the row you just clicked)', () => {
  const b = el('BUTTON');
  assert.equal(keyAction(ev({ key: 'n' }, b)), 'next');
  assert.equal(keyAction(ev({ key: 'p' }, b)), 'prev');
  assert.equal(keyAction(ev({ key: 'ArrowRight' }, b)), 'seek-fwd');
});
test('widgets that own arrow keys keep them', () => {
  for (const r of ['slider', 'textbox', 'combobox', 'listbox', 'spinbutton', 'searchbox']) {
    assert.equal(keyAction(ev({ key: 'ArrowLeft' }, withRole('DIV', r))), null, r);
    assert.equal(keyAction(ev(SPACE, withRole('DIV', r))), null, r);
  }
});
test('modifiers and already-handled events are ignored', () => {
  for (const m of ['ctrlKey', 'metaKey', 'altKey']) {
    assert.equal(keyAction(ev({ ...SPACE, [m]: true })), null, m);
    assert.equal(keyAction(ev({ key: 'n', [m]: true })), null, m);
  }
  assert.equal(keyAction(ev({ key: 'n', defaultPrevented: true })), null);
});
test('Shift alone does not block (capital N still next)', () => {
  assert.equal(keyAction(ev({ key: 'n', shiftKey: true })), 'next');
});
test('missing event or target never throws', () => {
  assert.equal(keyAction(null), null);
  assert.equal(keyAction({ key: 'n' }), 'next');
  assert.equal(keyAction({ code: 'Space' }), 'toggle');
});
