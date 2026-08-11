/**
 * Loads the pre-baked, closed-palette floor/wall sprite sheets Tiled itself
 * paints from (assets/tiled/png/floor.png, wall-0.png, wall-1.png — see
 * server/scripts/bake-floor-wall-tiled.mts), once via plain HTTP, and slices
 * them into per-(pattern|bitmask, swatch) SpriteData for floorTiles.ts /
 * wallTiles.ts. Replaces the old floorTilesLoaded/wallTilesLoaded Colyseus
 * messages — no more live per-pixel colorize (see
 * docs/design/tiled-editor-integration.md).
 */
import { setFloorSheets } from '@pixel/shared/office/floorTiles.js';
import { setWallSheets } from '@pixel/shared/office/wallTiles.js';
import {
  FLOOR_TILE_H,
  FLOOR_TILE_W,
  TILED_SHEET_COLUMNS,
  WALL_BITMASK_COUNT,
  WALL_TILE_H,
  WALL_TILE_W,
} from '@pixel/shared/office/tiledSheetLayout.js';
import type { SpriteData } from '@pixel/shared/office/types.js';

import { serverHttpOrigin } from './room.js';

function hex2(n: number): string {
  return n.toString(16).padStart(2, '0');
}

/** Fetch a PNG (not an <img> src) so decoding never taints the canvas
 *  regardless of cross-origin CORS headers (Vite dev serves the client on a
 *  different port than the game server — see serverHttpOrigin). */
async function fetchBitmap(url: string): Promise<ImageBitmap> {
  const res = await fetch(url, { cache: 'force-cache' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return createImageBitmap(await res.blob());
}

/** Slice one baked sheet into `rows` groups of TILED_SHEET_COLUMNS tiles
 *  each, tileW×tileH — mirrors bake-floor-wall-tiled.mts's composeSheet
 *  layout exactly (flat index i → col = i % columns, row = floor(i / columns)). */
function sliceSheet(bitmap: ImageBitmap, tileW: number, tileH: number, rows: number): SpriteData[][] {
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(bitmap, 0, 0);

  const out: SpriteData[][] = [];
  for (let row = 0; row < rows; row++) {
    const group: SpriteData[] = [];
    for (let col = 0; col < TILED_SHEET_COLUMNS; col++) {
      const { data } = ctx.getImageData(col * tileW, row * tileH, tileW, tileH);
      const sprite: SpriteData = [];
      for (let y = 0; y < tileH; y++) {
        const line: string[] = [];
        for (let x = 0; x < tileW; x++) {
          const i = (y * tileW + x) * 4;
          const a = data[i + 3];
          if (a === 0) line.push('');
          else {
            const base = `#${hex2(data[i])}${hex2(data[i + 1])}${hex2(data[i + 2])}`;
            line.push(a === 255 ? base : base + hex2(a));
          }
        }
        sprite.push(line);
      }
      group.push(sprite);
    }
    out.push(group);
  }
  return out;
}

/** Fetch + slice the baked floor/wall sheets and populate floorTiles.ts /
 *  wallTiles.ts. Safe to call once at scene start; a failure is logged and
 *  leaves floor/wall rendering at their "not loaded yet" fallback (flat fill). */
export async function loadTiledSheets(): Promise<void> {
  try {
    const base = `${serverHttpOrigin()}/assets/tiled/png`;
    const [floorBitmap, wall0Bitmap, wall1Bitmap] = await Promise.all([
      fetchBitmap(`${base}/floor.png`),
      fetchBitmap(`${base}/wall-0.png`),
      fetchBitmap(`${base}/wall-1.png`),
    ]);
    const floorRows = Math.round(floorBitmap.height / FLOOR_TILE_H);
    setFloorSheets(sliceSheet(floorBitmap, FLOOR_TILE_W, FLOOR_TILE_H, floorRows));
    setWallSheets([
      sliceSheet(wall0Bitmap, WALL_TILE_W, WALL_TILE_H, WALL_BITMASK_COUNT),
      sliceSheet(wall1Bitmap, WALL_TILE_W, WALL_TILE_H, WALL_BITMASK_COUNT),
    ]);
  } catch (err) {
    console.warn('[tiledSheets] failed to load baked floor/wall sheets:', err instanceof Error ? err.message : err);
  }
}
