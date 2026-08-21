import assert from 'node:assert/strict';
import test from 'node:test';

import { sanitizeHotkey } from './accelerator.js';

test('accepts modifier+key combos and canonicalises modifier order', () => {
  assert.equal(sanitizeHotkey('Ctrl+Shift+M'), 'Ctrl+Shift+M');
  assert.equal(sanitizeHotkey('Shift+Ctrl+M'), 'Ctrl+Shift+M');
  assert.equal(sanitizeHotkey('Super+Alt+Ctrl+Shift+F5'), 'Ctrl+Alt+Shift+Super+F5');
  assert.equal(sanitizeHotkey('Alt+Space'), 'Alt+Space');
  assert.equal(sanitizeHotkey('Ctrl+PageUp'), 'Ctrl+PageUp');
});

test('accepts a bare F-key but no other bare or Shift-only key', () => {
  assert.equal(sanitizeHotkey('F8'), 'F8');
  assert.equal(sanitizeHotkey('F24'), 'F24');
  assert.equal(sanitizeHotkey('Shift+F8'), 'Shift+F8');
  // A bare or Shift-only letter is plain typing and must never be grabbed.
  assert.equal(sanitizeHotkey('M'), '');
  assert.equal(sanitizeHotkey('Shift+M'), '');
  assert.equal(sanitizeHotkey('5'), '');
});

test('rejects everything outside the grammar', () => {
  assert.equal(sanitizeHotkey(''), '');
  assert.equal(sanitizeHotkey(undefined), '');
  assert.equal(sanitizeHotkey(42), '');
  assert.equal(sanitizeHotkey('Ctrl+'), '');
  assert.equal(sanitizeHotkey('+M'), '');
  assert.equal(sanitizeHotkey('Ctrl+Ctrl+M'), ''); // duplicate modifier
  assert.equal(sanitizeHotkey('Meta+M'), ''); // unknown modifier token
  assert.equal(sanitizeHotkey('Ctrl+m'), ''); // keys are upper-case only
  assert.equal(sanitizeHotkey('Ctrl+F25'), '');
  assert.equal(sanitizeHotkey('Ctrl+Escape'), ''); // key outside the set
  assert.equal(sanitizeHotkey('Ctrl+M '.repeat(10)), ''); // over-long
});
