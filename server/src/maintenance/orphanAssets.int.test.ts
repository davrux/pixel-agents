/**
 * These guards are the reason the prune may run unattended on every boot. Each one
 * exists because of a way an automatic delete could go wrong, and they are tested
 * rather than trusted: a wrong decision here destroys art, and there is no step where
 * a human reads a report first.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';

import { classifyAssets, decidePrune, MIN_HEALTHY_IDS, ORPHAN_GRACE_DAYS, type StoredAsset } from './orphanAssets.js';

const NOW = 1_760_000_000_000;
const days = (n: number) => n * 86_400_000;
const row = (name: string, ageDays: number, bytes = 1000): StoredAsset => ({ name, bytes, updatedAt: NOW - days(ageDays) });

test('a row a tileset carries is never an orphan, whatever its age', () => {
  const rows = [row('CHAIR', 900), row('GHOST', 900)];
  const c = classifyAssets(rows, new Set(['CHAIR']), new Map());
  assert.deepEqual(c.kept.map((r) => r.name), ['CHAIR']);
  assert.deepEqual(c.orphans.map((r) => r.name), ['GHOST']);
});

test('a row that is PLACED is kept and reported, not deleted', () => {
  const rows = [row('GHOST', 900)];
  const c = classifyAssets(rows, new Set(), new Map([['GHOST', ['zone uponu']]]));
  assert.equal(c.orphans.length, 0, 'a placed row must never reach the deletable set');
  assert.deepEqual(c.inUse[0].where, ['zone uponu']);
  // …and the decision agrees, since it only ever sees `orphans`.
  assert.deepEqual(decidePrune(c, 2000, NOW).deletable, []);
});

test('an unreadable registry deletes nothing — the case that could empty the table', () => {
  const rows = [row('A', 900), row('B', 900), row('C', 900)];
  const c = classifyAssets(rows, new Set(), new Map());
  assert.equal(c.orphans.length, 3, 'with no known ids everything looks orphaned…');
  const d = decidePrune(c, 0, NOW);
  assert.deepEqual(d.deletable, [], '…which is exactly when nothing may be deleted');
  assert.match(d.refused ?? '', /only 0 ids/);
  // A half-loaded registry is refused too.
  assert.match(decidePrune(c, MIN_HEALTHY_IDS - 1, NOW).refused ?? '', /ids/);
  assert.equal(decidePrune(c, MIN_HEALTHY_IDS, NOW).refused, undefined, 'a healthy count proceeds');
});

test('recent rows are held back, old ones go', () => {
  const rows = [row('FRESH', 0), row('YESTERDAY', 1), row('OLD', ORPHAN_GRACE_DAYS + 2)];
  const c = classifyAssets(rows, new Set(), new Map());
  const d = decidePrune(c, 2000, NOW);
  assert.deepEqual(d.deletable.map((r) => r.name), ['OLD']);
  assert.deepEqual(d.tooYoung.map((r) => r.name), ['FRESH', 'YESTERDAY']);
});

test('a row without a usable timestamp is held back rather than guessed about', () => {
  const c = classifyAssets([{ name: 'NO_DATE', bytes: 10, updatedAt: 0 }], new Set(), new Map());
  const d = decidePrune(c, 2000, NOW);
  assert.deepEqual(d.deletable, []);
  assert.deepEqual(d.tooYoung.map((r) => r.name), ['NO_DATE']);
});

test('nothing to do is not a refusal', () => {
  const d = decidePrune({ kept: [], orphans: [], inUse: [] }, 0, NOW);
  assert.deepEqual(d.deletable, []);
  assert.equal(d.refused, undefined, 'an empty table must not log an alarm on every boot');
});

test('the real world would have been pruned: nine-day-old junk, healthy registry', () => {
  // The actual numbers this was written for — 695 rows, nine days old, 1766 ids.
  const rows = Array.from({ length: 695 }, (_, i) => row(`BEDS-SHEET_${i}`, 9, 2000));
  const c = classifyAssets(rows, new Set(Array.from({ length: 1766 }, (_, i) => `TILE_${i}`)), new Map());
  const d = decidePrune(c, 1766, NOW);
  assert.equal(d.deletable.length, 695);
  assert.equal(d.refused, undefined);
});
