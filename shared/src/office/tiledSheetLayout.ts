/**
 * Grid layout of the pre-baked Tiled floor/wall sprite sheets
 * (assets/tiled/png/floor-resurrect64.png, wall-0-resurrect64.png,
 * wall-1-resurrect64.png, plus their -warm counterparts — see
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
 *  S=4, W=8 — see wallTiles.ts's buildWallMask). Always the FIRST 16 rows of
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
 *  order). The regular set is named after its actual source palette (see
 *  palettes.ts's PALETTE_64 — Kerrie Lake's "Resurrect 64",
 *  lospec.com/palette-list/resurrect-64, verified hex-for-hex against the
 *  published palette); the warm set keeps its plain "-warm" name since
 *  WARM_PALETTE_64 isn't a published/named palette, just generated for this
 *  project. 'floor-warm' shares the same 11 base patterns as the regular set
 *  (plus one warm-only pattern, wood planks) — see FLOOR_SET_PALETTES.
 *  'floor-metro-*' is an unrelated set of its own 7 patterns (tile grid, wood,
 *  decking) derived from the MetroCity Interior pack, not a recolor of the base
 *  patterns — see server/scripts/gen-metro-source-art.mts.
 *
 *  The '-endesga' pairs bake the same two pattern lists against Endesga's
 *  "Endesga 64" (see palettes.ts's ENDESGA_PALETTE_64) — its neutral-heavy
 *  ramps suit the near-greyscale metro textures better than the other two
 *  palettes, which push everything toward a hue.
 *
 *  APPEND ONLY: a saved layout stores this index in tileFloorSet, so
 *  reordering silently restyles every existing floor tile. */
export const FLOOR_SET_FILES = [
  'floor-resurrect64',
  'floor-warm',
  'floor-metro-resurrect64',
  'floor-endesga',
  'floor-metro-endesga',
];

/** One entry per wall "set" — index = OfficeLayout.tileWallSet, matching a
 *  wall-<name>.tsj / png/wall-<name>.png pair. Sets 2/3 share the same
 *  source art as sets 0/1 respectively, just baked with a different
 *  palette (see palettes.ts's WALL_SET_PALETTES) — a deliberate style+color
 *  pairing, not a naming coincidence. Same resurrect64/warm naming as
 *  FLOOR_SET_FILES above.
 *
 *  The two 'wall-metro-*' sets (same art, different palette) are the thin-wall
 *  style: a 6px strip centered in its cell instead of art filling the whole
 *  tile, so they only read correctly where floor is drawn beneath the wall.
 *  Their art is synthesized from the MetroCity Interior pack's own wall
 *  cross-sections, and they are the only sets with more than 16 pieces — 4
 *  north-wall face pieces follow the bitmask ones. See
 *  server/scripts/gen-metro-source-art.mts.
 *
 *  APPEND ONLY: a saved layout stores this index in tileWallSet, so
 *  reordering silently restyles every existing wall tile. */
export const WALL_SET_FILES = [
  'wall-0-resurrect64',
  'wall-1-resurrect64',
  'wall-0-warm',
  'wall-1-warm',
  'wall-metro-resurrect64',
  'wall-metro-endesga',
];
