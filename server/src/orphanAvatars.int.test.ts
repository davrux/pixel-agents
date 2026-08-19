/**
 * The guards on an unattended deleter, tested where they live.
 *
 * `decideAvatarPrune` runs at every boot with nobody watching, and what it deletes is
 * somebody's drawn avatar. The three ways it could be wrong are each pinned here:
 * believing an unreadable `users` table (which would make every avatar an orphan and
 * take the lot), touching work that is only days old, and treating a row with no
 * timestamp as old — unknown is not old.
 *
 * Kept pure on purpose: no database, so a guard can be exercised in the state that
 * matters (zero accounts) without arranging a broken world first.
 *
 * TEST BOUNDARIES:
 *   @real-dependency: decideAvatarPrune -- Mock? NO. It IS the decision under test;
 *       the SQL either side of it is two one-line queries.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';

import { decideAvatarPrune, MIN_HEALTHY_USERS } from './maintenance/orphanAvatars.js';
import { ORPHAN_GRACE_DAYS } from './maintenance/orphanAssets.js';

const NOW = 1_800_000_000_000;
const days = (n: number) => NOW - n * 24 * 60 * 60 * 1000;
const row = (name: string, ageDays: number, bytes = 77_000) => ({ name, bytes, updatedAt: days(ageDays) });

test('an avatar whose account is gone and which is old enough is deleted', () => {
  const d = decideAvatarPrune([row('ghost', ORPHAN_GRACE_DAYS + 1)], new Set(['meik']), NOW);
  assert.equal(d.refused, undefined);
  assert.deepEqual(
    d.deletable.map((r) => r.name),
    ['ghost'],
  );
  assert.equal(d.owned.length, 0);
});

test('an avatar with an account is kept, however old', () => {
  const d = decideAvatarPrune([row('meik', 900)], new Set(['meik']), NOW);
  assert.equal(d.deletable.length, 0);
  assert.deepEqual(
    d.owned.map((r) => r.name),
    ['meik'],
  );
});

test('recent work is held back even without an account', () => {
  const d = decideAvatarPrune([row('fresh', ORPHAN_GRACE_DAYS - 1)], new Set(['meik']), NOW);
  assert.equal(d.deletable.length, 0);
  assert.deepEqual(
    d.tooYoung.map((r) => r.name),
    ['fresh'],
  );
});

test('an empty users table is refused, not obeyed', () => {
  // The dangerous case: with no accounts every avatar looks orphaned, so a checker
  // that trusted this evidence would delete every avatar in the world at once.
  const rows = [row('a', 900), row('b', 900)];
  const d = decideAvatarPrune(rows, new Set(), NOW);
  assert.ok(d.refused, 'an unreadable users table must refuse');
  assert.equal(d.deletable.length, 0);
  assert.equal(d.tooYoung.length, 2, 'the rows are held, not classified as keepable');
  assert.ok(MIN_HEALTHY_USERS >= 1);
});

test('a row without a timestamp is never aged out — unknown is not old', () => {
  const d = decideAvatarPrune([{ name: 'nostamp', bytes: 100, updatedAt: 0 }], new Set(['meik']), NOW);
  assert.equal(d.deletable.length, 0);
  assert.deepEqual(
    d.tooYoung.map((r) => r.name),
    ['nostamp'],
  );
});
