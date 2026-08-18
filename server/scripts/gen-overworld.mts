#!/usr/bin/env -S node --import tsx
/**
 * One-time importer for the "Zelda-like tilesets and sprites" pack's
 * Overworld.png sheet (ArMM1998, public domain / CC0 — see the README credit).
 *
 * Two outputs, and deliberately no slicing into per-item sprites:
 *
 *   - **Floor patterns** (FLOOR_RECTS): the fully-opaque terrain cells — grass,
 *     waters, sand shores, cliffs, waterfall runs, dirt paths, garden beds —
 *     each written to assets/floors/overworld_<i>.png for
 *     bake-floor-wall-tiled.mts to bake into the natural-only (one column, no
 *     palette swatches) floor-overworld set. Which cells are ground cannot be
 *     derived from the pixels — it takes eyes; the table below is that
 *     judgement, written down. Cells whose pixels exactly repeat an earlier
 *     pattern are skipped — big terrain blocks tile the same art.
 *
 *   - **The whole sheet as a GRID decal tileset** (decal-overworld.tsj): one
 *     shared image, every non-empty 16x16 cell a DecalTile addressed by its
 *     position. In Tiled that is the sheet exactly as drawn — rubber-band a
 *     house and stamp it — and painted cells import as decals (art in the
 *     layout, no synced object; see tiled/decalProps.ts). This replaced an
 *     earlier alpha-component slicing into furniture items: the sheet is a
 *     packed collage the slicer could only cut apart with a long table of
 *     hand-judged rects, and painting from the intact sheet is both the
 *     pack's intended use and the better Tiled workflow. Anything that must
 *     be *interacted with* still wants to be furniture — placed from an
 *     ordinary furniture tileset, which this pack no longer provides.
 *
 * A grid cell's catalog id is positional (OW_<col>_<row>) — stable because the
 * sheet is the pack's own, committed verbatim; nothing renumbers it. Fully
 * transparent cells get no tiles[] entry, so they never reach the catalog.
 *
 * The pack itself lives outside the repo (tmp/zelda-like, gitignored); only
 * the derived floors + the sheet copy + tileset are committed.
 *
 * Run: scripts/import-overworld-pack.sh (this is its first step)
 */
import { PNG } from 'pngjs';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { DECAL_TILE_PROPS } from '../src/tiled/decalProps.js';
import { DECAL_TILE_CLASS } from '../src/tiled/tiledRegistry.js';

const ROOT = new URL('../..', import.meta.url).pathname;
const SHEET = path.join(ROOT, 'tmp', 'zelda-like', 'Overworld.png');
const FLOOR_DIR = path.join(ROOT, 'assets', 'floors');
const TILED = path.join(ROOT, 'assets', 'tiled');
const DECAL_TSJ = path.join(TILED, 'decal-overworld.tsj');
const SHEET_COPY = 'png/decal-overworld.png';
const T = 16;

interface Rect {
  tx: number;
  ty: number;
  w: number;
  h: number;
  note: string;
}
const r = (tx: number, ty: number, w: number, h: number, note: string): Rect => ({ tx, ty, w, h, note });

/**
 * The ground, in reading order. Only fully-opaque cells become patterns — a
 * partially transparent cell would render as a hole down to the canvas
 * background, since a zone has exactly one ground layer (the same rule that
 * limited the Sprout floors to the packs' fill tiles). A rect here may still
 * brush a see-through edge cell; those are skipped with a note rather than
 * failing the run, so a rect can honestly cover "the grass block" without
 * per-cell bookkeeping of its ragged fringe (the fringe stays in the sheet
 * and is painted from the decal set instead). Animation frames (the water
 * rows, half the open-water block) are simply not listed: floors don't
 * animate, and 2-4 near-copies of a pattern help nobody.
 */
const FLOOR_RECTS: Rect[] = [
  // ── top-left meadows and waters ──
  r(0, 0, 1, 1, 'grass, plain'),
  r(0, 1, 1, 1, 'water, high waves'),
  r(0, 2, 1, 1, 'water, low waves'),
  r(0, 3, 3, 3, 'grass with sand patch'),
  r(3, 3, 3, 2, 'deep water, ripple ring'),
  r(16, 0, 2, 4, 'open water'),
  // The grass square around the small pond, bush fill included; the pond's
  // own water centre (3,7) is opaque water and comes along.
  r(0, 6, 5, 2, 'bushes / grass around pond'),
  r(2, 8, 3, 1, 'grass below pond'),
  r(0, 9, 9, 2, 'meadow'),
  // ── the lake: sand shore, streaked water, island ──
  r(11, 5, 2, 2, 'tall grass'),
  r(15, 6, 3, 3, 'sand shore around lake hole'),
  r(18, 6, 3, 1, 'lake, streaked water'),
  r(18, 7, 3, 2, 'lake, streaked water lower'),
  r(15, 9, 2, 2, 'lake island'),
  r(17, 9, 3, 2, 'lake, ripple shore'),
  r(18, 11, 3, 1, 'lake, foam edge'),
  // ── cliffs, rivers and paths (lower-left quarter) ──
  r(4, 11, 4, 1, 'cliff, grass top'),
  r(4, 12, 3, 2, 'cliff face'),
  r(8, 13, 5, 2, 'grass to dirt'),
  r(12, 13, 1, 2, 'dirt path'),
  r(13, 15, 2, 1, 'dirt path, lower'),
  r(11, 16, 4, 1, 'dirt path, bottom'),
  r(2, 16, 3, 1, 'bright grass'),
  r(9, 17, 2, 1, 'grass, river inlet'),
  r(9, 18, 2, 1, 'cliff with waterfall top'),
  r(14, 11, 1, 1, 'stone slab'),
  r(16, 12, 1, 1, 'stone slab, cracked'),
  r(19, 13, 1, 1, 'cobble'),
  r(0, 20, 8, 1, 'soil and cliff-shore row'),
  r(9, 20, 2, 2, 'cliff and grass, waterfall run'),
  // ── gardens and hedges (bottom-left quarter) ──
  r(0, 29, 3, 3, 'grass with dirt patch'),
  r(0, 32, 3, 1, 'grass to soil edge'),
  r(0, 33, 2, 1, 'grass to soil edge, lower'),
  r(0, 34, 2, 2, 'garden beds'),
  r(9, 27, 2, 2, 'hedge mass'),
  r(11, 28, 3, 1, 'hedge, sparse'),
  r(14, 29, 5, 2, 'hedge field'),
  r(14, 31, 3, 1, 'hedge field, middle'),
  r(14, 32, 5, 2, 'hedge field, lower'),
];

// ── read the sheet ──
if (!fs.existsSync(SHEET)) {
  console.error(`✗ sheet missing: ${SHEET} — put the pack's PNGs in tmp/zelda-like/ first`);
  process.exit(1);
}
const sheetBytes = fs.readFileSync(SHEET);
const src = PNG.sync.read(sheetBytes);
const cols = Math.floor(src.width / T);
const rows = Math.floor(src.height / T);

function cellAlpha(tx: number, ty: number): { any: boolean; full: boolean } {
  let any = false;
  let full = true;
  for (let y = 0; y < T; y++)
    for (let x = 0; x < T; x++) {
      const a = src.data[((ty * T + y) * src.width + tx * T + x) * 4 + 3];
      if (a !== 0) any = true;
      if (a !== 255) full = false;
    }
  return { any, full };
}

function cellPng(tx: number, ty: number): PNG {
  const out = new PNG({ width: T, height: T });
  for (let y = 0; y < T; y++) {
    const srcStart = ((ty * T + y) * src.width + tx * T) * 4;
    src.data.copy(out.data, y * T * 4, srcStart, srcStart + T * 4);
  }
  return out;
}

// ── floors ──
for (const f of fs.readdirSync(FLOOR_DIR)) {
  if (/^overworld_\d+\.png$/.test(f)) fs.unlinkSync(path.join(FLOOR_DIR, f));
}
const seenPatterns = new Set<string>();
let floorIndex = 0;
let dupes = 0;
const skippedPartial: string[] = [];
for (const rect of FLOOR_RECTS) {
  for (let dy = 0; dy < rect.h; dy++) {
    for (let dx = 0; dx < rect.w; dx++) {
      const tx = rect.tx + dx;
      const ty = rect.ty + dy;
      if (!cellAlpha(tx, ty).full) {
        skippedPartial.push(`(${tx},${ty}) ${rect.note}`);
        continue;
      }
      const png = cellPng(tx, ty);
      const key = png.data.toString('base64');
      if (seenPatterns.has(key)) {
        dupes++;
        continue;
      }
      seenPatterns.add(key);
      fs.writeFileSync(path.join(FLOOR_DIR, `overworld_${floorIndex}.png`), PNG.sync.write(png));
      floorIndex++;
    }
  }
}
console.log(`✓ ${floorIndex} floor patterns → assets/floors/overworld_*.png (${dupes} repeated cells folded)`);
if (skippedPartial.length > 0) {
  console.log(`  ${skippedPartial.length} see-through cell(s) skipped (paintable from the decal set instead):`);
  for (const s of skippedPartial) console.log(`    ${s}`);
}

// ── the whole sheet as a grid decal tileset ──
// The image goes in verbatim (the copy IS the pack's sheet), and every
// non-empty cell gets a tiles[] entry: the DecalTile class plus the full decal
// property set at defaults, in the same shape sync-furniture-properties.mts
// keeps every other tile in.
interface TileEntry {
  id: number;
  type: string;
  properties: Array<{ name: string; type: string; value: string | number | boolean; propertytype?: string }>;
}
const tiles: TileEntry[] = [];
for (let ty = 0; ty < rows; ty++) {
  for (let tx = 0; tx < cols; tx++) {
    if (!cellAlpha(tx, ty).any) continue;
    const itemId = `OW_${tx}_${ty}`;
    tiles.push({
      id: ty * cols + tx,
      type: DECAL_TILE_CLASS,
      properties: [
        { name: 'id', type: 'string', value: itemId },
        ...DECAL_TILE_PROPS.map((spec) => ({
          name: spec.name,
          type: typeof spec.default === 'boolean' ? 'bool' : typeof spec.default === 'number' ? 'int' : 'string',
          value: spec.default,
          ...(spec.propertyType ? { propertytype: spec.propertyType } : {}),
        })),
      ],
    });
  }
}
fs.writeFileSync(path.join(TILED, SHEET_COPY), sheetBytes);
fs.writeFileSync(
  DECAL_TSJ,
  JSON.stringify(
    {
      columns: cols,
      image: SHEET_COPY,
      imagewidth: src.width,
      imageheight: src.height,
      margin: 0,
      name: 'decal-overworld',
      spacing: 0,
      tilecount: cols * rows,
      tiledversion: '1.11.0',
      tileheight: T,
      tilewidth: T,
      tiles,
      type: 'tileset',
      version: '1.10',
    },
    null,
    2,
  ) + '\n',
);
console.log(`✓ decal-overworld.tsj + ${SHEET_COPY} (${tiles.length} of ${cols * rows} cells carry art)`);
console.log('  Now: node --import tsx scripts/bake-floor-wall-tiled.mts');
console.log('  Then paint in Tiled: ground from floor-overworld, everything else onto DecalLayers from decal-overworld.');
