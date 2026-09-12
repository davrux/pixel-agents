/**
 * The driving camera's conventions, pinned.
 *
 * This is client presentation and would normally have no test here — but three of its rules are
 * the kind that break silently and are judged from a screenshot otherwise: which frame ends up
 * up-screen, that the view turns the SHORT way round, and that the world→screen inverse the DOM
 * overlays use agrees with what the canvas does. The module is deliberately Phaser-free so this
 * file can import it at all.
 *
 * What these tests can NOT establish, and nothing here should pretend otherwise: which way round
 * PHASER turns the world for a given camera rotation. Every function below flipped sign together
 * when that was corrected and every assertion still passed — because they pin the module's
 * internal consistency, which is what a test can see. The engine's own convention was settled by
 * driving a kart in a real browser and looking at the track; it is written down in
 * `driveCamera.ts` beside the function that encodes it.
 *
 * TEST BOUNDARIES:
 *   @real-dependency: client/src/render/driveCamera.ts -- Mock? NO. It IS the thing under test.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';

import { Direction } from '@pixel/shared/office/types';

import {
  CAMERA_TURN_RAD_PER_SEC,
  LOOK_AHEAD_TILES,
  cameraUpHeading,
  driveCameraRotation,
  facingAngle,
  lookAheadPoint,
  screenFacing,
  turnTowards,
  worldToScreen,
} from '../../client/src/render/driveCamera.js';

const deg = (d: number): number => (d * Math.PI) / 180;

test('the rotation and the heading it puts up-screen are exact inverses', () => {
  for (let d = 0; d < 360; d += 7) {
    const h = deg(d);
    const back = cameraUpHeading(driveCameraRotation(h));
    assert.ok(Math.abs(back - h) < 1e-9, `heading ${d}° came back as ${((back * 180) / Math.PI).toFixed(2)}°`);
  }
  // Negative and over-a-turn headings wrap rather than escaping.
  assert.ok(cameraUpHeading(driveCameraRotation(deg(-30))) >= 0);
  assert.ok(cameraUpHeading(driveCameraRotation(deg(700))) < Math.PI * 2);
});

test('the driver shows its back, whatever compass direction it drives', () => {
  // The whole reason the turning camera needs no new art: facing the way the camera looks is
  // always the `up` row, which is the back view.
  for (let d = 0; d < 360; d += 11) {
    const h = deg(d);
    assert.equal(screenFacing(h, h), Direction.UP, `heading ${d}° did not draw the back row`);
  }
  // And the other three quarters land where a viewer expects them.
  const north = deg(270); // up-screen
  assert.equal(screenFacing(deg(0), north), Direction.RIGHT, 'east, while driving north, is to the right');
  assert.equal(screenFacing(deg(180), north), Direction.LEFT, 'west, while driving north, is to the left');
  assert.equal(screenFacing(deg(90), north), Direction.DOWN, 'south, while driving north, faces the viewer');
});

test('a body facing maps to an angle and back', () => {
  for (const f of [Direction.DOWN, Direction.LEFT, Direction.RIGHT, Direction.UP]) {
    // With nothing rotated (east up-screen is rotation 0's inverse), a facing survives the trip.
    assert.equal(screenFacing(facingAngle(f), cameraUpHeading(0)), f, `facing ${f} did not survive`);
  }
});

test('the view turns the short way, and never faster than its limit', () => {
  const step = CAMERA_TURN_RAD_PER_SEC / 60;
  // Crossing due north: 350° to 10° is 20° the short way, not 340° the long way.
  const next = turnTowards(deg(350), deg(10), step);
  assert.ok(next > deg(350), `turned backwards: ${((next * 180) / Math.PI).toFixed(1)}°`);
  assert.ok(next - deg(350) <= step + 1e-9, 'exceeded the turn rate');
  // It arrives, and then stays put rather than oscillating.
  let a = deg(350);
  for (let i = 0; i < 200; i++) a = turnTowards(a, deg(10), step);
  assert.ok(Math.abs(a - deg(10)) < 1e-9, `never arrived: ${((a * 180) / Math.PI).toFixed(3)}°`);
  assert.equal(turnTowards(deg(10), deg(10), step), deg(10));
});

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
});

test('world to screen agrees with the old unrotated maths, and honours a turn', () => {
  const cam = { centreX: 200, centreY: 150, width: 800, height: 600, zoom: 2, rotation: 0 };
  // What every overlay did before this existed: (x - worldView.x) * zoom, with the view's left
  // edge at centre - width / (2 * zoom).
  const old = (wx: number, wy: number) => ({
    x: (wx - (cam.centreX - cam.width / (2 * cam.zoom))) * cam.zoom,
    y: (wy - (cam.centreY - cam.height / (2 * cam.zoom))) * cam.zoom,
  });
  for (const [wx, wy] of [[200, 150], [216, 150], [180, 130], [264, 214]]) {
    const a = worldToScreen(cam, wx, wy);
    const b = old(wx, wy);
    assert.ok(Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9, `(${wx},${wy}) drifted`);
  }
  // The camera's own centre never moves, whatever the rotation.
  for (let d = 0; d < 360; d += 30) {
    const turned = { ...cam, rotation: deg(d) };
    const mid = worldToScreen(turned, cam.centreX, cam.centreY);
    assert.ok(Math.abs(mid.x - 400) < 1e-9 && Math.abs(mid.y - 300) < 1e-9, `centre moved at ${d}°`);
  }
  // Driving east with the camera turned to match puts a point AHEAD of the kart above it.
  const east = { ...cam, rotation: driveCameraRotation(0) };
  const ahead = worldToScreen(east, cam.centreX + 32, cam.centreY);
  assert.ok(ahead.y < 300 - 1, `the road ahead is not up-screen: y=${ahead.y}`);
  assert.ok(Math.abs(ahead.x - 400) < 1e-6, `it drifted sideways: x=${ahead.x}`);
});
