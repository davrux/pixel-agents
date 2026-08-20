/**
 * Turning a furniture placement, and the thing that makes it different from turning a decal:
 * the cells have to come with it.
 *
 * A mirror is cosmetic; a quarter turn is not. The cells a piece blocks, the seats it
 * offers, where its approach tiles are, where a pet perches and how it sorts against
 * characters all follow from its footprint, so a turn that only reached the renderer would
 * draw a sofa lying across two cells while the collision still stood in one — the exact
 * failure `entryFor` exists to prevent (see its comment: "resolving both in one place is
 * what keeps them from disagreeing"). So the first tests here are not about the picture at
 * all; they are about the footprint, the seats and the facing.
 *
 * The second half is the two refusals. Tiled allows things cells cannot express — any angle,
 * and turning a piece whose TOP rows are air — and both are dropped at import with the id
 * named, rather than rounded or ignored silently.
 *
 * SOFA_BACK is the piece under test because it is 32×16, sittable and has no air rows: a
 * square one would pass a broken footprint swap, and one with air rows cannot be turned at
 * all. If the art ever changes shape, the assertion at the top says so instead of the rest
 * failing mysteriously.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';

import { buildDynamicCatalog, entryFor, getCatalogEntry } from '@pixel/shared/office/layout/furnitureCatalog';
import { getBlockedTiles, layoutToSitPoints } from '@pixel/shared/office/layout/layoutSerializer';
import { TILE_SIZE } from '@pixel/shared/office/constants';
import { Direction } from '@pixel/shared/office/types';

import { ASSETS_ROOT, buildFurnitureCatalogAndSprites } from '../assets.js';
import { importTmjToLayout } from './mapBridge.js';
import { loadTiledRegistry } from './tiledRegistry.js';

const registry = loadTiledRegistry(ASSETS_ROOT);
const noImages = (): null => null;
const COLS = 12;
const ROWS = 12;

/** One furniture object, placed at Tiled's own bottom-left anchor and turned `rotation`. */
function mapWith(id: string, col: number, bottomRow: number, rotation: number): Record<string, unknown> {
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
            width: native.width,
            height: native.height,
            visible: true,
            rotation,
            name: '',
          },
        ],
      },
    ],
  };
}

/**
 * Import, capturing both channels a complaint travels on: the console, and the `notices` the
 * result carries back. The second one is what `scripts/push-zones.sh` prints — the console is
 * on the server, which is not where somebody pushing a map is looking, and a refusal nobody
 * sees is indistinguishable from a bug (it read as "the game moved my couch").
 */
function importWatching(map: Record<string, unknown>): {
  layout: ReturnType<typeof importTmjToLayout>['layout'];
  warnings: string[];
  notices: string[];
} {
  const warnings: string[] = [];
  const real = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args.join(' '));
  try {
    const out = importTmjToLayout(map, registry, noImages);
    return { layout: out.layout, warnings, notices: out.notices };
  } finally {
    console.warn = real;
  }
}

test('the piece under test still has the shape these tests need', async () => {
  buildDynamicCatalog((await buildFurnitureCatalogAndSprites()) as never);
  const sofa = getCatalogEntry('SOFA_BACK');
  assert.ok(sofa, 'SOFA_BACK is gone from the catalog');
  assert.deepEqual(
    { w: sofa.width, h: sofa.height, sit: sofa.canSitOn === true, air: sofa.backgroundTiles ?? 0 },
    { w: 32, h: 16, sit: true, air: 0 },
    'SOFA_BACK must stay 32×16, sittable and without air rows for these tests to mean anything',
  );
  assert.equal(sofa.sitFacing, Direction.UP, 'and its sitter must face UP');
});

test('a quarter turn swaps the footprint, and the seats and facing follow the picture', async () => {
  buildDynamicCatalog((await buildFurnitureCatalogAndSprites()) as never);
  const { layout } = importWatching(mapWith('SOFA_BACK', 5, 5, 90));
  const item = layout.furniture[0];
  assert.equal(item.angle, 90, 'the turn must survive the import');

  // The footprint, through the one door every reader uses.
  const entry = entryFor(item);
  assert.deepEqual({ w: entry?.footprintW, h: entry?.footprintH }, { w: 1, h: 2 }, 'a 2×1 sofa turned is 1×2');
  assert.deepEqual({ w: entry?.width, h: entry?.height }, { w: 16, h: 32 }, 'and its drawn box with it');

  // What that means for the world: the cells it blocks are the turned ones.
  const blocked = [...getBlockedTiles(layout.furniture)].sort();
  assert.deepEqual(blocked, [`${item.col},${item.row}`, `${item.col},${item.row + 1}`].sort(), 'blocking follows the footprint');

  // And the seats, and which way a sitter looks: UP turned a quarter clockwise is RIGHT.
  const seats = [...layoutToSitPoints(layout.furniture).values()];
  assert.equal(seats.length, 2, 'a two-cell sofa seats two, turned or not');
  assert.deepEqual(
    seats.map((s) => `${s.col},${s.row}`).sort(),
    [`${item.col},${item.row}`, `${item.col},${item.row + 1}`].sort(),
    'the seats are where the picture is',
  );
  assert.equal(seats[0].facingDir, Direction.RIGHT, 'the sitter turned with the sofa');
});

test('a half turn keeps the sides but still turns the sitter', async () => {
  buildDynamicCatalog((await buildFurnitureCatalogAndSprites()) as never);
  const { layout } = importWatching(mapWith('SOFA_BACK', 5, 5, 180));
  const item = layout.furniture[0];
  const entry = entryFor(item);
  assert.deepEqual({ w: entry?.footprintW, h: entry?.footprintH }, { w: 2, h: 1 }, 'a half turn swaps nothing');
  const seats = [...layoutToSitPoints(layout.furniture).values()];
  assert.equal(seats[0].facingDir, Direction.DOWN, 'UP turned half way round is DOWN');
});

test('each angle lands the piece where Tiled shows it', async () => {
  buildDynamicCatalog((await buildFurnitureCatalogAndSprites()) as never);
  // Tiled turns an object around its own (x, y) — the bottom-left corner of the unrotated
  // box — so the box SWINGS rather than spinning in place. Anchor here: x = col 5,
  // y = bottom of row 5, art 32×16.
  const expected: Array<[number, { col: number; row: number }]> = [
    [0, { col: 5, row: 5 }], // the box sits above the pivot
    [90, { col: 5, row: 6 }], // swung right and down
    [180, { col: 3, row: 6 }], // hanging left and down
    [270, { col: 4, row: 4 }], // swung left and up
  ];
  for (const [rotation, at] of expected) {
    const { layout } = importWatching(mapWith('SOFA_BACK', 5, 5, rotation));
    const item = layout.furniture[0];
    assert.deepEqual({ col: item.col, row: item.row }, at, `${rotation}° landed in the wrong cell`);
  }
});

test('an angle that is not a quarter turn is refused, not rounded', async () => {
  buildDynamicCatalog((await buildFurnitureCatalogAndSprites()) as never);
  const { layout, warnings, notices } = importWatching(mapWith('SOFA_BACK', 5, 5, 37));
  const item = layout.furniture[0];
  assert.equal(item.angle, undefined, '37° must not become 45 or 0-with-a-shrug');
  assert.deepEqual({ col: item.col, row: item.row }, { col: 5, row: 5 }, 'and it stays where an upright one goes');
  assert.ok(
    warnings.some((w) => w.includes('SOFA_BACK') && w.includes('37')),
    `expected a warning naming the piece and the angle, got: ${warnings.join(' | ') || '(nothing)'}`,
  );
  // And it comes BACK, not just out: this is the line push-zones.sh prints.
  assert.ok(
    notices.some((n) => n.includes('SOFA_BACK') && n.includes('37')),
    `the refusal must travel back to whoever pushed the map, got: ${notices.join(' | ') || '(nothing)'}`,
  );
});

test('a piece whose top rows are air is not turned at all', async () => {
  buildDynamicCatalog((await buildFurnitureCatalogAndSprites()) as never);
  const esp = getCatalogEntry('ESPRESSO_MACHINE');
  assert.ok((esp?.backgroundTiles ?? 0) > 0, 'this test needs a piece with air rows');
  const { layout, warnings } = importWatching(mapWith('ESPRESSO_MACHINE', 5, 5, 90));
  const item = layout.furniture[0];
  assert.equal(item.angle, undefined, '"my top row is air" has no turned meaning, so the turn is dropped');
  const entry = entryFor(item);
  assert.equal(entry?.backgroundTiles, esp?.backgroundTiles, 'and its air rows still mean what they meant');
  assert.ok(
    warnings.some((w) => w.includes('ESPRESSO_MACHINE') && /air|backgroundTiles/.test(w)),
    `expected a warning naming the piece and why, got: ${warnings.join(' | ') || '(nothing)'}`,
  );
});

test('an upright placement is untouched by any of this', async () => {
  buildDynamicCatalog((await buildFurnitureCatalogAndSprites()) as never);
  const { layout, warnings, notices } = importWatching(mapWith('SOFA_BACK', 5, 5, 0));
  const item = layout.furniture[0];
  assert.equal(item.angle, undefined, 'no angle field on an unturned piece — nothing new on the wire');
  const entry = entryFor(item);
  assert.deepEqual({ w: entry?.footprintW, h: entry?.footprintH }, { w: 2, h: 1 });
  assert.equal(entry, getCatalogEntry('SOFA_BACK'), 'and it is still the SHARED entry, allocating nothing');
  assert.equal(warnings.length, 0, `an ordinary placement must not warn: ${warnings.join(' | ')}`);
  assert.deepEqual(notices, [], 'and a clean map reports nothing back either');
});
