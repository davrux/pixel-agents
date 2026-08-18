#!/usr/bin/env -S node --import tsx
/**
 * One-time importer for the "Zelda-like tilesets and sprites" pack's
 * Overworld.png sheet (ArMM1998, public domain / CC0 — see the README credit).
 *
 * One output, and deliberately no slicing into per-item sprites:
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
 * There used to be a second output: the opaque terrain cells were cut out as floor
 * patterns for a natural-only floor-overworld set, so ground could be painted on the
 * GroundLayer. That set is gone, and with it the hand-judged table of which cells are
 * ground — the same art is reachable as decals from this sheet, and one source beats
 * two. Ground that had been painted with it was cleared from the maps in the same
 * change.
 *
 * The sheet is re-composed with a gap between cells and their borders extruded into
 * it, rather than copied verbatim: a cell is drawn as a FRAME of this one texture, and
 * touching cells bleed into each other at fractional camera zoom (see
 * composeWithGaps). The cell count is unchanged, so every gid in every saved map still
 * points where it did.
 *
 * A grid cell's catalog id is positional (OW_<col>_<row>) — stable because the
 * sheet is the pack's own; nothing renumbers it. Fully
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

import { composeWithGaps, SHEET_GAP } from './lib/sheetSlice.mjs';
import { DECAL_TILE_PROPS } from '../src/tiled/decalProps.js';
import { DECAL_TILE_CLASS } from '../src/tiled/tiledRegistry.js';

const ROOT = new URL('../..', import.meta.url).pathname;
const SHEET = path.join(ROOT, 'tmp', 'gfx', 'Overworld.png');
const TILED = path.join(ROOT, 'assets', 'tiled');
const DECAL_TSJ = path.join(TILED, 'decal-overworld.tsj');
const SHEET_COPY = 'png/decal-overworld.png';
const T = 16;

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
const spaced = composeWithGaps(src, T, SHEET_GAP);
fs.writeFileSync(path.join(TILED, SHEET_COPY), PNG.sync.write(spaced));
fs.writeFileSync(
  DECAL_TSJ,
  JSON.stringify(
    {
      columns: cols,
      image: SHEET_COPY,
      imagewidth: spaced.width,
      imageheight: spaced.height,
      margin: 0,
      name: 'decal-overworld',
      spacing: SHEET_GAP,
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
console.log('  Now in Tiled: paint from decal-overworld onto DecalLayers — flat for ground, `occludes` for anything to walk behind.');
