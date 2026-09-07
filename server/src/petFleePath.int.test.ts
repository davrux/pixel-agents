/**
 * A fleeing animal's path is legal movement, whoever computed it.
 *
 * `pathAwayFrom` used to hand the question to the pathfinder for every candidate tile: filter all
 * 2634 walkable tiles of a real map, sort them by distance from the hunter, then ask A* whether the
 * best eight were reachable. Measured at 172 µs per call, and up to 428 µs when the animal was
 * cornered — because an A* that CANNOT reach its target is the most expensive one there is: it
 * exhausts everything it can reach before saying no.
 *
 * It now answers itself in two ways, and this test exists because the first of them is hand-rolled
 * movement rather than a call into the pathfinder:
 *
 *  1. **A dash**: step straight away while `canStep` allows it (1.4 µs).
 *  2. **A bounded flood fill** when the dash is blocked, which yields reachability and the route in
 *     one pass (21.7 µs), replacing the guess-then-search.
 *
 * Hand-rolled movement is exactly where a pet learns to walk through a wall, so what is pinned here
 * is not the numbers but the CONTRACT the pathfinder used to guarantee for free:
 *
 *   • every step is 4-connected — no diagonals, ever
 *   • every step passes `canStep`, which is the pathfinder's own predicate (walkable target AND no
 *     wall edge crossed); a wall is an EDGE, not a blocked tile, so `isWalkable` alone would let a
 *     dash walk straight through one
 *   • the path ends strictly farther from the hunter than it started — otherwise it is not a flight
 *   • it never exceeds the flee range, so nobody bolts across the office
 *
 * Asserted over many positions rather than one, and with walls and furniture in the way, so both
 * branches are exercised without the test having to know which one answered.
 *
 * TEST BOUNDARIES:
 *   @real-dependency: OfficeState, the real tile map, real wall edges -- Mock? NO. The claim is
 *       "this movement is as legal as the pathfinder's", and `canStep` is the arbiter both sides
 *       use. A stub would test my belief about walls instead of the walls.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';

import { PET_FLEE_RANGE_TILES } from '@pixel/shared/office/constants.js';
import { OfficeState } from '@pixel/shared/office/engine/officeState.js';
import { createPet } from '@pixel/shared/office/engine/pets.js';
import { canStep } from '@pixel/shared/office/layout/tileMap.js';
import { emptyWallEdges, vIndex } from '@pixel/shared/office/wallEdges.js';
import { PetKind, PetState, type Pet } from '@pixel/shared/office/types';

const COLS = 20;
const ROWS = 14;

/**
 * A floor with a wall down the middle and a block of unwalkable ground, so a flight has something
 * to be stopped by.
 *
 * The wall is a vertical run of EDGES at boundary 11, which is the edge between columns 10 and 11:
 * `crossingBlocked` looks the edge up under the HIGHER of the two columns, so `vIndex(cols, 11, r)`
 * is what stops a step from 10 to 11. Getting that backwards is what the first version of this
 * fixture did — it put the wall at boundary 10, west of the cat, and then asserted that dashing
 * east was illegal when it was perfectly legal. The test was wrong, not the code, and it is worth
 * the paragraph because the indexing is the kind of off-by-one that produces a confident wrong
 * test.
 */
function world(): { os: OfficeState; walls: ReturnType<typeof emptyWallEdges> } {
  const walls = emptyWallEdges(COLS, ROWS);
  for (let row = 0; row < ROWS; row++) walls.vertical[vIndex(COLS, 11, row)] = true;
  const os = new OfficeState({
    cols: COLS,
    rows: ROWS,
    tiles: new Array(COLS * ROWS).fill(1),
    walls,
    furniture: [],
    // A solid block plus three single pillars. The pillars are what force a BEND: a full-height
    // wall can only be run along, never around, so with the wall alone every escape came out
    // straight and the flood-fill branch was never really exercised. One blocked tile directly
    // away from the hunter, with open floor beside it, is the smallest thing that makes the way
    // out an L.
    tileBlocked: Array.from({ length: COLS * ROWS }, (_, i) => {
      const col = i % COLS;
      const row = (i - col) / COLS;
      const block = col >= 2 && col <= 4 && row >= 2 && row <= 4;
      const pillar = (col === 6 && row === 5) || (col === 15 && row === 9) || (col === 8 && row === 11);
      return block || pillar;
    }),
  } as never);
  return { os, walls };
}

/** Place a pet, already past its fade-in and its random first pause. */
function place(os: OfficeState, id: number, kind: PetKind, col: number, row: number): Pet {
  const pet = createPet(id, kind, 0, { col, row });
  pet.state = PetState.IDLE;
  pet.effect = null;
  pet.wanderTimer = 0;
  os.pets.set(id, pet);
  return pet;
}

const chebyshev = (a: { tileCol: number; tileRow: number }, b: { tileCol: number; tileRow: number }): number =>
  Math.max(Math.abs(a.tileCol - b.tileCol), Math.abs(a.tileRow - b.tileRow));

test('every flee path is legal movement, from every position on the map', () => {
  const inner = (os: OfficeState): { tileMap: never; blockedTiles: never; walls: never } =>
    os as unknown as { tileMap: never; blockedTiles: never; walls: never };

  let flights = 0;
  let dashes = 0;
  let detours = 0;
  // Every quarry position on the map, with the hunter on each of its four sides: both branches get
  // hit, including "the way out is through a wall" and "the corner is a dead end".
  for (let row = 1; row < ROWS - 1; row++) {
    for (let col = 1; col < COLS - 1; col++) {
      for (const [hc, hr] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const { os } = world();
        const cat = place(os, 1, PetKind.CAT, col, row);
        const dog = place(os, 2, PetKind.DOG, col + hc, row + hr);
        if (!canStep(col, row, dog.tileCol, dog.tileRow, inner(os).tileMap, inner(os).blockedTiles, inner(os).walls)) {
          continue; // the hunter could not be standing there in the first place
        }
        const before = chebyshev(cat, dog);
        os.setPetDecider((pet) => (pet.kind === PetKind.CAT ? 'flee' : 'sit'));
        os.update(1 / 20);
        if (cat.path.length === 0) continue; // cornered with nowhere to go: a legal answer
        flights++;

        // WHICH branch answered, decided the way the code decides it rather than guessed from the
        // shape of the path: if the first step directly away is legal, the dash could answer; if it
        // was not, the flood fill did. Counting bends instead was the first attempt here and it was
        // luck — a flood fill returns a straight path whenever running straight is the best escape,
        // which it usually is, and ties between equally distant tiles fall whichever way the queue
        // happens to run.
        const awayCol = cat.tileCol + (Math.sign(cat.tileCol - dog.tileCol) || 1);
        const awayRow = cat.tileRow + (Math.sign(cat.tileRow - dog.tileRow) || 1);
        const colAxis = Math.abs(cat.tileCol - dog.tileCol) === before;
        const rowAxis = Math.abs(cat.tileRow - dog.tileRow) === before;
        const dashCould =
          (colAxis && canStep(cat.tileCol, cat.tileRow, awayCol, cat.tileRow, inner(os).tileMap, inner(os).blockedTiles, inner(os).walls)) ||
          (rowAxis && canStep(cat.tileCol, cat.tileRow, cat.tileCol, awayRow, inner(os).tileMap, inner(os).blockedTiles, inner(os).walls));
        if (dashCould) dashes++;
        else detours++;

        assert.ok(
          cat.path.length <= PET_FLEE_RANGE_TILES,
          `a ${cat.path.length}-step flight from ${col},${row} exceeds the flee range`,
        );

        let prevCol = cat.tileCol;
        let prevRow = cat.tileRow;
        for (const step of cat.path) {
          const dCol = Math.abs(step.col - prevCol);
          const dRow = Math.abs(step.row - prevRow);
          assert.equal(dCol + dRow, 1, `step ${prevCol},${prevRow} -> ${step.col},${step.row} is not 4-connected`);
          assert.ok(
            canStep(prevCol, prevRow, step.col, step.row, inner(os).tileMap, inner(os).blockedTiles, inner(os).walls),
            `step ${prevCol},${prevRow} -> ${step.col},${step.row} crosses a wall or lands off the floor`,
          );
          prevCol = step.col;
          prevRow = step.row;
        }

        const end = { tileCol: prevCol, tileRow: prevRow };
        assert.ok(
          chebyshev(end, dog) > before,
          `the flight from ${col},${row} ended ${chebyshev(end, dog)} away, no farther than the ${before} it started at`,
        );
      }
    }
  }

  // The test is only worth its runtime if it exercised both answers.
  assert.ok(flights > 200, `only ${flights} flights were produced — the fixture stopped being a map`);
  assert.ok(dashes > 0, 'the dash branch never answered — is the fixture all wall?');
  assert.ok(
    detours > 0,
    'the flood-fill branch never answered: no position had its way out blocked, so the expensive ' +
      'half of this function is untested and the wall and pillars are not where they should be',
  );
});

test('a pet with the wall in its face still gets away, around it', () => {
  // The concrete case the dash cannot answer: the hunter is west, so away is east, and east is a
  // wall EDGE — invisible to a walkability test. The flood fill must route around it.
  const { os } = world();
  const cat = place(os, 1, PetKind.CAT, 10, 7); // hard against the wall between columns 10 and 11
  const dog = place(os, 2, PetKind.DOG, 9, 7);
  const before = chebyshev(cat, dog);
  os.setPetDecider((pet) => (pet.kind === PetKind.CAT ? 'flee' : 'sit'));
  os.update(1 / 20);

  assert.ok(cat.path.length > 0, 'the cat stood still with a whole map to run into');
  const last = cat.path[cat.path.length - 1];
  assert.ok(
    Math.max(Math.abs(last.col - dog.tileCol), Math.abs(last.row - dog.tileRow)) > before,
    'it moved, but not away',
  );
  // And it did not step east through the wall.
  assert.ok(
    cat.path.every((t) => t.col <= 10),
    `the path crossed the wall between columns 10 and 11: ${JSON.stringify(cat.path)}`,
  );
});
