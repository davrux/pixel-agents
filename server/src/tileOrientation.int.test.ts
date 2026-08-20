/**
 * Does our orientation table draw a cell the way Tiled shows it?
 *
 * This is the one part of per-cell flipping that cannot be checked by looking at it: Tiled
 * mirrors after transposing, a renderer mirrors before rotating, and reconciling the two is
 * four cases of "almost right". A wrong entry does not throw and does not look broken — it
 * draws a plausible picture in the wrong orientation, which nobody notices until a road
 * corner points the wrong way in a corner of a map.
 *
 * So the reference here is not a copy of the table: it is Tiled's documented rule expressed
 * as coordinates ("the diagonal flip is done first, then the horizontal and vertical flips"),
 * applied to the four corners of a cell. The test asks where each corner ENDS UP under both
 * rules and requires the answers to agree, for all eight combinations. Same idea as
 * poseFrames.int.test.ts measuring the frame arithmetic against the pixel path: two
 * independent statements of the same fact, so one of them can be wrong out loud.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ORIENT_D,
  ORIENT_H,
  ORIENT_MASK,
  ORIENT_V,
  cellOrientation,
  isTurned,
  quarterTurnsOf,
  turnedExtent,
} from '@pixel/shared/office/tileOrientation.js';

type Pt = readonly [number, number];
/** The unit cell's corners. 0/1 rather than pixels: the transform is what is being tested,
 *  not the tile size, and integers make a failure readable. */
const CORNERS: readonly Pt[] = [
  [0, 0],
  [1, 0],
  [0, 1],
  [1, 1],
];

const name = (bits: number): string =>
  [bits & ORIENT_D ? 'D' : '', bits & ORIENT_H ? 'H' : '', bits & ORIENT_V ? 'V' : ''].join('') || 'as painted';

/**
 * Tiled's own rule, from the TMX format's "tile flipping" section: the diagonal flip (an
 * x/y axis swap) happens FIRST, then the horizontal, then the vertical.
 */
function tiled(bits: number, [x, y]: Pt): Pt {
  let u = x;
  let v = y;
  if (bits & ORIENT_D) [u, v] = [v, u];
  if (bits & ORIENT_H) u = 1 - u;
  if (bits & ORIENT_V) v = 1 - v;
  return [u, v];
}

/**
 * What a renderer does with our table: mirror in the picture's own space (setFlipX/setFlipY
 * flip the texture), THEN rotate the result clockwise about the cell's centre.
 */
function rendered(bits: number, [x, y]: Pt): Pt {
  const o = cellOrientation(bits);
  let u = o.flipX ? 1 - x : x;
  let v = o.flipY ? 1 - y : y;
  for (let turned = 0; turned < o.angle; turned += 90) [u, v] = [1 - v, u]; // 90° clockwise
  return [u, v];
}

test('every one of Tiled\'s eight orientations is drawn the way Tiled shows it', () => {
  for (let bits = 0; bits <= ORIENT_MASK; bits++) {
    for (const corner of CORNERS) {
      assert.deepEqual(
        rendered(bits, corner),
        tiled(bits, corner),
        `${name(bits)}: corner ${corner.join(',')} lands in the wrong place`,
      );
    }
  }
});

test('the four diagonal states are the only ones that need a rotation', () => {
  for (let bits = 0; bits <= ORIENT_MASK; bits++) {
    const rotated = cellOrientation(bits).angle !== 0;
    assert.equal(rotated, (bits & ORIENT_D) !== 0, `${name(bits)}: rotation disagrees with the diagonal bit`);
  }
  // Why it matters: the unrotated path draws with origin (0,0) at the cell's corner, and
  // only a rotation forces the centred-origin variant. If a non-diagonal state ever asked
  // for one, every plain mirrored floor tile would take the slower path for nothing.
});

test('the eight orientations are all different — no entry is a duplicate of another', () => {
  // A copy-paste slip in the table would silently alias two states, and the corner test
  // above cannot catch it: it would simply check the same wrong transform twice.
  const seen = new Map<string, number>();
  for (let bits = 0; bits <= ORIENT_MASK; bits++) {
    const shape = CORNERS.map((c) => rendered(bits, c).join(',')).join(' ');
    const clash = seen.get(shape);
    assert.equal(clash, undefined, `${name(bits)} draws exactly like ${clash === undefined ? '' : name(clash)}`);
    seen.set(shape, bits);
  }
});

test('a mask from an untrusted layout cannot ask for a ninth orientation', () => {
  // The dense tile arrays have no content check of their own (layoutSanitize covers texts,
  // images and actions), so the reader is the bound: anything outside the three bits is
  // masked away rather than indexing off the end of the table.
  for (const bogus of [8, 64, 255, 0x7fffffff, -1, 1.5]) {
    const o = cellOrientation(bogus);
    assert.ok(o, `mask ${bogus} produced nothing`);
    assert.ok([0, 90, 270].includes(o.angle), `mask ${bogus} produced angle ${o.angle}`);
  }
  assert.equal(cellOrientation(undefined).angle, 0);
  assert.equal(isTurned(undefined), false);
  assert.equal(isTurned(0), false);
  assert.equal(isTurned(ORIENT_H), true);
});

// ── What a turned piece OCCUPIES ────────────────────────────────────────────
//
// Cells are axis-aligned, so a diagonal piece can only be given the rectangle around it.
// Two things here are load-bearing rather than obvious: the quarter turns must be an EXACT
// swap (cos(90°) is 6e-17, and a footprint that ceils 16.0000000000000002 blocks a whole
// extra cell), and the free angles must be rounded to whole pixels for the same reason at
// a smaller scale.

test('a quarter turn is an exact swap — no float drift, no extra cell', () => {
  for (const angle of [90, 270, -90, 450]) {
    assert.deepEqual(turnedExtent(32, 16, angle), { w: 16, h: 32 }, `${angle}° must swap exactly`);
  }
  for (const angle of [0, 180, 360, -180]) {
    assert.deepEqual(turnedExtent(32, 16, angle), { w: 32, h: 16 }, `${angle}° must keep the sides`);
  }
  assert.deepEqual(turnedExtent(32, 16, undefined), { w: 32, h: 16 }, 'and no angle at all changes nothing');
});

test('a free angle gets the rectangle around it, in whole pixels', () => {
  // 32×16 at 37°: 32·cos37 + 16·sin37 ≈ 35.19 wide, 32·sin37 + 16·cos37 ≈ 32.04 tall. The
  // rounding is what keeps that four-hundredths of a pixel from costing a blocked row.
  assert.deepEqual(turnedExtent(32, 16, 37), { w: 35, h: 32 });
  assert.equal(Math.ceil(35 / 16), 3, 'three cells wide');
  assert.equal(Math.ceil(32 / 16), 2, 'two cells tall — not three, which the unrounded 32.04 would have given');

  // Opposite angles enclose the same rectangle, and a square piece is symmetric in it.
  assert.deepEqual(turnedExtent(32, 16, 37), turnedExtent(32, 16, 217));
  assert.deepEqual(turnedExtent(16, 16, 45), turnedExtent(16, 16, 135));
  // 45° on a square is the widest it gets: 16·√2 ≈ 22.6 → 23.
  assert.deepEqual(turnedExtent(16, 16, 45), { w: 23, h: 23 });
});

test('quarterTurnsOf answers null only for an angle cells cannot express', () => {
  assert.equal(quarterTurnsOf(0), 0);
  assert.equal(quarterTurnsOf(90), 1);
  assert.equal(quarterTurnsOf(180), 2);
  assert.equal(quarterTurnsOf(270), 3);
  assert.equal(quarterTurnsOf(-90), 3, 'normalized, not rejected');
  assert.equal(quarterTurnsOf(450), 1);
  assert.equal(quarterTurnsOf(37), null);
  assert.equal(quarterTurnsOf(322.883756654971), null);
  assert.equal(quarterTurnsOf(Number.NaN), null, 'and nonsense is not a quarter turn either');
});
