import { rgbToHsl } from './colorize.js';
import type { ColorValue } from './colorTypes.js';

/** One selectable swatch: its reference hex (for the picker button's own
 *  fill) plus the hue/saturation/lightness `colorizeSprite` recolors with —
 *  the actual palette color, not just a tint of whatever brightness the
 *  source art happened to be drawn at. colorizeSprite recenters each
 *  sprite's own per-pixel shading around its average lightness before
 *  applying this swatch's target (see colorize.ts), so the pattern's relief
 *  (highlights/shadows) survives while the overall tile reads as this real
 *  color — a dark swatch renders dark, a light one renders light. */
export interface PaletteSwatch {
  hex: string;
  h: number;
  s: number;
}

/** h/s are derived from the hex itself (via rgbToHsl) rather than hand-
 *  entered — avoids transcription drift across a 64-entry palette; `l`
 *  (lightness) isn't stored here since swatchColor() re-derives it from hex
 *  directly at call time anyway. */
function swatch(hex: string): PaletteSwatch {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const [h, s] = rgbToHsl(r, g, b);
  return { hex, h, s: Math.round(s * 100) };
}

/** Kerrie Lake's "Resurrect 64" (lospec.com/palette-list/resurrect-64) — one
 *  shared 64-color palette for both floor and wall (previously DB32 for
 *  floor, a separate DawnBringer16 for wall; the split existed only to keep
 *  wall's ×16 autotile-bitmask multiplier from also multiplying against a
 *  large color count, but 64 colors × 16 masks × 2 sets = 2080 wall tiles is
 *  still a perfectly reasonable sheet size, so there's no reason left to
 *  keep two different palettes). See docs/design/tiled-editor-integration.md. */
export const PALETTE_64: PaletteSwatch[] = [
  '#2e222f', '#3e3546', '#625565', '#966c6c', '#ab947a', '#694f62', '#7f708a', '#9babb2',
  '#c7dcd0', '#ffffff', '#6e2727', '#b33831', '#ea4f36', '#f57d4a', '#ae2334', '#e83b3b',
  '#fb6b1d', '#f79617', '#f9c22b', '#7a3045', '#9e4539', '#cd683d', '#e6904e', '#fbb954',
  '#4c3e24', '#676633', '#a2a947', '#d5e04b', '#fbff86', '#165a4c', '#239063', '#1ebc73',
  '#91db69', '#cddf6c', '#313638', '#374e4a', '#547e64', '#92a984', '#b2ba90', '#0b5e65',
  '#0b8a8f', '#0eaf9b', '#30e1b9', '#8ff8e2', '#323353', '#484a77', '#4d65b4', '#4d9be6',
  '#8fd3ff', '#45293f', '#6b3e75', '#905ea9', '#a884f3', '#eaaded', '#753c54', '#a24b6f',
  '#cf657f', '#ed8099', '#831c5d', '#c32454', '#f04f78', '#f68181', '#fca790', '#fdcbb0',
].map(swatch);

/** A second closed 64-color palette, all warm hues (red→amber→gold→yellow,
 *  plus warm neutrals/browns/dusty-rose — no greens/blues/purples at all),
 *  for floor patterns/wall sets that want a warm-toned option instead of
 *  the general-purpose PALETTE_64. Generated for this project (8 warm hue
 *  ramps × 8 lightness steps) rather than sourced from an existing lospec
 *  palette — the ones checked either weren't actually warm-skewed despite
 *  the name (e.g. lospec's "Whole Punch 64", "Pastel-64") or weren't 64
 *  colors (lospec's "Warm C64" is 16). See docs/design/tiled-editor-integration.md. */
export const WARM_PALETTE_64: PaletteSwatch[] = [
  '#221f1c', '#403830', '#655749', '#897867', '#a5998d', '#bfb8b0', '#d9d6d3', '#f5f5f4',
  '#3f1216', '#62181f', '#8b1d27', '#b4222e', '#d92635', '#de545f', '#df9097', '#e6cbce',
  '#57270f', '#863913', '#b84b14', '#df5916', '#e97135', '#e7936a', '#e9bca5', '#f0e2db',
  '#5d4214', '#8c6117', '#c18215', '#ec9c13', '#ecab3c', '#eabe71', '#ebd4ad', '#f3ede2',
  '#433a19', '#6f5f20', '#a88e24', '#dbb724', '#e0c452', '#e2d18d', '#e9e1c4', '#f4f2ec',
  '#452017', '#692b1c', '#973820', '#c54526', '#d76447', '#d99381', '#e1bfb7', '#f0e8e6',
  '#302317', '#503721', '#794f2a', '#a86c38', '#c28b5b', '#ccab8e', '#dacbbe', '#eeeae8',
  '#492c27', '#713b33', '#9b483b', '#bf5a4a', '#c97f73', '#d1a59e', '#dfcbc8', '#f2eeee',
].map(swatch);

/** Which closed palette each floor "set" (OfficeLayout.tileFloorSet, see
 *  tiledSheetLayout.ts's FLOOR_SET_FILES) is baked from — parallel-indexed
 *  with FLOOR_SET_FILES. */
export const FLOOR_SET_PALETTES: PaletteSwatch[][] = [PALETTE_64, WARM_PALETTE_64];

/** Which closed palette each wall "set" (OfficeLayout.tileWallSet, see
 *  tiledSheetLayout.ts's WALL_SET_FILES) is baked from — parallel-indexed
 *  with WALL_SET_FILES. */
export const WALL_SET_PALETTES: PaletteSwatch[][] = [PALETTE_64, PALETTE_64, WARM_PALETTE_64, WARM_PALETTE_64];

export function paletteForFloorSet(setIndex: number): PaletteSwatch[] {
  return FLOOR_SET_PALETTES[setIndex] ?? PALETTE_64;
}

export function paletteForWallSet(setIndex: number): PaletteSwatch[] {
  return WALL_SET_PALETTES[setIndex] ?? PALETTE_64;
}

/** Reverse of swatchColor(): which palette swatch (if any) a stored
 *  ColorValue matches, by (h, s) — the same equality check the Layout
 *  editor's own swatch picker already uses to highlight the active one.
 *  Returns null for "Natural" (no tint): color is absent, or colorize is
 *  explicitly false (the "Natural" swatch button's own ColorValue) — one
 *  rule for both floor and wall, matching the baked Tiled sheets' own
 *  Natural/swatch split (see bake-floor-wall-tiled.mts). */
export function paletteSwatchIndex(
  palette: PaletteSwatch[],
  color: ColorValue | null | undefined,
): number | null {
  if (!color || color.colorize === false) return null;
  const idx = palette.findIndex((sw) => sw.h === color.h && sw.s === color.s);
  return idx >= 0 ? idx : null;
}

/** A palette swatch's ColorValue, ready for colorizeSprite/getColorizedSprite —
 *  `b` carries the swatch's own real lightness (derived from its hex) as a
 *  target brightness, per colorizeSprite's recentering; see PaletteSwatch's
 *  own doc comment for why this makes the rendered tile the actual color,
 *  not just a hue tint. */
export function swatchColor(s: PaletteSwatch): ColorValue {
  const r = parseInt(s.hex.slice(1, 3), 16);
  const g = parseInt(s.hex.slice(3, 5), 16);
  const bChan = parseInt(s.hex.slice(5, 7), 16);
  const [, , l] = rgbToHsl(r, g, bChan);
  return { h: s.h, s: s.s, b: (l - 0.5) * 200, c: 0, colorize: true };
}
