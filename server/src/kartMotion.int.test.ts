/**
 * A car drawn between patches moves at a constant rate.
 *
 * This is the test the report asked for — "ich habe zwar 47 fps aber irgendwie ruckelt es" — and
 * the claim it pins is not about the frame rate at all: it is that the drawn STEP is even. So it
 * simulates the loop the scene runs (patches at 20 Hz, frames at some rate, the carry plus the
 * ease) and measures the spread of the per-frame displacement, which is exactly what an eye
 * integrates into "smooth" or "juddery".
 *
 * The old filter — ease towards the last synced position — is kept here as the BASELINE, because
 * a smoothness number with nothing to compare it against says nothing. It is the one thing in this
 * file that is not production code, and it is eight characters long.
 *
 * TEST BOUNDARIES:
 *   @real-dependency: client/src/render/kartMotion.ts -- Mock? NO. It IS the thing under test,
 *       and it is deliberately Phaser-free so this file can import it at all (the same reason
 *       driveCamera.int.test.ts can). The frame loop and the patch arrivals are the INPUTS, so
 *       they are what varies here; driving a real browser would measure a GPU instead.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';

import { carriedPoint, KART_CARRY_MS, KART_CATCH_UP_PER_SEC } from '../../client/src/render/kartMotion.js';

const SPEED = 320; // px/s, a kart at full throttle
const PATCH = 1 / 20; // the server's patch rate

/** Run the scene's loop and report how evenly the drawing moved. */
function drawnSteps(opts: { fps: number; carry: boolean; jitterMs?: number }): {
  steps: number[];
  ideal: number;
} {
  const { fps, carry, jitterMs = 0 } = opts;
  const frame = 1 / fps;
  let seed = 7;
  const wobble = (): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5);
  let t = 0;
  let nextPatch = PATCH;
  let tx = 0;
  let vx = 0;
  let snapAt = 0;
  let x = 0;
  const steps: number[] = [];
  for (let f = 0; f < Math.round(6 * fps); f++) {
    const dt = frame * (1 + (jitterMs / 1000 / frame) * wobble());
    t += dt;
    while (t >= nextPatch) {
      tx = SPEED * nextPatch;
      vx = SPEED;
      snapAt = nextPatch;
      nextPatch += PATCH;
    }
    const before = x;
    const want = carry ? carriedPoint(tx, 0, vx, 0, (t - snapAt) * 1000).x : tx;
    x += (want - x) * (1 - Math.exp(-KART_CATCH_UP_PER_SEC * Math.min(dt, 0.1)));
    if (f > fps) steps.push(x - before); // past the start-up transient
  }
  return { steps, ideal: SPEED * frame };
}

const ripple = (r: { steps: number[]; ideal: number }): number =>
  (Math.max(...r.steps) - Math.min(...r.steps)) / r.ideal;

test('at a constant speed the drawn step is constant, whatever the frame rate', () => {
  for (const fps of [60, 47, 30]) {
    const carried = drawnSteps({ fps, carry: true });
    assert.ok(
      ripple(carried) < 0.02,
      `${fps} fps: the step varied by ${(ripple(carried) * 100).toFixed(0)} % of ${carried.ideal.toFixed(1)} px`,
    );
    // …and it is the RIGHT rate, not merely an even one: a smooth filter that lags for ever would
    // also pass the line above.
    const mean = carried.steps.reduce((a, b) => a + b, 0) / carried.steps.length;
    assert.ok(
      Math.abs(mean - carried.ideal) < 0.05,
      `${fps} fps: ${mean.toFixed(2)} px a frame against ${carried.ideal.toFixed(2)} wanted`,
    );
  }
});

test('easing towards the last patch instead is what juddered', () => {
  // The baseline, so the number above has something to mean. 47 fps is the rate that was reported.
  const eased = drawnSteps({ fps: 47, carry: false });
  assert.ok(ripple(eased) > 0.5, `the old filter rippled only ${(ripple(eased) * 100).toFixed(0)} %`);
  assert.ok(ripple(drawnSteps({ fps: 47, carry: true })) * 10 < ripple(eased), 'the carry is not an order better');
});

test('frame jitter is halved rather than amplified', () => {
  // A wobbly frame clock cannot be interpolated away — the drawing moves when a frame happens —
  // but the carry must not ADD to it. 8 ms of jitter on a 21 ms frame is ±38 %.
  const carried = ripple(drawnSteps({ fps: 47, carry: true, jitterMs: 8 }));
  const eased = ripple(drawnSteps({ fps: 47, carry: false, jitterMs: 8 }));
  assert.ok(carried < eased / 2, `carried ${(carried * 100).toFixed(0)} % against eased ${(eased * 100).toFixed(0)} %`);
});

test('the carry is capped, so a patch that never comes parks the car instead of launching it', () => {
  const near = carriedPoint(100, 100, SPEED, 0, KART_CARRY_MS);
  const late = carriedPoint(100, 100, SPEED, 0, 5000);
  assert.deepEqual(late, near, 'a five-second-old snapshot was carried further than a fresh one');
  assert.equal(near.x, 100 + (SPEED * KART_CARRY_MS) / 1000);
  // A negative age is two clocks disagreeing, and it must not drag the car backwards.
  assert.deepEqual(carriedPoint(100, 100, SPEED, 0, -40), { x: 100, y: 100 });
});
