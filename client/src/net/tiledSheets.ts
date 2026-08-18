/**
 * Loads the pre-baked, closed-palette floor/wall sprite sheets Tiled itself
 * paints from (assets/tiled/png/<set>.png, the sets listed by sets.json
 * — see server/scripts/bake-floor-wall-tiled.mts), once via plain HTTP, and
 * registers them as textures the renderer draws frames out of. Replaces the old
 * floorTilesLoaded/wallTilesLoaded Colyseus messages — no more live per-pixel
 * colorize (see docs/design.md).
 */
import { setFloorSheetInfo } from '@pixel/shared/office/floorTiles.js';
import { setWallSheetInfo } from '@pixel/shared/office/wallTiles.js';
import {
  FLOOR_TILE_H,
  FLOOR_TILE_SPACING,
  WALL_TILE_H,
  WALL_TILE_SPACING,
} from '@pixel/shared/office/tiledSheetLayout.js';

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

/**
 * Fetch the baked floor/wall sheets and register which sets exist.
 *
 * Returns the decoded bitmaps for the renderer to keep as textures — one per
 * sheet, drawn from by frame (see render/sprites.ts's registerSheetTexture).
 * They used to be sliced here into SpriteData, which re-encoded 533 KB of
 * already-decoded PNG into ~34 MB of hex strings only to upload it cell by cell.
 *
 * Safe to call once at scene start; a failure is logged and leaves floor/wall
 * rendering at their "not loaded yet" fallback (a flat fill).
 */
export async function loadTiledSheets(): Promise<Array<{ name: string; bitmap: ImageBitmap }>> {
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
    // Each floor set can have a different pattern (row) count — e.g. a set with
    // one extra pattern the base "floor" set doesn't have. Read off the sheet's
    // own height, so adding a pattern needs no code change.
    setFloorSheetInfo(
      Object.fromEntries(
        floorBitmaps.map((b, i) => [
          floorNames[i],
          Math.round((b.height + FLOOR_TILE_SPACING) / (FLOOR_TILE_H + FLOOR_TILE_SPACING)),
        ]),
      ),
    );
    // Piece count per wall set likewise: a set may carry extra hand-painted-only
    // pieces after the 16 adjacency ones (the metro sets' north-wall faces — see
    // server/src/core/assets/pngDecoder.ts's parseWallPng).
    setWallSheetInfo(
      Object.fromEntries(
        wallBitmaps.map((b, i) => [
          wallNames[i],
          Math.round((b.height + WALL_TILE_SPACING) / (WALL_TILE_H + WALL_TILE_SPACING)),
        ]),
      ),
    );
    return [
      ...floorNames.map((name, i) => ({ name, bitmap: floorBitmaps[i] })),
      ...wallNames.map((name, i) => ({ name, bitmap: wallBitmaps[i] })),
    ];
  } catch (err) {
    console.warn('[tiledSheets] failed to load baked floor/wall sheets:', err instanceof Error ? err.message : err);
    return [];
  }
}
