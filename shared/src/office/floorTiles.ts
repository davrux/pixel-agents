/**
 * Floor tile pattern storage.
 *
 * Sprites are pre-baked, closed-palette PNGs (see
 * server/scripts/bake-floor-wall-tiled.mts and client/src/net/tiledSheets.ts)
 * — a direct (set, pattern, swatch) lookup, no runtime HSL colorize.
 */

import { CANVAS_ERROR_TILE_COLOR, TILE_SIZE } from './constants.js';
import type { SpriteData } from './types.js';

/** floorSheets[setName][pattern][0] = Natural (raw, uncolorized); [1+i] = the
 *  set's palette colorized. Populated once by the client's tiledSheets loader
 *  from the baked assets/tiled/png/<setName>.png sheets.
 *
 *  Keyed by the set's NAME, not by a position in a list. It used to be an array
 *  indexed by a number that meant "position in FLOOR_SET_FILES", which made a
 *  hardcoded list of filenames the identity of a floor set: renaming one broke
 *  it, and merely REORDERING the list silently restyled every floor tile of
 *  every saved map. A layout now names the sets it uses (OfficeLayout.floorSets)
 *  and nothing in the code enumerates them. */
let floorSheets: Record<string, SpriteData[][]> = {};

/** Set floor tile sprites (called once the baked floor sheets are fetched +
 *  sliced — see client/src/net/tiledSheets.ts). */
export function setFloorSheets(sheets: Record<string, SpriteData[][]>): void {
  floorSheets = sheets;
}

/** Check whether the baked floor sheets have loaded yet. */
export function hasFloorSprites(): boolean {
  return Object.keys(floorSheets).length > 0;
}

const ERROR_TILE: SpriteData = Array.from({ length: TILE_SIZE }, () =>
  Array(TILE_SIZE).fill(CANVAS_ERROR_TILE_COLOR) as string[],
);

/**
 * Get the pre-baked sprite for a floor pattern (1-based) + swatch index (an
 * index into the set's own palette, or null/undefined for "Natural") in a named
 * floor set — a direct lookup, no HSL math.
 *
 * An unknown name falls back to whichever set loaded first rather than drawing
 * the error tile: it means the map names a set this build does not have (a
 * renamed or removed tileset), and a plausible floor is a better answer than a
 * magenta grid. Warned once per name so it is visible without flooding.
 */
export function getColorizedFloorSprite(
  patternIndex: number,
  swatchIndex: number | null | undefined,
  setName?: string,
): SpriteData {
  const set = (setName !== undefined ? floorSheets[setName] : undefined) ?? fallbackFloorSet(setName);
  const sheet = set?.[patternIndex - 1];
  if (!sheet) return ERROR_TILE;
  return sheet[swatchIndex == null ? 0 : swatchIndex + 1] ?? ERROR_TILE;
}

const warnedFloorSets = new Set<string>();
function fallbackFloorSet(name: string | undefined): SpriteData[][] | undefined {
  const names = Object.keys(floorSheets);
  if (names.length === 0) return undefined;
  if (name !== undefined && !warnedFloorSets.has(name)) {
    warnedFloorSets.add(name);
    console.warn(`[floorTiles] unknown floor set "${name}" — falling back to "${names[0]}"`);
  }
  return floorSheets[names[0]];
}
