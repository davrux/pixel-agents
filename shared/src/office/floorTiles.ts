/**
 * Floor tile pattern storage.
 *
 * Sprites are pre-baked, closed-palette PNGs (see
 * server/scripts/bake-floor-wall-tiled.mts and client/src/net/tiledSheets.ts)
 * — a direct (pattern, swatch) lookup, no runtime HSL colorize.
 */

import type { ColorValue } from './colorTypes.js';
import { CANVAS_ERROR_TILE_COLOR, TILE_SIZE } from './constants.js';
import { FLOOR_PALETTE, paletteSwatchIndex } from './palettes.js';
import type { SpriteData } from './types.js';

/** floorSheets[pattern][0] = Natural (raw, uncolorized); [1+i] =
 *  FLOOR_PALETTE[i] colorized. Populated once by the client's tiledSheets
 *  loader from the baked assets/tiled/png/floor.png sheet. */
let floorSheets: SpriteData[][] = [];

/** Set floor tile sprites (called once the baked floor.png sheet is fetched
 *  + sliced — see client/src/net/tiledSheets.ts). */
export function setFloorSheets(sheets: SpriteData[][]): void {
  floorSheets = sheets;
}

/** Check whether the baked floor sheet has loaded yet. */
export function hasFloorSprites(): boolean {
  return floorSheets.length > 0;
}

/** Get count of available floor patterns (0 until the baked sheet loads). */
export function getFloorPatternCount(): number {
  return floorSheets.length;
}

const ERROR_TILE: SpriteData = Array.from({ length: TILE_SIZE }, () =>
  Array(TILE_SIZE).fill(CANVAS_ERROR_TILE_COLOR) as string[],
);

/**
 * Get the pre-baked sprite for a floor pattern (1-based) + color — a direct
 * lookup into the closed 64-color palette (see paletteSwatchIndex), falling
 * back to the "Natural" (raw) tile when color is absent or unmatched.
 */
export function getColorizedFloorSprite(
  patternIndex: number,
  color: ColorValue | null | undefined,
): SpriteData {
  const sheet = floorSheets[patternIndex - 1];
  if (!sheet) return ERROR_TILE;
  const swatchIdx = paletteSwatchIndex(FLOOR_PALETTE, color);
  return sheet[swatchIdx === null ? 0 : swatchIdx + 1] ?? ERROR_TILE;
}
