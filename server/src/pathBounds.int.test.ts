/**
 * A bounded search stays bounded, and it counts STEPS.
 *
 * `findPath` had no step bound at all, so what bounded a search was the reachable walkable
 * component — i.e. the whole map. That is fine for a click, whose target the player can see, and
 * wrong for anything asked on a cadence: a search that CANNOT reach its target is the most
 * expensive kind, because it exhausts everything it can reach before saying no. `pathAwayFrom` was
 * rewritten around that fact for the flee half of a chase (428 µs → ~30); the chase half kept
 * asking the unbounded question twice a second per hunter, and a quarry five tiles away behind a
 * wall was exactly the case that cost the full component.
 *
 * The bound is a parameter honoured by BOTH branches, because a bound only one of them respects is
 * a bound that lies. So what is pinned here is the contract, per branch:
 *
 *   • **Inclusive.** A path of exactly `maxSteps` steps is still returned — the goal is matched
 *     when a node is popped, before its neighbours are refused. An off-by-one here does not fail,
 *     it just quietly stops a chase one tile short of where the constant says it should.
 *   • **Steps, not cost.** `AVOID_TILE_COST` is 8, so a legal 11-step route across one avoided
 *     tile costs 18. A cap read off the cost would refuse a path well inside the step bound while
 *     claiming to be a step bound — and the caller would see "unreachable" for something two
 *     tiles away. This is the test that makes the honesty of the parameter a fact.
 *   • **A bound never changes an answer that fits inside it.** Swept over a map with a wall and
 *     pillars, against a flood fill the test computes itself, so the reference is independent of
 *     the thing under test (the `poseFrames.int.test.ts` habit).
 *
 * What is deliberately NOT asserted: completeness of the bounded Dijkstra. Its cost-settled
 * `visited` set means a node settled by a cheap long route can hide an expensive short one that
 * would have reached the goal inside the bound. The guarantees are "never expands past `maxSteps`"
 * and "never returns a path longer than `maxSteps`"; today's only bounded caller passes no
 * `avoidTiles` and therefore takes the BFS branch. Writing a test that claims more than that would
 * be writing a test for a promise the code does not make.
 *
 * TEST BOUNDARIES:
 *   @real-dependency: the real tile map, real wall edges, real `canStep` -- Mock? NO. `canStep` is
 *       the arbiter of what a legal step is, and a stub would test my belief about walls instead
 *       of the walls. The grids are hand-built here rather than loaded, because the claim is about
 *       geometry and a hand-built corridor is the only way to make one gap unavoidable.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';

import { canStep, findPath } from '@pixel/shared/office/layout/tileMap.js';
import { emptyWallEdges, vIndex } from '@pixel/shared/office/wallEdges.js';
import { TileType } from '@pixel/shared/office/types';

const COLS = 24;
const ROWS = 16;
const NO_BLOCKS = new Set<string>();

const openFloor = (): number[][] => Array.from({ length: ROWS }, () => new Array<number>(COLS).fill(1));

/** A floor split by a VOID row, walkable only through the named columns. */
function corridor(...gaps: number[]): number[][] {
  const map = openFloor();
  for (let col = 0; col < COLS; col++) {
    if (!gaps.includes(col)) map[5][col] = TileType.VOID;
  }
  return map;
}

/** Every step 4-connected and legal, ending where it was asked to. */
function assertLegal(
  path: Array<{ col: number; row: number }>,
  from: { col: number; row: number },
  to: { col: number; row: number },
  map: number[][],
  walls?: ReturnType<typeof emptyWallEdges>,
): void {
  let cur = from;
  for (const step of path) {
    const d = Math.abs(step.col - cur.col) + Math.abs(step.row - cur.row);
    assert.equal(d, 1, `step ${JSON.stringify(step)} from ${JSON.stringify(cur)} is not 4-connected`);
    assert.ok(canStep(cur.col, cur.row, step.col, step.row, map, NO_BLOCKS, walls), `illegal step onto ${JSON.stringify(step)}`);
    cur = step;
  }
  assert.deepEqual({ col: cur.col, row: cur.row }, to, 'the path does not end at the target');
}

/** Shortest step count from `from` to every reachable tile — the independent reference. */
function depths(map: number[][], from: { col: number; row: number }, walls?: ReturnType<typeof emptyWallEdges>): Map<string, number> {
  const out = new Map<string, number>([[`${from.col},${from.row}`, 0]]);
  const queue = [from];
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head];
    const d = out.get(`${cur.col},${cur.row}`)!;
    for (const [dc, dr] of [
      [0, -1],
      [0, 1],
      [-1, 0],
      [1, 0],
    ] as const) {
      const next = { col: cur.col + dc, row: cur.row + dr };
      if (out.has(`${next.col},${next.row}`)) continue;
      if (!canStep(cur.col, cur.row, next.col, next.row, map, NO_BLOCKS, walls)) continue;
      out.set(`${next.col},${next.row}`, d + 1);
      queue.push(next);
    }
  }
  return out;
}

test('the bound is inclusive, and one step tighter refuses', () => {
  const map = openFloor();
  // Twelve steps of open floor: six across and six down, so the shortest route is exactly the
  // Manhattan distance and the boundary is unambiguous.
  const unbounded = findPath(2, 2, 8, 8, map, NO_BLOCKS);
  assert.equal(unbounded.length, 12, 'the fixture is not the 12 steps this test is about');

  const exact = findPath(2, 2, 8, 8, map, NO_BLOCKS, undefined, undefined, 12);
  assert.deepEqual(exact, unbounded, 'a path of exactly maxSteps steps must still be returned, unchanged');
  assertLegal(exact, { col: 2, row: 2 }, { col: 8, row: 8 }, map);

  assert.deepEqual(findPath(2, 2, 8, 8, map, NO_BLOCKS, undefined, undefined, 11), [], 'one step tighter than the answer must refuse');
  // And the free early-out on Manhattan distance answers the same way, without searching.
  assert.deepEqual(findPath(2, 2, 8, 8, map, NO_BLOCKS, undefined, undefined, 5), []);
});

test('the avoid-cost branch bounds steps, not cost', () => {
  // One gap in a wall, so every route passes through it, and that gap is the avoided tile: the
  // answer is 11 steps and costs 11 + AVOID_TILE_COST - 1 = 18. A cap read off the cost would
  // refuse this at 11 and report a tile three rows away as unreachable.
  const map = corridor(4);
  const avoid = new Set(['4,5']);
  const unbounded = findPath(2, 2, 2, 9, map, NO_BLOCKS, avoid);
  assert.equal(unbounded.length, 11, 'the fixture is not the 11 steps this test is about');
  assert.ok(
    unbounded.some((s) => s.col === 4 && s.row === 5),
    'the gap is meant to be unavoidable — the fixture has stopped testing what it says',
  );

  const bounded = findPath(2, 2, 2, 9, map, NO_BLOCKS, avoid, undefined, 11);
  // Length and legality, not the identical route: at exactly the boundary the prune stops nodes
  // AT `maxSteps` from expanding, so a tile one step from the goal may end up settled by a
  // different equally-good parent. Both answers are 11 legal steps, which is what was promised.
  assert.equal(bounded.length, 11, 'a step bound of 11 must accept an 11-step path whatever it cost');
  assertLegal(bounded, { col: 2, row: 2 }, { col: 2, row: 9 }, map);
  assert.deepEqual(findPath(2, 2, 2, 9, map, NO_BLOCKS, avoid, undefined, 10), [], 'and 10 must refuse the 11-step path');
});

test('a bounded avoid-cost search still routes around what it is told to avoid', () => {
  // Which branch answered, decided the way the code decides it — `avoidTiles` non-empty — and
  // shown by the only behaviour the two branches do not share: a detour that costs more STEPS and
  // less cost wins. Two gaps, the near one avoided; the plain BFS would take the near one at 11
  // steps, Dijkstra pays 15 steps to keep off it.
  const map = corridor(4, 6);
  const avoid = new Set(['4,5']);
  const bfs = findPath(2, 2, 2, 9, map, NO_BLOCKS, undefined, undefined, 20);
  assert.equal(bfs.length, 11, 'without avoidTiles the near gap is the shortest way');
  assert.ok(bfs.some((s) => s.col === 4 && s.row === 5));

  const dijkstra = findPath(2, 2, 2, 9, map, NO_BLOCKS, avoid, undefined, 20);
  assert.equal(dijkstra.length, 15, 'the detour through the far gap is 15 steps');
  assert.ok(!dijkstra.some((s) => s.col === 4 && s.row === 5), 'the avoided tile was walked over anyway');
  assert.ok(dijkstra.some((s) => s.col === 6 && s.row === 5), 'the detour does not go through the far gap');
  assertLegal(dijkstra, { col: 2, row: 2 }, { col: 2, row: 9 }, map);
});

test('a bound never changes an answer that fits inside it', () => {
  // A wall of EDGES at boundary 11 (the edge between columns 10 and 11 — `crossingBlocked` looks
  // it up under the higher column, see petFleePath.int.test.ts for the off-by-one this indexing
  // invites), plus pillars, so routes have to bend and some targets are unreachable.
  const walls = emptyWallEdges(COLS, ROWS);
  for (let row = 0; row < ROWS - 2; row++) walls.vertical[vIndex(COLS, 11, row)] = true;
  const map = openFloor();
  for (const [col, row] of [
    [6, 5],
    [15, 9],
    [8, 11],
  ] as const) {
    map[row][col] = TileType.VOID;
  }

  const BOUND = 15;
  let fitted = 0;
  let refused = 0;
  for (const from of [
    { col: 2, row: 2 },
    { col: 9, row: 7 },
    { col: 13, row: 3 },
    { col: 5, row: 13 },
  ]) {
    const reference = depths(map, from, walls);
    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        if (map[row][col] === TileType.VOID) continue;
        if (col === from.col && row === from.row) continue;
        const to = { col, row };
        const unbounded = findPath(from.col, from.row, to.col, to.row, map, NO_BLOCKS, undefined, walls);
        const bounded = findPath(from.col, from.row, to.col, to.row, map, NO_BLOCKS, undefined, walls, BOUND);

        // The unbounded answer is the shortest one, measured against the test's own flood fill.
        const d = reference.get(`${col},${row}`);
        assert.equal(unbounded.length, d ?? 0, `${JSON.stringify(from)} → ${JSON.stringify(to)}: not the shortest route`);

        if (d !== undefined && d <= BOUND) {
          assert.deepEqual(bounded, unbounded, `${JSON.stringify(from)} → ${JSON.stringify(to)} fits in ${BOUND} steps and changed`);
          assertLegal(bounded, from, to, map, walls);
          fitted++;
        } else {
          assert.deepEqual(bounded, [], `${JSON.stringify(from)} → ${JSON.stringify(to)} is beyond the bound and answered anyway`);
          refused++;
        }
        assert.ok(bounded.length <= BOUND, 'a bounded search returned a longer path than its bound');
      }
    }
  }
  // Both outcomes actually occurred, so neither assertion above is vacuous.
  assert.ok(fitted > 100, `only ${fitted} targets fitted inside the bound`);
  assert.ok(refused > 100, `only ${refused} targets were out of range — the fixture is too small to prove anything`);
});
