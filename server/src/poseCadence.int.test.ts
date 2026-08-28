/**
 * The one table that says how fast a pose's frames advance, checked against the engine that
 * actually advances them.
 *
 * There were three tables and they disagreed: the engine's constants (pets, advanced server-side),
 * a copy in `OfficeScene` whose comment admitted it was "mirroring the engine's constants"
 * (characters, advanced client-side), and a third hand-written one in the character editor. The
 * editor's walk was 150 ms against the game's 75 — an author judged every walk cycle at half speed,
 * and nothing could have caught it, because a duplicated constant is only wrong in comparison.
 *
 * What is pinned here is the comparison:
 *
 *  1. Every cadence equals the engine constant it comes from. Derived values, so this fails only
 *     if somebody re-hardcodes one — which is exactly the regression.
 *  2. Every pose the engine ANIMATES has an entry. `engine/pets.ts` is read for its
 *     `advancePetFrame` call sites, so a new pet state with a new cadence and no table entry fails
 *     here rather than silently previewing at the fallback.
 *  3. The preview fallback is not a game value. A renderer that used it would animate a pose the
 *     world holds still.
 *  4. The preview's ONE deliberate difference from the world — a moving pose plays at
 *     `PREVIEW_SLOWDOWN` — is a factor on the world's number, so a stationary pose stays identical
 *     and the two can never drift apart again.
 *
 * TEST BOUNDARIES:
 *   @real-dependency: the shared constants + the engine source -- Mock? NO. The claim is "these
 *       numbers are the same numbers", so both sides have to be the real ones; the pet half reads
 *       `pets.ts` as text because the cadence is chosen at a call site, not exported as a table.
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  COFFEE_FRAME_DURATION_SEC,
  PET_DRINK_FRAME_DURATION_SEC,
  PET_IDLE_FRAME_DURATION_SEC,
  PET_TAIL_WAG_DURATION_SEC,
  PET_TALK_FRAME_DURATION_SEC,
  PET_WALK_FRAME_DURATION_SEC,
  TYPE_FRAME_DURATION_SEC,
  WALK_FRAME_DURATION_SEC,
} from '@pixel/shared/office/constants';
import {
  CHARACTER_POSE_FRAME_MS,
  PET_POSE_FRAME_MS,
  PREVIEW_FALLBACK_FRAME_MS,
  PREVIEW_SLOWDOWN,
  poseFrameMs,
  previewFrameMs,
} from '@pixel/shared/office/poseCadence';

const PETS_SRC = join(import.meta.dirname, '..', '..', 'shared', 'src', 'office', 'engine', 'pets.ts');

test('every cadence is the engine constant, not a number somebody typed', () => {
  assert.equal(poseFrameMs('walk', 'character'), WALK_FRAME_DURATION_SEC * 1000);
  assert.equal(poseFrameMs('typing', 'character'), TYPE_FRAME_DURATION_SEC * 1000);
  assert.equal(poseFrameMs('reading', 'character'), TYPE_FRAME_DURATION_SEC * 1000);
  assert.equal(poseFrameMs('coffee', 'character'), COFFEE_FRAME_DURATION_SEC * 1000);
  assert.equal(poseFrameMs('walk', 'pet'), PET_WALK_FRAME_DURATION_SEC * 1000);
  assert.equal(poseFrameMs('idle', 'pet'), PET_IDLE_FRAME_DURATION_SEC * 1000);
  assert.equal(poseFrameMs('sit', 'pet'), PET_TAIL_WAG_DURATION_SEC * 1000);
  assert.equal(poseFrameMs('drink', 'pet'), PET_DRINK_FRAME_DURATION_SEC * 1000);
  assert.equal(poseFrameMs('talk', 'pet'), PET_TALK_FRAME_DURATION_SEC * 1000);

  // The two numbers the complaint was actually about, spelled out so a change to either constant
  // shows up here as a decision rather than as a diff nobody reads.
  assert.equal(poseFrameMs('walk', 'character'), 75, 'a character walk frame is 75 ms');
  assert.equal(poseFrameMs('walk', 'pet'), 120, 'a pet walks at its own cadence, not the human one');
});

test('a preview slows a MOVING pose and leaves every other one alone', () => {
  // The one deliberate difference between the preview and the world, and the reason it is a factor
  // rather than a table: the editor draws a still, magnified sprite, so a walk cycle at the
  // world's 75 ms reads frantic where the same frames on a character crossing tiles do not. The
  // stationary poses need no correction because they are stationary in the world as well.
  assert.equal(previewFrameMs('walk', 'character'), poseFrameMs('walk', 'character') * PREVIEW_SLOWDOWN);
  assert.equal(previewFrameMs('walk', 'character'), 150, 'which is also what the editor showed before any of this');
  assert.equal(previewFrameMs('walk', 'pet'), 240, 'a pet slows by the same factor, from its own 120');

  for (const [kind, poses] of [
    ['character', ['typing', 'reading', 'coffee']],
    ['pet', ['sit', 'talk']],
  ] as const) {
    for (const pose of poses) {
      assert.equal(
        previewFrameMs(pose, kind),
        poseFrameMs(pose, kind),
        `${kind} ${pose} is stationary in the world too — slowing it would make the preview lie`,
      );
    }
  }

  // And the numbers still come from the engine: the factor multiplies the world's answer, so the
  // two cannot drift apart the way they had (a hand-written 150 against the game's 75).
  assert.equal(previewFrameMs('walk', 'character') / PREVIEW_SLOWDOWN, poseFrameMs('walk', 'character'));
});

test('every pose the pet engine animates has a cadence in the table', () => {
  // The cadence is chosen per call site in the engine, so the source is the only place that lists
  // them. A new pet state that animates and forgets the table would preview at the fallback.
  const src = readFileSync(PETS_SRC, 'utf8');
  const used = [...src.matchAll(/advancePetFrame\([^,]+,[^,]+,\s*([A-Z_]+)\s*,/g)].map((m) => m[1]);
  assert.ok(used.length >= 5, `expected the engine to animate several pet poses, found ${used.length}`);

  const inTable = new Set(Object.values(PET_POSE_FRAME_MS));
  const constants: Record<string, number> = {
    PET_IDLE_FRAME_DURATION_SEC,
    PET_WALK_FRAME_DURATION_SEC,
    PET_TAIL_WAG_DURATION_SEC,
    PET_DRINK_FRAME_DURATION_SEC,
    PET_TALK_FRAME_DURATION_SEC,
  };
  for (const name of used) {
    const seconds = constants[name];
    assert.ok(seconds !== undefined, `the engine animates with ${name}, which this test does not know — add it`);
    assert.ok(
      inTable.has(seconds * 1000),
      `the engine animates a pet pose at ${name} (${seconds * 1000} ms) but no entry in PET_POSE_FRAME_MS has that cadence`,
    );
  }
});

test('a pose the world holds still reports zero, and only a preview substitutes for it', () => {
  // A character's idle is the neutral standing frame, and the engine has no sleep state at all.
  assert.equal(poseFrameMs('idle', 'character'), 0);
  assert.equal(poseFrameMs('sleep', 'pet'), 0);
  assert.equal(poseFrameMs('nonsense', 'character'), 0);
  // The renderer's own check is `> 0`, so those stay static there…
  assert.equal(CHARACTER_POSE_FRAME_MS.idle, undefined, 'adding idle here would animate every standing character');
  // …while an editor can still show authored frames cycling.
  assert.equal(previewFrameMs('idle', 'character'), PREVIEW_FALLBACK_FRAME_MS);
  assert.equal(previewFrameMs('sleep', 'pet'), PREVIEW_FALLBACK_FRAME_MS);
});
