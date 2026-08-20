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
 * The second half is what a turn COSTS when cells cannot express it. Any angle is honoured
 * now — a free one is drawn as Tiled shows it and occupies the rectangle around it — but that
 * rectangle covers cells the art does not reach, so seats are dropped; and "my top rows are
 * air" stops meaning anything once the top is a side, so air rows are dropped too. Both are
 * decided at import, with the id named in a notice the push prints, rather than guessed.
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

test('a free angle is kept — drawn as Tiled shows it, occupying the rectangle around it', async () => {
  buildDynamicCatalog((await buildFurnitureCatalogAndSprites()) as never);
  const { layout, warnings, notices } = importWatching(mapWith('SOFA_BACK', 5, 5, 37));
  const item = layout.furniture[0];
  assert.equal(item.angle, 37, '37° is honoured, not rounded to a quarter turn');

  // Cells are axis-aligned, so what it occupies is the enclosing rectangle. A 32×16 couch
  // at 37° is about 35 wide and 32 tall, i.e. three cells by two.
  const entry = entryFor(item);
  assert.deepEqual(
    { w: entry?.footprintW, h: entry?.footprintH },
    { w: 3, h: 2 },
    'the footprint is the rectangle around the turned art',
  );
  assert.equal([...getBlockedTiles(layout.furniture)].length, 6, 'and it blocks that rectangle — never walk through a couch');

  // The rectangle covers cells the art does not reach, so the parts that depend on knowing
  // WHICH cell is which are dropped rather than guessed.
  assert.equal(item.canSitOn, false, 'no seats on a diagonal couch');
  assert.equal([...layoutToSitPoints(layout.furniture).values()].length, 0, 'and none are offered');
  assert.ok(
    notices.some((n) => n.includes('SOFA_BACK') && /37/.test(n) && /seats/.test(n)),
    `the mapper must be told what the angle cost, got: ${notices.join(' | ') || '(nothing)'}`,
  );
  assert.ok(warnings.length > 0, 'and it is on the server console too');
});

test('a turned piece with air rows keeps the turn and loses the air rows', async () => {
  buildDynamicCatalog((await buildFurnitureCatalogAndSprites()) as never);
  const esp = getCatalogEntry('ESPRESSO_MACHINE');
  assert.ok((esp?.backgroundTiles ?? 0) > 0, 'this test needs a piece with air rows');
  const { layout, notices } = importWatching(mapWith('ESPRESSO_MACHINE', 5, 5, 90));
  const item = layout.furniture[0];
  assert.equal(item.angle, 90, 'the turn is honoured');
  // "My TOP rows are air" stops meaning anything once the top is a side, so it goes — and it
  // goes towards SOLID, because the alternative is an appliance you walk through.
  assert.equal(item.backgroundTiles, 0, 'the air rows are dropped, not reinterpreted');
  assert.equal(entryFor(item)?.footprintW, 2, 'and the piece still occupies its cells');
  assert.ok(
    notices.some((n) => n.includes('ESPRESSO_MACHINE') && /air/.test(n)),
    `expected a notice naming the piece and why, got: ${notices.join(' | ') || '(nothing)'}`,
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
