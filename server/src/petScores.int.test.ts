/**
 * The scuffle board: who won, counted per zone, surviving everything a pet does not.
 *
 * A pet instance lives ten minutes and then despawns, so the tally is kept per pet SLOT — `dog_0`,
 * `cat_1` — because a slot is what has a name (Emma, Loui) and an instance is what has a lifespan.
 * Per zone, because a board hangs in a room and a zone chooses which animals live in it.
 *
 * Four things are pinned, and each is a way this could have been built wrongly:
 *
 *  1. **The engine reports a finished fight exactly once**, by slot, for the winner and the loser.
 *     The transition SCUFFLE → WIN happens once per fight and only on the winner's side, which is
 *     why that is where it is read; reading it per pet would have counted every fight twice.
 *  2. **A row, not a blob.** The store upserts by primary key, so the first fight of a slot creates
 *     its row and the hundredth costs the same. (The blob-in-`settings` shape cost 5.3 ms per write
 *     at ten thousand entries — AGENTS.md § Memory.)
 *  3. **A tally belongs to its zone** and goes when the zone goes, next to the two other
 *     zone-scoped tables that `ZoneStore.delete` clears.
 *  4. **The order is stable**: most wins first, then fewest losses, then the name — so two reads of
 *     the same numbers cannot disagree about who is second.
 *
 * TEST BOUNDARIES:
 *   @real-dependency: the real engine and the real SQLite store -- Mock? NO. Claim 1 is about what
 *       the FSM emits and claim 2 about what SQL does with it; a stub of either would test the
 *       assumption rather than the seam. The store writes to the per-test temp database that
 *       `test-data-dir.mjs` sets up before any module can open one.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';

import { PET_SCUFFLE_DURATION_SEC } from '@pixel/shared/office/constants.js';
import { OfficeState } from '@pixel/shared/office/engine/officeState.js';
import { createPet } from '@pixel/shared/office/engine/pets.js';
import { PetKind, PetState, type Pet } from '@pixel/shared/office/types';

import { petScoreStore } from './petScoreStore.js';

const emptyMap = (cols = 16, rows = 12) => ({
  cols,
  rows,
  tiles: new Array(cols * rows).fill(1),
  walls: { horizontal: [], vertical: [] },
  furniture: [] as Array<Record<string, unknown>>,
});

function place(os: OfficeState, id: number, kind: PetKind, variant: number, col: number, row: number): Pet {
  const pet = createPet(id, kind, variant, { col, row });
  pet.state = PetState.IDLE;
  pet.effect = null;
  pet.wanderTimer = 0;
  os.pets.set(id, pet);
  return pet;
}

test('a finished fight is reported once, by slot, with the winner named first', () => {
  const os = new OfficeState(emptyMap() as never);
  const dog = place(os, 1, PetKind.DOG, 0, 4, 4);
  place(os, 2, PetKind.CAT, 1, 5, 4);
  os.setPetDecider((pet) => (pet.kind === PetKind.DOG ? 'chase' : 'wander'));

  // Into the cloud, and nothing is reported while it lasts: a fight that is still happening has no
  // result, and the client has nothing to show either.
  for (let i = 0; i < 20; i++) os.update(1 / 20);
  assert.equal(dog.state, PetState.SCUFFLE, 'no cloud to finish');
  assert.deepEqual(os.takeScuffleResults(), [], 'a result was reported before the fight ended');

  // Out the other side.
  for (let i = 0; i < Math.round((PET_SCUFFLE_DURATION_SEC + 0.3) * 20); i++) os.update(1 / 20);
  const results = os.takeScuffleResults();
  assert.equal(results.length, 1, `expected exactly one result, got ${results.length}`);
  const [{ winner, loser }] = results;
  assert.deepEqual(
    [winner, loser].sort(),
    ['cat_1', 'dog_0'],
    'the pair is not reported by slot — a name or an instance id would not survive the animal',
  );
  // Which of the two won is the roll's business; that the WINNER is the one named `winner` is not.
  const dogWon = dog.scuffleWon;
  assert.equal(winner, dogWon ? 'dog_0' : 'cat_1');
  assert.equal(loser, dogWon ? 'cat_1' : 'dog_0');

  // Drained, so the room cannot count the same fight twice.
  assert.deepEqual(os.takeScuffleResults(), []);
});

test('the store counts both sides and reads back in a stable order', () => {
  const zone = 'board-test';
  petScoreStore.clearZone(zone);
  petScoreStore.record(zone, 'dog_0', 'cat_0');
  petScoreStore.record(zone, 'dog_0', 'cat_1');
  petScoreStore.record(zone, 'cat_0', 'bird_0');

  assert.deepEqual(petScoreStore.table(zone), [
    { pet: 'dog_0', wins: 2, losses: 0 },
    { pet: 'cat_0', wins: 1, losses: 1 },
    { pet: 'bird_0', wins: 0, losses: 1 },
    { pet: 'cat_1', wins: 0, losses: 1 },
  ]);
  // bird_0 before cat_1 is the tie-break doing its job: same wins, same losses, so the name
  // decides — and it decides the same way on every read.
  const twice = JSON.stringify(petScoreStore.table(zone));
  assert.equal(twice, JSON.stringify(petScoreStore.table(zone)), 'two reads disagreed about the order');
});

test('a tally is per zone and nothing leaks between them', () => {
  petScoreStore.clearZone('zone-a');
  petScoreStore.clearZone('zone-b');
  petScoreStore.record('zone-a', 'dog_0', 'cat_0');
  petScoreStore.record('zone-b', 'cat_0', 'dog_0');

  assert.deepEqual(petScoreStore.table('zone-a'), [
    { pet: 'dog_0', wins: 1, losses: 0 },
    { pet: 'cat_0', wins: 0, losses: 1 },
  ]);
  assert.deepEqual(petScoreStore.table('zone-b'), [
    { pet: 'cat_0', wins: 1, losses: 0 },
    { pet: 'dog_0', wins: 0, losses: 1 },
  ]);
  assert.deepEqual(petScoreStore.table('zone-never-used'), [], 'an unused zone has a board, and it is empty');
});

test('clearing a zone takes its board with it, and only its own', () => {
  petScoreStore.clearZone('keep');
  petScoreStore.clearZone('drop');
  petScoreStore.record('keep', 'dog_0', 'cat_0');
  petScoreStore.record('drop', 'dog_1', 'cat_1');

  petScoreStore.clearZone('drop');

  assert.deepEqual(petScoreStore.table('drop'), [], 'the deleted zone kept its tally');
  assert.equal(petScoreStore.table('keep').length, 2, 'clearing one zone emptied another');
});

test('a bad record is ignored rather than stored', () => {
  // The engine only ever reports two real slots, but the store is a public API and an empty zone id
  // would file a board nobody can ever read.
  const zone = 'guard-test';
  petScoreStore.clearZone(zone);
  petScoreStore.record('', 'dog_0', 'cat_0');
  petScoreStore.record(zone, '', 'cat_0');
  petScoreStore.record(zone, 'dog_0', '');
  assert.deepEqual(petScoreStore.table(zone), [], 'a half-empty record was written anyway');
});
