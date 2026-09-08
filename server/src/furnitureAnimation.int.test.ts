/**
 * A still world is still on the wire — and animated furniture is exactly what used to break that.
 *
 * This test was inverted on purpose, and the reason is worth reading before changing it back.
 *
 * It used to DEMAND a rebuild: the engine expressed an animation frame as a different art id
 * (`{...item, id: frame}`), so it swapped its placement list every time a frame advanced, and this
 * file asserted that it did — because once, silently, it had stopped. But that swap was the trigger
 * `SimRoom.syncFurniture` hung off: it threw away all 163 `FurnitureSync` records and rebuilt them,
 * so every one of nineteen fields was dirty, and a patch carried the whole map. Measured on uponu
 * with ONE character and nothing moving: **11 442 bytes per patch, 5 swaps per second, 57 KB/s per
 * viewer** — 46 Mbit/s at 100 viewers, to say that a goldfish and a flag had reached their next
 * picture. What actually differed between two swaps was four short art ids, of 163 × 19 fields.
 *
 * A frame is presentation timing (AGENTS.md invariant 2: "Sync state and intent, not frames"), so
 * it moved to the client — which already has the same catalog and the same `animationFrameAt`. The
 * server keeps the half no client could work out: **which pieces are switched ON**, from who is
 * sitting where. So the properties are now:
 *
 *  1. **Nothing churns while nobody acts** — an animated piece placed, twenty seconds of ticks,
 *     and the placement list keeps its identity. That is what makes the wire silent, and it is the
 *     opposite of what this file used to require.
 *  2. **The frames are still there to animate from.** The client's whole ability to do this rests
 *     on `animationFrameAt` returning different ids over one loop, so it is asserted here rather
 *     than assumed — if the art ever stops animating, this says so instead of a world quietly
 *     standing still.
 *  3. **On/off still comes from the server, as uids.** Somebody sitting down at a desk lights its
 *     monitor: the uid appears in `furnitureOnUids` AND the engine's own placement carries the ON
 *     variant. Both, because the client draws from the first and the server's geometry from the
 *     second, and a disagreement would be a dark screen at a working desk.
 *  4. **Standing up switches it off again**, and the list goes back to empty — so the synced set
 *     cannot silently accumulate the uid of every desk anybody ever sat at.
 *
 * TEST BOUNDARIES:
 *   @real-dependency: the Tiled furniture catalog and the real engine -- Mock? NO. Whether a type
 *       animates and what its "on" variant is are facts about the real art (`animationFrameAt`,
 *       `onState` on the tile); a stub would test the loop instead of the question. The auto-on
 *       geometry (who faces what) is engine behaviour and is the point of claims 3 and 4.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';

import { animationFrameAt, buildDynamicCatalog, getCatalogEntry } from '@pixel/shared/office/layout/furnitureCatalog';
import { OfficeState } from '@pixel/shared/office/engine/officeState.js';
import { TILE_SIZE } from '@pixel/shared/office/constants';
import { CharacterState, Direction } from '@pixel/shared/office/types';

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

/** How often `update` replaced the placement list over `ticks` ticks of 1/20 s. */
function churnOver(os: OfficeState, ticks: number): number {
  let last = os.furniturePlacements;
  let n = 0;
  for (let i = 0; i < ticks; i++) {
    os.update(1 / 20);
    if (os.furniturePlacements !== last) {
      n++;
      last = os.furniturePlacements;
    }
  }
  return n;
}

test('an animated piece costs the wire nothing: twenty seconds of ticks, no churn', async () => {
  buildDynamicCatalog((await buildFurnitureCatalogAndSprites()) as never);
  // A real animated piece, named out loud so a change in the art fails with the reason.
  assert.notEqual(animationFrameAt('FOUNTAIN_1', 0), null, 'FOUNTAIN_1 must be an animated type');

  const os = new OfficeState({ ...emptyMap(), furniture: [place('FOUNTAIN_1')] } as never);
  // 400 ticks — a fountain loops many times over in that, and the old engine swapped the list
  // about 100 times, each swap putting the whole map on every viewer's wire.
  assert.equal(churnOver(os, 400), 0, 'the placement list was replaced while nothing happened');
  assert.deepEqual(os.furnitureOnUids, [], 'a fountain has no on/off state to report');
});

test('the frames a client animates from are really there', () => {
  // Claim 2: the client resolves the frame itself, so this is the fact the whole feature rests on.
  const ids = new Set<string>();
  for (let ms = 0; ms < 4000; ms += 20) {
    const id = animationFrameAt('FOUNTAIN_1', ms);
    if (id) ids.add(id);
  }
  assert.ok(ids.size > 1, `FOUNTAIN_1 shows only ${[...ids]} over four seconds — nothing to animate`);
  // And a piece that does not animate must say so, or the client would put every chair on a clock.
  assert.equal(animationFrameAt('SOFA_BACK', 0), null, 'a sofa must not be an animated type');
});

test('sitting down switches the monitor on — as a uid and in the engine placement', () => {
  // PC_FRONT_OFF names PC_FRONT_ON_1 as its on-state (furniture-electronics.tsj), and its ON half
  // is itself animated — which is the case worth testing: the server says "on", the client
  // animates what that resolves to.
  const pc = place('PC_FRONT_OFF', 4, 3);
  const os = new OfficeState({ ...emptyMap(), furniture: [pc] } as never);
  os.update(1 / 20);
  assert.deepEqual(os.furnitureOnUids, [], 'the desk was lit with nobody at it');

  // A player seated one tile below the PC, facing up at it.
  const id = os.addPlayer('char_0', 'tester', { col: 4, row: 4 });
  const ch = os.getCharacter(id);
  assert.ok(ch);
  ch.state = CharacterState.SIT;
  ch.dir = Direction.UP;
  ch.tileCol = 4;
  ch.tileRow = 4;
  os.update(1 / 20);

  assert.deepEqual(os.furnitureOnUids, [pc.uid], 'sitting down did not switch the monitor on');
  const placed = os.furniturePlacements.find((f) => f.uid === pc.uid);
  assert.equal(placed?.id, 'PC_FRONT_ON_1', 'the engine kept the OFF art while reporting the piece as on');
  assert.notEqual(animationFrameAt('PC_FRONT_ON_1', 0), null, 'the ON half should animate — that is the client half of this');

  // Standing up puts it back, and leaves nothing behind in the synced set.
  ch.state = CharacterState.IDLE;
  os.update(1 / 20);
  assert.deepEqual(os.furnitureOnUids, [], 'standing up left the monitor on');
  assert.equal(os.furniturePlacements.find((f) => f.uid === pc.uid)?.id, 'PC_FRONT_OFF');
});
