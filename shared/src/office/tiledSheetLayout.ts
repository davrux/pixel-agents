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
