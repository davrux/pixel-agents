/**
 * A decal turned in Tiled comes out turned — and the one case that cannot be turned says so.
 *
 * Decals already carried Tiled's two mirrors; the third bit (the axes swap) was dropped,
 * which made a diagonally flipped decal draw unrotated. That is the same class of silent
 * mismatch between editor and game as the mirrored ground cell, so it is fixed the same way
 * and through the same table (shared/office/tileOrientation.ts).
 *
 * The interesting half is the refusal. Ground can always take a quarter turn because
 * `groundFits` guarantees one square cell; a decal cannot, because its art may be several
 * cells tall, and a 16×48 tree turned 90° would occupy 48×16 — not the cells it was placed
 * on. What Tiled itself draws for an oversized rotated tile in a tile layer is not something
 * this repo can check against, so the import keeps the mirrors, drops the turn, and names
 * the id. This file pins both halves, because "it silently did nothing" is exactly the
 * behaviour being replaced.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';

import { buildDynamicCatalog, getCatalogEntry } from '@pixel/shared/office/layout/furnitureCatalog';
import { layoutToDecalInstances } from '@pixel/shared/office/layout/layoutSerializer';
import { orientationOf } from '@pixel/shared/office/tileOrientation';
import { TILE_SIZE } from '@pixel/shared/office/constants';

import { ASSETS_ROOT, buildFurnitureCatalogAndSprites } from '../assets.js';
import { importTmjToLayout } from './mapBridge.js';
import { loadTiledRegistry } from './tiledRegistry.js';

const COLS = 10;
const ROWS = 10;
const TMJ_H = 0x80000000;
const TMJ_V = 0x40000000;
const TMJ_D = 0x20000000;

const registry = loadTiledRegistry(ASSETS_ROOT);
const decalSet = registry.bySource('decal.tsj');
const noImages = (): null => null;

/** One cell of a decal layer, whatever gid the caller wants on it. */
function mapWith(index: number, gid: number): Record<string, unknown> {
  const data = new Array(COLS * ROWS).fill(0);
  data[index] = gid;
  return {
    width: COLS,
    height: ROWS,
    tilesets: [{ firstgid: 1, source: 'decal.tsj' }],
    layers: [{ class: 'DecalLayer', name: 'Decals', type: 'tilelayer', data }],
  };
}

/** A decal tile of a given art shape — square, or not (decal.tsj holds a 32×16 one). */
function localIdWhere(pick: (w: number, h: number) => boolean): number {
  assert.ok(decalSet, 'assets/tiled/decal.tsj is not on disk');
  for (let i = 0; i < decalSet.tiles.length; i++) {
    const entry = getCatalogEntry(String(decalSet.tiles[i]?.props.id ?? ''));
    if (entry && pick(entry.width, entry.height)) return i;
  }
  throw new Error('decal.tsj holds no tile of the shape this test needs');
}

test('a square decal takes all eight orientations, like a ground cell', async () => {
  buildDynamicCatalog((await buildFurnitureCatalogAndSprites()) as never);
  const square = localIdWhere((w, h) => w === h && w === TILE_SIZE);
  const cases = [
    { tmj: 0, h: undefined, v: undefined, d: undefined, label: 'as painted' },
    { tmj: TMJ_H, h: true, v: undefined, d: undefined, label: 'H' },
    { tmj: TMJ_V, h: undefined, v: true, d: undefined, label: 'V' },
    { tmj: TMJ_H + TMJ_V, h: true, v: true, d: undefined, label: 'H+V' },
    { tmj: TMJ_D, h: undefined, v: undefined, d: true, label: 'D' },
    { tmj: TMJ_D + TMJ_H, h: true, v: undefined, d: true, label: 'D+H' },
    { tmj: TMJ_D + TMJ_V, h: undefined, v: true, d: true, label: 'D+V' },
    { tmj: TMJ_D + TMJ_H + TMJ_V, h: true, v: true, d: true, label: 'D+H+V' },
  ];
  for (const c of cases) {
    const { layout } = importTmjToLayout(mapWith(3 * COLS + 3, 1 + square + c.tmj), registry, noImages);
    const decal = layout.decals?.[0];
    assert.ok(decal, `${c.label}: the decal did not survive the import`);
    assert.equal(decal.flippedHorizontally, c.h, `${c.label}: horizontal`);
    assert.equal(decal.flippedVertically, c.v, `${c.label}: vertical`);
    assert.equal(decal.flippedDiagonally, c.d, `${c.label}: diagonal`);
    // And it reaches the renderer: the instance carries the same three answers.
    const inst = layoutToDecalInstances(layout.decals)[0];
    assert.equal(inst.mirrored, c.h, `${c.label}: instance mirrored`);
    assert.equal(inst.flippedVertically, c.v, `${c.label}: instance flippedVertically`);
    assert.equal(inst.flippedDiagonally, c.d, `${c.label}: instance flippedDiagonally`);
  }
});

test('the eight orientations are eight DIFFERENT drawings', async () => {
  // Guard on the guard: if two of them resolved to the same flip/angle triple, the test
  // above would still pass while two orientations drew identically.
  buildDynamicCatalog((await buildFurnitureCatalogAndSprites()) as never);
  const seen = new Set<string>();
  for (const [h, v, d] of [
    [false, false, false],
    [true, false, false],
    [false, true, false],
    [true, true, false],
    [false, false, true],
    [true, false, true],
    [false, true, true],
    [true, true, true],
  ]) {
    const o = orientationOf(h, v, d);
    const key = `${o.flipX}/${o.flipY}/${o.angle}`;
    assert.equal(seen.has(key), false, `H=${h} V=${v} D=${d} draws like an earlier one (${key})`);
    seen.add(key);
  }
});

test('a decal whose art is not square keeps its mirrors but not the quarter turn', async () => {
  buildDynamicCatalog((await buildFurnitureCatalogAndSprites()) as never);
  // 32×16 here: turned 90° it would occupy 16×32, i.e. a cell the mapper did not paint.
  const oblong = localIdWhere((w, h) => w !== h);
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args.join(' '));
  let layout;
  try {
    ({ layout } = importTmjToLayout(mapWith(5 * COLS + 5, 1 + oblong + TMJ_D + TMJ_H), registry, noImages));
  } finally {
    console.warn = realWarn;
  }
  const decal = layout.decals?.[0];
  assert.ok(decal, 'the decal itself must survive — only the turn is refused');
  assert.equal(decal.flippedHorizontally, true, 'the mirror still applies');
  assert.equal(decal.flippedDiagonally, undefined, 'a non-square decal must not be rotated');
  assert.ok(
    warnings.some((w) => w.includes(decal.id) && /square/.test(w)),
    `expected a warning naming "${decal.id}" and why, got: ${warnings.join(' | ') || '(nothing)'}`,
  );
});

test('a map with no rotated decal produces no warning and no diagonal flags', async () => {
  buildDynamicCatalog((await buildFurnitureCatalogAndSprites()) as never);
  const oblong = localIdWhere((w, h) => w !== h);
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args.join(' '));
  let layout;
  try {
    ({ layout } = importTmjToLayout(mapWith(5 * COLS + 5, 1 + oblong + TMJ_V), registry, noImages));
  } finally {
    console.warn = realWarn;
  }
  assert.equal(layout.decals?.[0]?.flippedVertically, true);
  assert.equal(layout.decals?.[0]?.flippedDiagonally, undefined);
  assert.equal(
    warnings.filter((w) => /square/.test(w)).length,
    0,
    `a mirrored (not rotated) decal must not complain: ${warnings.join(' | ')}`,
  );
});
