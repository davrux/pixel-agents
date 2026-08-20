/**
 * How a map cell's picture is oriented — Tiled's three flip bits, resolved in one place.
 *
 * A mapper mirroring a tile in Tiled (X/Y/Z while painting) sets one of three high bits on
 * the gid. Two of the three are a plain mirror; the third is a *transpose* — the axes swap —
 * and together they express all eight orientations of a square picture. The engine used to
 * throw all three away: `baseGid()` strips them so the tile still resolves (without that a
 * mirrored cell matched no tileset range and the cell silently became VOID), but the
 * orientation was lost, so the game drew what Tiled did not show.
 *
 * This module is the single answer to "how is this cell turned", for the same reason
 * `spriteForPose` is the single answer to which frame a pose draws: the composition below is
 * the part that is easy to get subtly wrong, and a wrong table looks ALMOST right — only the
 * four diagonal states are affected, and two of those are plausible pictures. So the rule is
 * stated once, as arithmetic, and `tileOrientation.int.test.ts` derives Tiled's own transform
 * from first principles (where each corner of the cell lands) and asserts this table produces
 * the same mapping for all eight combinations.
 *
 * The rule, in Tiled's documented order: **the diagonal flip is applied first, then the
 * horizontal, then the vertical.** A renderer, on the other hand, mirrors in the picture's own
 * space and rotates afterwards, so the two orders have to be reconciled rather than copied:
 *
 *   Tiled      transform = Mirror(H, V) ∘ Transpose^D
 *   renderer   transform = Rotate(angle) ∘ Mirror(flipX, flipY)
 *
 * Solving that for the four diagonal cases is what the table below is. Note that H+V needs no
 * rotation even though it equals a 180° turn — two mirrors are cheaper than the rotated draw
 * path, and it keeps rotation to the cases that genuinely need it.
 */

import { Direction } from './types.js';

/** Tiled's flip bits, as the small mask stored per cell (see OfficeLayout.tileFlip). */
export const ORIENT_H = 1;
export const ORIENT_V = 2;
export const ORIENT_D = 4;
/** Everything the mask can say — anything else in a stored layout is not ours. */
export const ORIENT_MASK = ORIENT_H | ORIENT_V | ORIENT_D;

export interface CellOrientation {
  /** Mirror the picture horizontally, in its own space (Phaser's `setFlipX`). */
  flipX: boolean;
  /** Mirror it vertically (`setFlipY`). */
  flipY: boolean;
  /** Degrees CLOCKWISE, applied after the mirrors. Only ever 0, 90 or 270: a
   *  half turn is expressed as two mirrors instead, so a rotation in this field
   *  means the cell was flipped diagonally and needs the rotated draw path. */
  angle: 0 | 90 | 270;
}

const UNTURNED: CellOrientation = { flipX: false, flipY: false, angle: 0 };

/**
 * The eight orientations, indexed by the mask. Written out rather than computed, because
 * the derivation belongs in prose (above) and in the test — not in four lines of clever
 * arithmetic that nobody can check by reading.
 */
const TABLE: readonly CellOrientation[] = [
  UNTURNED, //                     0        as painted
  { flipX: true, flipY: false, angle: 0 }, //   H      mirrored left/right
  { flipX: false, flipY: true, angle: 0 }, //   V      mirrored top/bottom
  { flipX: true, flipY: true, angle: 0 }, //    H+V    both, i.e. a half turn
  { flipX: false, flipY: true, angle: 90 }, //  D      transposed (reflected along ↘)
  { flipX: false, flipY: false, angle: 90 }, // D+H    a quarter turn clockwise
  { flipX: false, flipY: false, angle: 270 }, // D+V   a quarter turn anticlockwise
  { flipX: true, flipY: false, angle: 90 }, //  D+H+V  reflected along ↗
];

/**
 * How to draw a cell whose stored orientation mask is `bits`.
 *
 * Masked before use, so a layout that arrived over the wire cannot ask for anything but
 * these eight — a pushed map is untrusted input like everything else, and the dense tile
 * arrays it carries have no other content check (see server/src/layoutSanitize.ts).
 */
export function cellOrientation(bits: number | undefined): CellOrientation {
  if (!bits) return UNTURNED; // the overwhelmingly common case, and 0/undefined agree
  return TABLE[bits & ORIENT_MASK];
}

/**
 * A free angle in degrees as a number of quarter turns clockwise, or null when it is not a
 * multiple of 90.
 *
 * Tiled lets an OBJECT be rotated to any angle, which a tile-layer cell cannot be — and for
 * furniture only quarter turns can be honoured, because the footprint it blocks is counted
 * in cells. 37° has no cell answer, so the import refuses it rather than rounding: rounding
 * would put the collision somewhere the mapper can see it is not.
 */
export function quarterTurnsOf(angle: number | undefined): 0 | 1 | 2 | 3 | null {
  if (!angle) return 0;
  if (!Number.isFinite(angle)) return null;
  const norm = ((angle % 360) + 360) % 360;
  if (norm % 90 !== 0) return null;
  return (norm / 90) as 0 | 1 | 2 | 3;
}

/** Does this angle swap a piece's width and height? True for a quarter turn either way. */
export function turnSwapsSides(angle: number | undefined): boolean {
  const q = quarterTurnsOf(angle);
  return q === 1 || q === 3;
}

/**
 * A facing, turned clockwise by the same angle.
 *
 * Applied AFTER the mirrors, matching both Tiled (an object's rotation turns the
 * already-flipped tile image) and the renderer (`Rotate ∘ Mirror`, see above) — so a
 * chair's sitter faces where the chair's back now points, whatever else was done to it.
 */
export function turnFacing(dir: Direction, angle: number | undefined): Direction {
  const q = quarterTurnsOf(angle);
  if (!q) return dir;
  // Clockwise on screen: down → left → up → right → down.
  const CW: Direction[] = [Direction.DOWN, Direction.LEFT, Direction.UP, Direction.RIGHT];
  const at = CW.indexOf(dir);
  return at < 0 ? dir : CW[(at + q) % 4];
}

/**
 * The same answer for a PLACEMENT, which carries the three bits as booleans rather than
 * as a mask (`PlacedDecal`/`PlacedFurniture`/`PlacedImage` predate the mask and store one
 * flag each). Same table either way — the point of routing both through here is that
 * "how is this turned" must not have a second implementation for the placement case.
 */
export function orientationOf(
  flippedHorizontally: boolean | undefined,
  flippedVertically: boolean | undefined,
  flippedDiagonally: boolean | undefined,
): CellOrientation {
  return cellOrientation(
    (flippedHorizontally ? ORIENT_H : 0) | (flippedVertically ? ORIENT_V : 0) | (flippedDiagonally ? ORIENT_D : 0),
  );
}

/** True when this cell is turned at all — lets a caller keep its fast path. */
export function isTurned(bits: number | undefined): boolean {
  return ((bits ?? 0) & ORIENT_MASK) !== 0;
}
