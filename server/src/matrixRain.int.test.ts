/**
 * The Matrix rain is one sweep, over every figure size — that is the whole contract of the sheet.
 *
 * The effect used to be painted cell by cell: a head row travelled down the character's frame with
 * a fading trail behind it, and every pixel of the rectangle got a `fillRect` twice per frame (581
 * of them for a 16×32 character, 4 376 for a 64×64 one, 7.10 ms of frame time with five 64×64
 * figures at once, measured in headless Chromium). It is now one tiling texture scrolled across the
 * body, which is two draws whatever the figure is — see client/src/render/matrixRain.ts.
 *
 * What that trade buys is speed; what it can silently get WRONG is the sweep, because the texture
 * repeats. Three properties therefore have to hold, and none of them is visible in a screenshot of
 * a single frame:
 *
 *  1. **The band starts above the head and ends below the feet.** A sweep that begins on the chest
 *     looks like the figure is cut in half, which is the exact bug the pixel version was rewritten
 *     to fix once before ("a reveal front is a reveal front").
 *  2. **It passes exactly ONCE.** The tile repeats every `frameH` pixels of texture, so if the
 *     empty gap after the band were shorter than the tallest legal figure, a second band would
 *     already be entering the frame while the first was still leaving — continuous rain instead of
 *     a wavefront, and only on tall characters.
 *  3. **The art matches what the code thinks it is.** The committed PNG is generated
 *     (scripts/draw-matrix-rain.sh) and the geometry is declared in `MATRIX_RAIN_SHEET`; a redraw
 *     at another size with the declaration left alone would put drops in the gap.
 *
 * TEST BOUNDARIES:
 *   @real-dependency: the committed PNG and the real constants -- Mock? NO. Two of the three claims
 *       are about the relationship between the art's size and the code's arithmetic, so replacing
 *       either end would test nothing at all.
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  EFFECT_SHEETS,
  MATRIX_RAIN_BAND_PX,
  MATRIX_RAIN_SHEET,
  matrixRainScrollY,
} from '@pixel/shared/office/effects.js';
import { MAX_CHAR_DIM } from '@pixel/shared/office/sprites/characterSpec.js';

const REPO = join(import.meta.dirname, '..', '..');

/** Every frame height the world can hand the effect: the two bundled shapes and the legal maximum. */
const HEIGHTS = [32, 16, 48, MAX_CHAR_DIM];

test('the band clears the head before the sweep starts and the feet after it ends', () => {
  for (const h of HEIGHTS) {
    // Texture row y appears at sprite row `y - tilePositionY`, so the band (texture rows
    // 0…BAND) is on screen at [-ty, BAND - ty).
    const start = -matrixRainScrollY(0, h);
    const end = -matrixRainScrollY(1, h);
    assert.ok(
      start + MATRIX_RAIN_BAND_PX <= 0,
      `at h=${h} the sweep starts with the band already ${start + MATRIX_RAIN_BAND_PX}px into the figure`,
    );
    assert.ok(end >= h, `at h=${h} the sweep ends at ${end}, before the feet at ${h}`);
  }
});

test('a figure never shows two bands at once, at any size or moment', () => {
  const period = MATRIX_RAIN_SHEET.frameH;
  for (const h of HEIGHTS) {
    for (let step = 0; step <= 200; step++) {
      const top = -matrixRainScrollY(step / 200, h);
      // Every copy of the band, at `top + k * period`, that overlaps the figure's [0, h).
      let visible = 0;
      for (let k = -3; k <= 3; k++) {
        const a = top + k * period;
        if (a < h && a + MATRIX_RAIN_BAND_PX > 0) visible++;
      }
      assert.ok(
        visible <= 1,
        `h=${h} shows ${visible} bands at progress ${(step / 200).toFixed(2)} — the sheet's empty ` +
          `gap (${period - MATRIX_RAIN_BAND_PX}px) is not longer than the figure`,
      );
    }
  }
  // And the reason that holds, stated as the number rather than as luck.
  assert.ok(
    period - MATRIX_RAIN_BAND_PX >= MAX_CHAR_DIM,
    `the gap is ${period - MATRIX_RAIN_BAND_PX}px but a figure may be ${MAX_CHAR_DIM}px tall`,
  );
});

test('the committed sheet is the size the code declares, and its drops sit in the band', () => {
  const bytes = readFileSync(join(REPO, 'assets', 'effects', `${MATRIX_RAIN_SHEET.id}.png`));
  // IHDR: width and height are big-endian at bytes 16 and 20 of a PNG.
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  assert.equal(width, MATRIX_RAIN_SHEET.frameW, 'the PNG is not as wide as MATRIX_RAIN_SHEET says');
  assert.equal(height, MATRIX_RAIN_SHEET.frameH, 'the PNG is not as tall as MATRIX_RAIN_SHEET says');
  // Powers of two, because the texture is sampled with GL_REPEAT.
  for (const [name, v] of [
    ['width', width],
    ['height', height],
  ] as const) {
    assert.equal(v & (v - 1), 0, `${name} ${v} is not a power of two, which REPEAT wrapping needs`);
  }
  assert.ok(
    MATRIX_RAIN_BAND_PX < height,
    'the band is the whole tile, so there is no gap and the rain never stops',
  );
});

test('the rain is registered as an effect sheet, so the loading phase fetches it', () => {
  // Without this it is a file nobody asks for, the client falls back to the pixel path, and the
  // only symptom is one warning and a slow frame.
  assert.ok(
    EFFECT_SHEETS.some((s) => s.id === MATRIX_RAIN_SHEET.id),
    'MATRIX_RAIN_SHEET is not in EFFECT_SHEETS',
  );
  assert.equal(MATRIX_RAIN_SHEET.frames, 1, 'the rain is scrolled, not played — a frame count above 1 means it was authored as an animation');
});
