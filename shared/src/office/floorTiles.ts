/**
 * Which floor sets exist, and which sheet cell a (pattern, swatch) is.
 *
 * This module used to hold the pixels: the client fetched the baked sheets,
 * sliced every cell into a SpriteData grid, and handed them over. For the two
 * floor palettes plus the two metro ones that is 2340 cells and ~600k pixels;
 * with the wall sheets it came to 3.79 million, about 34 MB of hex strings — all
 * of it a re-encoding of 533 KB of PNG the browser had already decoded, only to
 * upload it to the GPU cell by cell afterwards.
 *
 * So it holds no pixels any more. A baked sheet already IS an atlas, so the
 * renderer registers each one as a single texture and draws rectangles out of it
 * (see client/src/render/sprites.ts's registerSheetTexture / sheetFrame). What is
 * left here is the part that genuinely belongs to the engine: which sets exist,
 * how many patterns each has, and the mapping from (pattern, swatch) to a cell —
 * see tiledSheetLayout.ts, which is where that grid is defined.
 */

import type { SheetCellRef } from './types.js';

/**
 * Pattern (row) count per floor set, keyed by the set's NAME.
 *
 * Keyed by name, not by a position in a list: it used to be an array indexed by
 * "position in FLOOR_SET_FILES", which made a hardcoded list of filenames the
 * identity of a floor set — renaming one broke it, and merely REORDERING the list
 * silently restyled every floor tile of every saved map. A layout names the sets
 * it uses (OfficeLayout.floorSets) and nothing in the code enumerates them.
 */
let floorPatternCounts: Record<string, number> = {};

/** Register the floor sets that loaded, with each set's pattern count (read off
 *  the sheet's own height — see client/src/net/tiledSheets.ts). */
export function setFloorSheetInfo(patternCounts: Record<string, number>): void {
  floorPatternCounts = patternCounts;
}

/** Have the baked floor sheets loaded yet? */
export function hasFloorSprites(): boolean {
  return Object.keys(floorPatternCounts).length > 0;
}

/**
 * Which sheet cell draws a floor pattern (1-based) in a set's palette swatch
 * (an index into the set's own palette, or null/undefined for "Natural").
 *
 * `null` means "cannot be drawn": no sheets yet, or a pattern the set does not
 * have. The renderer answers that with its error tile, which is the same signal
 * the magenta grid used to be, just decided one layer up.
 *
 * An unknown set name falls back to whichever set loaded first rather than
 * refusing: it means the map names a set this build does not have (a renamed or
 * removed tileset), and a plausible floor beats a wall of magenta. Warned once
 * per name so it stays visible without flooding.
 */
export function getFloorCellRef(
  patternIndex: number,
  swatchIndex: number | null | undefined,
  setName?: string,
): SheetCellRef | null {
  const sheet = resolveFloorSet(setName);
  if (sheet === undefined) return null;
  const row = patternIndex - 1;
  if (row < 0 || row >= floorPatternCounts[sheet]) return null;
  return { sheet, kind: 'floor', row, col: swatchIndex == null ? 0 : swatchIndex + 1 };
}

const warnedFloorSets = new Set<string>();
function resolveFloorSet(name: string | undefined): string | undefined {
  if (name !== undefined && floorPatternCounts[name] !== undefined) return name;
  const names = Object.keys(floorPatternCounts);
  if (names.length === 0) return undefined;
  if (name !== undefined && !warnedFloorSets.has(name)) {
    warnedFloorSets.add(name);
    console.warn(`[floorTiles] unknown floor set "${name}" — falling back to "${names[0]}"`);
  }
  return names[0];
}
