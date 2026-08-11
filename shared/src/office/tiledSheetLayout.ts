/**
 * Grid layout of the pre-baked Tiled floor/wall sprite sheets
 * (assets/tiled/png/floor.png, wall-0.png, wall-1.png — see
 * server/scripts/bake-floor-wall-tiled.mts). One shared source so the bake
 * script and the client's sheet loader (client/src/net/tiledSheets.ts) can
 * never disagree on how a flat tile index maps to (pattern|bitmask, swatch).
 *
 * Columns: index 0 = "Natural" (raw, uncolorized), 1+i = PALETTE_64[i]
 * colorized. Rows: one per floor pattern, or one per wall bitmask (0-15).
 */
import { TILE_SIZE } from './constants.js';
import { PALETTE_64 } from './palettes.js';

export const TILED_SHEET_COLUMNS = PALETTE_64.length + 1;
export const FLOOR_TILE_W = TILE_SIZE;
export const FLOOR_TILE_H = TILE_SIZE;
export const WALL_TILE_W = TILE_SIZE;
export const WALL_TILE_H = 32;
export const WALL_BITMASK_COUNT = 16;

/** One entry per floor "set" — index = OfficeLayout.tileFloorSet, matching
 *  a <name>.tsj / png/<name>.png pair (server/scripts/bake-floor-wall-tiled.mts
 *  writes these; client/src/net/tiledSheets.ts fetches them in this exact
 *  order). 'floor-warm' shares the same 11 base patterns as 'floor' (plus
 *  one warm-only pattern, wood planks) — see palettes.ts's FLOOR_SET_PALETTES. */
export const FLOOR_SET_FILES = ['floor', 'floor-warm'];

/** One entry per wall "set" — index = OfficeLayout.tileWallSet, matching a
 *  wall-<name>.tsj / png/wall-<name>.png pair. Sets 2/3 share the same
 *  source art as sets 0/1 respectively, just baked with a different
 *  palette (see palettes.ts's WALL_SET_PALETTES) — a deliberate style+color
 *  pairing, not a naming coincidence. */
export const WALL_SET_FILES = ['wall-0', 'wall-1', 'wall-0-warm', 'wall-1-warm'];
