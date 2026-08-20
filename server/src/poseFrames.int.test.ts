/**
 * The index model must pick the SAME picture as the pixel model — for every sheet,
 * pose, direction and frame counter the game can ask for.
 *
 * This is the safety net under drawing from a sheet instead of from decoded pixels
 * (`poseFrames.ts` vs `spriteForPose`). Two implementations of "which column is the walk
 * cycle's third step" is exactly the kind of duplication that fails silently: nothing
 * throws, the animation is just subtly wrong, and a screenshot looks fine. So the old
 * path is the oracle here: for each combination, the sprite `spriteForPose` returns must
 * be pixel-identical to the sheet cell the new arithmetic points at.
 *
 * The one case where they legitimately differ is the synthesized seated pose (a
 * character with no `sit` track): the pixel path shifts the stand frame down, the index
 * path returns that column plus `synthSit`, and the renderer does the shifting. Asserted
 * explicitly rather than skipped.
 *
 * TEST BOUNDARIES:
 *   @real-dependency: the bundled sheets -- Mock? NO. A synthetic spec would only
 *       exercise the shapes I happened to think of; the shipped art carries the real
 *       track layouts (including a character with a coffee track and pets with three).
 *   @real-dependency: spriteForPose + buildCharacterSprites -- Mock? NO. They ARE the
 *       oracle; stubbing them would test the new code against my assumptions.
 */
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';

import { poseFrame, sheetRowForDir, standColumn } from '@pixel/shared/office/sprites/poseFrames.js';
import { DEFAULT_CHARACTER_SPEC, type CharacterSpec } from '@pixel/shared/office/sprites/characterSpec.js';
import { getCharacterSprites, setCharacterTemplates, spriteForPose } from '@pixel/shared/office/sprites/spriteData.js';
import { Direction } from '@pixel/shared/office/types.js';

import { ASSETS_ROOT } from './assets.js';
import { decodeCharacterPng } from './core/assets/pngDecoder.js';

const DIRS = [Direction.DOWN, Direction.UP, Direction.RIGHT, Direction.LEFT];

/** Poses the engine can ask for (agents and pets), plus one nobody ever drew. */
const POSES = ['walk', 'typing', 'reading', 'coffee', 'idle', 'sit', 'drink', 'talk', 'sleep', 'nonsense'];

test('for every sheet, pose, direction and frame the index model picks the pixel model’s frame', () => {
  const charDir = path.join(ASSETS_ROOT, 'assets', 'characters');
  const files = fs.readdirSync(charDir).filter((x) => /^char_\d+\.png$/.test(x)).sort();
  assert.ok(files.length >= 6);
  let compared = 0;
  for (const f of files) {
    const dirs = decodeCharacterPng(fs.readFileSync(path.join(charDir, f))) as unknown as Record<string, string[][][]>;
    const id = f.replace('.png', '');
    setCharacterTemplates([{ id, data: dirs as never }] as never);
    const sprites = getCharacterSprites(id);
    const available = dirs.down.length;
    const rows = [dirs.down, dirs.up, dirs.right, dirs.left ?? dirs.right];
    for (const pose of POSES) {
      for (let d = 0; d < DIRS.length; d++) {
        for (let frame = 0; frame < 9; frame++) {
          const want = spriteForPose(pose, DIRS[d], frame, sprites);
          const got = poseFrame(DEFAULT_CHARACTER_SPEC, pose, frame, available);
          if (got.synthSit) continue; // compared separately below
          assert.deepEqual(
            // Through sheetRowForDir, the same conversion the renderer uses — the
            // earlier version of this test wrote the mapping out by hand and therefore
            // could not catch the renderer passing a Direction where a row was wanted
            // (walking north drew the left-facing frames).
            rows[sheetRowForDir(DIRS[d])][got.col],
            want,
            `${id} pose=${pose} dir=${d} frame=${frame}: column ${got.col} is not what spriteForPose drew`,
          );
          compared++;
        }
      }
    }
  }
  assert.ok(compared > 1500, `expected a broad sweep, compared ${compared}`);
});

test('the synthesized seated pose points at the stand column and says so', () => {
  const charDir = path.join(ASSETS_ROOT, 'assets', 'characters');
  const dirs = decodeCharacterPng(fs.readFileSync(path.join(charDir, 'char_0.png'))) as unknown as Record<string, string[][][]>;
  // The default spec has no sit track, so `sit` is the synthesized case.
  assert.equal(DEFAULT_CHARACTER_SPEC.tracks.some((t) => t.name === 'sit'), false);
  const got = poseFrame(DEFAULT_CHARACTER_SPEC, 'sit', 3, dirs.down.length);
  assert.equal(got.synthSit, true);
  assert.equal(got.col, standColumn(DEFAULT_CHARACTER_SPEC));

  // And a spec that DOES have a sit track is not synthesized.
  const withSit: CharacterSpec = {
    frame: { w: 16, h: 32 },
    tracks: [...DEFAULT_CHARACTER_SPEC.tracks, { name: 'sit', frames: 2, play: 'loop' }],
  };
  const real = poseFrame(withSit, 'sit', 0, 12);
  assert.equal(real.synthSit, false);
});

test('a spec claiming more columns than the sheet has falls back instead of drawing a gap', () => {
  const spec: CharacterSpec = { frame: { w: 16, h: 32 }, tracks: [{ name: 'walk', frames: 3, play: 'pingpong' }, { name: 'typing', frames: 4, play: 'loop' }] };
  // Only the three walk columns exist.
  const got = poseFrame(spec, 'typing', 0, 3);
  assert.equal(got.col, standColumn(spec), 'a track outside the sheet must fall back to the stand column');
  assert.equal(got.synthSit, false);
});

test('ping-pong turns three drawn steps into a four-step cycle', () => {
  const spec: CharacterSpec = { frame: { w: 16, h: 32 }, tracks: [{ name: 'walk', frames: 3, play: 'pingpong' }] };
  const cols = [0, 1, 2, 3, 4].map((f) => poseFrame(spec, 'walk', f, 3).col);
  assert.deepEqual(cols, [0, 1, 2, 1, 0]);
});

test('a facing is not a row number — the mapping is stated, not assumed', () => {
  // Direction is DOWN 0, LEFT 1, RIGHT 2, UP 3; a sheet is down, up, right, left. Two of
  // the four coincide, which is why passing one for the other looked fine until somebody
  // walked north.
  assert.equal(sheetRowForDir(Direction.DOWN), 0);
  assert.equal(sheetRowForDir(Direction.UP), 1);
  assert.equal(sheetRowForDir(Direction.RIGHT), 2);
  assert.equal(sheetRowForDir(Direction.LEFT), 3);
  assert.notEqual(sheetRowForDir(Direction.UP), Direction.UP);
  assert.notEqual(sheetRowForDir(Direction.LEFT), Direction.LEFT);
});
