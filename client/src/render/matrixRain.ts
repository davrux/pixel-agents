/**
 * The Matrix rain as one tiled draw instead of thousands of filled pixels.
 *
 * What the effect looks like has not changed: the figure fades in (or out) under a wavefront of
 * falling code. What changed is who paints it. The old path (`renderMatrixEffect`, now the
 * fallback) visited every cell of the character's frame rectangle twice per frame — body pixel,
 * then rain pixel — into a canvas texture per character that was re-uploaded to the GPU on every
 * frame. Counted: 581 `fillRect` calls per frame for a 16×32 character, **4 376 for a 64×64 one**,
 * and 7.10 ms of frame time with five 64×64 figures materialising at once.
 *
 * Here the body is the ordinary atlas sprite at a lower opacity, and the rain is one `TileSprite`
 * scrolling `MATRIX_RAIN_SHEET` across it. Two draws, whatever the figure's size, and the sheet is
 * generic — the rain was never masked to the silhouette, which is what makes a single texture
 * correct for every skin, pose, direction and frame size.
 *
 * The one texture of its own this file creates is the deliberate exception AGENTS.md § Conventions
 * allows for: tiling is `GL_REPEAT` on a whole texture and cannot be asked of one frame inside a
 * packed atlas page. It is created once for the world (not once per character), from the bitmap the
 * sheet store already holds, and it is 32×128 — both powers of two, because REPEAT on a
 * non-power-of-two texture is where portability ends.
 */
import { MATRIX_RAIN_SHEET } from '@pixel/shared/office/effects.js';

import { effectSheetId } from '../art/effects.js';
import { sheetBitmap } from '../art/sheetStore.js';

const TEXTURE_KEY = 'fx_matrix_rain';

/** Warned once per session, or a missing sheet would print per character per frame. */
let warned = false;

/**
 * The rain texture, created on first use and kept for the session.
 *
 * Returns null when the sheet did not load, which is the caller's signal to fall back to the pixel
 * path rather than to draw nothing: an effect sheet is fetched over HTTP and that failure is not
 * fatal by design (see art/effects.ts).
 */
export function matrixRainTexture(scene: Phaser.Scene): string | null {
  if (scene.textures.exists(TEXTURE_KEY)) return TEXTURE_KEY;
  const bitmap = sheetBitmap(effectSheetId(MATRIX_RAIN_SHEET.id));
  if (!bitmap) {
    if (!warned) {
      warned = true;
      console.warn('[matrix] no rain sheet — falling back to the per-pixel effect');
    }
    return null;
  }
  const tex = scene.textures.createCanvas(TEXTURE_KEY, bitmap.width, bitmap.height);
  if (!tex) return null;
  const ctx = tex.getContext();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(bitmap, 0, 0);
  tex.refresh();
  return TEXTURE_KEY;
}
