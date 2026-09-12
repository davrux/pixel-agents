/**
 * The driving camera: it turns with the kart, and it looks ahead.
 *
 * Two effects, and they are separable on purpose. TURNING is what makes the view read as
 * "behind the kart": the camera rotates so the direction of travel points up the screen, which
 * puts the kart's nose at the top and — because a character sheet's four rows are
 * `down, up, right, left` and `up` IS the back view — shows the driver from behind with no new
 * art at all. LOOKING AHEAD is the smaller half, borrowed as an idea from Dust Racing 2D: the
 * camera leads the kart in proportion to its speed, so at pace you see where you are going
 * instead of where you are.
 *
 * It is NOT Mode 7. The ground stays a flat top-down tile map; only the frame it is seen in
 * turns. That was the deliberate choice — the back view for no new art, and the perspective
 * version left open (a fragment shader on a full-screen quad, which Phaser 4 can do through
 * `add.shader`) for the day the flatness is what bothers somebody.
 *
 * Everything here is plain numbers — no Phaser types — so the conventions below can be pinned by
 * a test rather than judged from a screenshot. Two of them are the ones that break silently:
 *
 *  - **The rotation and the heading it puts up-screen are ONE pair of functions**
 *    (`driveCameraRotation` / `cameraUpHeading`). Every reader of "which way is up" goes through
 *    the second, so if the engine's sign convention is ever the other way round, both change
 *    together and nothing else in the client has an opinion.
 *  - **`worldToScreen` is the inverse the DOM overlays need.** Labels, prompts and bubbles are
 *    HTML positioned over the canvas, and they were all doing `(x - worldView.x) * zoom`, which
 *    silently assumes an unrotated camera — correct for the whole world until this file existed,
 *    and wrong by up to the screen diagonal the moment it turns.
 */
import { facingFromHeading } from '@pixel/shared/office/race/kart.js';
import { wrapAngle } from '@pixel/shared/office/race/track.js';

/** How far ahead of itself the camera looks at full speed, in tiles. */
export const LOOK_AHEAD_TILES = 3.5;
/** How fast the view is allowed to swing round, in radians per second. */
export const CAMERA_TURN_RAD_PER_SEC = 4.5;

/** The four body rows, in the order a sheet stores them. */
export type BodyFacing = 0 | 1 | 2 | 3;

/** Screen up, as an angle in the world's own convention (0 = east, growing clockwise). */
const SCREEN_UP = -Math.PI / 2;

/**
 * The camera rotation that makes `heading` point up the screen.
 *
 * Phaser's camera rotation turns the WORLD WITH it: a world direction `a` lands on screen at
 * `a + rotation`. That sign was established by driving and looking, not from the docs — the
 * typings do not even expose a readable `rotation` — and getting it backwards turns the track
 * the wrong way while every test still passes, which is exactly why it is written down here and
 * why every other reader goes through `cameraUpHeading` instead of doing its own arithmetic.
 */
export function driveCameraRotation(heading: number): number {
  return SCREEN_UP - heading;
}

/** Which world heading is currently up-screen. The exact inverse of `driveCameraRotation`. */
export function cameraUpHeading(rotation: number): number {
  return wrapAngle(SCREEN_UP - rotation);
}

/**
 * Turn `from` towards `to` the short way round, by at most `maxStep`.
 *
 * The short way is the whole point: a kart crossing due north steps between angles that differ
 * by nearly a full turn, and a camera that interpolated the long way would spin the world once
 * per lap. Snapping instead of easing is the other failure — at 60 Hz a bang-bang steering input
 * makes the horizon jitter, which is unpleasant in a way a still screenshot never shows.
 */
export function turnTowards(from: number, to: number, maxStep: number): number {
  let d = to - from;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  if (Math.abs(d) <= maxStep) return to;
  return from + Math.sign(d) * maxStep;
}

/**
 * Where the camera centres: ahead of the kart, in proportion to how fast it is going.
 *
 * `speed` and `maxSpeed` are px/s; the lead is clamped to [0, 1] of `LOOK_AHEAD_TILES` so a
 * bumped or reversing kart pulls the view back to itself rather than behind itself.
 */
export function lookAheadPoint(
  x: number,
  y: number,
  heading: number,
  speed: number,
  maxSpeed: number,
  tileSize: number,
): { x: number; y: number } {
  const t = maxSpeed > 0 ? Math.max(0, Math.min(1, speed / maxSpeed)) : 0;
  const lead = t * LOOK_AHEAD_TILES * tileSize;
  return { x: x + Math.cos(heading) * lead, y: y + Math.sin(heading) * lead };
}

/** The little of a camera this maths needs — so nothing here imports Phaser. */
export interface ViewCamera {
  /** World point under the centre of the viewport. */
  centreX: number;
  centreY: number;
  width: number;
  height: number;
  zoom: number;
  rotation: number;
}

/**
 * World pixels → screen pixels, honouring zoom AND rotation.
 *
 * At `rotation === 0` this is exactly what the overlays computed before — `(x - worldView.x) * zoom`
 * — because the world view's left edge is `centre - width / (2 * zoom)`.
 */
export function worldToScreen(cam: ViewCamera, wx: number, wy: number): { x: number; y: number } {
  const dx = (wx - cam.centreX) * cam.zoom;
  const dy = (wy - cam.centreY) * cam.zoom;
  const cos = Math.cos(cam.rotation);
  const sin = Math.sin(cam.rotation);
  return {
    x: cam.width / 2 + dx * cos - dy * sin,
    y: cam.height / 2 + dx * sin + dy * cos,
  };
}

/**
 * Which body row to draw for something facing `worldAngle`, when `upHeading` is up-screen.
 *
 * The sprite itself is kept upright (the renderer counter-rotates it), so what has to change is
 * WHICH picture: a driver heading the way the camera looks must show its back, whatever compass
 * direction that happens to be. With `worldAngle === upHeading` this returns 3 — `up`, the back
 * row — which is the whole reason the turning camera needs no new art.
 */
export function screenFacing(worldAngle: number, upHeading: number): BodyFacing {
  return facingFromHeading(worldAngle - upHeading + SCREEN_UP) as BodyFacing;
}

/** A body's facing as an angle, for the rows a sheet stores (`down, up, right, left`). */
export function facingAngle(facing: number): number {
  return facing === 0 ? Math.PI / 2 : facing === 1 ? Math.PI : facing === 3 ? -Math.PI / 2 : 0;
}
