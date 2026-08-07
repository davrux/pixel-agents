/**
 * Floor tile pattern storage and caching.
 *
 * Stores grayscale floor patterns loaded from individual PNGs in assets/floors/.
 * Uses shared colorize module for HSL tinting (Photoshop-style Colorize).
 * Caches colorized SpriteData by (pattern, h, s, b, c) key.
 */

import { CANVAS_ERROR_TILE_COLOR, FALLBACK_FLOOR_COLOR, TILE_SIZE } from './constants.js';
import { clearColorizeCache, colorizeToPalette } from './colorize.js';
import { TILE_COLOR_PALETTE, resolveTileColor } from './tileColorPalette.js';
import type { SpriteData } from './types.js';

/** Default solid gray 16×16 tile used when floor tile PNGs are not loaded */
const DEFAULT_FLOOR_SPRITE: SpriteData = Array.from(
  { length: TILE_SIZE },
  () => Array(TILE_SIZE).fill(FALLBACK_FLOOR_COLOR) as string[],
);

/** Module-level storage for floor tile sprites (set once on load) */
let floorSprites: SpriteData[] = [];

/** Baked (pattern, colorIndex) -> tinted SpriteData, cleared alongside the
 *  base sprites on reload. Bounded (patterns × TILE_COLOR_PALETTE.length),
 *  so caching forever is fine — unlike the old free-h/s/b/c cache, this can
 *  never grow unbounded. */
const paletteCache = new Map<string, SpriteData>();

// Re-export WALL_COLOR from constants for backward compatibility
export { WALL_COLOR } from './constants.js';

/** Set floor tile sprites (called once when extension sends floorTilesLoaded) */
export function setFloorSprites(sprites: SpriteData[]): void {
  floorSprites = sprites;
  clearColorizeCache();
  paletteCache.clear();
}

/** Get the raw (grayscale) floor sprite for a pattern index (1-7 -> array index 0-6).
 *  Falls back to the default solid gray tile when floors.png is not loaded. */
function getFloorSprite(patternIndex: number): SpriteData | null {
  const idx = patternIndex - 1;
  if (idx < 0) return null;
  if (idx < floorSprites.length) return floorSprites[idx];
  // No PNG sprites loaded — return default solid tile for any valid pattern index
  if (floorSprites.length === 0 && patternIndex >= 1) return DEFAULT_FLOOR_SPRITE;
  return null;
}

/** Check if floor sprites are available (always true — falls back to default solid tile) */
export function hasFloorSprites(): boolean {
  return true;
}

/** Get count of available floor patterns (at least 1 for the default solid tile) */
export function getFloorPatternCount(): number {
  return floorSprites.length > 0 ? floorSprites.length : 1;
}

/** Get all floor sprites (for preview rendering, falls back to default solid tile) - unused */
// function getAllFloorSprites(): SpriteData[] {
//   return floorSprites.length > 0 ? floorSprites : [DEFAULT_FLOOR_SPRITE];
// }

/**
 * Get a floor sprite tinted with one TILE_COLOR_PALETTE swatch (see
 * colorizeToPalette) — null colorIndex returns the plain grayscale pattern
 * untinted (a wall/void tile, or a tile explicitly painted without a swatch).
 */
export function getPaletteFloorSprite(patternIndex: number, colorIndex: number | null): SpriteData {
  const base = getFloorSprite(patternIndex);
  if (!base) {
    // Return a 16x16 magenta error tile
    const err: SpriteData = Array.from({ length: 16 }, () => Array(16).fill(CANVAS_ERROR_TILE_COLOR));
    return err;
  }
  const targetHex = resolveTileColor(colorIndex);
  if (!targetHex) return base;

  const key = `${patternIndex}-${colorIndex}`;
  const cached = paletteCache.get(key);
  if (cached) return cached;
  const result = colorizeToPalette(base, targetHex, TILE_COLOR_PALETTE);
  paletteCache.set(key, result);
  return result;
}
