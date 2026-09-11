import {
  MATRIX_FLICKER_FPS,
  MATRIX_RAIN_FLICKER_DIM,
  MATRIX_FLICKER_VISIBILITY_THRESHOLD,
} from '../constants.js';
import { warpStyle } from '../effects.js';
import type { Character } from '../types.js';

/**
 * How far through its phase a character is, and how solid its body therefore is.
 *
 * The duration comes from the STYLE (see WARP_STYLES), because the same timer runs a 0.5 s
 * implosion and a 1.0 s phoenix — and the engine repositions the body at that same boundary, so
 * both sides must divide by the same number.
 *
 * The per-pixel renderer that used to live below these two functions is gone: it existed as a
 * fallback for a rain sheet that failed to load, and it cost 7.10 ms per frame with five 64x64
 * figures (4 376 fills each). A missing sheet now degrades to no effect at all — the figure is
 * simply drawn, whole — which is the honest answer for art that did not arrive, and it took a
 * per-character canvas, a seed array on the Character and a second copy of every curve with it.
 */
export function warpProgress(ch: Character): number {
  const seconds = warpStyle(ch.warpStyle).durationSec;
  return Math.max(0, Math.min(1, ch.matrixEffectTimer / seconds));
}

/**
 * The body's opacity: solid a little before the sweep finishes on the way in, and not fully gone
 * until it has passed on the way out, so the figure never snaps at either end.
 */
export function matrixBodyAlpha(ch: Character): number {
  const progress = warpProgress(ch);
  return ch.matrixEffect === 'spawn' ? Math.min(1, progress * 1.35) : Math.max(0, 1 - progress * 1.15);
}

/**
 * The shimmer, as one number for a whole band of rain.
 *
 * The pixel path flickers each trail CELL independently (`flickerVisible`), which is free when you
 * are already visiting every cell and impossible when the rain is one tiled draw. Dimming the whole
 * band on the same 30 Hz clock is the cheap equivalent: it reads as the code flickering rather than
 * as individual glyphs doing so, which is a fair trade for 4 376 fills per frame.
 */
export function matrixRainDim(ch: Character): number {
  const t = Math.floor(ch.matrixEffectTimer * MATRIX_FLICKER_FPS);
  const hash = (ch.id * 7 + t * 31) & 0xff;
  return hash < MATRIX_FLICKER_VISIBILITY_THRESHOLD ? 1 : MATRIX_RAIN_FLICKER_DIM;
}
