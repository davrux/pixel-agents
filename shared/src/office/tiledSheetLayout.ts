/**
 * Grid layout of the pre-baked Tiled floor/wall sprite sheets
 * (assets/tiled/png/floor-*.png, wall-metro-*.png — see
 * server/scripts/bake-floor-wall-tiled.mts). One shared source so the bake
 * script and the client's sheet loader (client/src/net/tiledSheets.ts) can
 * never disagree on how a flat tile index maps to (pattern|bitmask, swatch).
 *
 * Columns: index 0 = "Natural" (raw, uncolorized), 1+i = the set's own
 * palette[i] colorized (which palette that is per set: see palettes.ts's
 * FLOOR_SET_PALETTES/WALL_SET_PALETTES — every palette is 64 colors, so the
 * column count is the same for all of them). Rows: one per floor pattern, or
 * one per wall piece.
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

/** One entry per floor "set" — index = OfficeLayout.tileFloorSet, matching
 *  a <name>.tsj / png/<name>.png pair (server/scripts/bake-floor-wall-tiled.mts
 *  writes these; client/src/net/tiledSheets.ts fetches them in this exact
 *  order). Each set is named after its own art plus the palette it bakes
 *  against: 'floor-*' is this project's original 11 hand-drawn patterns,
 *  'floor-metro-*' an unrelated set of 7 patterns (tile grid, wood, decking)
 *  derived from the MetroCity Interior pack (see
 *  server/scripts/gen-metro-source-art.mts) — not a recolor of the others.
 *  '-resurrect64' is Kerrie Lake's "Resurrect 64"
 *  (lospec.com/palette-list/resurrect-64), '-endesga' is Endesga's "Endesga 64"
 *  (lospec.com/palette-list/endesga-64), both verified hex-for-hex — see
 *  palettes.ts.
 *
 *  APPEND ONLY: a saved layout stores this index in tileFloorSet, so
 *  reordering silently restyles every existing floor tile. */
export const FLOOR_SET_FILES = [
  'floor-resurrect64',
  'floor-metro-resurrect64',
  'floor-endesga',
  'floor-metro-endesga',
];

/** One entry per wall "set" — index = WallEdges.latticeSet, matching a
 *  wall-<name>.tsj / png/wall-<name>.png pair. Both sets are the same
 *  thin-wall art baked against a different palette (same '-resurrect64' /
 *  '-endesga' naming as FLOOR_SET_FILES above): a 6px strip inside its cell
 *  rather than art filling the whole tile, so they only read correctly where
 *  they sit on the cell boundaries with floor on both sides (see
 *  OfficeLayout.walls).
 *  Synthesized from the MetroCity Interior pack's own wall cross-sections, and
 *  the only sets with more than 16 pieces — 4 north-wall face pieces follow the
 *  bitmask ones. See server/scripts/gen-metro-source-art.mts.
 *
 *  APPEND ONLY: a saved layout stores this index in WallEdges.latticeSet, so
 *  reordering silently restyles every existing wall. */
export const WALL_SET_FILES = ['wall-metro-resurrect64', 'wall-metro-endesga'];
