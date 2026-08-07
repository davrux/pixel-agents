/**
 * Wall tile auto-tiling: sprite storage and bitmask-based piece selection.
 *
 * Stores wall tile sets loaded from individual PNGs in assets/walls/.
 * Each set contains 16 wall sprites (one per 4-bit bitmask).
 * At render time, each wall tile's 4 cardinal neighbors are checked to build
 * a bitmask, and the corresponding sprite is drawn directly.
 * No changes to the layout model — auto-tiling is purely visual.
 *
 * Bitmask convention: N=1, E=2, S=4, W=8. Out-of-bounds = NOT wall.
 */

import { colorizeToPalette } from './colorize.js';
import { TILE_COLOR_PALETTE, resolveTileColor } from './tileColorPalette.js';
import { isWall, tileColorIndexOf } from './tileGid.js';
import type { FurnitureInstance, SpriteData, TileGid } from './types.js';
import { TILE_SIZE } from './types.js';

/** Wall tile sets: each set has 16 sprites indexed by bitmask (0-15) */
let wallSets: SpriteData[][] = [];

/** Baked (setIndex, mask, colorIndex) -> tinted SpriteData — see floorTiles.ts's
 *  paletteCache for why caching forever is fine (bounded set). */
const paletteCache = new Map<string, SpriteData>();

/** Set wall tile sets (called once when extension sends wallTilesLoaded) */
export function setWallSprites(sets: SpriteData[][]): void {
  wallSets = sets;
  paletteCache.clear();
}

/** Check if wall sprites have been loaded */
export function hasWallSprites(): boolean {
  return wallSets.length > 0;
}

/** Get number of available wall sets */
export function getWallSetCount(): number {
  return wallSets.length;
}

/** Get the first sprite (bitmask 0, top-left piece) of a wall set for preview rendering */
export function getWallSetPreviewSprite(setIndex: number): SpriteData | null {
  const set = wallSets[setIndex];
  if (!set) return null;
  return set[0] ?? null;
}

/**
 * Build the 4-bit neighbor bitmask for a wall tile at (col, row).
 */
function buildWallMask(col: number, row: number, tileMap: TileGid[][]): number {
  const tmRows = tileMap.length;
  const tmCols = tmRows > 0 ? tileMap[0].length : 0;

  let mask = 0;
  if (row > 0 && isWall(tileMap[row - 1][col])) mask |= 1; // N
  if (col < tmCols - 1 && isWall(tileMap[row][col + 1])) mask |= 2; // E
  if (row < tmRows - 1 && isWall(tileMap[row + 1][col])) mask |= 4; // S
  if (col > 0 && isWall(tileMap[row][col - 1])) mask |= 8; // W
  return mask;
}

/**
 * Get a wall sprite tinted with one TILE_COLOR_PALETTE swatch (see
 * colorizeToPalette), for a tile based on its cardinal neighbors. Falls back
 * to the untinted piece if `colorIndex` doesn't resolve (shouldn't happen for
 * a real wall gid — every one carries a valid index by construction).
 * Returns the tinted sprite + Y offset, or null if no wall sprites loaded.
 */
function getPaletteWallSprite(
  col: number,
  row: number,
  tileMap: TileGid[][],
  colorIndex: number,
  setIndex = 0,
): { sprite: SpriteData; offsetY: number } | null {
  if (wallSets.length === 0) return null;
  const sprites = wallSets[setIndex] ?? wallSets[0];

  const mask = buildWallMask(col, row, tileMap);
  const sprite = sprites[mask];
  if (!sprite) return null;

  const targetHex = resolveTileColor(colorIndex);
  if (!targetHex) return { sprite, offsetY: TILE_SIZE - sprite.length };

  const cacheKey = `${setIndex}-${mask}-${colorIndex}`;
  let tinted = paletteCache.get(cacheKey);
  if (!tinted) {
    tinted = colorizeToPalette(sprite, targetHex, TILE_COLOR_PALETTE);
    paletteCache.set(cacheKey, tinted);
  }

  return { sprite: tinted, offsetY: TILE_SIZE - sprite.length };
}

/**
 * Build FurnitureInstance-like objects for all wall tiles so they can participate
 * in z-sorting with furniture and characters.
 */
export function getWallInstances(tileMap: TileGid[][]): FurnitureInstance[] {
  if (wallSets.length === 0) return [];
  const tmRows = tileMap.length;
  const tmCols = tmRows > 0 ? tileMap[0].length : 0;
  const instances: FurnitureInstance[] = [];
  for (let r = 0; r < tmRows; r++) {
    for (let c = 0; c < tmCols; c++) {
      const gid = tileMap[r][c];
      if (!isWall(gid)) continue;
      const colorIndex = tileColorIndexOf(gid) ?? 0;
      const wallInfo = getPaletteWallSprite(c, r, tileMap, colorIndex);
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
 * The flat fill hex color for a wall tile with a given palette swatch — used
 * as the pre-wall-sprite background rect, so it's just the swatch's real
 * color directly (no gradient to compute: a flat fill has no shading to
 * preserve, unlike the per-pixel wall sprite tinting above).
 */
export function paletteWallColorToHex(colorIndex: number): string | null {
  return resolveTileColor(colorIndex);
}
