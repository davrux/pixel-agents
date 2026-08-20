/**
 * A ground cell mirrored in Tiled comes out mirrored in the game.
 *
 * The import used to throw the three flip bits away. It had to strip them to RESOLVE the
 * gid — a mirrored gid matches no tileset range, and the cell silently became VOID, i.e.
 * invisible AND unwalkable — but stripping is not the same as keeping, so the editor showed
 * a mirrored floor and the game drew the original. That is the failure this file pins: the
 * bits survive the import, land on the right cell, and mean what Tiled means by them.
 *
 * The other half is that the array must not exist unless it is used. A dense per-cell array
 * on a 56×57 map is 3192 numbers travelling to every client on every join, and no map today
 * mirrors anything — so "absent when nothing is mirrored" is a property worth asserting, not
 * an implementation detail.
 *
 * Uses a real ground tileset from disk, so this also fails if the sheet stops being square
 * (`groundFits` is what makes the diagonal orientations safe: a quarter turn is only
 * harmless because a ground tile is exactly one map cell).
 */
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';

import { ORIENT_D, ORIENT_H, ORIENT_V } from '@pixel/shared/office/tileOrientation';
import { TILE_SIZE } from '@pixel/shared/office/constants';

import { ASSETS_ROOT } from '../assets.js';
import { importTmjToLayout } from './mapBridge.js';
import { loadTiledRegistry } from './tiledRegistry.js';

const COLS = 8;
const ROWS = 4;

/** Tiled's bits, as they appear in a .tmj's own `data` array. */
const TMJ_H = 0x80000000;
const TMJ_V = 0x40000000;
const TMJ_D = 0x20000000;

const registry = loadTiledRegistry(ASSETS_ROOT);
const noImages = (): null => null;

/** A ground tileset that is on disk and holds square, one-cell tiles. */
function groundSet(): { file: string; localId: number } {
  const set = registry.bySource('floor-endesga.tsj');
  assert.ok(set, 'assets/tiled/floor-endesga.tsj is not on disk');
  assert.equal(set.tileWidth || TILE_SIZE, TILE_SIZE, 'a ground tile must be one cell wide');
  assert.equal(set.tileHeight || TILE_SIZE, TILE_SIZE, 'a ground tile must be one cell tall');
  return { file: 'floor-endesga.tsj', localId: 1 * set.columns + 8 };
}

function importGround(data: number[]): ReturnType<typeof importTmjToLayout>['layout'] {
  return importTmjToLayout(
    {
      width: COLS,
      height: ROWS,
      tilesets: [{ firstgid: 1, source: groundSet().file }],
      layers: [{ class: 'GroundLayer', name: 'Ground', type: 'tilelayer', data }],
    },
    registry,
    noImages,
  ).layout;
}

test('each of Tiled\'s eight orientations survives the import as itself', () => {
  const { localId } = groundSet();
  const gid = 1 + localId;
  // Painted in the order the bits are numbered, so a mix-up between H and V shows up as a
  // swap rather than as "something is wrong somewhere".
  const cases: Array<{ tmj: number; expect: number; label: string }> = [
    { tmj: 0, expect: 0, label: 'as painted' },
    { tmj: TMJ_H, expect: ORIENT_H, label: 'mirrored left/right' },
    { tmj: TMJ_V, expect: ORIENT_V, label: 'mirrored top/bottom' },
    { tmj: TMJ_H + TMJ_V, expect: ORIENT_H | ORIENT_V, label: 'half turn' },
    { tmj: TMJ_D, expect: ORIENT_D, label: 'transposed' },
    { tmj: TMJ_D + TMJ_H, expect: ORIENT_D | ORIENT_H, label: 'quarter turn clockwise' },
    { tmj: TMJ_D + TMJ_V, expect: ORIENT_D | ORIENT_V, label: 'quarter turn anticlockwise' },
    { tmj: TMJ_D + TMJ_H + TMJ_V, expect: ORIENT_D | ORIENT_H | ORIENT_V, label: 'other diagonal' },
  ];

  const data = new Array(COLS * ROWS).fill(0);
  cases.forEach((c, i) => (data[i] = gid + c.tmj));
  const layout = importGround(data);

  assert.ok(layout.tileFlip, 'a map that mirrors cells must carry tileFlip');
  cases.forEach((c, i) => {
    assert.equal(layout.tileFlip?.[i], c.expect, `cell ${i} (${c.label})`);
    // The tile itself is untouched by the orientation — same picture, turned.
    assert.equal(layout.tiles[i], localId, `cell ${i} (${c.label}) lost its tile`);
    assert.equal(layout.tileFloorSet?.[i], 0, `cell ${i} (${c.label}) lost its set`);
  });
});

test('the array is parallel to tiles, and a mirrored cell is still walkable ground', () => {
  const { localId } = groundSet();
  const data = new Array(COLS * ROWS).fill(0);
  const at = 2 * COLS + 5;
  data[at] = 1 + localId + TMJ_H + TMJ_D;
  const layout = importGround(data);

  assert.equal(layout.tileFlip?.length, COLS * ROWS, 'one entry per cell, like tileBlocked');
  assert.equal(layout.tileFlip?.[at], ORIENT_H | ORIENT_D, 'the orientation sits on the painted cell');
  // Every OTHER cell is unmirrored — an off-by-one in the loop would smear the mask.
  assert.equal(
    layout.tileFlip?.filter((bits) => bits !== 0).length,
    1,
    'only the painted cell is mirrored',
  );
  // Cosmetic and nothing else: the cell is ground, so it is still walkable.
  assert.notEqual(layout.tiles[at], -1, 'a mirrored cell must not become VOID');
});

test('a map that mirrors nothing carries no tileFlip at all', () => {
  const { localId } = groundSet();
  const data = new Array(COLS * ROWS).fill(0);
  data[0] = 1 + localId;
  data[1] = 1 + localId;
  const layout = importGround(data);
  assert.equal(layout.tileFlip, undefined, '3192 zeros must not travel to every client');
  // And the fields it is parallel to are still there, so "absent" is about this one array.
  assert.equal(layout.tiles.length, COLS * ROWS);
  assert.equal(layout.tileFloorSet?.length, COLS * ROWS);
});

test('every committed zone map carries exactly the orientations its file states', () => {
  // Counted from the .tmj itself rather than asserting "no map uses this", which was true
  // for about a day: uponu mirrors 98 ground cells now. Reading the flip bits out of the
  // raw file and comparing the totals is the version of this that keeps working, and it is
  // the one that actually catches the regression it was written for — a bitwise `&` instead
  // of this file's subtraction style makes 0x80000000 negative, and ORDINARY cells start
  // reporting an orientation, which shows up here as a count that does not match.
  const dir = path.join(ASSETS_ROOT, 'assets', 'tiled', 'zones');
  const maps = fs.readdirSync(dir).filter((f) => f.endsWith('.tmj'));
  assert.ok(maps.length > 0, 'no bundled zone maps to check');
  const ANY_FLIP = 0x80000000 + 0x40000000 + 0x20000000;
  for (const file of maps) {
    const tmj = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as {
      layers?: Array<{ class?: string; data?: number[] }>;
    };
    const ground = tmj.layers?.find((l) => l.class === 'GroundLayer')?.data ?? [];
    const stated = ground.filter((gid) => ((gid >>> 0) & ANY_FLIP) !== 0).length;
    const { layout } = importTmjToLayout(tmj as Record<string, unknown>, registry, noImages);
    const carried = (layout.tileFlip ?? []).filter((bits) => bits !== 0).length;
    assert.equal(carried, stated, `${file}: the map states ${stated} turned ground cell(s), the layout carries ${carried}`);
    if (stated === 0) assert.equal(layout.tileFlip, undefined, `${file}: nothing is turned, so no array should travel`);
    for (const bits of layout.tileFlip ?? []) {
      assert.ok(bits >= 0 && bits <= 7, `${file}: ${bits} is not one of the eight orientations`);
    }
  }
});
