#!/usr/bin/env -S node --import tsx
/**
 * One-time bake: generates the Tiled-facing floor/wall tilesets — real,
 * distinct PNG tiles for every (pattern, palette swatch) and (wall bitmask,
 * palette swatch) combination, since Tiled has no concept of "one sprite +
 * a runtime recolor". The runtime keeps rendering via colorize.ts's
 * getColorizedSprite exactly as before (see shared/src/office/floorTiles.ts,
 * wallTiles.ts) — this script exists purely so a human editing in Tiled sees
 * the same closed palette (DB32 floor / Dawnbringer16 wall, see palettes.ts)
 * as real, paintable tiles, and so task #157's map bridge has a well-defined
 * GID → (pattern|bitmask, swatch) mapping via custom properties.
 *
 * Each pattern/bitmask gets one extra "Natural" tile (index 0, no swatch
 * property) — the raw, uncolorized sprite, matching what a null tileColors
 * entry renders as today (see PhaserRenderer.ts / wallTiles.ts's
 * getWallSprite vs getColorizedWallSprite).
 *
 * Run (from server/): node --import tsx scripts/bake-floor-wall-tiled.mts
 */
import { PNG } from 'pngjs';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { decodeFloorPng, parseWallPng } from '../src/core/assets/pngDecoder.js';
import { averageLightness, getColorizedSprite } from '../../shared/src/office/colorize.js';
import { FLOOR_PALETTE, WALL_PALETTE, swatchColor } from '../../shared/src/office/palettes.js';
import type { SpriteData } from '../../shared/src/office/types.js';

const ROOT = new URL('../..', import.meta.url).pathname;
const OUT_DIR = path.join(ROOT, 'assets', 'tiled');
const OUT_PNG_DIR = path.join(OUT_DIR, 'png');
const TILE_W = 16;
const FLOOR_H = 16;
const WALL_H = 32;

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

/** Lay out `tiles` (each `tileW`×`tileH`) into one sheet PNG, `columns` wide. */
function composeSheet(tiles: SpriteData[], tileW: number, tileH: number, columns: number): Buffer {
  const rows = Math.ceil(tiles.length / columns);
  const sheet = new PNG({ width: columns * tileW, height: rows * tileH });
  sheet.data.fill(0);
  tiles.forEach((sprite, i) => {
    const col = i % columns;
    const row = Math.floor(i / columns);
    const tilePng = spriteToPng(sprite, tileW, tileH);
    PNG.bitblt(tilePng, sheet, 0, 0, tileW, tileH, col * tileW, row * tileH);
  });
  return PNG.sync.write(sheet);
}

interface TiledProp {
  name: string;
  type: string;
  value: string | number | boolean;
}
function grid(tileW: number, tileH: number, columns: number, tileCount: number, imageFile: string, imageW: number, imageH: number, tileProps: TiledProp[][], name: string) {
  return {
    columns,
    image: imageFile,
    imagewidth: imageW,
    imageheight: imageH,
    margin: 0,
    name,
    spacing: 0,
    tilecount: tileCount,
    tiledversion: '1.11.0',
    tileheight: tileH,
    tilewidth: tileW,
    tiles: tileProps.map((properties, id) => ({ id, properties })),
    type: 'tileset',
    version: '1.10',
  };
}

function bakeFloor(): void {
  const patternCount = 11;
  const tiles: SpriteData[] = [];
  const props: TiledProp[][] = [];
  for (let p = 0; p < patternCount; p++) {
    const raw = decodeFloorPng(fs.readFileSync(path.join(ROOT, 'assets', 'floors', `floor_${p}.png`)));
    // Column 0: Natural (raw, uncolorized) — matches a null tileColors entry.
    tiles.push(raw);
    props.push([{ name: 'pattern', type: 'int', value: p + 1 }]);
    for (let s = 0; s < FLOOR_PALETTE.length; s++) {
      const swatch = FLOOR_PALETTE[s];
      const colorized = getColorizedSprite(`bake-floor-${p}-${swatch.h}-${swatch.s}`, raw, swatchColor(swatch));
      tiles.push(colorized);
      props.push([
        { name: 'pattern', type: 'int', value: p + 1 },
        { name: 'hue', type: 'int', value: swatch.h },
        { name: 'sat', type: 'int', value: swatch.s },
      ]);
    }
  }
  const columns = FLOOR_PALETTE.length + 1; // Natural + 32 swatches
  const buf = composeSheet(tiles, TILE_W, FLOOR_H, columns);
  fs.writeFileSync(path.join(OUT_PNG_DIR, 'floor.png'), buf);
  const tsj = grid(TILE_W, FLOOR_H, columns, tiles.length, 'png/floor.png', columns * TILE_W, patternCount * FLOOR_H, props, 'floor');
  fs.writeFileSync(path.join(OUT_DIR, 'floor.tsj'), JSON.stringify(tsj, null, 2) + '\n');
  console.log(`✓ floor.tsj + png/floor.png (${tiles.length} tiles, ${patternCount} patterns × ${columns} colors)`);
}

/** Tiled wangid order (JSON format): [top, topright, right, bottomright,
 *  bottom, bottomleft, left, topleft] — an "edge" Wang set only sets the 4
 *  edge slots (even indices), corners (odd) stay 0. Two Wang colors: 1 = wall
 *  present in that direction, 2 = no wall — matches buildWallMask's N=1,E=2,
 *  S=4,W=8 bitmask exactly (see shared/src/office/wallTiles.ts), so painting
 *  with this Wang set in Tiled autotiles the same way our own renderer picks
 *  pieces. NOT verified against a live Tiled instance — spot-check before
 *  relying on the autotile brush; the per-tile `bitmask` property is the
 *  actually load-bearing data for task #157's map import either way. */
function wangIdForMask(mask: number): number[] {
  const wallOrEmpty = (bit: number) => (mask & bit ? 1 : 2);
  return [wallOrEmpty(1), 0, wallOrEmpty(2), 0, wallOrEmpty(4), 0, wallOrEmpty(8), 0]; // N,_,E,_,S,_,W,_
}

function bakeWallSet(setIndex: number): void {
  const raw = parseWallPng(fs.readFileSync(path.join(ROOT, 'assets', 'walls', `wall_${setIndex}.png`)));
  // One shared brightness baseline across all 16 pieces (not per piece) —
  // see wallTiles.ts's wallSetReferenceLightness for why: pieces vary a lot
  // in how much of their area is "cap" vs "face", so recentering each
  // independently breaks the "one continuous wall" illusion at piece
  // boundaries. Must match the runtime's own reference exactly, or a tile
  // painted from this baked tileset would render a visibly different tone
  // than the same bitmask+color painted live.
  const referenceLightness = averageLightness(raw.flat());
  const tiles: SpriteData[] = [];
  const props: TiledProp[][] = [];
  for (let mask = 0; mask < 16; mask++) {
    const piece = raw[mask];
    tiles.push(piece);
    props.push([{ name: 'bitmask', type: 'int', value: mask }]);
    for (let s = 0; s < WALL_PALETTE.length; s++) {
      const swatch = WALL_PALETTE[s];
      const colorized = getColorizedSprite(`bake-wall-${setIndex}-${mask}-${swatch.h}-${swatch.s}`, piece, swatchColor(swatch), referenceLightness);
      tiles.push(colorized);
      props.push([
        { name: 'bitmask', type: 'int', value: mask },
        { name: 'hue', type: 'int', value: swatch.h },
        { name: 'sat', type: 'int', value: swatch.s },
      ]);
    }
  }
  const columns = WALL_PALETTE.length + 1; // Natural + 16 swatches
  const buf = composeSheet(tiles, TILE_W, WALL_H, columns);
  fs.writeFileSync(path.join(OUT_PNG_DIR, `wall-${setIndex}.png`), buf);
  const tsj = grid(TILE_W, WALL_H, columns, tiles.length, `png/wall-${setIndex}.png`, columns * TILE_W, 16 * WALL_H, props, `wall-${setIndex}`) as Record<string, unknown>;
  // One Wang/Terrain set PER COLOR, not one set covering all colors — a Wang
  // set's brush only knows "does this tile satisfy the required edge
  // pattern", with no notion of color at all, so a single set spanning every
  // swatch column would let the autotile brush freely substitute any
  // same-bitmask tile regardless of column, silently changing color every
  // time it paints. Splitting into 17 sets (Natural + one per swatch), each
  // covering only its own 16 bitmask tiles, means picking e.g. "Wall — #597dce"
  // as the active terrain keeps every painted piece that same color.
  const colorLabels = ['Natural', ...WALL_PALETTE.map((sw) => sw.hex)];
  tsj.wangsets = colorLabels.map((label, col) => ({
    colors: [
      { color: '#861616', name: 'wall', probability: 1, tile: -1 },
      { color: '#3a3a3a', name: 'empty', probability: 1, tile: -1 },
    ],
    name: `Wall — ${label}`,
    tile: -1,
    type: 'edge',
    wangtiles: Array.from({ length: 16 }, (_, mask) => ({
      tileid: mask * columns + col,
      wangid: wangIdForMask(mask),
    })),
  }));
  fs.writeFileSync(path.join(OUT_DIR, `wall-${setIndex}.tsj`), JSON.stringify(tsj, null, 2) + '\n');
  console.log(`✓ wall-${setIndex}.tsj + png/wall-${setIndex}.png (${tiles.length} tiles, 16 bitmasks × ${columns} colors)`);
}

fs.mkdirSync(OUT_PNG_DIR, { recursive: true });
bakeFloor();
bakeWallSet(0);
bakeWallSet(1);
