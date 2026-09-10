/**
 * A pet's target search pathfinds a few times, not once per candidate.
 *
 * `findFreePetTarget` used to run a full BFS for EVERY candidate and only then pick one at
 * random — one search per free seat, per pet-perchable table, per water bowl, per unclaimed agent.
 * On uponu that is ~66 searches for one 'sit' decision (45 sittable placements plus 21 perches),
 * and the 'talk' branch runs one per agent, which is up to 301 in the worlds this repo has
 * measured. O(candidates × area) is the only term in the engine that is quadratic in map area, and
 * it lands on the 20 Hz simulation thread whose whole tick budget is 0.062 ms.
 *
 * It picks first and paths after: `pickReachable` probes at most `PET_TARGET_PATH_TRIES` of them.
 * Four things about that need pinning, and each is a way the rewrite could quietly go wrong:
 *
 *   • **The count.** The saving is the claim, so it is asserted directly — through the callback
 *     seam rather than a counter in production code.
 *   • **`[]` means "already standing on it", null means "cannot get there".** `findPath` answers
 *     `[]` to both questions, and the old code disambiguated at four separate sites with its own
 *     "am I on that tile" test. Collapse the two and a pet intermittently refuses to use the
 *     thing it is standing on.
 *   • **The pick stays uniform.** Sorting by distance and taking the nearest would be cheaper
 *     still, and would pile every animal onto the same chair and then serialize them through one
 *     claim.
 *   • **Exactly one claim, and none at all on failure.** The claim used to be made after the
 *     candidate list was complete; it is now made after the pick, which is a new opportunity to
 *     leave a seat marked as taken by a pet that never went to it.
 *
 * TEST BOUNDARIES:
 *   @real-dependency: OfficeState + the real furniture catalog -- Mock? NO. Whether a placement
 *       yields a seat point on a BLOCKED tile is a fact about the catalog and `buildPoints`, and
 *       that blocked tile is the whole reason the search unblocks its destination. A stub would
 *       test my assumption about it. The counting tests need none of that and use the pure helper.
 */
import { strict as assert } from 'node:assert';
import test, { before } from 'node:test';

import { PET_TARGET_PATH_TRIES } from '@pixel/shared/office/constants.js';
import { OfficeState } from '@pixel/shared/office/engine/officeState.js';
import { createPet, pickReachable, type PetTarget } from '@pixel/shared/office/engine/pets.js';
import { buildDynamicCatalog, getCatalogEntry } from '@pixel/shared/office/layout/furnitureCatalog';
import { PetKind, PetState, TILE_SIZE, type Pet } from '@pixel/shared/office/types';

import { buildFurnitureCatalogAndSprites } from './assets.js';

before(async () => {
  buildDynamicCatalog((await buildFurnitureCatalogAndSprites()) as never);
});

const STEP = [{ col: 1, row: 1 }];

test('a reachable candidate costs one search, and an unreachable field costs the tries', () => {
  const candidates = Array.from({ length: 200 }, (_, i) => i);

  let calls = 0;
  const hit = pickReachable(candidates, PET_TARGET_PATH_TRIES, () => {
    calls++;
    return STEP;
  });
  assert.ok(hit, 'nothing was picked from 200 reachable candidates');
  assert.equal(calls, 1, 'the first probe answered, so nothing else may be searched');

  calls = 0;
  const probed: number[] = [];
  const miss = pickReachable(candidates, PET_TARGET_PATH_TRIES, (c) => {
    calls++;
    probed.push(c);
    return null;
  });
  assert.equal(miss, null, 'an unreachable field must yield no target');
  assert.equal(calls, PET_TARGET_PATH_TRIES, `200 candidates cost ${calls} searches, not ${PET_TARGET_PATH_TRIES}`);
  assert.equal(new Set(probed).size, probed.length, 'the same candidate was probed twice');

  // Fewer candidates than tries is not a special case: it probes what there is.
  calls = 0;
  pickReachable([1, 2], PET_TARGET_PATH_TRIES, () => {
    calls++;
    return null;
  });
  assert.equal(calls, 2, 'two candidates must cost two searches, not three');
  assert.equal(
    pickReachable([], PET_TARGET_PATH_TRIES, () => {
      throw new Error('an empty candidate list must not be probed at all');
    }),
    null,
  );
});

test('an empty path is a hit, not a miss', () => {
  // "Already standing on it" — `findPath` answers `[]`, and so does "no route". The contract is
  // that only null means the second, and this is the assertion that keeps a pet from refusing the
  // desk it is lying on.
  const picked = pickReachable([{ here: true }], PET_TARGET_PATH_TRIES, () => []);
  assert.ok(picked, 'an empty path was treated as unreachable');
  assert.deepEqual(picked.path, []);
});

test('the pick stays uniform over candidates', () => {
  // 400 rounds over four reachable candidates: every one has to come up. A "nearest first"
  // shortcut passes every other test in this file and fails this one.
  const seen = new Map<string, number>();
  for (let i = 0; i < 400; i++) {
    const picked = pickReachable(['a', 'b', 'c', 'd'], PET_TARGET_PATH_TRIES, () => STEP);
    seen.set(picked!.candidate, (seen.get(picked!.candidate) ?? 0) + 1);
  }
  for (const c of ['a', 'b', 'c', 'd']) {
    assert.ok((seen.get(c) ?? 0) > 20, `candidate ${c} was chosen ${seen.get(c) ?? 0} times in 400 rounds: ${JSON.stringify([...seen])}`);
  }
});

// ── The engine, over real placements ──────────────────────────────────────────

const COLS = 24;
const ROWS = 20;

/** One placement of `id`, at its catalog size. */
function place(id: string, col: number, row: number): Record<string, unknown> {
  const entry = getCatalogEntry(id);
  assert.ok(entry, `${id} is not in the catalog`);
  return { uid: `${id}-${col}-${row}`, id, col, row, x: col * TILE_SIZE, y: row * TILE_SIZE, width: entry.width, height: entry.height };
}

/** Chairs, sofas and two pet-perchable tables — built per world, because the catalog only exists
 *  once `before` has run. */
const seating = (): Array<Record<string, unknown>> => [
  place('SOFA_BACK', 4, 4),
  place('SOFA_BACK', 10, 4),
  place('WOODEN_CHAIR_BACK', 16, 4),
  place('DESK_FRONT', 4, 12),
  place('COFFEE_TABLE', 12, 12),
];

function world(blocked?: (col: number, row: number) => boolean): OfficeState {
  return new OfficeState({
    cols: COLS,
    rows: ROWS,
    tiles: new Array(COLS * ROWS).fill(1),
    walls: { horizontal: [], vertical: [] },
    furniture: seating(),
    ...(blocked
      ? {
          tileBlocked: Array.from({ length: COLS * ROWS }, (_, i) => blocked(i % COLS, (i - (i % COLS)) / COLS)),
        }
      : {}),
  } as never);
}

/** The private search and the four claim sets, which is what this half is about. */
type Inner = {
  findFreePetTarget(pet: Pet, action: string): PetTarget | null;
  blockedTiles: Set<string>;
  petSeatClaims: Set<string>;
  petStationClaims: Set<string>;
  petFurnitureClaims: Set<string>;
  petTalkClaims: Set<number>;
};
const inner = (os: OfficeState): Inner => os as unknown as Inner;
const claimCount = (i: Inner): number =>
  i.petSeatClaims.size + i.petStationClaims.size + i.petFurnitureClaims.size + i.petTalkClaims.size;

function pet(os: OfficeState, col: number, row: number): Pet {
  const p = createPet(1, PetKind.CAT, 0, { col, row });
  p.state = PetState.IDLE;
  p.effect = null;
  p.wanderTimer = 0;
  os.pets.set(1, p);
  return p;
}

test('one sit decision claims exactly one target, and leaves the blocked tiles as they were', () => {
  const os = world();
  const i = inner(os);
  const cat = pet(os, 2, 2);

  // The premise, read from the layout rather than assumed: several candidates, and their tiles are
  // BLOCKED for walking — which is what the search has to unblock to path onto them at all.
  const seats = [...os.points.values()].filter((p) => p.posture === 'sit');
  assert.ok(seats.length >= 4, `the fixture offers ${seats.length} seats, too few to be about picking one`);
  assert.ok(
    seats.every((p) => i.blockedTiles.has(`${p.col},${p.row}`)),
    'the seat tiles are not blocked, so this fixture no longer exercises the unblock',
  );

  const before = [...i.blockedTiles].sort();
  const target = i.findFreePetTarget(cat, 'sit');
  assert.ok(target, 'no reachable seat was found on open floor');
  assert.equal(claimCount(i), 1, 'a decision must claim exactly one thing');
  assert.ok(target.path.length > 0, 'the target came without a route to it');
  const last = target.path[target.path.length - 1];
  assert.deepEqual({ col: last.col, row: last.row }, { col: target.sitCol, row: target.sitRow }, 'the route does not end at the target');
  assert.deepEqual([...i.blockedTiles].sort(), before, 'the temporary unblock was not restored exactly');
});

test('a pet that can reach nothing claims nothing', () => {
  // Walled in on its own tile: every candidate is unreachable, so all three probes fail. The claim
  // is not that it gives up — that has always been a valid outcome, and the FSM answers it with a
  // random wander — but that it gives up holding NOTHING.
  const os = world((col, row) => (col === 2 && row === 1) || (col === 2 && row === 3) || (col === 1 && row === 2) || (col === 3 && row === 2));
  const i = inner(os);
  const cat = pet(os, 2, 2);

  const before = [...i.blockedTiles].sort();
  assert.equal(i.findFreePetTarget(cat, 'sit'), null, 'a walled-in pet found a seat');
  assert.equal(claimCount(i), 0, 'a failed decision left a claim behind — that seat is now taken by nobody');
  assert.deepEqual([...i.blockedTiles].sort(), before, 'the unblock was not restored on the failure path');
});

test('a pet standing on a free seat takes it without a route', () => {
  const os = world();
  const i = inner(os);
  const seat = [...os.points.values()].find((p) => p.posture === 'sit');
  assert.ok(seat, 'the fixture has no seat');
  const cat = pet(os, seat.col, seat.row);

  const target = i.findFreePetTarget(cat, 'sit');
  assert.ok(target, 'a pet standing on a free seat was told there is nothing to sit on');
  // It may pick any of the five, but if it picked THIS one the route must be empty rather than
  // absent — the `[]`-is-a-hit contract, over the real engine.
  if (target.sitCol === seat.col && target.sitRow === seat.row) {
    assert.deepEqual(target.path, [], 'the pet was routed to the tile it is standing on');
  }
  assert.equal(claimCount(i), 1);
});
