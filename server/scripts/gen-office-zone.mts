#!/usr/bin/env -S node --import tsx
/**
 * Author the "campus" zone: a one-storey office building with an open-plan
 * middle, meeting rooms, a kitchen and side offices, plus grounds outside with
 * parking and a small lake.
 *
 * Builds an OfficeLayout in code and hands it to the real exportLayoutToTmj, so
 * gids, the wall lattice, tile-object anchoring and object shapes come from the
 * one implementation that already gets them right — hand-writing a .tmj would
 * duplicate all of that and drift from it. The result is a normal Tiled map: open
 * it and rearrange freely, this script is a starting point, not an owner (it
 * refuses to overwrite, see the guard at the bottom).
 *
 * The plan deliberately feeds what the world's inhabitants actually do:
 *   - desks with a screen facing the seat, because an agent picks a seat facing
 *     something switchable and the screen then turns itself on (officeState's
 *     seatDrivenSwitchableTiles)
 *   - a coffee machine, which is what an idle agent walks to on a break and
 *     what a pet drinks at
 *   - tables marked petCanSitOn, so cats have somewhere to sit above the floor
 *   - wide corridors and one open middle, because everything here paths on a
 *     4-connected grid and narrow doorways make agents queue
 *
 * Run (from server/): node --import tsx scripts/gen-office-zone.mts [--force]
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { loadAssetBundle } from '../src/assets.js';
import { loadTiledRegistry } from '../src/tiled/tiledRegistry.js';
import { exportLayoutToTmj } from '../src/tiled/mapBridge.js';
import { buildDynamicCatalog, getCatalogEntry } from '@pixel/shared/office/layout/furnitureCatalog.js';
import { emptyWallEdges, hIndex, vIndex } from '@pixel/shared/office/wallEdges.js';
import { TileType } from '@pixel/shared/office/types.js';
import type { Action, OfficeLayout, PlacedFurniture } from '@pixel/shared/office/types.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const ZONE = 'campus';
const OUT = path.join(ROOT, 'assets', 'tiled', 'zones', `${ZONE}.tmj`);

const COLS = 60;
const ROWS = 54;

// ── Floors: (set, pattern, swatch) — see tiledSheetLayout.ts ────────
// Sets 1/3 are the MetroCity-derived patterns, set 0 the project's own 11,
// whose last two are grass and water. `swatch: null` means Natural, the sheet's
// uncolorized column — which for the metro wood patterns is the warm brown the
// art was drawn in; running a palette swatch over them only darkens them
// towards black, so Natural is the right choice there rather than a fallback.
// Values below were picked by sampling the baked sheets, not guessed.
type Floor = { set: number; pattern: number; swatch: number | null };
const WOOD: Floor = { set: 1, pattern: 2, swatch: null }; // warm planks, rgb(140,94,35)
const TILES: Floor = { set: 1, pattern: 1, swatch: null }; // pale tile grid — kitchen
const CARPET: Floor = { set: 1, pattern: 4, swatch: 46 }; // muted blue — meeting rooms
const PAVING: Floor = { set: 1, pattern: 1, swatch: 34 }; // neutral dark grey, rgb(63,70,73)
const GRASS: Floor = { set: 0, pattern: 10, swatch: 30 };
const WATER: Floor = { set: 0, pattern: 11, swatch: 47 }; // lake blue, rgb(83,154,223)

// The catalog has to exist before anything is placed: place() looks every id up
// to reject a typo loudly instead of writing a map with a hole in it.
const bundle = await loadAssetBundle(ROOT);
if (!buildDynamicCatalog({ catalog: bundle.raw.furnitureCatalog as never, sprites: bundle.raw.furnitureSprites as never })) {
  throw new Error('furniture catalog failed to build');
}

const layout: OfficeLayout = {
  cols: COLS,
  rows: ROWS,
  tiles: new Array(COLS * ROWS).fill(TileType.VOID),
  tileColors: new Array(COLS * ROWS).fill(null),
  tileFloorSet: new Array(COLS * ROWS).fill(0),
  tileBlocked: new Array(COLS * ROWS).fill(false),
  tileActions: new Array(COLS * ROWS).fill(null),
  walls: emptyWallEdges(COLS, ROWS),
  furniture: [],
  texts: [],
  images: [],
};

const idx = (c: number, r: number): number => r * COLS + c;

function floor(c0: number, r0: number, c1: number, r1: number, f: Floor): void {
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      if (c < 0 || r < 0 || c >= COLS || r >= ROWS) continue;
      layout.tiles[idx(c, r)] = f.pattern as (typeof TileType)[keyof typeof TileType];
      layout.tileFloorSet![idx(c, r)] = f.set;
      layout.tileColors![idx(c, r)] = f.swatch as never;
    }
  }
}

/** Wall edges around a rectangle of CELLS. `doors` lists gaps, each naming a
 *  side and the cell range along it to leave open. */
function walls(
  c0: number,
  r0: number,
  c1: number,
  r1: number,
  doors: Array<{ side: 'N' | 'S' | 'W' | 'E'; from: number; to: number }> = [],
): void {
  const w = layout.walls!;
  const open = (side: 'N' | 'S' | 'W' | 'E', at: number): boolean =>
    doors.some((d) => d.side === side && at >= d.from && at <= d.to);
  for (let c = c0; c <= c1; c++) {
    if (!open('N', c)) w.horizontal[hIndex(COLS, c, r0)] = true;
    if (!open('S', c)) w.horizontal[hIndex(COLS, c, r1 + 1)] = true;
  }
  for (let r = r0; r <= r1; r++) {
    if (!open('W', r)) w.vertical[vIndex(COLS, c0, r)] = true;
    if (!open('E', r)) w.vertical[vIndex(COLS, c1 + 1, r)] = true;
  }
}

let seq = 0;
function place(id: string, col: number, row: number, extra: Partial<PlacedFurniture> = {}): void {
  const entry = getCatalogEntry(id);
  if (!entry) {
    console.warn(`  ! unknown furniture id "${id}" — skipped`);
    return;
  }
  layout.furniture.push({ uid: `gen-${++seq}`, id, col, row, ...extra });
}

const MEETING: Action = { kind: 'meetingRoom', video: true };

// ══ The building ═══════════════════════════════════════════════════
// Outer shell cols 2..51, rows 3..31. Row 2 is the face course above the north
// wall, so the building reads as having a back wall rather than a hairline.
const B = { c0: 2, r0: 3, c1: 51, r1: 31 };

floor(B.c0, B.r0, B.c1, B.r1, WOOD);

// North band of rooms: three meeting rooms and the kitchen, rows 4..11.
const MEETING_ROOMS = [
  { c0: 3, c1: 11 },
  { c0: 14, c1: 22 },
  { c0: 25, c1: 33 },
];
for (const [i, m] of MEETING_ROOMS.entries()) {
  floor(m.c0, 4, m.c1, 11, CARPET);
  // Door in the south wall, two tiles wide — one-tile doorways make agents queue.
  const doorAt = m.c0 + 3;
  walls(m.c0, 4, m.c1, 11, [{ side: 'S', from: doorAt, to: doorAt + 1 }]);
  // A table with chairs down both long sides, and a screen on the north wall.
  const tc = m.c0 + 3;
  place('TABLE_FRONT', tc, 6);
  for (let k = 0; k < 3; k++) {
    place('WOODEN_CHAIR_SIDE', tc - 1, 6 + k, { sitFacing: 2 }); // face E, toward the table
    place('WOODEN_CHAIR_SIDE', tc + 3, 6 + k, { flippedHorizontally: true, sitFacing: 1 }); // face W
  }
  place('MONITOR', m.c0 + 1, 4, { action: MEETING, name: ['Alpha', 'Beta', 'Gamma'][i] });
  place('PLANT_2', m.c1 - 1, 5);
}

// Kitchen, rows 4..11, the widest room in the band.
const K = { c0: 36, c1: 50 };
floor(K.c0, 4, K.c1, 11, TILES);
walls(K.c0, 4, K.c1, 11, [{ side: 'S', from: K.c0 + 4, to: K.c0 + 6 }]);
for (let c = K.c0 + 1; c <= K.c0 + 6; c += 2) place('KITCHEN_COUNTER_FRONT', c, 4);
place('KITCHEN_SINK', K.c0 + 7, 4);
place('STOVE', K.c0 + 8, 4);
place('FRIDGE', K.c0 + 10, 4);
place('COFFEE_MACHINE', K.c0 + 1, 5, { approachSides: ['S'] });
// Two cafeteria tables. Pets may sit on them; agents on the chairs.
for (const tc of [K.c0 + 3, K.c0 + 9]) {
  place('SMALL_TABLE_FRONT', tc, 8, { petCanSitOn: true });
  place('CUSHIONED_CHAIR_FRONT', tc, 10, { sitFacing: 3 });
  place('CUSHIONED_CHAIR_FRONT', tc + 1, 10, { sitFacing: 3 });
}

// Side offices: two west, two east, rows 14..29.
const OFFICES = [
  { c0: 3, c1: 10, r0: 14, r1: 21, door: { side: 'E' as const, at: 18 } },
  { c0: 3, c1: 10, r0: 23, r1: 29, door: { side: 'E' as const, at: 26 } },
  { c0: 44, c1: 50, r0: 14, r1: 21, door: { side: 'W' as const, at: 18 } },
  { c0: 44, c1: 50, r0: 23, r1: 29, door: { side: 'W' as const, at: 26 } },
];
for (const o of OFFICES) {
  floor(o.c0, o.r0, o.c1, o.r1, WOOD);
  walls(o.c0, o.r0, o.c1, o.r1, [{ side: o.door.side, from: o.door.at, to: o.door.at + 1 }]);
  const dc = o.c0 + 2;
  place('DESK_FRONT', dc, o.r0 + 2);
  place('PC_FRONT_OFF', dc + 1, o.r0 + 2);
  place('WOODEN_CHAIR_BACK', dc + 1, o.r0 + 4, { sitFacing: 3 }); // face N, at the desk
  place('DOUBLE_BOOKSHELF', o.c0, o.r0, {});
  place('PLANT', o.c1, o.r1);
}

// ── Open-plan middle, cols 12..42, rows 14..29 ─────────────────────
// No walls of its own: it IS the space between the rooms, which is what makes
// the building read as open.
floor(12, 12, 42, 30, WOOD);
// Six desk clusters, each a desk with a screen and a seat facing it.
for (const [i, spot] of [
  { c: 14, r: 16 },
  { c: 20, r: 16 },
  { c: 26, r: 16 },
  { c: 14, r: 23 },
  { c: 20, r: 23 },
  { c: 26, r: 23 },
].entries()) {
  place('DESK_FRONT', spot.c, spot.r);
  place('PC_FRONT_OFF', spot.c + 1, spot.r);
  place('WOODEN_CHAIR_BACK', spot.c + 1, spot.r + 2, { sitFacing: 3 });
  if (i % 3 === 2) place('LARGE_PLANT', spot.c + 4, spot.r);
}
// A lounge corner: sofas around a coffee table, where pets like to end up.
place('COFFEE_TABLE', 35, 20, { petCanSitOn: true });
place('SOFA_BACK', 35, 18, { sitFacing: 3 });
place('SOFA_FRONT', 35, 22, { sitFacing: 0 });
place('SOFA_SIDE', 34, 20, { sitFacing: 2 });
place('LARGE_PLANT', 38, 18);
place('ARCADE', 41, 15, { action: { kind: 'arcade' }, name: 'Lobby cabinet' });

// The shell last, so its door gaps are not overwritten by room walls.
// South wall: the way out, four tiles wide. North wall carries the face course.
walls(B.c0, B.r0, B.c1, B.r1, [{ side: 'S', from: 25, to: 28 }]);
{
  const w = layout.walls!;
  const piece: Array<number | null> = new Array(COLS * ROWS).fill(null);
  // Same set and Natural colour as the lattice walls below it, so the face
  // course reads as the same wall seen from the front.
  const set: number[] = new Array(COLS * ROWS).fill(0);
  const color: Array<number | null> = new Array(COLS * ROWS).fill(null);
  for (let c = B.c0; c <= B.c1; c++) piece[idx(c, B.r0 - 1)] = 16; // first face piece
  w.faces = { piece, set, color };
}

// ══ Outside ════════════════════════════════════════════════════════
floor(0, 33, COLS - 1, ROWS - 1, GRASS);
// The path from the exit, widening onto the forecourt.
floor(25, 32, 28, 38, PAVING);
floor(4, 36, 44, 38, PAVING);

// Parking: bays west of the path, cars nose-in facing north.
floor(4, 39, 22, 47, PAVING);
const CARS = ['METRO_CAR_02', 'METRO_CAR_03', 'METRO_CAR_10', 'METRO_CAR_11', 'METRO_CAR_20', 'METRO_CAR_21'];
for (const [i, car] of CARS.entries()) {
  place(car, 5 + (i % 3) * 6, i < 3 ? 39 : 44);
}

// The lake, east of the path — a rounded basin rather than a rectangle.
const LAKE = { cx: 43, cy: 45, rx: 11, ry: 6 };
for (let r = 33; r < ROWS; r++) {
  for (let c = 30; c < COLS; c++) {
    const dx = (c - LAKE.cx) / LAKE.rx;
    const dy = (r - LAKE.cy) / LAKE.ry;
    if (dx * dx + dy * dy <= 1) floor(c, r, c, r, WATER);
  }
}
// Water is scenery, not floor you may walk on.
for (let i = 0; i < COLS * ROWS; i++) {
  if (layout.tiles[i] === WATER.pattern && layout.tileFloorSet![i] === WATER.set) layout.tileBlocked![i] = true;
}
// A bench looking at the water, and trees along the bank.
place('WOODEN_BENCH', 42, 38, { canSitOn: true, sitFacing: 0 });
place('WOODEN_BENCH', 43, 38, { canSitOn: true, sitFacing: 0 });
for (const [c, r] of [
  [31, 34],
  [36, 34],
  [50, 36],
  [55, 41],
  [33, 48],
  [39, 51],
  [48, 51],
] as Array<[number, number]>) {
  place(c % 2 === 0 ? 'TREE' : 'PINE_TREE', c, r);
}
for (const [c, r] of [
  [29, 40],
  [30, 45],
  [46, 34],
  [52, 47],
  [24, 43],
  [23, 48],
] as Array<[number, number]>) {
  place('BUSH', c, r);
}
// Trees along the road frontage, west of the parking.
for (const r of [40, 44, 48]) place('PINE_TREE', 1, r);

// Arrive just inside the exit, so a newcomer sees the building around them.
layout.tileActions![idx(26, 29)] = { kind: 'spawnPoint' };

// ══ Write ══════════════════════════════════════════════════════════
if (fs.existsSync(OUT) && !process.argv.includes('--force')) {
  console.error(`✗ ${path.relative(ROOT, OUT)} already exists — pass --force to overwrite (you will lose Tiled edits).`);
  process.exit(1);
}

const { tmj } = exportLayoutToTmj(layout, loadTiledRegistry(ROOT), ZONE);
fs.writeFileSync(OUT, `${JSON.stringify(tmj, null, 2)}\n`);

const walkable = layout.tiles.filter((t, i) => t !== TileType.VOID && !layout.tileBlocked![i]).length;
console.log(`✓ ${path.relative(ROOT, OUT)}  ${COLS}×${ROWS}`);
console.log(`  ${walkable} walkable tiles, ${layout.furniture.length} furniture, ${layout.walls!.vertical.filter(Boolean).length}V+${layout.walls!.horizontal.filter(Boolean).length}H wall edges`);
