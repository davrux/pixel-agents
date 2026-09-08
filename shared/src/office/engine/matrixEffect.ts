import {
  MATRIX_COLUMN_STAGGER_RANGE,
  MATRIX_FLICKER_FPS,
  MATRIX_RAIN_FLICKER_DIM,
  MATRIX_FLICKER_VISIBILITY_THRESHOLD,
  MATRIX_HEAD_COLOR,
  MATRIX_SEED_COUNT,
  MATRIX_TRAIL_DIM_THRESHOLD,
  MATRIX_TRAIL_EMPTY_ALPHA,
  MATRIX_TRAIL_LENGTH,
  MATRIX_TRAIL_MID_THRESHOLD,
  matrixGreenBright,
  matrixGreenDim,
  matrixGreenMid,
} from '../constants.js';
import type { Character, SpriteData } from '../types.js';
import { MATRIX_EFFECT_DURATION } from '../types.js';

/**
 * How far through the effect a character is, and how solid its body therefore is.
 *
 * Both live here, exported, because there are now TWO renderers of this effect — the sheet path
 * that draws the body from the atlas with the rain tiled over it, and the pixel path below that
 * stands in when the rain sheet did not load. A second copy of `progress * 1.35` in the client is
 * exactly the drift AGENTS.md describes for the cadence tables: nothing would ever look wrong
 * enough to notice, and the two would stop agreeing.
 */
export function matrixProgress(ch: Character): number {
  return Math.max(0, Math.min(1, ch.matrixEffectTimer / MATRIX_EFFECT_DURATION));
}

/**
 * The body's opacity: solid a little before the sweep finishes on the way in, and not fully gone
 * until it has passed on the way out, so the figure never snaps at either end.
 */
export function matrixBodyAlpha(ch: Character): number {
  const progress = matrixProgress(ch);
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

/** Hash-based flicker: ~70% visible for shimmer effect */
function flickerVisible(col: number, row: number, time: number): boolean {
  const t = Math.floor(time * MATRIX_FLICKER_FPS);
  const hash = (col * 7 + row * 13 + t * 31) & 0xff;
  return hash < MATRIX_FLICKER_VISIBILITY_THRESHOLD;
}

function generateSeeds(): number[] {
  const seeds: number[] = [];
  for (let i = 0; i < MATRIX_SEED_COUNT; i++) {
    seeds.push(Math.random());
  }
  return seeds;
}

export { generateSeeds as matrixEffectSeeds };

/**
 * Render a character materialising or dissolving under Matrix-style digital rain, pixel by pixel.
 *
 * **This is the FALLBACK path, and it is the reference.** The client draws the effect from a tiled
 * sheet (`client/src/render/matrixRain.ts`) and only comes here when that sheet is missing — an
 * effect sheet is fetched over HTTP and a failure there is deliberately not fatal, so the choice is
 * between this and no effect at all. Do not promote it back: it fills every cell of the frame
 * rectangle twice per frame into a private per-character canvas, which is 581 fills for a 16×32
 * character and 4 376 for a 64×64 one, and measured 7.10 ms per frame with five 64×64 figures
 * materialising at once.
 *
 * The body's opacity is driven by overall progress, and the rain is drawn over
 * it — so the figure is always whole, just fainter or more solid. It used to be
 * the other way round: the rain's head *uncovered* the character row by row on
 * the way down, which meant that for most of the animation the legs did not
 * exist yet and a head-and-torso hovered in the air. That reads as a figure
 * missing its lower half rather than as a materialisation, and no amount of
 * tuning the trail length fixes it — a reveal front is a reveal front.
 *
 * The rain keeps the per-column stagger, so the sweep still looks like falling
 * code rather than a uniform fade.
 */
export function renderMatrixEffect(
  ctx: CanvasRenderingContext2D,
  ch: Character,
  spriteData: SpriteData,
  drawX: number,
  drawY: number,
  zoom: number,
): void {
  const progress = matrixProgress(ch);
  const time = ch.matrixEffectTimer;
  // Measured off the sprite, never assumed: frame size is per-character (see
  // CharacterSpec), and a hardcoded row count silently stopped drawing every
  // taller character below that row for the effect's whole duration.
  const rows = spriteData.length;
  const cols = rows > 0 ? spriteData[0].length : 0;
  const totalSweep = rows + MATRIX_TRAIL_LENGTH;
  const bodyAlpha = matrixBodyAlpha(ch);

  for (let col = 0; col < cols; col++) {
    // Stagger: each column starts at a slightly different time.
    const stagger = (ch.matrixEffectSeeds[col] ?? 0) * MATRIX_COLUMN_STAGGER_RANGE;
    const colProgress = Math.max(0, Math.min(1, (progress - stagger) / (1 - MATRIX_COLUMN_STAGGER_RANGE)));
    const headRow = colProgress * totalSweep;

    for (let row = 0; row < rows; row++) {
      const pixel = spriteData[row]?.[col];
      const px = drawX + col * zoom;
      const py = drawY + row * zoom;

      // 1. The body, whole, at the current opacity.
      if (pixel && pixel !== '' && bodyAlpha > 0) {
        ctx.globalAlpha = bodyAlpha;
        ctx.fillStyle = pixel;
        ctx.fillRect(px, py, zoom, zoom);
        ctx.globalAlpha = 1;
      }

      // 2. The rain on top: a bright head with a fading trail behind it.
      const distFromHead = headRow - row;
      if (distFromHead < 0 || distFromHead >= MATRIX_TRAIL_LENGTH) continue;
      if (distFromHead < 1) {
        ctx.fillStyle = MATRIX_HEAD_COLOR;
        ctx.fillRect(px, py, zoom, zoom);
        continue;
      }
      if (!flickerVisible(col, row, time)) continue;
      const trailPos = distFromHead / MATRIX_TRAIL_LENGTH;
      const alpha = (1 - trailPos) * MATRIX_TRAIL_EMPTY_ALPHA;
      ctx.fillStyle =
        trailPos < MATRIX_TRAIL_MID_THRESHOLD
          ? matrixGreenBright(alpha)
          : trailPos < MATRIX_TRAIL_DIM_THRESHOLD
            ? matrixGreenMid(alpha)
            : matrixGreenDim(alpha);
      ctx.fillRect(px, py, zoom, zoom);
    }
  }
}
