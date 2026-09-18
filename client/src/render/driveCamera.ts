/**
 * The driving camera: it looks ahead, and it widens with speed.
 *
 * The map STANDS STILL, facing north, and the kart turns within it — which is what every top-down
 * racer does, and what this world's art is drawn for. The camera used to rotate so that the
 * direction of travel pointed up the screen; that was dropped on 2026-09-15 after it was reported
 * as not suiting the presentation ("das Drehen der Karte passt so überhaupt nicht zu unserer
 * Top-Down-Darstellung"), and the reason it had been worth trying had expired anyway: its own
 * justification was that a race zone has no upright 2.5D art for a turned camera to lay on its
 * side, and the raceway's paddock now has exactly that — trees, buildings, a bridge.
 *
 * What is left is the half that was never the problem, plus what replaces the turning:
 *
 *  - **LOOKING AHEAD**, borrowed as an idea from Dust Racing 2D: the camera leads the kart in
 *    proportion to its speed, so at pace you see where you are going instead of where you are.
 *  - **WIDENING**, which is where the sense of speed goes now that the world no longer sweeps
 *    past a fixed nose. The view eases out towards `SPEED_ZOOM_MIN` of the zoom the viewer chose,
 *    so the track opens up as you accelerate and closes in again when you slow for a corner.
 *
 * Both hang off ONE fraction of top speed (`speedFraction`), deliberately: two curves that
 * disagree about what "flat out" means would have the camera at its widest while still leading
 * for half throttle.
 *
 * Everything here is plain numbers — no Phaser types — so the conventions can be pinned by a test
 * rather than judged from a screenshot.
 */

/** How far ahead of itself the camera looks at full speed, in tiles. */
export const LOOK_AHEAD_TILES = 3.5;
/** The zoom at full speed, as a factor on the zoom the viewer chose with the wheel. */
export const SPEED_ZOOM_MIN = 0.75;
/** How fast the widening follows a change of speed, per second. */
export const SPEED_ZOOM_EASE_PER_SEC = 2;

/**
 * How near top speed, 0…1 — the one input both camera effects read.
 *
 * Clamped at both ends: a reversing kart or a shove that reads as negative speed gives 0 rather
 * than a lead pointing behind the car, and a bump that briefly measures faster than the engine can
 * go does not throw the view wider than flat out.
 */
export function speedFraction(speed: number, maxSpeed: number): number {
  if (!(maxSpeed > 0)) return 0;
  return Math.max(0, Math.min(1, speed / maxSpeed));
}

/**
 * Where the camera centres: ahead of the kart, in proportion to how fast it is going.
 *
 * `speed` and `maxSpeed` are px/s.
 */
export function lookAheadPoint(
  x: number,
  y: number,
  heading: number,
  speed: number,
  maxSpeed: number,
  tileSize: number,
): { x: number; y: number } {
  const lead = speedFraction(speed, maxSpeed) * LOOK_AHEAD_TILES * tileSize;
  return { x: x + Math.cos(heading) * lead, y: y + Math.sin(heading) * lead };
}

/**
 * The zoom factor for a given speed: 1 at rest, `SPEED_ZOOM_MIN` flat out.
 *
 * A FACTOR rather than a zoom, because the viewer's wheel owns the zoom and the two must not
 * fight — the scene multiplies this onto whatever was chosen, so a spectator who zoomed out to
 * study the circuit stays zoomed out and a driver still feels the track open up.
 */
export function speedZoom(speed: number, maxSpeed: number): number {
  return 1 - (1 - SPEED_ZOOM_MIN) * speedFraction(speed, maxSpeed);
}

/**
 * Ease `from` towards `to` at `perSec`, snapping once it is within `epsilon`.
 *
 * The snap is what stops the zoom creeping by a ten-thousandth every frame forever: the scene only
 * touches the camera when the number actually changed, and an exponential ease never arrives.
 */
export function easeTowards(from: number, to: number, dt: number, perSec: number, epsilon = 0.002): number {
  const k = Math.min(1, Math.max(0, dt) * perSec);
  const next = from + (to - from) * k;
  return Math.abs(next - to) < epsilon ? to : next;
}

/** The little of a camera this maths needs — so nothing here imports Phaser. */
export interface ViewCamera {
  /** World point under the centre of the viewport. */
  centreX: number;
  centreY: number;
  width: number;
  height: number;
  zoom: number;
}

/**
 * World pixels → screen pixels.
 *
 * Hung off the camera's CENTRE rather than the world view's left edge, which is what the DOM
 * overlays used to do (`(x - worldView.x) * zoom`). The two agree exactly for a square camera, and
 * the centre is the form that survived a turning one; it is kept because it is the honest
 * statement of what the transform is, and because `worldView` is an AABB with one more way to be
 * subtly wrong.
 */
export function worldToScreen(cam: ViewCamera, wx: number, wy: number): { x: number; y: number } {
  return {
    x: cam.width / 2 + (wx - cam.centreX) * cam.zoom,
    y: cam.height / 2 + (wy - cam.centreY) * cam.zoom,
  };
}

/**
 * The camera's bounds: how far it may scroll, given the map and what fits on screen.
 *
 * Phaser clamps `scrollX` to `bounds.x + (displayWidth - width) / 2` and refuses to go past
 * `bounds.x + bounds.width - displayWidth` — so when the bounds are SMALLER than the view, both
 * ends collapse onto the first value and the camera is pinned. That pinning is wanted (there is
 * nothing out there to pan to), but with the bounds set to the map it pins the screen's centre at
 * `displayWidth / 2` rather than at the map's middle: the map then sits off to one side with the
 * slack beside it, and no amount of dragging moves it. Reported from the desktop app as "die Karte
 * bleibt am linken Rand, ich kann sie nicht frei bewegen", and measured on the raceway in a
 * 1400 × 800 window: **251 world pixels off centre**, which is 117 on screen.
 *
 * So the bounds are at least as big as the VIEW and centred on the map, which makes Phaser's own
 * clamp land the map's middle in the middle of the screen. Everything else is unchanged: while the
 * map is bigger than the view — and always while DRIVING, where the camera has to be able to lead
 * the car past the edge — the generous half-a-screen margin stays, because that is what lets the
 * camera move at all.
 */
export function cameraBounds(opts: {
  officeW: number;
  officeH: number;
  viewW: number;
  viewH: number;
  driving: boolean;
}): { x: number; y: number; width: number; height: number } {
  const { officeW, officeH, viewW, viewH, driving } = opts;
  const overscrollX = !driving && viewW >= officeW ? 0 : viewW / 2;
  const overscrollY = !driving && viewH >= officeH ? 0 : viewH / 2;
  const width = Math.max(officeW + overscrollX * 2, viewW);
  const height = Math.max(officeH + overscrollY * 2, viewH);
  return { x: officeW / 2 - width / 2, y: officeH / 2 - height / 2, width, height };
}
