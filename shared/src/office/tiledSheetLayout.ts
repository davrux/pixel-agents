/**
 * Grid layout of the pre-baked Tiled floor/wall sprite sheets
 * (assets/tiled/png/floor-*.png, wall-metro-*.png — see
 * server/scripts/bake-floor-wall-tiled.mts). One shared source so the bake
 * script and the client's sheet loader (client/src/net/tiledSheets.ts) can
 * never disagree on how a flat tile index maps to (pattern|bitmask, swatch).
 *
 * Columns: index 0 = "Natural" (raw, uncolorized), 1+i = the set's own
 * palette[i] colorized. The column count is PER SET — the palette sets have
 * TILED_SHEET_COLUMNS (Natural + 64 swatches), a natural-only set (imported
 * art keeping its own colors, e.g. floor-overworld) has exactly 1 — and each
 * consumer reads it off the artifact itself: the client from the sheet's
 * pixel width, the map bridge from the .tsj's own `columns`. Rows: one per
 * floor pattern, or one per wall piece.
 *
 * A wall set's row count is NOT fixed: rows 0-15 are always the adjacency
 * bitmask pieces, but a set may carry extra hand-painted-only pieces after
 * them (the metro sets' north-wall faces). Both the bake script and the
 * client's slicer derive the count from the sheet's own height — see
 * server/src/core/assets/pngDecoder.ts's parseWallPng.
 */
import { TILE_SIZE } from './constants.js';
import { PALETTE_64 } from './palettes.js';

export const TILED_SHEET_COLUMNS = PALETTE_64.length + 1;
export const FLOOR_TILE_W = TILE_SIZE;
export const FLOOR_TILE_H = TILE_SIZE;
export const WALL_TILE_W = TILE_SIZE;
export const WALL_TILE_H = 32;
/** How many of a wall set's pieces are the adjacency autotile ones (N=1, E=2,
 *  S=4, W=8 — see wallEdges.ts's latticeMask). Always the FIRST 16 rows of
 *  every set; a set's total row count can be larger, see the header comment. */
export const WALL_BITMASK_COUNT = 16;
/** Transparent gap (px) baked between adjacent wall tiles in the sheet image
 *  — wall art often runs edge-to-edge to its own tile boundary, so with zero
 *  gap neighboring bitmask variants visually blend together in Tiled's
 *  Tilesets panel. Purely a sheet-layout spacer: doesn't change which GID
 *  maps to which (bitmask, swatch) — see rowAndSwatchFromLocalId — only
 *  where that tile sits in pixels, which both the bake script and the
 *  client's sheet slicer must agree on. Floor tiles don't have this
 *  ambiguity (no directional edges to confuse), so they stay at 0 gap. */
export const WALL_TILE_SPACING = 6;

/**
 * There is deliberately no list of tileset filenames here any more.
 *
 * FLOOR_SET_FILES / WALL_SET_FILES used to enumerate them, and a saved layout
 * stored a position in those arrays — so the arrays were the identity of a floor
 * or wall set. Renaming a tileset broke every map using it, and reordering the
 * array restyled every map silently. The server now discovers them from disk by
 * the tiles' own Tiled class (isFurnitureTileset's floor/wall counterparts in
 * tiled/tiledRegistry.ts), a layout names the sets it uses (OfficeLayout.
 * floorSets / wallSets), and the client asks the server what exists.
 */
