import {
  MATRIX_COLUMN_STAGGER_RANGE,
  MATRIX_FLICKER_FPS,
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
 * Render a character materialising or dissolving under Matrix-style digital rain.
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
  const progress = Math.max(0, Math.min(1, ch.matrixEffectTimer / MATRIX_EFFECT_DURATION));
  const isSpawn = ch.matrixEffect === 'spawn';
  const time = ch.matrixEffectTimer;
  // Measured off the sprite, never assumed: frame size is per-character (see
  // CharacterSpec), and a hardcoded row count silently stopped drawing every
  // taller character below that row for the effect's whole duration.
  const rows = spriteData.length;
  const cols = rows > 0 ? spriteData[0].length : 0;
  const totalSweep = rows + MATRIX_TRAIL_LENGTH;
  // Solid a little before the sweep finishes on the way in, and not fully gone
  // until it has passed on the way out, so the body never snaps at either end.
  const bodyAlpha = isSpawn ? Math.min(1, progress * 1.35) : Math.max(0, 1 - progress * 1.15);

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
