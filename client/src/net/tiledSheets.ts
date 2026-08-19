/**
 * Loads the pre-baked, closed-palette floor/wall sprite sheets Tiled itself
 * paints from (assets/tiled/png/baked/<set>.png, the sets listed by sets.json
 * — see server/scripts/bake-floor-wall-tiled.mts), once via plain HTTP, and
 * registers them as textures the renderer draws frames out of. Replaces the old
 * floorTilesLoaded/wallTilesLoaded Colyseus messages — no more live per-pixel
 * colorize (see docs/design.md).
 */
import {
  FLOOR_TILE_H,
  FLOOR_TILE_W,
  setSheetGrids,
  FLOOR_TILE_SPACING,
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
    const origin = serverHttpOrigin();
    // Where the atlas is comes from the server (sets.json), and the image it
    // points at comes from the manifest — no path spelled out here.
    const manifestRel = (await sheetPaths(origin)).atlas || 'png/baked/atlas-furniture.json';
    const res = await fetch(`${origin}/assets/tiled/${manifestRel}`);
    if (!res.ok) throw new Error(`${manifestRel}: HTTP ${res.status}`);
    const manifest = (await res.json()) as AtlasManifest;
    if (!manifest?.frames || Object.keys(manifest.frames).length === 0) throw new Error('manifest has no frames');
    const bitmap = await fetchBitmap(`${origin}/assets/tiled/${manifest.image}`);
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
  /** Where the sheet's PNG is, relative to assets/tiled — the tileset's own
   *  `image`, passed through by the server. Not built from `name` here: that
   *  turned a file move into a client release. */
  img?: string;
  /** One cell's size, from the tileset's own tilewidth/tileheight. This replaced a
   *  'floor' | 'wall' kind: how tall a cell is was never a classification, it is a
   *  measurement the artifact states. */
  tileWidth?: number;
  tileHeight?: number;
}

interface SetsJson {
  /** Every grid tileset the server has — ground may come from any of them. */
  sheets?: SheetInfo[];
  /** Where the furniture atlas's manifest is, relative to assets/tiled. */
  atlas?: string;
}

/** sets.json, fetched once and shared: both loaders here need it, and it is the
 *  one place that says where any of this art lives. A failed fetch is not cached,
 *  so a later call may try again. */
let setsPromise: Promise<SetsJson> | null = null;
function sheetPaths(origin: string): Promise<SetsJson> {
  setsPromise ??= fetch(`${origin}/assets/tiled/sets.json`)
    .then((r) => {
      if (!r.ok) throw new Error(`sets.json: HTTP ${r.status}`);
      return r.json() as Promise<SetsJson>;
    })
    .catch((err) => {
      setsPromise = null;
      throw err;
    });
  return setsPromise;
}

/** A fetched sheet, ready for the renderer to keep as a texture. `spacing` travels
 *  with it because a frame's rect depends on it (see render/sprites.ts). */
export interface LoadedSheet {
  name: string;
  bitmap: ImageBitmap;
  spacing: number;
  /** One cell's size, so the renderer can cut frames without knowing what kind of
   *  sheet this is (see SheetCellRef). */
  tileW: number;
  tileH: number;
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
export async function loadTiledSheets(wanted?: Iterable<string>): Promise<LoadedSheet[]> {
  try {
    const origin = serverHttpOrigin();
    // Which sheets exist comes from the server, which reads it off disk — no list of
    // filenames in the client bundle, so adding or renaming a tileset needs no client
    // release (see tiledSheetLayout.ts for what the old constants cost).
    const sets = await sheetPaths(origin);
    const all = sets.sheets ?? [];
    // Only the sets a map NAMES, when the caller knows them. A ground or wall cell can
    // only refer to a set the layout lists (see OfficeLayout.floorSets/wallSets), and
    // everything else — decal and furniture art — arrives through the atlas or its own
    // ref image. Fetching all of them meant this zone also downloaded the palette it
    // does not use, the roads it has not painted and the collision marker nothing ever
    // draws: 177 KB of 774 KB here, and one more sheet with every pack imported.
    const names = wanted ? new Set(wanted) : null;
    const sheets = names ? all.filter((f) => names.has(f.name)) : all;
    if (names) {
      const missing = [...names].filter((n) => !all.some((f) => f.name === n));
      if (missing.length) console.warn(`[tiledSheets] this build has no tileset named ${missing.join(', ')} — those cells stay blank`);
    }
    const bitmaps = await Promise.all(
      sheets.map((f) => fetchBitmap(`${origin}/assets/tiled/${f.img || `png/baked/${f.name}.png`}`)),
    );
    // Row count per set comes from the sheet's own height, so adding a floor pattern or
    // an extra hand-painted wall piece needs no code change. A wall set may carry
    // pieces past the 16 adjacency ones (the metro sets' north-wall faces — see
    // server/src/core/assets/pngDecoder.ts's parseWallPng).
    setSheetGrids(
      Object.fromEntries(
        sheets.map((f, i) => {
          const tileW = f.tileWidth || FLOOR_TILE_W;
          const tileH = f.tileHeight || FLOOR_TILE_H;
          return [f.name, { columns: f.columns, rows: Math.round((bitmaps[i].height + f.spacing) / (tileH + f.spacing)), tileW, tileH }];
        }),
      ),
    );
    return sheets.map((f, i) => ({
      name: f.name,
      bitmap: bitmaps[i],
      spacing: f.spacing,
      tileW: f.tileWidth || FLOOR_TILE_W,
      tileH: f.tileHeight || FLOOR_TILE_H,
    }));
  } catch (err) {
    console.warn('[tiledSheets] failed to load the tileset sheets:', err instanceof Error ? err.message : err);
    return [];
  }
}
