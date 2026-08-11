// Time clock furniture — integration tests for the generated asset.
//
// ============================================================================
// SCOPE. The server's whole involvement in TimeTracking is this asset plus a
// 'workStatus' room message: the credential, the vendor's API and every rule
// about bookings live in the Electron main process (see
// desktop/src/timetracking/, tested there). So the only thing to check here is
// that the furniture it generates is well-formed.
//
// Covered:
//   - the catalog entry's declared size matches the sprite's real dimensions
//   - the entry carries the timeClock action (what makes walking up to it open
//     the clock, via effectiveAction)
//   - every pixel is transparent or a valid colour, and it is actually drawn
//
// NOT covered (honest absence): the booking flow, which needs a live
// TimeTracking install and a desktop build — verified by hand.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { timeClockAssets, timeClockSprite } from './timeClockAssets.js';

test('the time clock entry declares the dimensions its sprite actually has', () => {
  // Drift here is the classic generated-asset bug: the catalog says one size,
  // the pixels are another, and the thing renders stretched or clipped.
  const [{ entry }] = timeClockAssets();
  const sprite = timeClockSprite();
  assert.equal(sprite.length, entry.height, 'sprite row count must equal declared height');
  assert.equal(sprite[0].length, entry.width, 'sprite column count must equal declared width');
  // 1×2 tiles at the world's 16px tile size.
  assert.equal(entry.footprintW, 1);
  assert.equal(entry.footprintH, 2);
  assert.equal((entry.footprintW as number) * 16, entry.width);
  assert.equal((entry.footprintH as number) * 16, entry.height);
});

test('the time clock carries the timeClock action, so walking up to it opens the clock', () => {
  const [{ entry }] = timeClockAssets();
  assert.equal(entry.id, 'TIME_CLOCK');
  assert.deepEqual(entry.action, { kind: 'timeClock' });
  assert.equal(entry.canPlaceOnFloor, true);
});

test('every time clock pixel is transparent or a valid #rrggbb', () => {
  const sprite = timeClockSprite();
  let painted = 0;
  for (const row of sprite) {
    assert.equal(row.length, 16);
    for (const px of row) {
      if (px === '') continue;
      assert.match(px, /^#[0-9a-f]{6}$/, `bad pixel value ${px}`);
      painted++;
    }
  }
  // Sanity that it is actually a drawing and not an empty grid.
  assert.ok(painted > 200, `expected a drawn sprite, got ${painted} painted pixels`);
});
