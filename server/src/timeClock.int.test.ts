// Time clock furniture — integration tests for the catalog entry.
//
// ============================================================================
// SCOPE. The server's whole involvement in TimeTracking is this piece of
// furniture plus a 'workStatus' room message: the credential, the vendor's API
// and every rule about bookings live in the Electron main process (see
// desktop/src/timetracking/, tested there). So the only thing to check here is
// that the furniture is well-formed.
//
// The asset used to be drawn in code (timeClockAssets.ts) and these tests
// checked the generator. It is a Tiled tile now — the tileset is the only
// source of furniture (see AGENTS.md) — so they check the same properties one
// step further along: what the catalog actually reads off assets/tiled/.
//
// Covered:
//   - the tile exists in a furniture tileset and carries the timeClock action,
//     which is what makes walking up to it open the clock (via effectiveAction)
//   - its declared size matches the PNG's real dimensions, and both agree with
//     the 1x2 footprint the catalog derives
//
// NOT covered (honest absence): the booking flow, which needs a live
// TimeTracking install and a desktop build — verified by hand.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { PNG } from 'pngjs';

import { parseFurnitureTileset, type TiledTilesetJson } from './core/assets/tiledFurniture.js';
import { isFurnitureTileset } from './tiled/tiledRegistry.js';

const TILED_DIR = path.join(new URL('../..', import.meta.url).pathname, 'assets', 'tiled');

/** The TIME_CLOCK entry, found the way the loader finds it: by walking every
 *  furniture tileset rather than by naming the file it happens to live in. */
function timeClock(): { asset: ReturnType<typeof parseFurnitureTileset>[number]['asset']; imagePath: string } {
  for (const file of fs.readdirSync(TILED_DIR).filter((f) => f.endsWith('.tsj'))) {
    const json = JSON.parse(fs.readFileSync(path.join(TILED_DIR, file), 'utf-8')) as TiledTilesetJson;
    if (!isFurnitureTileset(json)) continue;
    const found = parseFurnitureTileset(json).find((e) => e.asset.id === 'TIME_CLOCK');
    if (found) return found;
  }
  throw new Error('TIME_CLOCK is in no furniture tileset — the time clock is unreachable without it');
}

test('the time clock carries the timeClock action, so walking up to it opens the clock', () => {
  const { asset } = timeClock();
  assert.deepEqual(asset.action, { kind: 'timeClock' });
  assert.equal(asset.label, 'Time Clock');
  // The head hangs above head height; only the pedestal's tile blocks.
  assert.equal(asset.backgroundTiles, 1);
});

test('the time clock declares the dimensions its PNG actually has', () => {
  // Drift here is the classic asset bug: the tileset says one size, the pixels
  // are another, and the thing renders stretched or clipped.
  const { asset, imagePath } = timeClock();
  const png = PNG.sync.read(fs.readFileSync(path.join(TILED_DIR, imagePath)));
  assert.equal(png.width, asset.width, 'PNG width must equal the declared width');
  assert.equal(png.height, asset.height, 'PNG height must equal the declared height');
  // 1x2 tiles at the world's 16px tile size.
  assert.equal(asset.footprintW, 1);
  assert.equal(asset.footprintH, 2);
  assert.equal(asset.footprintW * 16, asset.width);
  assert.equal(asset.footprintH * 16, asset.height);
});

test('the time clock is actually drawn, not an empty grid', () => {
  const { imagePath } = timeClock();
  const png = PNG.sync.read(fs.readFileSync(path.join(TILED_DIR, imagePath)));
  let painted = 0;
  for (let i = 3; i < png.data.length; i += 4) if (png.data[i] > 0) painted++;
  assert.ok(painted > 200, `expected a drawn sprite, got ${painted} painted pixels`);
});
