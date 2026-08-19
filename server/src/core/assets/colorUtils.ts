/**
 * Pure color conversion utilities — no external dependencies.
 */

import { PNG_ALPHA_THRESHOLD } from './constants.js';

export function rgbaToHex(r: number, g: number, b: number, a: number): string {
  if (a < PNG_ALPHA_THRESHOLD) return '';
  const rgb =
    `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`.toUpperCase();
  if (a >= 255) return rgb;
  return `${rgb}${a.toString(16).padStart(2, '0').toUpperCase()}`;
}

/**
 * Exact inverse of {@link rgbaToHex}: '' is transparent, '#RRGGBB' opaque, and
 * '#RRGGBBAA' keeps its alpha. Anything unparseable is treated as transparent
 * rather than as black, because a stray value in stored sprite data is far more
 * likely to be a gap than a deliberate black pixel.
 */
export function hexToRgba(hex: string): { r: number; g: number; b: number; a: number } {
  const h = (hex ?? '').trim();
  if (!h || h[0] !== '#' || (h.length !== 7 && h.length !== 9)) return { r: 0, g: 0, b: 0, a: 0 };
  const n = (at: number): number => {
    const v = parseInt(h.slice(at, at + 2), 16);
    return Number.isFinite(v) ? v : 0;
  };
  if (h.length === 7) return { r: n(1), g: n(3), b: n(5), a: 255 };
  const a = n(7);
  // Below the decoder's threshold there is no colour to preserve — it reads back as ''.
  return a < PNG_ALPHA_THRESHOLD ? { r: 0, g: 0, b: 0, a: 0 } : { r: n(1), g: n(3), b: n(5), a };
}
