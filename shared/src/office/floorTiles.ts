/**
 * Which sheets the ground can be drawn from, and which cell of one a tile id is.
 *
 * This module used to hold the pixels: the client fetched the baked sheets, sliced
 * every cell into a SpriteData grid, and handed them over. For the two floor
 * palettes plus the two metro ones that is 2340 cells and ~600k pixels; with the
 * wall sheets it came to 3.79 million, about 34 MB of hex strings — all of it a
 * re-encoding of 533 KB of PNG the browser had already decoded, only to upload it
 * to the GPU cell by cell afterwards. So it holds no pixels any more: a baked
 * sheet already IS an atlas, and the renderer registers each one as a single
 * texture and draws rectangles out of it (see client/src/render/sprites.ts).
 *
 * What is left is the engine's own part, and it got smaller. It used to map a
 * (pattern, swatch) pair to a cell, which only worked for sheets baked as
 * pattern-rows × palette-columns — that is why the ground was restricted to tiles
 * of Tiled class `FloorTile`. A ground cell now simply names a LOCAL TILE ID in a
 * sheet, the same thing Tiled itself paints with, so any grid tileset can be
 * ground and the baked floor sets keep working: their swatch was always just the
 * column of the cell.
 */

import type { SheetCellRef } from './types.js';

/** A registered sheet's grid, keyed by the sheet's NAME.
 *
 *  Keyed by name, not by a position in a list: it used to be an array indexed by
 *  "position in FLOOR_SET_FILES", which made a hardcoded list of filenames the
 *  identity of a floor set — renaming one broke it, and merely REORDERING the list
 *  silently restyled every floor tile of every saved map. A layout names the sets
 *  it uses (OfficeLayout.floorSets) and nothing in the code enumerates them. */
let sheetGrids: Record<string, { columns: number; rows: number }> = {};

/** Register the sheets that loaded, with each one's grid (read off the sheet's own
 *  size — see client/src/net/tiledSheets.ts). Every GRID tileset belongs here, not
 *  just the baked floor sets: a map may use any of them as ground. */
export function setSheetGrids(grids: Record<string, { columns: number; rows: number }>): void {
  sheetGrids = grids;
}

/** Have any sheets loaded yet? */
export function hasGroundSheets(): boolean {
  return Object.keys(sheetGrids).length > 0;
}

/**
 * Which sheet cell draws ground tile `localId` of set `setName`.
 *
 * `null` means "cannot be drawn": no sheets loaded yet, an unknown set, or an id
 * past the end of that sheet. The renderer answers that with its error tile, which
 * is the same signal the magenta grid used to be, just decided one layer up.
 *
 * An unknown set name is NOT quietly swapped for another sheet. The old code fell
 * back to whichever floor set had loaded first, on the grounds that "a plausible
 * floor beats a wall of magenta" — reasonable while a number meant a pattern that
 * every set had, and wrong now: the same id in a different sheet is unrelated art,
 * so the fallback would replace a missing tileset with confident nonsense. Warned
 * once per name instead.
 */
export function groundCellRef(setName: string | undefined, localId: number): SheetCellRef | null {
  if (localId < 0 || setName === undefined) return null;
  const grid = sheetGrids[setName];
  if (grid === undefined) {
    if (!warnedSets.has(setName)) {
      warnedSets.add(setName);
      console.warn(`[floorTiles] ground set "${setName}" is not loaded — those cells stay blank`);
    }
    return null;
  }
  if (grid.columns <= 0) return null;
  const row = Math.floor(localId / grid.columns);
  const col = localId % grid.columns;
  if (row >= grid.rows) return null;
  return { sheet: setName, kind: 'floor', row, col };
}

const warnedSets = new Set<string>();

/**
 * The local tile id a version-1 layout's (pattern, swatch) pair meant.
 *
 * Kept for the migration only (see migrateLayout): a v1 cell stored the sheet ROW
 * as a 1-based pattern and the column as a swatch index with null for column 0,
 * which is exactly this arithmetic inverted.
 */
export function localIdFromPatternAndSwatch(pattern: number, swatch: number | null | undefined, columns: number): number {
  const row = pattern - 1;
  const col = swatch == null ? 0 : swatch + 1;
  return row * columns + col;
}
