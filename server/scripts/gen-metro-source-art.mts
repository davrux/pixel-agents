#!/usr/bin/env -S node --import tsx
/**
 * One-time generator: derives our own source art from the MetroCity Interior
 * pack — assets/walls/wall_metro.png (the "metro" wall set) and
 * assets/floors/metro_*.png (the "floor-metro" floor set), which
 * bake-floor-wall-tiled.mts then bakes into Tiled tilesets like any other
 * set (one tileset each; nothing enumerates their filenames — see
 * tiled/tiledRegistry.ts's floorSetNames/wallSetNames).
 *
 * The floors are plain crops — the pack's floor textures are genuinely
 * 16x16-seamless (verified: the artist lays each one out as an identical 2x2
 * block in the sheet, so it repeats by construction). The walls are not; see
 * below.
 *
 * Why the walls are generated instead of cropped: the pack draws thin
 * walls as *hand-placed* pieces on tile edges (a 6px vertical strip hugging
 * the left edge, a 9px horizontal band hugging the bottom edge, plus a
 * handful of L-corners) — it has no notion of a 16-piece adjacency autotile,
 * and in particular no T-junctions or cross at all. So we don't crop its
 * pieces; we measure its two cross-sections and synthesize all 16 bitmask
 * pieces from them. That yields joins the source art doesn't even contain,
 * and every piece is consistent by construction.
 *
 * After the 16 bitmask pieces the sheet carries 4 more: the pack's north-wall
 * FACE pieces (cornice / fill / baseboard / a 1-tall variant with both), the
 * flat wall surface a room is looked *at* rather than the thin top-down line.
 * Nothing derives those from adjacency — a computed mask is only ever 0-15 —
 * so they exist purely to be painted by hand in Tiled, which is what
 * WallEdges.latticePiece already carries through import and render.
 *
 * Two deliberate departures from the source pack:
 *   - Arms are CENTERED in the cell (strip at x5-10, band at y4-12) rather
 *     than edge-hugging. A wall in our engine occupies a whole grid cell
 *     back when a wall WAS a cell, so edge-hugging art would have sat half a
 *     cell away from what it blocked. Walls are edges now (see WallEdges) and
 *     these same centered pieces are drawn on the lattice, which puts them on
 *     the boundaries — the centering is what makes that work.
 *   - Art occupies only the BOTTOM 16 rows of each 16x32 piece slot. The slot
 *     is 32 tall because wall sprites are bottom-anchored and may extend one
 *     cell upward (see wallTiles.ts's getWallSprite offsetY); Metro's thin
 *     walls are flat top-down art with no raised face, so they stay inside
 *     their own cell.
 *
 * The MetroCity pack itself lives outside the repo (tmp/metro, gitignored —
 * same as the other third-party packs already listed in .gitignore); only the
 * derived art is committed. Re-run this only when re-deriving those files.
 *
 * Run (from server/): node --import tsx scripts/gen-metro-source-art.mts
 */
import { PNG } from 'pngjs';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  WALL_BITMASK_COUNT,
} from '../../shared/src/office/tiledSheetLayout.js';
import { WALL_GRID_COLS, WALL_PIECE_HEIGHT, WALL_PIECE_WIDTH } from '../src/core/assets/constants.js';

const ROOT = new URL('../..', import.meta.url).pathname;
const PACK = path.join(ROOT, 'tmp', 'metro', 'Interior');
/** The pack's two interior tilesets. HOUSE's white/gray thin walls (the
 *  room block at tile cols 11-14, rows 11-14) are the most office-neutral of
 *  the pack's wall art, and the only variant drawn with real corner pieces. */
const HOUSE = path.join(PACK, 'Home', 'TilesHouse.png');
const HOSPITAL = path.join(PACK, 'Hospital', 'TilesHospital.png');
const WALL_OUT = path.join(ROOT, 'assets', 'walls', 'wall_metro.png');
const FLOOR_DIR = path.join(ROOT, 'assets', 'floors');

/** Where in HOUSE the two wall cross-sections are measured (tile coords, 16px
 *  grid). Both come from the same white wall run so the set is one material:
 *  STRIP_TILE's left 6 columns are a pure vertical run, BAND_TILE's bottom 9
 *  rows a pure horizontal run (no corner, no end cap). */
const STRIP_TILE = { tx: 11, ty: 13, y: 3 };
const BAND_TILE = { tx: 12, ty: 11 };

/** The north-wall FACE block in HOUSE (tile col 4 of the white room block at
 *  cols 3-5, rows 4-7) — the pack's way of drawing the wall a room is looked
 *  *at*, as a flat surface a few tiles tall, rather than the thin top-down line
 *  the other pieces are. Row 4 carries the cornice in its top 7px, rows 5/6 are
 *  pure fill, row 7 carries the baseboard in its bottom 4px. Cols 3/5 differ
 *  from col 4 only in cornice/baseboard wood grain, not in shape, so one column
 *  is the whole vocabulary. */
const FACE_CORNICE_TILE = { tx: 4, ty: 4 };
const FACE_FILL_TILE = { tx: 4, ty: 5 };
const FACE_BASEBOARD_TILE = { tx: 4, ty: 7 };
/** How tall the cornice and baseboard are inside their own tile (px), measured
 *  from the source: cornice occupies rows 0-6, baseboard rows 12-15. */
const CORNICE_H = 7;
const BASEBOARD_H = 4;

/**
 * The pack's OTHER north-wall face blocks, taken verbatim — one piece per tile
 * row of the block, in the order the artist stacked them.
 *
 * Only structurally distinct blocks are here. The pack also draws the same face
 * in white, teal, dark teal, cream and red, but those are pure recolours (cornice
 * and baseboard are pixel-identical across them, verified), and the 64-swatch
 * palette already covers colour — importing them would be five copies of one
 * piece. What IS distinct: a striped-wallpaper fill, and the hospital's grey trim
 * in three stackings (plain, a low rail, a handrail that spans two tiles).
 *
 * Taken row-by-row rather than decomposed into cornice/fill/baseboard because the
 * rails sit at heights the artist chose — reducing them to a scheme of mine would
 * either lose a variant or invent one.
 */
const FACE_BLOCKS: Array<{ sheet: 'house' | 'hospital'; tx: number; rows: number[]; note: string }> = [
  { sheet: 'house', tx: 26, rows: [5, 6, 7, 8], note: 'wood trim, striped wallpaper' },
  { sheet: 'hospital', tx: 10, rows: [4, 5, 6, 7], note: 'grey trim, plain' },
  { sheet: 'hospital', tx: 2, rows: [4, 5, 6, 7], note: 'grey trim, low rail' },
  { sheet: 'hospital', tx: 6, rows: [4, 5, 6, 7], note: 'grey trim, handrail' },
];

type Rgba = [number, number, number, number];

function pixelReader(file: string): { at: (x: number, y: number) => Rgba } {
  const png = PNG.sync.read(fs.readFileSync(file));
  return {
    at: (x, y) => {
      const i = (y * png.width + x) * 4;
      return [png.data[i], png.data[i + 1], png.data[i + 2], png.data[i + 3]];
    },
  };
}

function readSource(): { strip: Rgba[]; band: Rgba[][] } {
  const { at } = pixelReader(HOUSE);
  // 6px vertical cross-section: [outline, body, body, body, body, outline].
  const strip = Array.from({ length: 6 }, (_, x) => at(STRIP_TILE.tx * 16 + x, STRIP_TILE.ty * 16 + STRIP_TILE.y));
  // 9px horizontal cross-section, full 16px wide: rows are
  // [top outline, top surface x3, mid dark line, face x3, bottom outline].
  // Kept 16 wide (not one column) because the pack dithers the second face
  // row per-x — sampling one column would flatten that texture away.
  const band = Array.from({ length: 9 }, (_, j) =>
    Array.from({ length: 16 }, (_, x) => at(BAND_TILE.tx * 16 + x, BAND_TILE.ty * 16 + 7 + j)),
  );
  return { strip, band };
}

/** The four north-wall face pieces, appended after the 16 bitmask ones (see
 *  FACE_PIECE_COUNT / the header comment). Each is exactly one cell tall so a
 *  mapper stacks them to whatever height the wall should be — 1 tall is SOLID
 *  alone, 2 tall is TOP over BOTTOM, n tall is TOP + MID×(n-2) + BOTTOM. That
 *  keeps every cell blocking exactly its own 16px, which a single taller
 *  sprite spilling into the cell above would not.
 *
 *  These pieces are unreachable from neighbour adjacency by construction (a
 *  derived mask is only ever 0-15), so they exist purely to be painted
 *  deliberately in Tiled — which is exactly what WallEdges.latticePiece
 *  already carries through import and render. */
function buildFacePieces(): Rgba[][][] {
  const { at } = pixelReader(HOUSE);
  const tileRows = (t: { tx: number; ty: number }): Rgba[][] =>
    Array.from({ length: 16 }, (_, y) => Array.from({ length: 16 }, (_, x) => at(t.tx * 16 + x, t.ty * 16 + y)));
  const cornice = tileRows(FACE_CORNICE_TILE);
  const fill = tileRows(FACE_FILL_TILE);
  const baseboard = tileRows(FACE_BASEBOARD_TILE);
  // SOLID is the only synthesized one: the cornice's top rows and the
  // baseboard's bottom rows over one cell of fill, for a wall exactly 1 tall.
  const solid = fill.map((row, y) => {
    if (y < CORNICE_H) return cornice[y];
    if (y >= 16 - BASEBOARD_H) return baseboard[y];
    return row;
  });
  return [cornice, fill, baseboard, solid];
}

/** The FACE_BLOCKS above, flattened to one piece per source row. */
function buildExtraFacePieces(): Rgba[][][] {
  const readers = { house: pixelReader(HOUSE), hospital: pixelReader(HOSPITAL) };
  const out: Rgba[][][] = [];
  for (const block of FACE_BLOCKS) {
    const { at } = readers[block.sheet];
    for (const ty of block.rows) {
      out.push(Array.from({ length: 16 }, (_, y) => Array.from({ length: 16 }, (_, x) => at(block.tx * 16 + x, ty * 16 + y))));
    }
  }
  return out;
}

/** Geometry, in cell coordinates (0-15). The vertical strip is 6px wide
 *  centered (outline at 5 and 10, body 6-9); the horizontal band is 9px tall
 *  centered (outline at 4 and 12, interior 5-11). Both cross-sections are the
 *  measured ones, so a wall run is pixel-identical to the source pack's. */
const STRIP_X0 = 5;
const STRIP_X1 = 10;
const BAND_Y0 = 4;
const BAND_Y1 = 12;

interface Box {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}
const inBox = (b: Box, x: number, y: number) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1;

/**
 * The four arms, as (solid, interior) box pairs. An arm reaches the cell edge
 * it points at (so consecutive cells join seamlessly) and stops at the
 * opposite side of the centre junction. `interior` excludes the arm's own
 * outline ring except on the edge it reaches through.
 *
 * The N/S arms carry NO horizontal outline where they meet the edge, and the
 * E/W arms none where they meet theirs — that is what makes outline =
 * solid − interior come out as the boundary of the *union* of arms, which is
 * exactly how the source pack draws its corners (the band's top outline stops
 * where a vertical strip continues through it).
 */
const ARMS: Record<'N' | 'E' | 'S' | 'W', { solid: Box; interior: Box }> = {
  N: { solid: { x0: STRIP_X0, x1: STRIP_X1, y0: 0, y1: BAND_Y1 }, interior: { x0: STRIP_X0 + 1, x1: STRIP_X1 - 1, y0: 0, y1: BAND_Y1 - 1 } },
  S: { solid: { x0: STRIP_X0, x1: STRIP_X1, y0: BAND_Y0, y1: 15 }, interior: { x0: STRIP_X0 + 1, x1: STRIP_X1 - 1, y0: BAND_Y0 + 1, y1: 15 } },
  E: { solid: { x0: STRIP_X0, x1: 15, y0: BAND_Y0, y1: BAND_Y1 }, interior: { x0: STRIP_X0 + 1, x1: 15, y0: BAND_Y0 + 1, y1: BAND_Y1 - 1 } },
  W: { solid: { x0: 0, x1: STRIP_X1, y0: BAND_Y0, y1: BAND_Y1 }, interior: { x0: 0, x1: STRIP_X1 - 1, y0: BAND_Y0 + 1, y1: BAND_Y1 - 1 } },
};
/** Bitmask 0 (no wall neighbour in any direction): a free-standing post,
 *  the junction box alone. */
const POST: { solid: Box; interior: Box } = {
  solid: { x0: STRIP_X0, x1: STRIP_X1, y0: BAND_Y0, y1: BAND_Y1 },
  interior: { x0: STRIP_X0 + 1, x1: STRIP_X1 - 1, y0: BAND_Y0 + 1, y1: BAND_Y1 - 1 },
};

const BIT: Array<['N' | 'E' | 'S' | 'W', number]> = [
  ['N', 1],
  ['E', 2],
  ['S', 4],
  ['W', 8],
];

function buildPiece(mask: number, strip: Rgba[], band: Rgba[][]): Rgba[][] {
  const arms = BIT.filter(([, bit]) => mask & bit).map(([dir]) => ARMS[dir]);
  const parts = arms.length > 0 ? arms : [POST];
  const horizontal = parts.filter((p) => p === ARMS.E || p === ARMS.W);
  const vertical = parts.filter((p) => p === ARMS.N || p === ARMS.S || p === POST);

  const transparent: Rgba = [0, 0, 0, 0];
  const cell: Rgba[][] = Array.from({ length: 16 }, () => Array.from({ length: 16 }, () => transparent));
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      if (!parts.some((p) => inBox(p.solid, x, y))) continue;
      // Interior of a horizontal arm → the band's own cross-section (keeps
      // its mid line and dithered face). Interior of a vertical arm → the
      // strip's flat body. A pixel inside the junction belongs to the band
      // whenever a horizontal arm exists, which is how the source pack runs
      // the band straight through a corner.
      if (horizontal.some((p) => inBox(p.interior, x, y))) {
        cell[y][x] = band[y - BAND_Y0][x % 16];
        continue;
      }
      if (vertical.some((p) => inBox(p.interior, x, y))) {
        cell[y][x] = strip[x - STRIP_X0];
        continue;
      }
      // Outline: the boundary of the union. On a piece that has a horizontal
      // arm, the top/bottom rows keep the band's own two (slightly different)
      // outline tones; everywhere else the strip's single outline tone.
      const bandOutline = horizontal.length > 0 && (y === BAND_Y0 || y === BAND_Y1);
      cell[y][x] = bandOutline ? band[y - BAND_Y0][x % 16] : strip[0];
    }
  }
  return cell;
}

/**
 * The floor textures to crop, in the order they become rows of the
 * "floor-metro" sheet — i.e. METRO_FLOOR_PATTERN_FILES in
 * bake-floor-wall-tiled.mts, and so OfficeLayout tile values 1..N for
 * tileFloorSet = the floor-metro index. APPEND ONLY: a saved layout stores
 * the pattern as that row number, so reordering this list silently repaints
 * every existing floor-metro tile.
 *
 * Each entry is a single tile the pack itself repeats as an identical 2x2
 * block, which is what makes it safe to use as a one-tile seamless fill.
 * Deliberately excluded: the pack's flat single-color fills (those are wall
 * faces — our palette already covers flat color), its striped curtain
 * textures, and its checkerboard (a 32x32 period, not expressible as one
 * 16x16 pattern).
 */
const FLOOR_PICKS: Array<{ file: string; sheet: string; tx: number; ty: number; note: string }> = [
  { file: 'metro_0.png', sheet: HOUSE, tx: 17, ty: 8, note: 'light tile grid — the neutral office floor' },
  { file: 'metro_1.png', sheet: HOUSE, tx: 6, ty: 8, note: 'wood planks, horizontal' },
  { file: 'metro_2.png', sheet: HOUSE, tx: 6, ty: 11, note: 'wood planks, vertical' },
  { file: 'metro_3.png', sheet: HOSPITAL, tx: 9, ty: 9, note: 'dark wood, horizontal' },
  { file: 'metro_4.png', sheet: HOSPITAL, tx: 6, ty: 9, note: 'dark wood, vertical' },
  { file: 'metro_5.png', sheet: HOUSE, tx: 5, ty: 27, note: 'dark plank decking, horizontal' },
  { file: 'metro_6.png', sheet: HOSPITAL, tx: 2, ty: 10, note: 'blue tile' },
];

function writeFloors(): void {
  for (const pick of FLOOR_PICKS) {
    const { at } = pixelReader(pick.sheet);
    const png = new PNG({ width: 16, height: 16 });
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const [r, g, b, a] = at(pick.tx * 16 + x, pick.ty * 16 + y);
        const i = (y * 16 + x) * 4;
        png.data[i] = r;
        png.data[i + 1] = g;
        png.data[i + 2] = b;
        png.data[i + 3] = a;
      }
    }
    const out = path.join(FLOOR_DIR, pick.file);
    fs.writeFileSync(out, PNG.sync.write(png));
    console.log(`✓ ${path.relative(ROOT, out)} — ${pick.note}`);
  }
}

const { strip, band } = readSource();
const pieces = [
  ...Array.from({ length: WALL_BITMASK_COUNT }, (_, mask) => buildPiece(mask, strip, band)),
  ...buildFacePieces(),
  ...buildExtraFacePieces(),
];
// The grid must come out exactly full — parseWallPng derives a set's piece
// count from the sheet's height, so a half-empty last row would read back as
// extra blank pieces and show up as empty tiles in Tiled's palette.
if (pieces.length % WALL_GRID_COLS !== 0) {
  throw new Error(`${pieces.length} pieces don't fill a ${WALL_GRID_COLS}-wide grid`);
}
const sheet = new PNG({
  width: WALL_GRID_COLS * WALL_PIECE_WIDTH,
  height: (pieces.length / WALL_GRID_COLS) * WALL_PIECE_HEIGHT,
});
sheet.data.fill(0);
pieces.forEach((cell, index) => {
  const ox = (index % WALL_GRID_COLS) * WALL_PIECE_WIDTH;
  // Art sits in the bottom 16 rows of the 32-tall slot — see header comment.
  const oy = Math.floor(index / WALL_GRID_COLS) * WALL_PIECE_HEIGHT + (WALL_PIECE_HEIGHT - 16);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const i = ((oy + y) * sheet.width + (ox + x)) * 4;
      const [r, g, b, a] = cell[y][x];
      sheet.data[i] = r;
      sheet.data[i + 1] = g;
      sheet.data[i + 2] = b;
      sheet.data[i + 3] = a;
    }
  }
});
fs.writeFileSync(WALL_OUT, PNG.sync.write(sheet));
console.log(
  `✓ ${path.relative(ROOT, WALL_OUT)} (${WALL_BITMASK_COUNT} bitmask + ${pieces.length - WALL_BITMASK_COUNT} face pieces, ${sheet.width}x${sheet.height})`,
);
writeFloors();
