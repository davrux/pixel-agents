/**
 * A placement may carry its own drawn size (Tiled's object resize). Ignoring it was two
 * bugs in one — drawn at the art's size AND anchored by the art's footprint, so a
 * machine placed at 16×16 from 32×32 art appeared twice as large and a cell too high.
 * These pin both halves, and the consequences a size has beyond the picture.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';

import { buildDynamicCatalog, entryFor, getCatalogEntry } from '@pixel/shared/office/layout/furnitureCatalog';
import { getBlockedTiles, layoutToFurnitureInstances } from '@pixel/shared/office/layout/layoutSerializer';
import { TILE_SIZE } from '@pixel/shared/office/constants';

import { ASSETS_ROOT, buildFurnitureCatalogAndSprites } from '../assets.js';
import { importTmjToLayout } from './mapBridge.js';
import { loadTiledRegistry } from './tiledRegistry.js';

const registry = loadTiledRegistry(ASSETS_ROOT);
const noImages = () => null;
const COLS = 10;
const ROWS = 10;

/** A one-object map placing `id` at Tiled's bottom-left anchor (col, bottomRow+1). */
function mapWith(id: string, size: { w: number; h: number } | null, col: number, bottomRow: number) {
  const set = registry.tilesets.find((ts) => ts.tiles.some((t) => t?.props?.id === id));
  assert.ok(set, `no tileset carries ${id}`);
  const localId = set.tiles.findIndex((t) => t?.props?.id === id);
  const native = getCatalogEntry(id);
  assert.ok(native, `${id} is not in the catalog`);
  return {
    width: COLS,
    height: ROWS,
    tilesets: [{ firstgid: 1, source: `../${set.file}` }],
    layers: [
      {
        class: 'FurnitureLayer',
        name: 'Furniture',
        type: 'objectgroup',
        objects: [
          {
            id: 1,
            gid: 1 + localId,
            type: 'FurnitureObject',
            x: col * TILE_SIZE,
            y: (bottomRow + 1) * TILE_SIZE,
            width: size ? size.w : native.width,
            height: size ? size.h : native.height,
            visible: true,
            rotation: 0,
            name: '',
          },
        ],
      },
    ],
  };
}

test('a resized placement keeps its size and lands where Tiled shows it', async () => {
  buildDynamicCatalog((await buildFurnitureCatalogAndSprites()) as never);
  const native = getCatalogEntry('ESPRESSO_MACHINE');
  assert.equal(native?.height, 32, 'this test needs art taller than one cell');

  // Placed at half size, bottom edge on row 5 → it occupies row 5, not row 4.
  const { layout } = importTmjToLayout(mapWith('ESPRESSO_MACHINE', { w: 16, h: 16 }, 5, 5), registry, noImages);
  const item = layout.furniture[0];
  assert.equal(item.width, 16);
  assert.equal(item.height, 16);
  assert.deepEqual({ col: item.col, row: item.row }, { col: 5, row: 5 });

  // The cells follow from the size, so collision agrees with the picture…
  const resolved = entryFor(item);
  assert.deepEqual({ w: resolved?.footprintW, h: resolved?.footprintH }, { w: 1, h: 1 });
  // …and the sprite is drawn at that size, at that cell.
  const inst = layoutToFurnitureInstances(layout.furniture)[0];
  assert.deepEqual({ w: inst.width, h: inst.height, x: inst.x, y: inst.y }, { w: 16, h: 16, x: 80, y: 80 });
});

test('an unresized placement is untouched — the normal case', async () => {
  buildDynamicCatalog((await buildFurnitureCatalogAndSprites()) as never);
  const { layout } = importTmjToLayout(mapWith('ESPRESSO_MACHINE', null, 5, 5), registry, noImages);
  const item = layout.furniture[0];
  assert.equal(item.width, undefined, 'no size is stored when it is the art\'s own');
  assert.equal(item.height, undefined);
  // 32px art anchored with its bottom on row 5 covers rows 4 and 5.
  assert.deepEqual({ col: item.col, row: item.row }, { col: 5, row: 4 });
  assert.equal(entryFor(item), getCatalogEntry('ESPRESSO_MACHINE'), 'the shared entry is reused, not copied');
});

test('shrinking scales the air rows with it, or the appliance becomes walk-through', async () => {
  buildDynamicCatalog((await buildFurnitureCatalogAndSprites()) as never);
  const native = getCatalogEntry('ESPRESSO_MACHINE');
  assert.equal(native?.backgroundTiles, 1, 'this test needs art whose top row is air');

  const small = importTmjToLayout(mapWith('ESPRESSO_MACHINE', { w: 16, h: 16 }, 5, 5), registry, noImages).layout;
  assert.equal(entryFor(small.furniture[0])?.backgroundTiles, 0, '1 air row of 2 cells is half a cell at half size');
  assert.deepEqual([...getBlockedTiles(small.furniture)], ['5,5'], 'it stands on its cell');

  const full = importTmjToLayout(mapWith('ESPRESSO_MACHINE', null, 5, 5), registry, noImages).layout;
  // 2×2 art: its top row is air, its bottom row blocks — both cells of it.
  assert.deepEqual([...getBlockedTiles(full.furniture)].sort(), ['5,5', '6,5'], 'unscaled: the whole bottom row blocks');
});

test('a piece smaller than a cell still occupies one', async () => {
  buildDynamicCatalog((await buildFurnitureCatalogAndSprites()) as never);
  const { layout } = importTmjToLayout(mapWith('ESPRESSO_MACHINE', { w: 8, h: 8 }, 3, 3), registry, noImages);
  const resolved = entryFor(layout.furniture[0]);
  assert.deepEqual({ w: resolved?.footprintW, h: resolved?.footprintH }, { w: 1, h: 1 }, 'never zero cells');
});
