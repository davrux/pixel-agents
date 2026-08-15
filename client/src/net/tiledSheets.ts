/**
 * Loads the pre-baked, closed-palette floor/wall sprite sheets Tiled itself
 * paints from (assets/tiled/png/<set>.png, the sets listed by sets.json
 * — see server/scripts/bake-floor-wall-tiled.mts), once via plain HTTP, and
 * slices them into per-(set, pattern|bitmask, swatch) SpriteData for
 * floorTiles.ts / wallTiles.ts. Replaces the old floorTilesLoaded/
 * wallTilesLoaded Colyseus messages — no more live per-pixel colorize (see
 * docs/design.md).
 */
import { setFloorSheets } from '@pixel/shared/office/floorTiles.js';
import { setWallSheets } from '@pixel/shared/office/wallTiles.js';
import {
  FLOOR_TILE_H,
  FLOOR_TILE_W,
  TILED_SHEET_COLUMNS,
  WALL_BITMASK_COUNT,
  WALL_TILE_H,
  WALL_TILE_SPACING,
  WALL_TILE_W,
} from '@pixel/shared/office/tiledSheetLayout.js';
import type { SpriteData } from '@pixel/shared/office/types.js';

import { serverHttpOrigin } from './room.js';

function hex2(n: number): string {
  return n.toString(16).padStart(2, '0');
}

/** Fetch a PNG (not an <img> src) so decoding never taints the canvas
 *  regardless of cross-origin CORS headers (Vite dev serves the client on a
 *  different port than the game server — see serverHttpOrigin). Default
 *  cache mode (NOT 'force-cache'): the server sends `Cache-Control:
 *  max-age=0` plus a strong ETag/Last-Modified specifically so a re-baked
 *  sheet (see bake-floor-wall-tiled.mts) is always revalidated — a cheap 304
 *  when unchanged, fresh bytes immediately when it isn't. 'force-cache'
 *  skips that revalidation entirely and keeps serving whatever's already in
 *  the browser's cache even after the file on disk changed, silently
 *  misaligning every tile the next time the sheet's layout changes (as
 *  happened when WALL_TILE_SPACING was introduced). */
async function fetchBitmap(url: string): Promise<ImageBitmap> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return createImageBitmap(await res.blob());
}

/** Slice one baked sheet into `rows` groups of TILED_SHEET_COLUMNS tiles
 *  each, tileW×tileH — mirrors bake-floor-wall-tiled.mts's composeSheet
 *  layout exactly (flat index i → col = i % columns, row = floor(i / columns)),
 *  including its `spacing` transparent px between tiles (0 for floor sheets,
 *  WALL_TILE_SPACING for wall sheets — see tiledSheetLayout.ts). */
function sliceSheet(bitmap: ImageBitmap, tileW: number, tileH: number, rows: number, spacing = 0): SpriteData[][] {
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
      const { data } = ctx.getImageData(col * (tileW + spacing), row * (tileH + spacing), tileW, tileH);
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
    const origin = serverHttpOrigin();
    const base = `${origin}/assets/tiled/png`;
    // Which sets exist comes from the server, which reads it off disk — no list
    // of filenames in the client bundle, so adding or renaming a tileset needs
    // no client release (see tiledSheetLayout.ts for what the old constants
    // cost). A layout names the sets it uses; these names are the keys.
    const setsRes = await fetch(`${origin}/assets/tiled/sets.json`);
    if (!setsRes.ok) throw new Error(`sets.json: HTTP ${setsRes.status}`);
    const sets = (await setsRes.json()) as { floor?: string[]; wall?: string[] };
    const floorNames = sets.floor ?? [];
    const wallNames = sets.wall ?? [];
    const [floorBitmaps, wallBitmaps] = await Promise.all([
      Promise.all(floorNames.map((f) => fetchBitmap(`${base}/${f}.png`))),
      Promise.all(wallNames.map((f) => fetchBitmap(`${base}/${f}.png`))),
    ]);
    // Each floor set can have a different pattern (row) count — e.g.
    // floor-warm has one warm-only pattern the base "floor" set doesn't.
    setFloorSheets(
      Object.fromEntries(
        floorBitmaps.map((bitmap, i) => [
          floorNames[i],
          sliceSheet(bitmap, FLOOR_TILE_W, FLOOR_TILE_H, Math.round(bitmap.height / FLOOR_TILE_H)),
        ]),
      ),
    );
    // Row count per wall set comes from the sheet itself, same as floors above:
    // a set may carry extra hand-painted-only pieces after the 16 adjacency
    // ones (the metro set's north-wall faces — see
    // server/src/core/assets/pngDecoder.ts's parseWallPng).
    setWallSheets(
      Object.fromEntries(
        wallBitmaps.map((bitmap, i) => [
          wallNames[i],
          sliceSheet(
            bitmap,
            WALL_TILE_W,
            WALL_TILE_H,
            Math.round((bitmap.height + WALL_TILE_SPACING) / (WALL_TILE_H + WALL_TILE_SPACING)),
            WALL_TILE_SPACING,
          ),
        ]),
      ),
    );
  } catch (err) {
    console.warn('[tiledSheets] failed to load baked floor/wall sheets:', err instanceof Error ? err.message : err);
  }
}
