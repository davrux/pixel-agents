/**
 * Bakes the floor and wall Tiled tilesets (assets/tiled/*.png + *.tsx) from
 * our own source PNGs and the closed TILE_COLOR_PALETTE (see
 * shared/src/office/tileColorPalette.ts).
 *
 * Why this exists: our own editor/renderer tint floor/wall patterns lazily,
 * in memory, on demand (floorTiles.ts/wallTiles.ts) — but Tiled can't run
 * that code. It only ever shows real image files. So every (pattern,
 * colorIndex) / (wallSet, mask, colorIndex) combination this repo can
 * produce gets baked here, once, as an actual tileset image Tiled can open
 * directly.
 *
 * Regenerate whenever a floor/wall source PNG or TILE_COLOR_PALETTE changes:
 *   pnpm --filter @pixel/server run generate:tiled
 *
 * Output is one sprite-sheet PNG + matching .tsx (Tiled tileset XML) per
 * source: floor-tileset.{png,tsx}, wall-<N>-tileset.{png,tsx}. Each tile
 * carries custom properties (pattern/colorIndex or wallSet/mask/colorIndex)
 * so a future import script can read a placed tile's meaning directly from
 * Tiled instead of relying on its position in the sheet.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

import { decodeFloorPng, parseWallPng } from '../core/assets/pngDecoder.js';
import { colorizeToPalette } from '@pixel/shared/office/colorize.js';
import { TILE_COLOR_PALETTE } from '@pixel/shared/office/tileColorPalette.js';
import type { SpriteData } from '@pixel/shared/office/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const ASSETS_DIR = path.join(REPO_ROOT, 'assets');
const OUT_DIR = path.join(ASSETS_DIR, 'tiled');

const TILE_W = 16;
const PALETTE_SIZE = TILE_COLOR_PALETTE.length;

/** Write one sprite's pixels into a PNG's RGBA buffer at a given tile cell. */
function blitTile(png: PNG, sheetWidthPx: number, sprite: SpriteData, tileW: number, tileH: number, col: number, row: number): void {
  for (let y = 0; y < tileH; y++) {
    const spriteRow = sprite[y];
    for (let x = 0; x < tileW; x++) {
      const pixel = spriteRow?.[x] ?? '';
      const dx = col * tileW + x;
      const dy = row * tileH + y;
      const di = (dy * sheetWidthPx + dx) * 4;
      if (!pixel) {
        png.data[di + 3] = 0; // transparent
        continue;
      }
      png.data[di] = parseInt(pixel.slice(1, 3), 16);
      png.data[di + 1] = parseInt(pixel.slice(3, 5), 16);
      png.data[di + 2] = parseInt(pixel.slice(5, 7), 16);
      png.data[di + 3] = pixel.length > 7 ? parseInt(pixel.slice(7, 9), 16) : 255;
    }
  }
}

function tileProperties(props: Record<string, number>): string {
  const entries = Object.entries(props)
    .map(([name, value]) => `      <property name="${name}" type="int" value="${value}"/>`)
    .join('\n');
  return `    <properties>\n${entries}\n    </properties>`;
}

function writeTsx(filePath: string, opts: { name: string; tileW: number; tileH: number; columns: number; tileCount: number; imageFile: string; imageW: number; imageH: number; tiles: string[] }): void {
  const tsx = `<?xml version="1.0" encoding="UTF-8"?>
<tileset version="1.10" tiledversion="1.11.0" name="${opts.name}" tilewidth="${opts.tileW}" tileheight="${opts.tileH}" tilecount="${opts.tileCount}" columns="${opts.columns}">
  <image source="${opts.imageFile}" width="${opts.imageW}" height="${opts.imageH}"/>
${opts.tiles.join('\n')}
</tileset>
`;
  fs.writeFileSync(filePath, tsx);
}

function generateFloorTileset(): void {
  const floorsDir = path.join(ASSETS_DIR, 'floors');
  const patternFiles = fs
    .readdirSync(floorsDir)
    .map((f) => /^floor_(\d+)\.png$/i.exec(f))
    .filter((m): m is RegExpExecArray => !!m)
    .sort((a, b) => Number(a[1]) - Number(b[1]));
  if (patternFiles.length === 0) {
    console.log('[tiled] no floor_N.png files found, skipping floor tileset');
    return;
  }

  const cols = PALETTE_SIZE;
  const rows = patternFiles.length;
  const sheetW = cols * TILE_W;
  const sheetH = rows * TILE_W;
  const png = new PNG({ width: sheetW, height: sheetH });
  const tileEntries: string[] = [];

  patternFiles.forEach((match, patternRow) => {
    const patternNumber = patternRow + 1; // 1-based, matches tileGid.ts's floorGid(pattern, ...)
    const base = decodeFloorPng(fs.readFileSync(path.join(floorsDir, match[0])));
    TILE_COLOR_PALETTE.forEach((hex, colorIndex) => {
      const tinted = colorizeToPalette(base, hex, TILE_COLOR_PALETTE);
      blitTile(png, sheetW, tinted, TILE_W, TILE_W, colorIndex, patternRow);
      const gid = patternRow * cols + colorIndex;
      tileEntries.push(`  <tile id="${gid}">\n${tileProperties({ pattern: patternNumber, colorIndex })}\n  </tile>`);
    });
  });

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'floor-tileset.png'), PNG.sync.write(png));
  writeTsx(path.join(OUT_DIR, 'floor-tileset.tsx'), {
    name: 'Floor',
    tileW: TILE_W,
    tileH: TILE_W,
    columns: cols,
    tileCount: rows * cols,
    imageFile: 'floor-tileset.png',
    imageW: sheetW,
    imageH: sheetH,
    tiles: tileEntries,
  });
  console.log(`[tiled] floor-tileset.png: ${rows} patterns x ${cols} colors = ${rows * cols} tiles (${sheetW}x${sheetH}px)`);
}

function generateWallTilesets(): void {
  const wallsDir = path.join(ASSETS_DIR, 'walls');
  const wallFiles = fs
    .readdirSync(wallsDir)
    .map((f) => /^wall_(\d+)\.png$/i.exec(f))
    .filter((m): m is RegExpExecArray => !!m)
    .sort((a, b) => Number(a[1]) - Number(b[1]));
  if (wallFiles.length === 0) {
    console.log('[tiled] no wall_N.png files found, skipping wall tilesets');
    return;
  }

  const cols = PALETTE_SIZE;
  fs.mkdirSync(OUT_DIR, { recursive: true });

  for (const match of wallFiles) {
    const setIndex = Number(match[1]);
    const pieces = parseWallPng(fs.readFileSync(path.join(wallsDir, match[0]))); // 16 sprites, 16x32 each
    const rows = pieces.length;
    const tileH = pieces[0]?.length ?? 32;
    const sheetW = cols * TILE_W;
    const sheetH = rows * tileH;
    const png = new PNG({ width: sheetW, height: sheetH });
    const tileEntries: string[] = [];

    pieces.forEach((piece, mask) => {
      TILE_COLOR_PALETTE.forEach((hex, colorIndex) => {
        const tinted = colorizeToPalette(piece, hex, TILE_COLOR_PALETTE);
        blitTile(png, sheetW, tinted, TILE_W, tileH, colorIndex, mask);
        const gid = mask * cols + colorIndex;
        tileEntries.push(`  <tile id="${gid}">\n${tileProperties({ wallSet: setIndex, mask, colorIndex })}\n  </tile>`);
      });
    });

    const imageFile = `wall-${setIndex}-tileset.png`;
    fs.writeFileSync(path.join(OUT_DIR, imageFile), PNG.sync.write(png));
    writeTsx(path.join(OUT_DIR, `wall-${setIndex}-tileset.tsx`), {
      name: `Wall ${setIndex}`,
      tileW: TILE_W,
      tileH,
      columns: cols,
      tileCount: rows * cols,
      imageFile,
      imageW: sheetW,
      imageH: sheetH,
      tiles: tileEntries,
    });
    console.log(`[tiled] ${imageFile}: ${rows} masks x ${cols} colors = ${rows * cols} tiles (${sheetW}x${sheetH}px)`);
  }
}

generateFloorTileset();
generateWallTilesets();
console.log(`[tiled] done -> ${path.relative(REPO_ROOT, OUT_DIR)}`);
