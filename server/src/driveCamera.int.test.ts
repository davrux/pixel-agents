/**
 * The driving camera's conventions, pinned.
 *
 * This is client presentation and would normally have no test here — but its rules are the kind
 * that break silently and are judged from a screenshot otherwise: that the lead and the widening
 * read ONE fraction of top speed, that the ease arrives instead of creeping forever, and that the
 * world→screen transform the DOM overlays use agrees with what the canvas does. The module is
 * deliberately Phaser-free so this file can import it at all.
 *
 * The camera used to TURN with the kart, and most of this file was about that; the rotation was
 * dropped on 2026-09-15 (see driveCamera.ts). What those tests could never establish — which way
 * round Phaser turns the world for a given camera rotation — is the reason the replacement is a
 * zoom: a zoom has no sign to get backwards.
 *
 * TEST BOUNDARIES:
 *   @real-dependency: client/src/render/driveCamera.ts -- Mock? NO. It IS the thing under test.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  LOOK_AHEAD_TILES,
  SPEED_ZOOM_EASE_PER_SEC,
  SPEED_ZOOM_MIN,
  easeTowards,
  lookAheadPoint,
  speedFraction,
  speedZoom,
  worldToScreen,
  cameraBounds,
} from '../../client/src/render/driveCamera.js';

test('the camera leads the kart in proportion to speed, and never trails it', () => {
  const at = lookAheadPoint(100, 100, 0, 110, 110, 16); // flat out, heading east
  assert.ok(Math.abs(at.x - (100 + LOOK_AHEAD_TILES * 16)) < 1e-9, `lead: ${at.x - 100}`);
  assert.equal(Math.round(at.y), 100);
  const parked = lookAheadPoint(100, 100, 0, 0, 110, 16);
  assert.deepEqual(parked, { x: 100, y: 100 });
  // Reversing, or a shove that reads as negative speed, pulls the view back to the kart —
  // never behind it, which would point the camera away from where you are going.
  const backwards = lookAheadPoint(100, 100, 0, -50, 110, 16);
  assert.deepEqual(backwards, { x: 100, y: 100 });
  // Over the limit is clamped, not extrapolated.
  const over = lookAheadPoint(100, 100, 0, 400, 110, 16);
  assert.ok(Math.abs(over.x - at.x) < 1e-9, 'a bumped kart threw the camera past its lead');
  // A track with no stated top speed leads by nothing rather than dividing by zero.
  assert.deepEqual(lookAheadPoint(100, 100, 0, 50, 0, 16), { x: 100, y: 100 });
});

test('the view widens with speed, up to its limit and no further', () => {
  assert.equal(speedZoom(0, 320), 1, 'a parked kart is not zoomed out at all');
  assert.ok(Math.abs(speedZoom(320, 320) - SPEED_ZOOM_MIN) < 1e-9, 'flat out is not the full widening');
  assert.ok(Math.abs(speedZoom(900, 320) - SPEED_ZOOM_MIN) < 1e-9, 'a bump widened the view past flat out');
  assert.equal(speedZoom(-40, 320), 1, 'reversing zoomed the wrong way');
  // Monotone, so accelerating never pulls the view back IN.
  let prev = speedZoom(0, 320);
  for (let v = 10; v <= 320; v += 10) {
    const z = speedZoom(v, 320);
    assert.ok(z <= prev + 1e-12, `zoom rose at ${v} px/s: ${z} after ${prev}`);
    prev = z;
  }
});

test('the lead and the widening read the same fraction of top speed', () => {
  // Two curves that disagreed about what "flat out" means would have the view at its widest while
  // still leading for half throttle. One function decides both, and this is what says so.
  for (let v = 0; v <= 320; v += 23) {
    const t = speedFraction(v, 320);
    const lead = lookAheadPoint(0, 0, 0, v, 320, 16).x / (LOOK_AHEAD_TILES * 16);
    const widen = (1 - speedZoom(v, 320)) / (1 - SPEED_ZOOM_MIN);
    assert.ok(Math.abs(lead - t) < 1e-9 && Math.abs(widen - t) < 1e-9, `at ${v} px/s: ${lead} vs ${widen}`);
  }
});

test('the ease arrives, and never overshoots on a long frame', () => {
  let z = 1;
  for (let i = 0; i < 600; i++) z = easeTowards(z, SPEED_ZOOM_MIN, 1 / 60, SPEED_ZOOM_EASE_PER_SEC);
  assert.equal(z, SPEED_ZOOM_MIN, 'never arrived — the camera would creep for the whole race');
  assert.equal(easeTowards(z, SPEED_ZOOM_MIN, 1 / 60, SPEED_ZOOM_EASE_PER_SEC), SPEED_ZOOM_MIN, 'it did not stay');
  // A stalled tab hands over a huge dt; the step is capped at the target rather than past it.
  assert.equal(easeTowards(1, 0.75, 30, SPEED_ZOOM_EASE_PER_SEC), 0.75);
  // A frame with no time in it changes nothing.
  assert.equal(easeTowards(0.9, 0.75, 0, SPEED_ZOOM_EASE_PER_SEC), 0.9);
  assert.equal(easeTowards(0.9, 0.75, -1, SPEED_ZOOM_EASE_PER_SEC), 0.9);
  // And it works in both directions — stepping out of a kart eases back to 1.
  let back = SPEED_ZOOM_MIN;
  for (let i = 0; i < 600; i++) back = easeTowards(back, 1, 1 / 60, SPEED_ZOOM_EASE_PER_SEC);
  assert.equal(back, 1);
});

test('world to screen agrees with the maths every overlay used before it existed', () => {
  const cam = { centreX: 200, centreY: 150, width: 800, height: 600, zoom: 2 };
  // What every overlay did on its own: (x - worldView.x) * zoom, with the view's left edge at
  // centre - width / (2 * zoom).
  const old = (wx: number, wy: number) => ({
    x: (wx - (cam.centreX - cam.width / (2 * cam.zoom))) * cam.zoom,
    y: (wy - (cam.centreY - cam.height / (2 * cam.zoom))) * cam.zoom,
  });
  for (const [wx, wy] of [[200, 150], [216, 150], [180, 130], [264, 214]]) {
    const a = worldToScreen(cam, wx, wy);
    const b = old(wx, wy);
    assert.ok(Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9, `(${wx},${wy}) drifted`);
  }
  // The camera's own centre is the middle of the viewport, at every zoom — including the ones the
  // speed widening produces, which are not round numbers.
  for (const zoom of [0.2, 0.75 * 1.5, 1, 1.5, 14]) {
    const mid = worldToScreen({ ...cam, zoom }, cam.centreX, cam.centreY);
    assert.ok(Math.abs(mid.x - 400) < 1e-9 && Math.abs(mid.y - 300) < 1e-9, `centre moved at zoom ${zoom}`);
  }
});

/**
 * The map ends up in the MIDDLE of the screen when it is smaller than the view.
 *
 * Asserted through Phaser's own clamp rather than against the bounds I chose — the numbers in
 * `cameraBounds` only mean something once that formula is applied to them, and the bug being fixed
 * was precisely a set of bounds that looked right and clamped wrong. The formula is copied from
 * `BaseCamera.clampX` in the installed Phaser (4.2.1) and is four lines long; a test that instead
 * re-stated my own arithmetic would have passed on the broken version too.
 */
const clamp = (scroll: number, bound: number, span: number, view: number, screen: number): number => {
  // Phaser: bx = bounds.x + (displayWidth - width) / 2, bw = max(bx, bx + bounds.width - dw)
  const bx = bound + (view - screen) / 2;
  const bw = Math.max(bx, bx + span - view);
  return Math.min(Math.max(scroll, bx), bw);
};

test('a map smaller than the view is centred, not pushed against an edge', () => {
  // The raceway as it is now, in a desktop window: 156x107 tiles, and a view wider than the map.
  const officeW = 156 * 16;
  const officeH = 107 * 16;
  const screenW = 1400;
  const screenH = 800;
  const zoom = Math.min(screenW / officeW, screenH / officeH); // what minZoom() lands on
  const viewW = screenW / zoom;
  const viewH = screenH / zoom;
  assert.ok(viewW > officeW, 'this fixture no longer has slack beside the map');

  const b = cameraBounds({ officeW, officeH, viewW, viewH, driving: false });
  // Whatever the camera asks for, the clamp puts the screen's centre on the map's centre.
  for (const asked of [-9999, 0, officeW / 2, 9999]) {
    const scrollX = clamp(asked, b.x, b.width, viewW, screenW);
    const middle = scrollX + screenW / 2;
    assert.ok(
      Math.abs(middle - officeW / 2) < 1,
      `asking for ${asked} put the screen's middle at ${middle.toFixed(0)} instead of ${officeW / 2}`,
    );
  }
  // The bounds set to the MAP — what this replaced — miss by a quarter of the slack, which is what
  // "the map sits at the left edge" was.
  const naive = clamp(0, 0, officeW, viewW, screenW) + screenW / 2;
  assert.ok(
    Math.abs(naive - officeW / 2) > 100,
    `the old bounds were only ${Math.abs(naive - officeW / 2).toFixed(0)} px off, so this test proves little`,
  );
});

test('a map bigger than the view keeps its half-a-screen of overscroll', () => {
  // Nothing about panning a big map changes: that margin is what lets the camera move at all, and
  // a driver keeps it even when the whole circuit would fit on screen.
  const officeW = 2496;
  const officeH = 1712;
  for (const driving of [false, true]) {
    const b = cameraBounds({ officeW, officeH, viewW: 900, viewH: 500, driving });
    assert.equal(b.x, -450, 'lost the horizontal overscroll');
    assert.equal(b.width, officeW + 900, 'lost the horizontal overscroll');
    assert.equal(b.y, -250, 'lost the vertical overscroll');
  }
  // …and DRIVING keeps it even where the view is bigger, or the camera cannot lead the car.
  const wide = cameraBounds({ officeW: 800, officeH: 600, viewW: 3000, viewH: 1700, driving: true });
  assert.equal(wide.width, 800 + 3000, 'a driving camera lost the room it needs to lead the car');
});
