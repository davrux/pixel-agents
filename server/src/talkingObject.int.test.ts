/**
 * Talking objects — the furniture that says the hour by itself.
 *
 * ============================================================================
 * SCOPE. Three separate things have to be true for the talking whale to say
 * `9:00`, and each fails differently:
 *
 *   1. the ART is in a furniture tileset and carries the action, or a mapper
 *      cannot place a talking object at all (the same check the time clock
 *      gets, for the same reason: a tile that says the wrong size renders
 *      stretched, and a tile with no action is scenery);
 *   2. the CLOCK turns exactly once per hour and says the hour it turned to —
 *      the part nobody can watch, since the boundary comes once an hour and a
 *      test that waited for one would not be written. `update` takes the wall
 *      clock as a parameter precisely so this is a millisecond;
 *   3. the object is NOT walked up to. A talking object is the first action
 *      that fires without a player, so the click path has to leave it alone
 *      while still picking up every other kind — tested with a positive
 *      control beside it, or "returns false" would pass for a piece that is
 *      simply unreachable.
 *
 * NOT covered (honest absence): the bubble itself, which is DOM in
 * OfficeScene, and the broadcast, which is one `this.broadcast` line in
 * SimRoom.handleSpokenLines — both verified by looking at the running client.
 * ============================================================================
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { PNG } from 'pngjs';

import { OfficeState } from '@pixel/shared/office/engine/index.js';
import { announceDue, hourStamp, hourText } from '@pixel/shared/office/engine/talkingObjects.js';
import { isClickAction } from '@pixel/shared/office/layout/furnitureCatalog.js';
import { emptyZoneMap } from '@pixel/shared/office/layout/layoutSerializer.js';
import type { OfficeLayout, PlacedFurniture } from '@pixel/shared/office/types.js';

import { parseFurnitureTileset, type TiledTilesetJson } from './core/assets/tiledFurniture.js';
import { isFurnitureTileset } from './tiled/tiledRegistry.js';

const TILED_DIR = path.join(new URL('../..', import.meta.url).pathname, 'assets', 'tiled');

/** The TALKING_WHALE entry, found the way the loader finds it: by walking every
 *  furniture tileset, not by naming the file it happens to live in. */
function whale(): { asset: ReturnType<typeof parseFurnitureTileset>[number]['asset']; imagePath: string } {
  for (const file of fs.readdirSync(TILED_DIR).filter((f) => f.endsWith('.tsj'))) {
    const json = JSON.parse(fs.readFileSync(path.join(TILED_DIR, file), 'utf-8')) as TiledTilesetJson;
    if (!isFurnitureTileset(json)) continue;
    const found = parseFurnitureTileset(json).find((e) => e.asset.id === 'TALKING_WHALE');
    if (found) return found;
  }
  throw new Error('TALKING_WHALE is in no furniture tileset — there is nothing a mapper could place');
}

// ── 1. the art ──────────────────────────────────────────────────────────────

test('the whale carries the talkingObject action, so placing it is all a mapper does', () => {
  const { asset } = whale();
  assert.deepEqual(asset.action, { kind: 'talkingObject' });
  assert.equal(asset.label, 'Talking Whale');
  // The whale itself is the top two rows — air you walk behind — and only the
  // plinth's row blocks.
  assert.equal(asset.backgroundTiles, 2);
});

test('the whale declares the dimensions its PNG actually has', () => {
  // Drift here is the classic asset bug: the tileset says one size, the pixels
  // are another, and the thing renders stretched or clipped — and for furniture
  // the size is also the footprint, so it would block the wrong cells too.
  const { asset, imagePath } = whale();
  const png = PNG.sync.read(fs.readFileSync(path.join(TILED_DIR, imagePath)));
  assert.equal(png.width, asset.width, 'PNG width must equal the declared width');
  assert.equal(png.height, asset.height, 'PNG height must equal the declared height');
  assert.equal(asset.footprintW, 3);
  assert.equal(asset.footprintH, 3);
  assert.equal(asset.footprintW * 16, asset.width);
  assert.equal(asset.footprintH * 16, asset.height);
  let painted = 0;
  for (let i = 3; i < png.data.length; i += 4) if (png.data[i] > 0) painted++;
  assert.ok(painted > 500, `expected a drawn sprite, got ${painted} painted pixels`);
});

// ── 2. the clock ────────────────────────────────────────────────────────────

/** A local-time moment, so the assertions below read as the wall clock the
 *  server would show — the announcement is deliberately in the server's own
 *  zone (see hourText), which means UTC is the wrong thing to build these from. */
const at = (h: number, m = 0, s = 0): number => new Date(2026, 7, 21, h, m, s).getTime();

test('the hour reads as it is spoken: 24-hour, no leading zero', () => {
  assert.equal(hourText(at(9, 0)), '9:00');
  assert.equal(hourText(at(9, 59, 59)), '9:00', 'still the ninth hour at 9:59:59');
  assert.equal(hourText(at(14, 30)), '14:00');
  assert.equal(hourText(at(0, 5)), '0:00');
  // 21:00, never a second 9:00 — a statue has no am/pm to show, so the one
  // thing this must not be is ambiguous.
  assert.equal(hourText(at(21, 0)), '21:00');
});

test('every moment inside one hour has one stamp, and the next hour has another', () => {
  assert.equal(hourStamp(at(9, 0, 0)), hourStamp(at(9, 59, 59)));
  assert.notEqual(hourStamp(at(9, 59, 59)), hourStamp(at(10, 0, 0)));
  assert.equal(hourStamp(at(9, 30)), at(9, 0, 0), 'the stamp IS the moment the hour began');
});

test('the first tick adopts the hour instead of announcing it', () => {
  // Arriving at 9:05 is not being present at 9:00, and a bubble saying 9:00
  // five minutes late is not late, it is wrong.
  const first = announceDue(at(9, 5), null);
  assert.equal(first.due, false);
  assert.equal(first.stamp, at(9, 0, 0));
  // …and the hour that follows is announced normally.
  assert.equal(announceDue(at(10, 0, 1), first.stamp).due, true);
});

test('the hour is announced on the boundary and not again inside it', () => {
  let stamp: number | null = null;
  const fired: string[] = [];
  for (const t of [at(8, 59, 58), at(8, 59, 59), at(9, 0, 0), at(9, 0, 1), at(9, 30), at(10, 0, 0)]) {
    const { due, stamp: next } = announceDue(t, stamp);
    stamp = next;
    if (due) fired.push(hourText(t));
  }
  assert.deepEqual(fired, ['9:00', '10:00']);
});

// ── 3. the engine, driven headlessly ────────────────────────────────────────

const COLS = 20;
const ROWS = 12;

/** A 1x1 placement carrying its action as a per-placement override — which is
 *  also the thing being checked: any piece of furniture can be made to talk,
 *  the whale is just the one drawn for it. */
function piece(uid: string, col: number, row: number, action: PlacedFurniture['action']): PlacedFurniture {
  return { uid, id: `TEST_${uid}`, col, row, action } as PlacedFurniture;
}

function world(furniture: PlacedFurniture[]): OfficeState {
  const layout: OfficeLayout = { ...emptyZoneMap(COLS, ROWS), furniture };
  return new OfficeState(layout);
}

test('a talking object says the hour, once, when the hour turns', () => {
  const os = world([piece('whale', 5, 5, { kind: 'talkingObject' })]);

  os.update(0.05, at(8, 59, 59));
  assert.deepEqual(os.takeSpokenLines(), [], 'the first tick adopts the hour, it does not announce it');

  os.update(0.05, at(9, 0, 0));
  assert.deepEqual(os.takeSpokenLines(), [{ col: 5, row: 5, text: '9:00' }]);

  // The rest of the hour is silent — 20 ticks a second for an hour would
  // otherwise be 72 000 bubbles.
  for (const t of [at(9, 0, 1), at(9, 15), at(9, 59, 59)]) os.update(0.05, t);
  assert.deepEqual(os.takeSpokenLines(), []);

  os.update(0.05, at(10, 0, 0));
  assert.deepEqual(os.takeSpokenLines(), [{ col: 5, row: 5, text: '10:00' }]);
});

test('every talking object in the zone says it, and nothing else says anything', () => {
  const os = world([
    piece('whale', 5, 5, { kind: 'talkingObject' }),
    piece('other', 12, 3, { kind: 'talkingObject' }),
    piece('kiosk', 8, 8, { kind: 'meetingManager' }),
    piece('bin', 2, 2, undefined),
  ]);
  os.update(0.05, at(8, 59, 59));
  os.update(0.05, at(9, 0, 0));
  assert.deepEqual(os.takeSpokenLines(), [
    { col: 5, row: 5, text: '9:00' },
    { col: 12, row: 3, text: '9:00' },
  ]);
});

test('reading the lines empties them, so the room cannot broadcast one twice', () => {
  const os = world([piece('whale', 5, 5, { kind: 'talkingObject' })]);
  os.update(0.05, at(8, 59, 59));
  os.update(0.05, at(9, 0, 0));
  assert.equal(os.takeSpokenLines().length, 1);
  assert.deepEqual(os.takeSpokenLines(), [], 'drained by the read');
});

test('a zone with nothing that talks never speaks, whatever the clock does', () => {
  const os = world([piece('kiosk', 8, 8, { kind: 'meetingManager' })]);
  for (const t of [at(8, 59, 59), at(9, 0, 0), at(10, 0, 0), at(11, 0, 0)]) os.update(0.05, t);
  assert.deepEqual(os.takeSpokenLines(), []);
});

// ── 4. clicking it does nothing ─────────────────────────────────────────────

test('a click reaches every action except the two that are not clicks', () => {
  assert.equal(isClickAction({ kind: 'meetingManager' }), true);
  assert.equal(isClickAction({ kind: 'arcade' }), true);
  assert.equal(isClickAction({ kind: 'iframe', url: 'https://example.com' }), true);
  // The appliance has its own approach path; the talking object has no approach
  // at all.
  assert.equal(isClickAction({ kind: 'appliance', pose: 'coffee' }), false);
  assert.equal(isClickAction({ kind: 'talkingObject' }), false);
  assert.equal(isClickAction(null), false);
});

test('walking up to a talking object is refused, while its neighbour still works', () => {
  // The positive control is the point: "returns false" would also be what an
  // unreachable piece of furniture returns, so the same player, in the same
  // world, one tile away, must succeed on a real click action.
  const os = world([
    piece('whale', 5, 5, { kind: 'talkingObject' }),
    piece('kiosk', 8, 5, { kind: 'meetingManager' }),
  ]);
  const id = os.addPlayer('char_0', 'Tester', { col: 6, row: 6 });

  assert.equal(os.walkPlayerToAction(id, 8, 5), true, 'the kiosk beside it is still a click action');
  assert.deepEqual(
    os.takePendingActionArrivals().map((a) => a.action.kind),
    [],
    'not standing at the kiosk yet — it walks there first',
  );

  assert.equal(os.walkPlayerToAction(id, 5, 5), false, 'the whale is not walked up to');
  assert.deepEqual(os.takePendingActionArrivals(), [], 'and nothing fired');
});
