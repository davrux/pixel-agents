/**
 * Wall tile auto-tiling: sprite storage and bitmask-based piece selection.
 *
 * Sprites are pre-baked, closed-palette PNGs (see
 * server/scripts/bake-floor-wall-tiled.mts and client/src/net/tiledSheets.ts)
 * — a direct (bitmask, swatch) lookup, no runtime HSL colorize.
 * At render time, each wall tile's 4 cardinal neighbors are checked to build
 * a bitmask, and the corresponding sprite is drawn directly.
 * No changes to the layout model — auto-tiling is purely visual.
 *
 * Bitmask convention: N=1, E=2, S=4, W=8. Out-of-bounds = NOT wall.
 */

import type { ColorValue } from './colorTypes.js';
import { hslToHex } from './colorize.js';
import { WALL_PALETTE, paletteSwatchIndex } from './palettes.js';
import type { FurnitureInstance, SpriteData, TileType as TileTypeVal } from './types.js';
import { TILE_SIZE, TileType } from './types.js';

/** wallSheets[setIndex][bitmask][0] = Natural (raw, uncolorized); [1+i] =
 *  WALL_PALETTE[i] colorized. Populated once by the client's tiledSheets
 *  loader from the baked assets/tiled/png/wall-N.png sheets. */
let wallSheets: SpriteData[][][] = [];

/** Set wall tile sets (called once the baked wall-N.png sheets are fetched +
 *  sliced — see client/src/net/tiledSheets.ts). */
export function setWallSheets(sheets: SpriteData[][][]): void {
  wallSheets = sheets;
}

/** Check if wall sprites have been loaded */
export function hasWallSprites(): boolean {
  return wallSheets.length > 0;
}

/** Get number of available wall sets */
export function getWallSetCount(): number {
  return wallSheets.length;
}

/** Get the "Natural" (raw, no tint) bitmask-0 piece of a wall set, for
 *  preview rendering. */
export function getWallSetPreviewSprite(setIndex: number): SpriteData | null {
  return wallSheets[setIndex]?.[0]?.[0] ?? null;
}

/** Get the bitmask-0 piece of a wall set in a given color — a direct lookup
 *  (see paletteSwatchIndex) used for the Layout editor's palette-preview
 *  thumbnails (LayoutEditor.ts's refreshPalettePreviews), so those previews
 *  don't need their own live colorize call. */
export function getWallSetSwatchPreview(
  setIndex: number,
  color: ColorValue | null | undefined,
): SpriteData | null {
  const pieces = wallSheets[setIndex]?.[0];
  if (!pieces) return null;
  const swatchIdx = paletteSwatchIndex(WALL_PALETTE, color);
  return pieces[swatchIdx === null ? 0 : swatchIdx + 1] ?? null;
}

/**
 * Build the 4-bit neighbor bitmask for a wall tile at (col, row).
 */
function buildWallMask(col: number, row: number, tileMap: TileTypeVal[][]): number {
  const tmRows = tileMap.length;
  const tmCols = tmRows > 0 ? tileMap[0].length : 0;

  let mask = 0;
  if (row > 0 && tileMap[row - 1][col] === TileType.WALL) mask |= 1; // N
  if (col < tmCols - 1 && tileMap[row][col + 1] === TileType.WALL) mask |= 2; // E
  if (row < tmRows - 1 && tileMap[row + 1][col] === TileType.WALL) mask |= 4; // S
  if (col > 0 && tileMap[row][col - 1] === TileType.WALL) mask |= 8; // W
  return mask;
}

/**
 * Get the pre-baked wall sprite + Y offset for a tile's cardinal neighbors —
 * a direct lookup into the closed palette (see paletteSwatchIndex), falling
 * back to the "Natural" (raw) piece when color is absent or unmatched, or
 * null (→ solid WALL_COLOR fill) if no wall sprites are loaded.
 */
function getWallSprite(
  col: number,
  row: number,
  tileMap: TileTypeVal[][],
  color: ColorValue | null | undefined,
  setIndex = 0,
): { sprite: SpriteData; offsetY: number } | null {
  const set = wallSheets[setIndex] ?? wallSheets[0];
  if (!set) return null;

  const mask = buildWallMask(col, row, tileMap);
  const pieces = set[mask];
  if (!pieces) return null;

  const swatchIdx = paletteSwatchIndex(WALL_PALETTE, color);
  const sprite = pieces[swatchIdx === null ? 0 : swatchIdx + 1];
  if (!sprite) return null;

  // Anchor sprite at bottom of tile — tall sprites extend upward
  return { sprite, offsetY: TILE_SIZE - sprite.length };
}

/**
 * Build FurnitureInstance-like objects for all wall tiles so they can participate
 * in z-sorting with furniture and characters.
 */
export function getWallInstances(
  tileMap: TileTypeVal[][],
  tileColors?: Array<ColorValue | null>,
  cols?: number,
): FurnitureInstance[] {
  if (wallSheets.length === 0) return [];
  const tmRows = tileMap.length;
  const tmCols = tmRows > 0 ? tileMap[0].length : 0;
  const layoutCols = cols ?? tmCols;
  const instances: FurnitureInstance[] = [];
  for (let r = 0; r < tmRows; r++) {
    for (let c = 0; c < tmCols; c++) {
      if (tileMap[r][c] !== TileType.WALL) continue;
      const colorIdx = r * layoutCols + c;
      const wallColor = tileColors?.[colorIdx];
      const wallInfo = getWallSprite(c, r, tileMap, wallColor);
      if (!wallInfo) continue;
      instances.push({
        sprite: wallInfo.sprite,
        x: c * TILE_SIZE,
        y: r * TILE_SIZE + wallInfo.offsetY,
        zY: (r + 1) * TILE_SIZE,
      });
    }
  }
  return instances;
}

/**
 * Compute the flat fill hex color for a wall tile with a given ColorValue.
 * Uses same Colorize algorithm as floor tiles: 50% gray → HSL.
 */
export function wallColorToHex(color: ColorValue): string {
  const { h, s, b, c } = color;
  // Start with 50% gray (wall base)
  let lightness = 0.5;

  // Apply contrast
  if (c !== 0) {
    const factor = (100 + c) / 100;
    lightness = 0.5 + (lightness - 0.5) * factor;
  }

  // Apply brightness
  if (b !== 0) {
    lightness = lightness + b / 200;
  }

  lightness = Math.max(0, Math.min(1, lightness));

  return hslToHex(h, s / 100, lightness);
}
