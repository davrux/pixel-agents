/**
 * Animated furniture must keep animating — and this is the test that would have caught the way
 * it stopped.
 *
 * The tick used to answer "did any animation frame change?" by building two signature STRINGS
 * over every placement, twice per tick: measured on uponu (160 placements) 14.1 µs per call,
 * which was half of the entire 56 µs tick, all for one boolean. It now compares frame ids for a
 * cached list of the animated types that are placed — and that cache is where the trap was.
 *
 * The list is refreshed by `rebuildFurnitureInstances`, which every state change that could
 * alter it goes through… except construction, which deliberately skips that method (see the
 * comment there: it sets the initial placements directly). So the list started empty, nothing
 * ever compared as changed, and NOTHING ANIMATED — silently, on every map, for the whole life of
 * the room. It cost nothing and broke everything, and no unit test noticed: the suite was green.
 *
 * So the property under test is behavioural and deterministic: tick a state that HAS an animated
 * piece, and the furniture must be rebuilt. No timing, no screenshot.
 *
 * TEST BOUNDARIES:
 *   @real-dependency: the Tiled furniture catalog -- Mock? NO. Whether a type animates is a fact
 *       about the real art (`animationFrameAt` reads the catalog's frame data); a stub would
 *       test the loop and not the question.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';

import { animationFrameAt, buildDynamicCatalog, getCatalogEntry } from '@pixel/shared/office/layout/furnitureCatalog';
import { OfficeState } from '@pixel/shared/office/engine/officeState.js';
import { TILE_SIZE } from '@pixel/shared/office/constants';

import { buildFurnitureCatalogAndSprites } from './assets.js';

/** An empty map with room to place things. */
const emptyMap = (cols = 12, rows = 12) => ({
  cols,
  rows,
  tiles: new Array(cols * rows).fill(1),
  walls: [],
  furniture: [] as Array<Record<string, unknown>>,
});

/** One placement of `id` at a cell. */
const place = (id: string, col = 3, row = 3) => {
  const entry = getCatalogEntry(id);
  assert.ok(entry, `${id} is not in the catalog`);
  return { uid: `${id}-1`, id, col, row, x: col * TILE_SIZE, y: row * TILE_SIZE, width: entry.width, height: entry.height };
};

/** How often `update` swapped the furniture array over `ticks` ticks of 1/20 s. */
function rebuildsOver(os: OfficeState, ticks: number): number {
  const read = () => (os as unknown as { furniture: unknown[] }).furniture;
  let last = read();
  let n = 0;
  for (let i = 0; i < ticks; i++) {
    os.update(1 / 20);
    if (read() !== last) {
      n++;
      last = read();
    }
  }
  return n;
}

test('a placed animation is rebuilt as its frames advance — from the very first tick', async () => {
  buildDynamicCatalog((await buildFurnitureCatalogAndSprites()) as never);
  // A real animated piece. FOUNTAIN_1 is one; the assertion says so out loud, so if the art ever
  // stops animating this fails with the reason rather than mysteriously passing.
  assert.notEqual(animationFrameAt('FOUNTAIN_1', 0), null, 'FOUNTAIN_1 must be an animated type');

  const layout = { ...emptyMap(), furniture: [place('FOUNTAIN_1')] };
  const os = new OfficeState(layout as never);
  // Two seconds of ticks. Any animation loops well inside that, so zero rebuilds means the
  // clock is advancing and nobody is looking — which is exactly the bug this pins.
  const rebuilds = rebuildsOver(os, 40);
  assert.ok(rebuilds > 0, 'an animated placement produced no rebuild in two seconds — nothing animates');
});

test('a map with nothing animated does not rebuild at all — the check must stay cheap', () => {
  // The other half: the fast path must really be idle. A rebuild per tick would mean the
  // comparison is broken in the direction that costs performance instead of correctness.
  const layout = { ...emptyMap(), furniture: [place('SOFA_BACK', 5, 5)] };
  const os = new OfficeState(layout as never);
  assert.equal(animationFrameAt('SOFA_BACK', 0), null, 'a sofa must not be an animated type');
  assert.equal(rebuildsOver(os, 40), 0, 'nothing animated, so nothing should be rebuilt');
});
