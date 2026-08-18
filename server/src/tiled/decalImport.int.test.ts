/**
 * Decals: painted map art that must never become a synced object.
 *
 * The whole reason DecalLayer exists is cost — a map may paint hundreds of
 * ground patches without paying for hundreds of FurnitureSync objects (see
 * PlacedDecal). So the first thing asserted here is the negative: a decal layer
 * produces no furniture, blocks nothing, and occupies nothing. If a later change
 * quietly routes decals through the furniture path, that is the assertion that
 * fails, not a frame-rate report six months from now.
 *
 * The second thing is the one that cannot be caught by eye in a diff: Tiled
 * anchors an oversized tile at its cell's BOTTOM edge, while the layout stores a
 * top-left cell. Getting that conversion wrong shifts art between editor and
 * game, which is precisely what the whole Tiled path exists to prevent.
 *
 * Uses the real decal tileset on disk (assets/tiled/decal.tsj), so a hand edit
 * that drops the `id` property or the DecalTile class fails here too.
 */
import { strict as assert } from 'node:assert';
import * as path from 'node:path';
import test from 'node:test';

import { buildDynamicCatalog, getCatalogEntry } from '@pixel/shared/office/layout/furnitureCatalog';
import { getBlockedTiles, layoutToDecalInstances } from '@pixel/shared/office/layout/layoutSerializer';
import { DECAL_DEPTH, TILE_SIZE } from '@pixel/shared/office/constants';

import { ASSETS_ROOT, buildFurnitureCatalogAndSprites } from '../assets.js';
import { importTmjToLayout } from './mapBridge.js';
import { loadTiledRegistry } from './tiledRegistry.js';

const COLS = 10;
const ROWS = 10;

/** A minimal map: one DecalLayer, whatever cells the caller paints. */
function mapWith(
  cells: Array<{ index: number; gid: number }>,
  opts: { layerName?: string; occludes?: boolean } = {},
): Record<string, unknown> {
  const data = new Array(COLS * ROWS).fill(0);
  for (const { index, gid } of cells) data[index] = gid;
  return {
    width: COLS,
    height: ROWS,
    tilesets: [{ firstgid: 1, source: 'decal.tsj' }],
    layers: [
      {
        class: 'DecalLayer',
        name: opts.layerName ?? 'Decals',
        type: 'tilelayer',
        data,
        ...(opts.occludes === undefined ? {} : { properties: [{ name: 'occludes', type: 'bool', value: opts.occludes }] }),
      },
    ],
  };
}

const registry = loadTiledRegistry(ASSETS_ROOT);
const decalSet = registry.bySource('decal.tsj');
const noImages = () => null;

/** The local id of a decal tile that is `tiles` cells tall, so the bottom-anchor
 *  conversion can be tested on real art rather than an invented size. */
function localIdOfHeight(tiles: number): number {
  assert.ok(decalSet, 'assets/tiled/decal.tsj is not on disk');
  assert.ok(
    decalSet.tiles.some((t) => t?.class === 'DecalTile' && t.props.id),
    'decal.tsj holds no DecalTile with an id',
  );
  for (let i = 0; i < decalSet.tiles.length; i++) {
    const entry = getCatalogEntry(String(decalSet.tiles[i]?.props.id ?? ''));
    if (entry && Math.round(entry.height / TILE_SIZE) === tiles) return i;
  }
  throw new Error(`decal.tsj holds no tile ${tiles} cells tall`);
}

test('a decal layer produces decals — and no furniture, no collision', async () => {
  buildDynamicCatalog((await buildFurnitureCatalogAndSprites()) as never);
  const flat = localIdOfHeight(1);
  const cell = 4 * COLS + 3;

  const { layout } = importTmjToLayout(mapWith([{ index: cell, gid: 1 + flat }]), registry, noImages);

  assert.equal(layout.decals?.length, 1, 'the painted cell did not become a decal');
  assert.equal(layout.furniture.length, 0, 'a decal layer must never produce furniture');
  assert.equal(getBlockedTiles(layout.furniture).size, 0, 'a decal must not block');
  const decal = layout.decals![0];
  assert.equal(decal.col, 3);
  assert.equal(decal.row, 4);
  // No uid: a decal has no identity to hold, which is what keeps it out of every
  // per-object bookkeeping map on the server.
  assert.equal('uid' in decal, false, 'a decal must not carry a uid');
});

test('an oversized decal converts from Tiled\'s bottom anchor to the top-left cell', async () => {
  buildDynamicCatalog((await buildFurnitureCatalogAndSprites()) as never);
  const tall = localIdOfHeight(3);
  const entry = getCatalogEntry(String(decalSet!.tiles[tall].props.id));
  assert.equal(Math.round(entry!.height / TILE_SIZE), 3);

  // Painted in the cell at row 6: Tiled draws it upwards from that cell's bottom
  // edge, so it covers rows 4..6 and its top-left cell is row 4.
  const { layout } = importTmjToLayout(mapWith([{ index: 6 * COLS + 2, gid: 1 + tall }]), registry, noImages);

  assert.equal(layout.decals?.[0].row, 4, 'the sprite would sit two rows below where Tiled shows it');
  assert.equal(layout.decals?.[0].col, 2);
});

test('flip bits survive the import', async () => {
  buildDynamicCatalog((await buildFurnitureCatalogAndSprites()) as never);
  const flat = localIdOfHeight(1);
  const FLIP_H = 0x80000000;
  const FLIP_V = 0x40000000;

  const { layout } = importTmjToLayout(
    mapWith([
      { index: 0, gid: (1 + flat) + FLIP_H },
      { index: 1, gid: (1 + flat) + FLIP_V },
      { index: 2, gid: (1 + flat) + FLIP_H + FLIP_V },
    ]),
    registry,
    noImages,
  );

  assert.equal(layout.decals?.length, 3);
  assert.deepEqual(
    layout.decals!.map((d) => [!!d.flippedHorizontally, !!d.flippedVertically]),
    [
      [true, false],
      [false, true],
      [true, true],
    ],
  );
});

test('several decal layers are all read, in the order the map lists them', async () => {
  buildDynamicCatalog((await buildFurnitureCatalogAndSprites()) as never);
  const flat = localIdOfHeight(1);
  const data = (index: number) => {
    const d = new Array(COLS * ROWS).fill(0);
    d[index] = 1 + flat;
    return d;
  };
  const tmj = {
    width: COLS,
    height: ROWS,
    tilesets: [{ firstgid: 1, source: 'decal.tsj' }],
    layers: [
      { class: 'DecalLayer', name: 'Ground detail', type: 'tilelayer', data: data(0) },
      { class: 'DecalLayer', name: 'On top', type: 'tilelayer', data: data(1) },
    ],
  };

  const { layout } = importTmjToLayout(tmj, registry, noImages);

  // `find` would have taken the first layer only, which is what makes stacking
  // impossible — a tile-layer cell holds one tile.
  assert.equal(layout.decals?.length, 2, 'only one of two decal layers was read');
  assert.equal(layout.decals![0].col, 0);
  assert.equal(layout.decals![1].col, 1);
});

test('flat decals render below everything, occluding ones sort by position', async () => {
  buildDynamicCatalog((await buildFurnitureCatalogAndSprites()) as never);
  const flat = localIdOfHeight(1);
  const id = String(decalSet!.tiles[flat].props.id);

  const [instance] = layoutToDecalInstances([{ id, col: 3, row: 4 }]);
  assert.equal(instance.x, 3 * TILE_SIZE);
  assert.equal(instance.y, 4 * TILE_SIZE);
  assert.equal(instance.zY, DECAL_DEPTH, 'a flat decal must not sort by position');
  assert.ok(DECAL_DEPTH < 0, 'the flat band has to stay below every positional depth');

  // The very same art, painted on a standing layer: depth becomes the sprite's
  // bottom edge — the same value furniture would get, so a character behind it is
  // drawn behind it. Nothing about the tile changed, which is the point.
  const [sorted] = layoutToDecalInstances([{ id, col: 3, row: 4, occludes: true }]);
  assert.equal(sorted.zY, 4 * TILE_SIZE + getCatalogEntry(id)!.height);
});

test('the LAYER decides flat vs standing, and the same tile may do both', async () => {
  buildDynamicCatalog((await buildFurnitureCatalogAndSprites()) as never);
  const flat = localIdOfHeight(1);
  const gid = 1 + flat;
  const cell = (index: number) => {
    const d = new Array(COLS * ROWS).fill(0);
    d[index] = gid;
    return d;
  };

  const { layout } = importTmjToLayout(
    {
      width: COLS,
      height: ROWS,
      tilesets: [{ firstgid: 1, source: 'decal.tsj' }],
      layers: [
        // Same tile, two layers, opposite answers — the case that made this a
        // layer property instead of a tile property: whether a picture is
        // background or an obstacle belongs to the place, not to the art.
        { class: 'DecalLayer', name: 'Ground', type: 'tilelayer', data: cell(0) },
        {
          class: 'DecalLayer',
          name: 'Standing',
          type: 'tilelayer',
          data: cell(1),
          properties: [{ name: 'occludes', type: 'bool', value: true }],
        },
      ],
    },
    registry,
    noImages,
  );

  assert.equal(layout.decals?.length, 2);
  assert.equal(layout.decals![0].occludes, undefined, 'a layer without the property means flat');
  assert.equal(layout.decals![1].occludes, true, 'the standing layer did not reach the cell');

  const [flatInstance, standingInstance] = layoutToDecalInstances(layout.decals);
  assert.equal(flatInstance.zY, DECAL_DEPTH);
  assert.ok(standingInstance.zY > 0, 'a standing decal must sort positionally');
});

test('a decal tile states no depth of its own — that is the layer\'s job', () => {
  // Guards the decision rather than the code: re-adding `occludes` to the tile
  // would give one question two answers, and the tile would silently win for
  // every cell of it across the whole map.
  assert.ok(decalSet, 'decal.tsj is not on disk');
  const offenders = decalSet.tiles
    .filter((t) => t?.class === 'DecalTile' && 'occludes' in (t.props ?? {}))
    .map((t) => String(t!.props.id));
  assert.deepEqual(offenders, [], `these decal tiles carry occludes: ${offenders.join(', ')}`);
});

test('a grid decal tileset loads: every named cell gets the sprite that sheet cell holds', async () => {
  const built = await buildFurnitureCatalogAndSprites();
  buildDynamicCatalog(built as never);

  const roads = (built.catalog as Array<{ id: string; width: number; height: number; decal?: boolean }>).filter((a) =>
    a.id.startsWith('ROAD_'),
  );
  assert.ok(roads.length > 100, `expected the road sheet in the catalog, got ${roads.length} tiles`);
  assert.ok(
    roads.every((r) => r.decal === true && r.width === TILE_SIZE && r.height === TILE_SIZE),
    'a road tile is a 16×16 decal',
  );
  const spriteless = roads.filter((r) => !(built.sprites as Record<string, unknown>)[r.id]);
  assert.deepEqual(spriteless.map((r) => r.id), [], 'named cells without a sprite — the sheet was not sliced');

  // The mapping from tile id to sheet cell is the part that cannot be eyeballed:
  // an off-by-one column shows every road piece as its neighbour, which still
  // looks like a road. So compare one cell against the PNG's own pixels.
  const { PNG } = await import('pngjs');
  const fs = await import('node:fs');
  // Where the sheet is comes from the tileset, not from a path spelled out here:
  // this test broke on a file move that changed no behaviour at all.
  const roadTsj = JSON.parse(fs.readFileSync(path.join(ASSETS_ROOT, 'assets/tiled/decal-roads.tsj'), 'utf-8')) as { image: string };
  const sheet = PNG.sync.read(fs.readFileSync(path.join(ASSETS_ROOT, 'assets/tiled', roadTsj.image)));
  const probe = roads.find((r) => r.id === 'ROAD_R05C07') ?? roads[roads.length - 1];
  const row = Number(probe.id.slice(6, 8));
  const col = Number(probe.id.slice(9, 11));
  const sprite = (built.sprites as Record<string, string[][]>)[probe.id];
  let mismatches = 0;
  for (let y = 0; y < TILE_SIZE; y++) {
    for (let x = 0; x < TILE_SIZE; x++) {
      const i = ((row * TILE_SIZE + y) * sheet.width + (col * TILE_SIZE + x)) * 4;
      const opaque = sheet.data[i + 3] !== 0;
      if (opaque !== !!sprite[y][x]) mismatches++;
    }
  }
  assert.equal(mismatches, 0, `${probe.id} does not match sheet cell (row ${row}, col ${col})`);
});

test('a road painted on a decal layer imports as one flat cell', async () => {
  const built = await buildFurnitureCatalogAndSprites();
  buildDynamicCatalog(built as never);
  const roadSet = registry.bySource('decal-roads.tsj');
  assert.ok(roadSet, 'decal-roads.tsj is not on disk');
  const localId = roadSet.tiles.findIndex((t) => t?.class === 'DecalTile' && t.props.id);
  assert.ok(localId >= 0, 'the road set names no tile');

  const data = new Array(COLS * ROWS).fill(0);
  data[7 * COLS + 5] = 1 + localId;
  const { layout } = importTmjToLayout(
    {
      width: COLS,
      height: ROWS,
      tilesets: [{ firstgid: 1, source: 'decal-roads.tsj' }],
      layers: [{ class: 'DecalLayer', name: 'Roads', type: 'tilelayer', data }],
    },
    registry,
    noImages,
  );

  assert.equal(layout.decals?.length, 1);
  // 16×16 art, so no bottom-anchor shift: the cell painted IS the cell occupied.
  assert.deepEqual(
    { col: layout.decals![0].col, row: layout.decals![0].row },
    { col: 5, row: 7 },
    'a one-cell decal must land exactly where it was painted',
  );
  assert.equal(layout.furniture.length, 0, 'a road must not become an object');
  assert.equal(getBlockedTiles(layout.furniture).size, 0, 'a road must not block by itself');
  assert.equal(layoutToDecalInstances(layout.decals)[0].zY, DECAL_DEPTH, 'a road is ground, so it lies flat');
});

test('a behaviour-carrying tile painted as a decal warns but still imports', async () => {
  buildDynamicCatalog((await buildFurnitureCatalogAndSprites()) as never);
  // A sittable chair from the real furniture tilesets: painting it on a decal
  // layer is legitimate (that is how a decorative chair stops being an object)
  // but its behaviour is gone, and losing that silently would be baffling.
  const furnitureSet = registry.tilesets.find((ts) =>
    ts.tiles.some((t) => t?.class === 'FurnitureTile' && t.props.canSitOn === true),
  );
  assert.ok(furnitureSet, 'no furniture tileset with a sittable tile');
  const localId = furnitureSet.tiles.findIndex((t) => t?.class === 'FurnitureTile' && t.props.canSitOn === true);

  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args.join(' '));
  let layout;
  try {
    ({ layout } = importTmjToLayout(
      {
        width: COLS,
        height: ROWS,
        tilesets: [{ firstgid: 1, source: path.basename(furnitureSet.file) }],
        layers: [
          {
            class: 'DecalLayer',
            name: 'Decals',
            type: 'tilelayer',
            data: (() => {
              const d = new Array(COLS * ROWS).fill(0);
              d[0] = 1 + localId;
              return d;
            })(),
          },
        ],
      },
      registry,
      noImages,
    ));
  } finally {
    console.warn = realWarn;
  }

  assert.equal(layout.decals?.length, 1, 'furniture art must still be paintable as a decal');
  assert.equal(layout.furniture.length, 0);
  assert.ok(
    warnings.some((w) => w.includes('canSitOn')),
    `expected a warning naming the lost behaviour, got: ${warnings.join(' | ')}`,
  );
});
