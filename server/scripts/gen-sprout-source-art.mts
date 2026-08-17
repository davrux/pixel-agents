#!/usr/bin/env -S node --import tsx
/**
 * One-time generator: derives our own source art from the Sprout Lands Basic
 * pack — assets/floors/sprout_*.png (the "floor-sprout" floor set) and
 * assets/walls/wall_sprout.png (the "wall-sprout" wall set), which
 * bake-floor-wall-tiled.mts then bakes into Tiled tilesets like any other set
 * (nothing enumerates their filenames — see tiled/tiledRegistry.ts's
 * floorSetNames/wallSetNames).
 *
 * The pack itself lives outside the repo (tmp/sprout, gitignored — same as the
 * MetroCity pack before it); only the derived art is committed. Its licence is
 * non-commercial, forbids redistributing the pack, and requires crediting
 * Cup Nooble — see assets/CREDITS.md.
 *
 * ── The floors are a deliberate SUBSET, not the whole ground tilesets ──
 *
 * Grass.png / Tilled_Dirt.png / Hills.png are 47-blob autotile sets: a big
 * grid of transparent-cornered EDGE pieces meant to be layered over another
 * ground. This engine has exactly one ground layer per tile (OfficeLayout's
 * tilePattern/tileFloorSet/tileColors), so an edge piece would render as a
 * hole down to the canvas background rather than as grass meeting dirt. What
 * survives that is the pack's fill tiles — fully opaque, seamless, and the
 * only part of those sheets a single ground layer can actually use. Same
 * reasoning as the metro floors next door, which are plain crops for the same
 * reason.
 *
 * The cost of taking the rest anyway would not be small: every pattern is
 * baked into 65 columns (Natural + 64 swatches) and the client slices ALL of
 * them into SpriteData at load (client/src/net/tiledSheets.ts), so the ~250
 * tiles of the three blob sets would be ~16k sliced sprites for art that
 * cannot be drawn correctly.
 *
 * The stair pieces are the one exception to "fills only": they are opaque,
 * they are floor (you walk up them), and there is nowhere else for them to go.
 *
 * ── The walls are a real adjacency set, taken verbatim ──
 *
 * Fences.png is already a 16-piece adjacency set, and its 4x4 layout maps
 * exactly onto our N=1/E=2/S=4/W=8 bitmask (see shared/src/office/wallTiles.ts):
 * its rows are the vertical connections (S / N+S / N / none) and its columns
 * the horizontal ones (none / E / E+W / W). So unlike the metro set — which
 * had to be synthesized from two measured cross-sections because the pack had
 * no T-junctions at all — this one is a straight remap, post centred in the
 * cell and rails running edge to edge, which is exactly the geometry the
 * lattice needs (see gen-metro-source-art.mts on why arms are centred).
 *
 * After the 16 bitmask pieces come 12 hand-painted-only FACE pieces from
 * Wooden_House_Walls_Tilset.png — the flat wall a room is looked *at*, which
 * no computed mask (0-15) can ever reach; they exist to be painted by hand in
 * Tiled, which WallEdges.latticePiece carries through import and render.
 *
 * Run: scripts/import-sprout-pack.sh (this is its first step)
 */
import { PNG } from 'pngjs';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { WALL_BITMASK_COUNT, WALL_GRID_COLS, WALL_PIECE_HEIGHT, WALL_PIECE_WIDTH } from '../src/core/assets/constants.js';

const ROOT = new URL('../..', import.meta.url).pathname;
const PACK = path.join(ROOT, 'tmp', 'sprout');
const FLOOR_DIR = path.join(ROOT, 'assets', 'floors');
const WALL_OUT = path.join(ROOT, 'assets', 'walls', 'wall_sprout.png');
const TILE = 16;

/**
 * The floor patterns, in order — pattern i is written to sprout_<i>.png and
 * becomes row i of the baked sheet (see bake-floor-wall-tiled.mts). Tile
 * coordinates are on each sheet's own 16px grid.
 *
 * Every one of these is fully opaque; see the header for why that is the
 * selection rule rather than an accident.
 */
const FLOOR_PATTERNS: Array<{ file: string; tx: number; ty: number; note: string }> = [
  // The base plane, first: one flat colour, no tuft, no speck. It is the
  // INTERIOR of Grass.png's blob rather than one of the fill rows below —
  // every one of those carries decoration, so large areas of them visibly
  // repeat. A ground you can cover a whole zone in has to be the plain one.
  { file: 'Tilesets/Grass.png', tx: 1, ty: 1, note: 'grass, plain' },
  // Grass.png's two rows of seamless fills: tufted, patchy, flowering.
  { file: 'Tilesets/Grass.png', tx: 0, ty: 5, note: 'grass, tufts' },
  { file: 'Tilesets/Grass.png', tx: 1, ty: 5, note: 'grass, sparse tufts' },
  { file: 'Tilesets/Grass.png', tx: 2, ty: 5, note: 'grass, tufts 2' },
  { file: 'Tilesets/Grass.png', tx: 3, ty: 5, note: 'grass, dark patches' },
  { file: 'Tilesets/Grass.png', tx: 4, ty: 5, note: 'grass, dark patches 2' },
  { file: 'Tilesets/Grass.png', tx: 5, ty: 5, note: 'grass, yellow flowers' },
  { file: 'Tilesets/Grass.png', tx: 0, ty: 6, note: 'grass, white flowers' },
  { file: 'Tilesets/Grass.png', tx: 1, ty: 6, note: 'grass, white tufts' },
  { file: 'Tilesets/Grass.png', tx: 2, ty: 6, note: 'grass, white tuft' },
  { file: 'Tilesets/Grass.png', tx: 3, ty: 6, note: 'grass, light patches' },
  { file: 'Tilesets/Grass.png', tx: 4, ty: 6, note: 'grass, light patches 2' },
  { file: 'Tilesets/Grass.png', tx: 5, ty: 6, note: 'grass, yellow flowers 2' },
  // Tilled_Dirt.png's fills — the bare soil the grass blob is cut out of.
  { file: 'Tilesets/Tilled_Dirt.png', tx: 0, ty: 5, note: 'soil' },
  { file: 'Tilesets/Tilled_Dirt.png', tx: 1, ty: 5, note: 'soil, specks' },
  { file: 'Tilesets/Tilled_Dirt.png', tx: 2, ty: 5, note: 'soil, specks 2' },
  { file: 'Tilesets/Tilled_Dirt.png', tx: 0, ty: 6, note: 'soil, seam' },
  { file: 'Tilesets/Tilled_Dirt.png', tx: 1, ty: 6, note: 'soil, light specks' },
  { file: 'Tilesets/Tilled_Dirt.png', tx: 2, ty: 6, note: 'soil, light specks 2' },
  // Water.png is a 4-frame animation of one tile. Floor patterns don't
  // animate, so only frame 0 comes across — the other three differ by a few
  // highlight pixels and would read as three near-identical patterns.
  { file: 'Tilesets/Water.png', tx: 0, ty: 0, note: 'water' },
  // The cliff stairway, a 2x2 block. Painted as four pieces because that is
  // what it is; nothing here derives a multi-tile footprint.
  { file: 'Tilesets/Hills.png', tx: 9, ty: 5, note: 'stairs, top left' },
  { file: 'Tilesets/Hills.png', tx: 10, ty: 5, note: 'stairs, top right' },
  { file: 'Tilesets/Hills.png', tx: 9, ty: 6, note: 'stairs, bottom left' },
  { file: 'Tilesets/Hills.png', tx: 10, ty: 6, note: 'stairs, bottom right' },
];

/** Fences.png, the adjacency set. Row = vertical connections, column =
 *  horizontal ones — the whole mapping, and the reason this is a remap rather
 *  than a synthesis (see the header). */
const FENCES = 'Tilesets/Fences.png';
/** Source row for a mask's vertical connections. */
function fenceRow(mask: number): number {
  const n = (mask & 1) !== 0;
  const s = (mask & 4) !== 0;
  return n && s ? 1 : n ? 2 : s ? 0 : 3;
}
/** Source column for a mask's horizontal connections. */
function fenceCol(mask: number): number {
  const e = (mask & 2) !== 0;
  const w = (mask & 8) !== 0;
  return e && w ? 2 : e ? 1 : w ? 3 : 0;
}

/**
 * The hand-painted-only face pieces, in the order they follow the 16 bitmask
 * ones. The first nine are Wooden_House_Walls_Tilset.png's 3x3 wall block in
 * reading order (left jamb / fill / right jamb × top / middle / bottom), the
 * last three its wider variant's distinct fills. Its two window-frame tops are
 * left out to keep the total a whole number of sheet rows — 16 + 12 = 28 = 7
 * rows of WALL_GRID_COLS, so no blank piece lands in the tileset.
 */
const WALLS_SHEET = 'Tilesets/Wooden_House_Walls_Tilset.png';
const FACE_PIECES: Array<{ tx: number; ty: number; note: string }> = [
  { tx: 0, ty: 0, note: 'left jamb, top' },
  { tx: 1, ty: 0, note: 'planks + cornice' },
  { tx: 2, ty: 0, note: 'right jamb, top' },
  { tx: 0, ty: 1, note: 'left jamb, middle' },
  { tx: 1, ty: 1, note: 'brick fill' },
  { tx: 2, ty: 1, note: 'right jamb, middle' },
  { tx: 0, ty: 2, note: 'left jamb, bottom' },
  { tx: 1, ty: 2, note: 'planks + baseboard' },
  { tx: 2, ty: 2, note: 'right jamb, bottom' },
  { tx: 3, ty: 1, note: 'planks + rail' },
  { tx: 4, ty: 1, note: 'planks, plain' },
  { tx: 3, ty: 2, note: 'planks + window' },
];

function read(file: string): PNG {
  return PNG.sync.read(fs.readFileSync(path.join(PACK, file)));
}

/** Copy the 16x16 tile at (tx, ty) of `src` into `dst` at (dx, dy). */
function blitTile(src: PNG, tx: number, ty: number, dst: PNG, dx: number, dy: number): void {
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const si = ((ty * TILE + y) * src.width + (tx * TILE + x)) * 4;
      const di = ((dy + y) * dst.width + (dx + x)) * 4;
      dst.data[di] = src.data[si];
      dst.data[di + 1] = src.data[si + 1];
      dst.data[di + 2] = src.data[si + 2];
      dst.data[di + 3] = src.data[si + 3];
    }
  }
}

// ── Floors ───────────────────────────────────────────────────────────────
const sheets = new Map<string, PNG>();
FLOOR_PATTERNS.forEach((pattern, i) => {
  let src = sheets.get(pattern.file);
  if (!src) {
    src = read(pattern.file);
    sheets.set(pattern.file, src);
  }
  const out = new PNG({ width: TILE, height: TILE });
  blitTile(src, pattern.tx, pattern.ty, out, 0, 0);
  // A pattern that isn't fully opaque would render as a hole, and silently —
  // the whole selection rule above rests on this, so check it rather than
  // trust the coordinates.
  for (let p = 3; p < out.data.length; p += 4) {
    if (out.data[p] !== 255) {
      throw new Error(`${pattern.file} (${pattern.tx},${pattern.ty}) "${pattern.note}" is not fully opaque — see this file's header`);
    }
  }
  fs.writeFileSync(path.join(FLOOR_DIR, `sprout_${i}.png`), PNG.sync.write(out));
});
console.log(`✓ ${FLOOR_PATTERNS.length} floor patterns → assets/floors/sprout_0..${FLOOR_PATTERNS.length - 1}.png`);

// ── Walls ────────────────────────────────────────────────────────────────
const pieceCount = WALL_BITMASK_COUNT + FACE_PIECES.length;
if (pieceCount % WALL_GRID_COLS !== 0) {
  throw new Error(`${pieceCount} wall pieces is not a whole number of ${WALL_GRID_COLS}-wide rows — parseWallPng reads the count off the image height`);
}
const wall = new PNG({ width: WALL_GRID_COLS * WALL_PIECE_WIDTH, height: (pieceCount / WALL_GRID_COLS) * WALL_PIECE_HEIGHT });
wall.data.fill(0);
const fences = read(FENCES);
const walls = read(WALLS_SHEET);
/** Where piece `index` sits in the sheet. The art occupies only the BOTTOM 16
 *  rows of its 16x32 slot: the slot is 32 tall because wall sprites are
 *  bottom-anchored and may extend a cell upward (wallTiles.ts's getWallSprite
 *  offsetY), which neither a fence nor a one-cell wall face does. */
function slot(index: number): { x: number; y: number } {
  return {
    x: (index % WALL_GRID_COLS) * WALL_PIECE_WIDTH,
    y: Math.floor(index / WALL_GRID_COLS) * WALL_PIECE_HEIGHT + (WALL_PIECE_HEIGHT - TILE),
  };
}
for (let mask = 0; mask < WALL_BITMASK_COUNT; mask++) {
  const { x, y } = slot(mask);
  blitTile(fences, fenceCol(mask), fenceRow(mask), wall, x, y);
}
FACE_PIECES.forEach((piece, i) => {
  const { x, y } = slot(WALL_BITMASK_COUNT + i);
  blitTile(walls, piece.tx, piece.ty, wall, x, y);
});
fs.writeFileSync(WALL_OUT, PNG.sync.write(wall));
console.log(`✓ ${WALL_BITMASK_COUNT} fence bitmask pieces + ${FACE_PIECES.length} wooden-house faces → ${path.relative(ROOT, WALL_OUT)}`);
