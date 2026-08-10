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

function swatch(hex: string, h: number, s: number): PaletteSwatch {
  return { hex, h, s };
}

/** DawnBringer's DB32 — floor gets the full palette (no autotile multiplier,
 *  see docs/design/tiled-editor-integration.md). */
export const FLOOR_PALETTE: PaletteSwatch[] = [
  swatch('#000000', 0, 0),
  swatch('#222034', 246, 24),
  swatch('#45283c', 319, 27),
  swatch('#663931', 9, 35),
  swatch('#8f563b', 19, 42),
  swatch('#df7126', 24, 74),
  swatch('#d9a066', 30, 60),
  swatch('#eec39a', 29, 71),
  swatch('#fbf236', 57, 96),
  swatch('#99e550', 91, 74),
  swatch('#6abe30', 95, 60),
  swatch('#37946e', 155, 46),
  swatch('#4b692f', 91, 38),
  swatch('#524b24', 51, 39),
  swatch('#323c39', 162, 9),
  swatch('#3f3f74', 240, 30),
  swatch('#306082', 205, 46),
  swatch('#5b6ee1', 231, 69),
  swatch('#639bff', 218, 100),
  swatch('#5fcde4', 190, 71),
  swatch('#cbdbfc', 220, 89),
  swatch('#ffffff', 0, 0),
  swatch('#9badb7', 201, 16),
  swatch('#847e87', 280, 4),
  swatch('#696a6a', 180, 0),
  swatch('#595652', 34, 4),
  swatch('#76428a', 283, 35),
  swatch('#ac3232', 0, 55),
  swatch('#d95763', 354, 63),
  swatch('#d77bba', 319, 53),
  swatch('#8f974a', 66, 34),
  swatch('#8a6f30', 42, 48),
];

/** DawnBringer's DB16 — a smaller, separately-designed palette (not just
 *  half of DB32), used for wall so the 4-neighbor autotile bitmask's ×16
 *  multiplier (16 pieces per set) doesn't multiply against the full 32
 *  colors too — see docs/design/tiled-editor-integration.md. */
export const WALL_PALETTE: PaletteSwatch[] = [
  swatch('#140c1c', 270, 40),
  swatch('#442434', 330, 31),
  swatch('#30346d', 236, 39),
  swatch('#4e4a4e', 300, 3),
  swatch('#854c30', 20, 47),
  swatch('#346524', 105, 47),
  swatch('#d04648', 359, 59),
  swatch('#757161', 48, 9),
  swatch('#597dce', 222, 54),
  swatch('#d27d2c', 29, 65),
  swatch('#8595a1', 206, 13),
  swatch('#6daa2c', 89, 59),
  swatch('#d2aa99', 18, 39),
  swatch('#6dc2ca', 185, 47),
  swatch('#dad45e', 57, 63),
  swatch('#deeed6', 100, 41),
];

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
