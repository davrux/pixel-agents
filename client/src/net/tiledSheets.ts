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

/** The furniture/decal atlas manifest — see server/scripts/bake-furniture-atlas.mts.
 *  Rects, not a grid: the art has mixed sizes, so a cell formula cannot describe
 *  it and the packer writes down where each id landed. */
export interface AtlasManifest {
  image: string;
  width: number;
  height: number;
  gap: number;
  extrude: number;
  frames: Record<string, { x: number; y: number; w: number; h: number }>;
}

/**
 * Fetch the baked collection-art atlas: one PNG plus the manifest saying where
 * each catalog id sits in it.
 *
 * Over HTTP, cached and revalidated with an ETag, because this art never changes
 * — unlike the catalog MESSAGE it will replace, which re-sends the same pixels on
 * every join and is what put that message at 7.6 MB. Returns null when either
 * half is missing or unreadable, and the caller then simply keeps using the
 * sprites the message carries: this is a faster path, never the only one.
 */
export async function loadFurnitureAtlas(): Promise<{ bitmap: ImageBitmap; manifest: AtlasManifest } | null> {
  try {
    const base = `${serverHttpOrigin()}/assets/tiled/png`;
    const res = await fetch(`${base}/atlas-furniture.json`);
    if (!res.ok) throw new Error(`atlas-furniture.json: HTTP ${res.status}`);
    const manifest = (await res.json()) as AtlasManifest;
    if (!manifest?.frames || Object.keys(manifest.frames).length === 0) throw new Error('manifest has no frames');
    const bitmap = await fetchBitmap(`${base}/${manifest.image.replace(/^png\//, '')}`);
    if (bitmap.width !== manifest.width || bitmap.height !== manifest.height) {
      // A manifest and an atlas from different bakes would draw the wrong art with
      // complete confidence, so they are checked against each other rather than
      // trusted to match.
      throw new Error(`atlas is ${bitmap.width}×${bitmap.height}, manifest says ${manifest.width}×${manifest.height}`);
    }
    return { bitmap, manifest };
  } catch (err) {
    console.warn('[tiledSheets] no furniture atlas, using the sprites from the catalog message:', err instanceof Error ? err.message : err);
    return null;
  }
}

/** One entry of sets.json: a sheet's name plus its own grid geometry. */
interface SheetInfo {
  name: string;
  columns: number;
  spacing: number;
}

/** A fetched sheet, ready for the renderer to keep as a texture. `spacing` travels
 *  with it because a frame's rect depends on it (see render/sprites.ts). */
export interface LoadedSheet {
  name: string;
  bitmap: ImageBitmap;
  spacing: number;
}

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
export async function loadTiledSheets(): Promise<LoadedSheet[]> {
  try {
    const origin = serverHttpOrigin();
    const base = `${origin}/assets/tiled/png`;
    // Which sets exist comes from the server, which reads it off disk — no list
    // of filenames in the client bundle, so adding or renaming a tileset needs
    // no client release (see tiledSheetLayout.ts for what the old constants
    // cost). A layout names the sets it uses; these names are the keys.
    const setsRes = await fetch(`${origin}/assets/tiled/sets.json`);
    if (!setsRes.ok) throw new Error(`sets.json: HTTP ${setsRes.status}`);
    // Each set arrives with its own grid geometry, not just a name: the column
    // count and the baked gap are PER SET (a natural-only set like
    // floor-overworld has one column, a palette bake 65), and reading them off
    // the .tsj — which is what the server does here — is what keeps a re-baked
    // sheet and this reader from ever disagreeing.
    const sets = (await setsRes.json()) as { floor?: SheetInfo[]; wall?: SheetInfo[] };
    const floors = sets.floor ?? [];
    const walls = sets.wall ?? [];
    const [floorBitmaps, wallBitmaps] = await Promise.all([
      Promise.all(floors.map((f) => fetchBitmap(`${base}/${f.name}.png`))),
      Promise.all(walls.map((f) => fetchBitmap(`${base}/${f.name}.png`))),
    ]);
    // Row count per set comes from the sheet's own height, so adding a floor
    // pattern or an extra hand-painted wall piece needs no code change. A wall set
    // may carry pieces past the 16 adjacency ones (the metro sets' north-wall
    // faces — see server/src/core/assets/pngDecoder.ts's parseWallPng).
    const rowsOf = (bitmap: ImageBitmap, tileH: number, spacing: number) =>
      Math.round((bitmap.height + spacing) / (tileH + spacing));
    setFloorSheetInfo(
      Object.fromEntries(floors.map((f, i) => [f.name, rowsOf(floorBitmaps[i], FLOOR_TILE_H, f.spacing)])),
    );
    setWallSheetInfo(
      Object.fromEntries(walls.map((f, i) => [f.name, rowsOf(wallBitmaps[i], WALL_TILE_H, f.spacing)])),
    );
    return [
      ...floors.map((f, i) => ({ name: f.name, bitmap: floorBitmaps[i], spacing: f.spacing })),
      ...walls.map((f, i) => ({ name: f.name, bitmap: wallBitmaps[i], spacing: f.spacing })),
    ];
  } catch (err) {
    console.warn('[tiledSheets] failed to load baked floor/wall sheets:', err instanceof Error ? err.message : err);
    return [];
  }
}
