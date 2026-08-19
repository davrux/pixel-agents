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

/**
 * The grid of every sheet that loaded, keyed by the sheet's NAME.
 *
 * One table for ground and walls alike, because a sheet cell is a sheet cell: the
 * cell size comes from the TILESET (its `tilewidth`/`tileheight`, passed through
 * sets.json), which is what let the FloorTile and WallTile classes go. They only
 * ever answered "how tall is a cell here", and a class is a poor place to keep a
 * measurement the artifact already states.
 *
 * Keyed by name rather than by a position in a list — see floorTiles.ts for what
 * that positional index cost when a tileset was renamed or merely reordered.
 */
export interface SheetGrid {
  columns: number;
  rows: number;
  /** One cell's size in px — 16×16 for ground art, taller for wall pieces. */
  tileW: number;
  tileH: number;
}
let grids: Record<string, SheetGrid> = {};

/** Register the sheets that loaded (client/src/net/tiledSheets.ts does this once). */
export function setSheetGrids(next: Record<string, SheetGrid>): void {
  grids = next;
}

/** A sheet's grid, or undefined if this build never loaded it — a map naming a
 *  tileset that is gone. Callers answer that with "cannot draw", never with a
 *  substitute sheet: the same id in another sheet is unrelated art. */
export function sheetGrid(name: string | undefined): SheetGrid | undefined {
  return name === undefined ? undefined : grids[name];
}

/** Have any sheets loaded yet? Before that the renderer has nothing to draw
 *  ground or walls from and falls back to its flat fill. */
export function hasSheets(): boolean {
  return Object.keys(grids).length > 0;
}

export const TILED_SHEET_COLUMNS = PALETTE_64.length + 1;
/** The sizes the BAKE cuts its sheets to. Read at render time from the sheet's own
 *  grid instead (see SheetGrid) — these stay because the bake has to choose a
 *  height for a wall piece, and 32 is that choice. WALL_TILE_W is gone with the
 *  floor/wall distinction in SheetCellRef: a cell's width is the map cell's. */
export const FLOOR_TILE_W = TILE_SIZE;
export const FLOOR_TILE_H = TILE_SIZE;
export const WALL_TILE_H = 32;
/** How many of a wall set's pieces are the adjacency autotile ones (N=1, E=2,
 *  S=4, W=8 — see wallEdges.ts's latticeMask). Always the FIRST 16 rows of
 *  every set; a set's total row count can be larger, see the header comment. */
export const WALL_BITMASK_COUNT = 16;
/**
 * Transparent gap (px) baked between adjacent FLOOR tiles in the sheet image.
 *
 * Not cosmetic, unlike the wall gap below: the client draws a sheet cell as a
 * frame of one shared texture (see client/src/render/sprites.ts's sheetFrame), and
 * a frame whose neighbour touches it can be sampled across that boundary — at a
 * fractional camera zoom the GPU reaches one texel into the cell next door and
 * paints a seam between every floor tile. A separate texture per tile could not do
 * that (it clamps at its own edge), which is why this only became necessary when
 * the sheets stopped being sliced into pixels. One px would do with NEAREST
 * filtering; two costs 130 px of sheet width and leaves no doubt.
 *
 * Changing it means re-running the bake: the .tsj records it, so Tiled and the
 * client both read the same number rather than assuming one.
 */
export const FLOOR_TILE_SPACING = 2;

/** Transparent gap (px) baked between adjacent wall tiles in the sheet image
 *  — wall art often runs edge-to-edge to its own tile boundary, so with zero
 *  gap neighboring bitmask variants visually blend together in Tiled's
 *  Tilesets panel. Purely a sheet-layout spacer: doesn't change which GID
 *  maps to which (bitmask, swatch) — see rowAndSwatchFromLocalId — only
 *  where that tile sits in pixels, which both the bake script and the
 *  client's sheet slicer must agree on. Floor tiles don't have this
 *  ambiguity (no directional edges to confuse), which is why they had no gap at
 *  all until frame bleeding made one necessary — see FLOOR_TILE_SPACING. */
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
