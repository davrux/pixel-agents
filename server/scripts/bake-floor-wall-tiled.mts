#!/usr/bin/env -S node --import tsx
/**
 * One-time bake: generates the Tiled-facing floor/wall tilesets — real,
 * distinct PNG tiles for every (pattern, palette swatch) and (wall bitmask,
 * palette swatch) combination, since Tiled has no concept of "one sprite +
 * a runtime recolor". The runtime keeps rendering via colorize.ts's
 * getColorizedSprite exactly as before (see shared/src/office/floorTiles.ts,
 * wallTiles.ts) — this script exists purely so a human editing in Tiled sees
 * the same closed palette (see palettes.ts) as real, paintable tiles.
 *
 * Each tile carries NO custom properties at all — only its Tiled class
 * (`type: 'FloorTile'`/`'WallTile'`, see Pixels.tiled-project). Which
 * pattern/bitmask a tile is, and which palette swatch (or "Natural", column
 * 0), is derived purely from its position in this grid — row = pattern-1 or
 * bitmask, column = swatch+1 (see mapBridge.ts's rowAndSwatchFromLocalId/
 * gidAt and shared/src/office/tiledSheetLayout.ts). Safe to derive
 * positionally because these files are entirely machine-generated — nothing
 * ever hand-edits their tile lists, unlike furniture-*.tsj.
 *
 * "Sets" (see FLOOR_SET_FILES/WALL_SET_FILES in tiledSheetLayout.ts): floor
 * and wall each come in a regular (PALETTE_64) and a warm (WARM_PALETTE_64)
 * variant, one .tsj/.png pair per variant — never mixed into one file, so
 * opening e.g. floor.tsj in Tiled always shows the same 11 patterns
 * regardless of how many warm variants exist. floor-warm additionally has
 * one warm-only pattern (wood planks) with no regular counterpart.
 *
 * Run (from server/): node --import tsx scripts/bake-floor-wall-tiled.mts
 */
import { PNG } from 'pngjs';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { decodeFloorPng, parseWallPng } from '../src/core/assets/pngDecoder.js';
import { averageLightness, getColorizedSprite } from '../../shared/src/office/colorize.js';
import { PALETTE_64, WARM_PALETTE_64, swatchColor } from '../../shared/src/office/palettes.js';
import {
  FLOOR_TILE_W,
  FLOOR_TILE_H,
  TILED_SHEET_COLUMNS,
  WALL_TILE_H,
  WALL_BITMASK_COUNT,
  WALL_TILE_SPACING,
} from '../../shared/src/office/tiledSheetLayout.js';
import type { PaletteSwatch } from '../../shared/src/office/palettes.js';
import type { SpriteData } from '../../shared/src/office/types.js';

const ROOT = new URL('../..', import.meta.url).pathname;
const OUT_DIR = path.join(ROOT, 'assets', 'tiled');
const OUT_PNG_DIR = path.join(OUT_DIR, 'png');
const TILE_W = FLOOR_TILE_W;
const FLOOR_H = FLOOR_TILE_H;
const WALL_H = WALL_TILE_H;

function spriteToPng(sprite: SpriteData, w: number, h: number): PNG {
  const png = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const px = sprite[y]?.[x] ?? '';
      const i = (y * w + x) * 4;
      if (!px) {
        png.data[i] = 0;
        png.data[i + 1] = 0;
        png.data[i + 2] = 0;
        png.data[i + 3] = 0;
        continue;
      }
      png.data[i] = parseInt(px.slice(1, 3), 16);
      png.data[i + 1] = parseInt(px.slice(3, 5), 16);
      png.data[i + 2] = parseInt(px.slice(5, 7), 16);
      png.data[i + 3] = px.length > 7 ? parseInt(px.slice(7, 9), 16) : 255;
    }
  }
  return png;
}

/** Lay out `tiles` (each `tileW`×`tileH`) into one sheet PNG, `columns` wide,
 *  with `spacing` transparent px between every tile (see WALL_TILE_SPACING;
 *  0 for floor sheets — no directional-edge ambiguity to separate there). */
function composeSheet(tiles: SpriteData[], tileW: number, tileH: number, columns: number, spacing = 0): Buffer {
  const rows = Math.ceil(tiles.length / columns);
  const sheet = new PNG({
    width: columns * tileW + (columns - 1) * spacing,
    height: rows * tileH + (rows - 1) * spacing,
  });
  sheet.data.fill(0);
  tiles.forEach((sprite, i) => {
    const col = i % columns;
    const row = Math.floor(i / columns);
    const tilePng = spriteToPng(sprite, tileW, tileH);
    PNG.bitblt(tilePng, sheet, 0, 0, tileW, tileH, col * (tileW + spacing), row * (tileH + spacing));
  });
  return PNG.sync.write(sheet);
}

function grid(tileW: number, tileH: number, columns: number, tileCount: number, imageFile: string, imageW: number, imageH: number, tileClass: string, name: string, spacing = 0) {
  return {
    columns,
    image: imageFile,
    imagewidth: imageW,
    imageheight: imageH,
    margin: 0,
    name,
    spacing,
    tilecount: tileCount,
    tiledversion: '1.11.0',
    tileheight: tileH,
    tilewidth: tileW,
    // `type` assigns each tile to its project-level class (Pixels.tiled-
    // project's FloorTile/WallTile) so Tiled recognizes it as one. No
    // per-tile properties — see this file's header comment.
    tiles: Array.from({ length: tileCount }, (_, id) => ({ id, type: tileClass })),
    type: 'tileset',
    version: '1.10',
  };
}

/** Every row's palette must be exactly TILED_SHEET_COLUMNS-1 colors — the
 *  sheet is one fixed-width grid, so a differently-sized palette would
 *  silently misalign every row after it. */
function checkPaletteSize(palette: PaletteSwatch[], label: string): PaletteSwatch[] {
  if (palette.length !== TILED_SHEET_COLUMNS - 1) {
    throw new Error(`${label}: palette has ${palette.length} colors, expected ${TILED_SHEET_COLUMNS - 1}`);
  }
  return palette;
}

/** The 11 shared base floor patterns every floor set includes (in order —
 *  row i = floor_<i>.png). floor-warm additionally appends its own
 *  warm-only pattern (wood planks) after these. */
const BASE_FLOOR_PATTERN_FILES = Array.from({ length: 11 }, (_, p) => `floor_${p}.png`);

function bakeFloorSheet(outputName: string, sourceFiles: string[], palette: PaletteSwatch[]): void {
  const pal = checkPaletteSize(palette, `floor set "${outputName}"`);
  const tiles: SpriteData[] = [];
  for (const sourceFile of sourceFiles) {
    const raw = decodeFloorPng(fs.readFileSync(path.join(ROOT, 'assets', 'floors', sourceFile)));
    // Column 0: Natural (raw, uncolorized) — matches a null tileColors entry.
    tiles.push(raw);
    for (const sw of pal) {
      tiles.push(getColorizedSprite(`bake-${outputName}-${sourceFile}-${sw.h}-${sw.s}`, raw, swatchColor(sw)));
    }
  }
  const columns = TILED_SHEET_COLUMNS; // Natural + 64 swatches
  const buf = composeSheet(tiles, TILE_W, FLOOR_H, columns);
  fs.writeFileSync(path.join(OUT_PNG_DIR, `${outputName}.png`), buf);
  const tsj = grid(TILE_W, FLOOR_H, columns, tiles.length, `png/${outputName}.png`, columns * TILE_W, sourceFiles.length * FLOOR_H, 'FloorTile', outputName);
  fs.writeFileSync(path.join(OUT_DIR, `${outputName}.tsj`), JSON.stringify(tsj, null, 2) + '\n');
  console.log(`✓ ${outputName}.tsj + png/${outputName}.png (${tiles.length} tiles, ${sourceFiles.length} patterns × ${columns} colors)`);
}

/** Tiled wangid order (JSON format): [top, topright, right, bottomright,
 *  bottom, bottomleft, left, topleft] — an "edge" Wang set only sets the 4
 *  edge slots (even indices), corners (odd) stay 0. Two Wang colors: 1 = wall
 *  present in that direction, 2 = no wall — matches buildWallMask's N=1,E=2,
 *  S=4,W=8 bitmask exactly (see shared/src/office/wallTiles.ts), so painting
 *  with this Wang set in Tiled autotiles the same way our own renderer picks
 *  pieces. Verified against a live Tiled 1.12 instance — the mapping itself
 *  is correct, but the Terrain Brush only recomputes a tile from *real*
 *  neighboring tiles that already carry wangid data; it won't build up an
 *  isolated tile edge-by-edge (each click on empty surroundings recomputes
 *  from scratch instead of accumulating). Workflow that actually works in
 *  Tiled: stamp placeholder wall tiles everywhere the walls should go first
 *  (any piece, e.g. via the regular Stamp tool), then use the Terrain Brush
 *  (no Ctrl) to click individual edges of those already-placed tiles to
 *  clear them to "empty" where needed — Ctrl+click forces the whole tile to
 *  one color (always yields the all-wall piece, bitmask 15) and is not
 *  useful for shaping a room outline. The per-tile `bitmask` property
 *  remains the load-bearing data for task #157's map import either way. */
function wangIdForMask(mask: number): number[] {
  const wallOrEmpty = (bit: number) => (mask & bit ? 1 : 2);
  return [wallOrEmpty(1), 0, wallOrEmpty(2), 0, wallOrEmpty(4), 0, wallOrEmpty(8), 0]; // N,_,E,_,S,_,W,_
}

/** `sourceFile` is the raw wall_N.png geometry to bake — two sets can (and
 *  do) share the same source, baked with a different palette, e.g.
 *  "wall-0-resurrect64" and "wall-0-warm" both read wall_0.png. */
function bakeWallSheet(outputName: string, sourceFile: string, palette: PaletteSwatch[]): void {
  const raw = parseWallPng(fs.readFileSync(path.join(ROOT, 'assets', 'walls', sourceFile)));
  // One shared brightness baseline across all 16 pieces (not per piece) —
  // see wallTiles.ts's wallSetReferenceLightness for why: pieces vary a lot
  // in how much of their area is "cap" vs "face", so recentering each
  // independently breaks the "one continuous wall" illusion at piece
  // boundaries. Must match the runtime's own reference exactly, or a tile
  // painted from this baked tileset would render a visibly different tone
  // than the same bitmask+color painted live.
  const referenceLightness = averageLightness(raw.flat());
  const pal = checkPaletteSize(palette, `wall set "${outputName}"`);
  const tiles: SpriteData[] = [];
  for (let mask = 0; mask < WALL_BITMASK_COUNT; mask++) {
    const piece = raw[mask];
    tiles.push(piece);
    for (const sw of pal) {
      tiles.push(getColorizedSprite(`bake-${outputName}-${mask}-${sw.h}-${sw.s}`, piece, swatchColor(sw), referenceLightness));
    }
  }
  const columns = TILED_SHEET_COLUMNS; // Natural + 64 swatches
  const buf = composeSheet(tiles, TILE_W, WALL_H, columns, WALL_TILE_SPACING);
  fs.writeFileSync(path.join(OUT_PNG_DIR, `${outputName}.png`), buf);
  const imageW = columns * TILE_W + (columns - 1) * WALL_TILE_SPACING;
  const imageH = 16 * WALL_H + (16 - 1) * WALL_TILE_SPACING;
  const tsj = grid(TILE_W, WALL_H, columns, tiles.length, `png/${outputName}.png`, imageW, imageH, 'WallTile', outputName, WALL_TILE_SPACING) as Record<
    string,
    unknown
  >;
  // One Wang/Terrain set PER COLOR, not one set covering all colors — a Wang
  // set's brush only knows "does this tile satisfy the required edge
  // pattern", with no notion of color at all, so a single set spanning every
  // swatch column would let the autotile brush freely substitute any
  // same-bitmask tile regardless of column, silently changing color every
  // time it paints. Splitting into 17 sets (Natural + one per swatch), each
  // covering only its own 16 bitmask tiles, means picking e.g. "Wall — #597dce"
  // as the active terrain keeps every painted piece that same color.
  const colorLabels = ['Natural', ...pal.map((sw) => sw.hex)];
  tsj.wangsets = colorLabels.map((label, col) => ({
    // The "wall" terrain's own `color` is what Tiled actually paints into the
    // Terrain Sets panel's swatch (the hex in `name` below is just text, not
    // a real preview) — set it to this set's real swatch color so browsing
    // the list doubles as a color picker instead of requiring you to read
    // and cross-reference the hex string by eye. "Natural" has no single
    // representative swatch (it's the un-recolored source art), so it keeps
    // a neutral placeholder — same '#808080' PhaserRenderer.ts uses for "no
    // tint". "empty" always stays neutral regardless of column: it's the Wang
    // *absence-of-wall* state, not a paint color, so it never varies by set.
    colors: [
      { color: col === 0 ? '#808080' : label, name: 'wall', probability: 1, tile: -1 },
      { color: '#3a3a3a', name: 'empty', probability: 1, tile: -1 },
    ],
    name: `Wall — ${label}`,
    // The set's own representative tile — what Tiled actually shows as the
    // small thumbnail icon next to each entry in the outer Terrain Sets
    // list (the per-terrain `color` above only shows once you open one set
    // and look at its "wall"/"empty" colors; scrolling the top-level list of
    // all 65 sets showed plain, colorless names without this). Bitmask 15
    // (the "all-wall" piece — see wangIdForMask's doc comment) is the
    // fully-painted tile, the clearest single-tile preview of this column's
    // actual color.
    tile: 15 * columns + col,
    type: 'edge',
    wangtiles: Array.from({ length: 16 }, (_, mask) => ({
      tileid: mask * columns + col,
      wangid: wangIdForMask(mask),
    })),
  }));
  fs.writeFileSync(path.join(OUT_DIR, `${outputName}.tsj`), JSON.stringify(tsj, null, 2) + '\n');
  console.log(`✓ ${outputName}.tsj + png/${outputName}.png (${tiles.length} tiles, 16 bitmasks × ${columns} colors)`);
}

fs.mkdirSync(OUT_PNG_DIR, { recursive: true });
bakeFloorSheet('floor-resurrect64', BASE_FLOOR_PATTERN_FILES, PALETTE_64);
bakeFloorSheet('floor-warm', [...BASE_FLOOR_PATTERN_FILES, 'floor_11.png'], WARM_PALETTE_64);
bakeWallSheet('wall-0-resurrect64', 'wall_0.png', PALETTE_64);
bakeWallSheet('wall-1-resurrect64', 'wall_1.png', PALETTE_64);
bakeWallSheet('wall-0-warm', 'wall_0.png', WARM_PALETTE_64);
bakeWallSheet('wall-1-warm', 'wall_1.png', WARM_PALETTE_64);
