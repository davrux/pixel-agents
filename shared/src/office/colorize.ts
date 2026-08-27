/**
 * Sprite colorization — a BUILD-time module now, not a runtime one.
 *
 * It recolours a grayscale pattern to a fixed HSL, which is how the floor and wall tilesets get
 * one tile per (pattern, palette swatch): `scripts/bake-floor-wall-tiled.mts` is its only
 * caller. The live game never recolours a pixel — it draws the baked sheets, and `floorTiles.ts`
 * only answers which CELL of which sheet a ground tile is.
 *
 * It had a second mode, "adjust" (shift each pixel's own HSL instead of mapping it), for
 * furniture that was coloured per placement. Furniture art comes from Tiled tilesets, nothing
 * has asked for that mode since, and `swatchColor` — the one producer of a ColorValue — always
 * wanted the colorize path, so the dispatch had one reachable branch. Both are gone.
 */

import type { ColorValue } from './colorTypes.js';
import type { SpriteData } from './types.js';

/** Generic colorized sprite cache: arbitrary string key → SpriteData */
const colorizeCache = new Map<string, SpriteData>();

/**
 * Get a colorized sprite from cache, or compute and cache it.
 * Caller provides a unique cache key.
 */
export function getColorizedSprite(
  cacheKey: string,
  sprite: SpriteData,
  color: ColorValue,
  referenceLightness?: number,
): SpriteData {
  const cached = colorizeCache.get(cacheKey);
  if (cached) return cached;
  const result = colorizeSprite(sprite, color, referenceLightness);
  colorizeCache.set(cacheKey, result);
  return result;
}

/** A sprite's own average perceived luminance across every opaque pixel
 *  (0-1) — the recentering point colorizeSprite shades around, so a target
 *  brightness (color.b) lands on an absolute lightness regardless of how
 *  bright or dark the source art was naturally drawn. Exported so a caller
 *  whose "sprite" is really one piece of a larger set that must shade
 *  consistently as a whole (e.g. wallTiles.ts's 16 bitmask pieces of one
 *  wall style) can compute ONE shared reference across every piece and pass
 *  it to getColorizedSprite explicitly — recentering each piece around its
 *  own average instead would preserve every piece's absolute target color
 *  but wash out the *relative* brightness differences between pieces that
 *  a continuous wall run needs to still read as one consistent texture. */
export function averageLightness(sprite: SpriteData): number {
  let sum = 0;
  let n = 0;
  for (const row of sprite) {
    for (const pixel of row) {
      if (!pixel) continue;
      const r = parseInt(pixel.slice(1, 3), 16);
      const g = parseInt(pixel.slice(3, 5), 16);
      const b = parseInt(pixel.slice(5, 7), 16);
      sum += (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      n++;
    }
  }
  return n > 0 ? sum / n : 0.5;
}

/**
 * Colorize a sprite using HSL transformation.
 *
 * Algorithm (Photoshop Colorize-style):
 * 1. Parse each pixel's color as perceived luminance (0-1)
 * 2. Recenter around the sprite's OWN average lightness (not a flat 0.5) —
 *    see averageLightness's own note.
 * 3. Apply contrast: stretch/compress around midpoint 0.5
 * 4. Apply brightness: shift lightness up/down
 * 5. Create HSL color with user's hue + saturation
 * 6. Convert HSL -> RGB -> hex
 */
function colorizeSprite(sprite: SpriteData, color: ColorValue, referenceLightness?: number): SpriteData {
  const { h, s, b, c } = color;
  const avgLightness = referenceLightness ?? averageLightness(sprite);
  const result: SpriteData = [];

  for (const row of sprite) {
    const newRow: string[] = [];
    for (const pixel of row) {
      if (pixel === '') {
        newRow.push('');
        continue;
      }

      // Parse hex to get RGB values
      const r = parseInt(pixel.slice(1, 3), 16);
      const g = parseInt(pixel.slice(3, 5), 16);
      const bv = parseInt(pixel.slice(5, 7), 16);
      // Use perceived luminance for grayscale, recentered around this
      // sprite's own average — see averageLightness.
      let lightness = 0.5 + ((0.299 * r + 0.587 * g + 0.114 * bv) / 255 - avgLightness);

      // Apply contrast: expand/compress around 0.5
      if (c !== 0) {
        const factor = (100 + c) / 100;
        lightness = 0.5 + (lightness - 0.5) * factor;
      }

      // Apply brightness: shift up/down
      if (b !== 0) {
        lightness = lightness + b / 200;
      }

      // Clamp
      lightness = Math.max(0, Math.min(1, lightness));

      // Preserve original alpha
      const alpha = extractAlpha(pixel);

      // Convert HSL to RGB
      const satFrac = s / 100;
      const hex = hslToHex(h, satFrac, lightness);
      newRow.push(appendAlpha(hex, alpha));
    }
    result.push(newRow);
  }

  return result;
}

/** Extract alpha from a hex pixel string. Returns 255 for #RRGGBB, parsed value for #RRGGBBAA. */
function extractAlpha(pixel: string): number {
  return pixel.length > 7 ? parseInt(pixel.slice(7, 9), 16) : 255;
}

/** Append alpha to a #RRGGBB hex string, omitting if fully opaque. */
function appendAlpha(hex: string, alpha: number): string {
  if (alpha >= 255) return hex;
  return `${hex}${alpha.toString(16).padStart(2, '0').toUpperCase()}`;
}

/** Convert HSL (h: 0-360, s: 0-1, l: 0-1) to #RRGGBB hex string */
function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r1 = 0,
    g1 = 0,
    b1 = 0;

  if (hp < 1) {
    r1 = c;
    g1 = x;
    b1 = 0;
  } else if (hp < 2) {
    r1 = x;
    g1 = c;
    b1 = 0;
  } else if (hp < 3) {
    r1 = 0;
    g1 = c;
    b1 = x;
  } else if (hp < 4) {
    r1 = 0;
    g1 = x;
    b1 = c;
  } else if (hp < 5) {
    r1 = x;
    g1 = 0;
    b1 = c;
  } else {
    r1 = c;
    g1 = 0;
    b1 = x;
  }

  const m = l - c / 2;
  const r = Math.round((r1 + m) * 255);
  const g = Math.round((g1 + m) * 255);
  const bOut = Math.round((b1 + m) * 255);

  return `#${clamp255(r).toString(16).padStart(2, '0')}${clamp255(g).toString(16).padStart(2, '0')}${clamp255(bOut).toString(16).padStart(2, '0')}`.toUpperCase();
}

function clamp255(v: number): number {
  return Math.max(0, Math.min(255, v));
}

/** Convert RGB (0-255 each) to HSL (h: 0-360, s: 0-1, l: 0-1) */
export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rf = r / 255,
    gf = g / 255,
    bf = b / 255;
  const max = Math.max(rf, gf, bf),
    min = Math.min(rf, gf, bf);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === rf) h = ((gf - bf) / d + (gf < bf ? 6 : 0)) * 60;
  else if (max === gf) h = ((bf - rf) / d + 2) * 60;
  else h = ((rf - gf) / d + 4) * 60;
  return [h, s, l];
}
