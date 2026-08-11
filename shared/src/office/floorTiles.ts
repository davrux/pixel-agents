/**
 * Floor tile pattern storage.
 *
 * Sprites are pre-baked, closed-palette PNGs (see
 * server/scripts/bake-floor-wall-tiled.mts and client/src/net/tiledSheets.ts)
 * — a direct (set, pattern, swatch) lookup, no runtime HSL colorize.
 */

import { CANVAS_ERROR_TILE_COLOR, TILE_SIZE } from './constants.js';
import type { SpriteData } from './types.js';

/** floorSheets[set][pattern][0] = Natural (raw, uncolorized); [1+i] =
 *  FLOOR_SET_PALETTES[set][i] colorized. Populated once by the client's
 *  tiledSheets loader from the baked assets/tiled/png/<FLOOR_SET_FILES[set]>.png
 *  sheets — see tiledSheetLayout.ts's FLOOR_SET_FILES. */
let floorSheets: SpriteData[][][] = [];

/** Set floor tile sprites (called once the baked floor sheets are fetched +
 *  sliced — see client/src/net/tiledSheets.ts). */
export function setFloorSheets(sheets: SpriteData[][][]): void {
  floorSheets = sheets;
}

/** Check whether the baked floor sheets have loaded yet. */
export function hasFloorSprites(): boolean {
  return floorSheets.length > 0;
}

/** Get count of available floor patterns in a set (0 until the baked sheet
 *  for that set loads). */
export function getFloorPatternCount(setIndex = 0): number {
  return floorSheets[setIndex]?.length ?? 0;
}

const ERROR_TILE: SpriteData = Array.from({ length: TILE_SIZE }, () =>
  Array(TILE_SIZE).fill(CANVAS_ERROR_TILE_COLOR) as string[],
);

/**
 * Get the pre-baked sprite for a floor pattern (1-based) + swatch index (an
 * index into whichever palette `setIndex` bakes from, or null/undefined for
 * "Natural") in a given floor set — a direct array lookup, no HSL math.
 */
export function getColorizedFloorSprite(
  patternIndex: number,
  swatchIndex: number | null | undefined,
  setIndex = 0,
): SpriteData {
  const sheet = floorSheets[setIndex]?.[patternIndex - 1];
  if (!sheet) return ERROR_TILE;
  return sheet[swatchIndex == null ? 0 : swatchIndex + 1] ?? ERROR_TILE;
}
