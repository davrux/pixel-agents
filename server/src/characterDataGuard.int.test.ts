/**
 * The gate on art a client sends. It had no test, which is the reason this file exists.
 *
 * `validCharacterData` is the authoritative check behind three message handlers — `saveAvatar`
 * (any authenticated user, for their own avatar), `avatarToTemplate` and `saveAsset` (admin) —
 * and whatever it lets through is packed into a PNG and stored (`art/artStore.ts`: "The
 * validator stays the authority"). So the properties worth pinning are not "does it accept a
 * good sheet" but the ones whose failure is silent: a frame size that differs BETWEEN direction
 * rows (the sheet would then be sliced on one row's numbers), a spec whose tracks do not sum to
 * the frame count (the renderer would index past the art), and a name that is not what
 * `cleanName` would produce (it is rewritten in place and persisted).
 *
 * The bounds are pinned as facts, not as guesses at what is "enough": 64 frames per direction,
 * 64×64 per frame. Those are also the numbers the editor, `MAX_CHAR_DIM` and the encoder agree
 * on, so a test that lets them drift is worse than none.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';

import { MAX_NAME_LEN } from '@pixel/shared';

import { validCharacterData, validCharacterSpec, validNpcConfig } from './art/characterDataGuard.js';

/** A frame of w×h opaque pixels. */
const frame = (w: number, h: number, colour = '#a1b2c3'): string[][] =>
  Array.from({ length: h }, () => Array.from({ length: w }, () => colour));
/** `n` frames of one size. */
const row = (n: number, w = 4, h = 8): string[][][] => Array.from({ length: n }, () => frame(w, h));
/** A minimal valid override. */
const sheet = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: 'Nora',
  down: row(3),
  up: row(3),
  right: row(3),
  ...over,
});

test('a plain sheet passes, with and without a left row', () => {
  assert.equal(validCharacterData(sheet()), true);
  assert.equal(validCharacterData(sheet({ left: row(3) })), true);
});

test('the frame size is one for the whole sheet, not per row', () => {
  // The failure this prevents is silent: the decoder slices every row on ONE frame size, so a
  // sheet whose `up` row is 8 wide where `down` is 4 would be cut on the wrong grid and draw
  // fragments of neighbouring frames.
  assert.equal(validCharacterData(sheet({ up: row(3, 8, 8) })), false, 'a wider up row must be refused');
  assert.equal(validCharacterData(sheet({ up: row(3, 4, 16) })), false, 'and a taller one too');
  assert.equal(validCharacterData(sheet({ left: row(3, 8, 8) })), false, 'including the optional left row');
  // Ragged inside one row is refused for the same reason.
  const ragged = row(3);
  ragged[1] = frame(6, 8);
  assert.equal(validCharacterData(sheet({ down: ragged })), false);
  const raggedLine = row(3);
  raggedLine[0][2] = ['#000000', '#000000'];
  assert.equal(validCharacterData(sheet({ down: raggedLine })), false, 'a short pixel line is ragged too');
});

test('down, up and right are mandatory; left is the only optional row', () => {
  for (const missing of ['down', 'up', 'right']) {
    assert.equal(validCharacterData(sheet({ [missing]: undefined })), false, `${missing} must be required`);
    assert.equal(validCharacterData(sheet({ [missing]: [] })), false, `an empty ${missing} row must be refused`);
  }
  assert.equal(validCharacterData(sheet({ left: undefined })), true);
  assert.equal(validCharacterData(sheet({ left: [] })), false, 'present but empty is still wrong');
});

test('the bounds are 64 frames of 64×64 — one past each is refused', () => {
  assert.equal(validCharacterData(sheet({ down: row(64), up: row(64), right: row(64) })), true);
  assert.equal(validCharacterData(sheet({ down: row(65), up: row(65), right: row(65) })), false);
  const big = { down: row(1, 64, 64), up: row(1, 64, 64), right: row(1, 64, 64) };
  assert.equal(validCharacterData(sheet(big)), true);
  assert.equal(validCharacterData(sheet({ down: row(1, 65, 64), up: row(1, 65, 64), right: row(1, 65, 64) })), false);
  assert.equal(validCharacterData(sheet({ down: row(1, 64, 65), up: row(1, 64, 65), right: row(1, 64, 65) })), false);
});

test('every pixel is a hex colour or the empty string, and nothing else', () => {
  for (const bad of ['red', '#abc', '#12345', '#1234567', 'a1b2c3', '#a1b2c3;', 0, null, undefined, {}]) {
    const r = row(1);
    r[0][0][0] = bad as string;
    assert.equal(validCharacterData(sheet({ down: r })), false, `${JSON.stringify(bad)} must not pass`);
  }
  const ok = row(1);
  ok[0][0][0] = '';
  ok[0][0][1] = '#a1b2c3ff';
  assert.equal(validCharacterData(sheet({ down: ok })), true, 'transparent and 8-digit hex are both fine');
});

test('the name is cleaned IN PLACE, and that cleaned value is what is checked', () => {
  // The callers persist `data.name` after this returns, so the rewrite is part of the gate.
  const data = sheet({ name: '  Nora   von    Uponu  ' });
  assert.equal(validCharacterData(data), true);
  assert.equal(data.name, 'Nora von Uponu', 'whitespace is collapsed and trimmed on the object itself');

  // Long input is CUT to the cap rather than refused — cleanName caps, then the pattern
  // checks. A name that only becomes legal by cutting must still be the cut one.
  const long = sheet({ name: 'x'.repeat(MAX_NAME_LEN + 20) });
  assert.equal(validCharacterData(long), true);
  assert.equal((long.name as string).length, MAX_NAME_LEN, `the cap is MAX_NAME_LEN (${MAX_NAME_LEN}), not 16`);

  // Whitespace of any kind is NORMALISED rather than refused: cleanName collapses `\s+` to
  // a single space, so a tab arrives as a space and the name is legal.
  const tabbed = sheet({ name: 'tab\there' });
  assert.equal(validCharacterData(tabbed), true);
  assert.equal(tabbed.name, 'tab here', 'a tab becomes a space, not a rejection');

  // Empty, non-string and genuinely non-printable are refused.
  for (const bad of ['', '   ', 'Umlaut \u00e4', 'emoji \u{1f986}', 'nul\u0000here', 'del\u007f', 42, null, undefined, {}]) {
    assert.equal(validCharacterData(sheet({ name: bad })), false, `${JSON.stringify(bad)} must not pass`);
  }
});

test('a spec must describe the sheet it comes with', () => {
  const withSpec = (tracks: unknown, frames = 3): unknown =>
    sheet({ down: row(frames), up: row(frames), right: row(frames), spec: { frame: { w: 4, h: 8 }, tracks } });
  assert.equal(validCharacterData(withSpec([{ name: 'walk', frames: 3, play: 'pingpong' }])), true);
  // The sum rule is the load-bearing one: a track list that claims more or fewer frames than
  // the sheet has makes the renderer read a column that is not there.
  assert.equal(validCharacterData(withSpec([{ name: 'walk', frames: 2, play: 'loop' }])), false, 'too few');
  assert.equal(validCharacterData(withSpec([{ name: 'walk', frames: 4, play: 'loop' }])), false, 'too many');
  assert.equal(
    validCharacterData(withSpec([{ name: 'walk', frames: 2, play: 'loop' }, { name: 'idle', frames: 1, play: 'loop' }])),
    true,
    'two tracks that add up are fine',
  );
  for (const bad of [
    [],
    'walk',
    [{ name: '', frames: 3, play: 'loop' }],
    [{ name: 'x'.repeat(33), frames: 3, play: 'loop' }],
    [{ name: 'walk', frames: 3, play: 'bounce' }],
    [{ name: 'walk', frames: 3.5, play: 'loop' }],
    [{ name: 'walk', frames: 0, play: 'loop' }],
  ]) {
    assert.equal(validCharacterData(withSpec(bad)), false, `${JSON.stringify(bad)} must not pass`);
  }
  // And the frame size in the spec is bounded like the pixels are.
  assert.equal(validCharacterSpec({ frame: { w: 64, h: 64 }, tracks: [{ name: 'w', frames: 1, play: 'loop' }] }, 1), true);
  assert.equal(validCharacterSpec({ frame: { w: 0, h: 32 }, tracks: [{ name: 'w', frames: 1, play: 'loop' }] }, 1), false);
  assert.equal(validCharacterSpec({ frame: { w: 65, h: 32 }, tracks: [{ name: 'w', frames: 1, play: 'loop' }] }, 1), false);
  assert.equal(validCharacterSpec({ tracks: [{ name: 'w', frames: 1, play: 'loop' }] }, 1), false, 'no frame at all');
});

test('an NPC config is bounded, and a reversed interval is refused', () => {
  const npc = (over: Record<string, unknown> = {}): unknown => ({
    active: true,
    minSec: 30,
    maxSec: 90,
    maxConcurrent: 2,
    ...over,
  });
  assert.equal(validNpcConfig(npc()), true);
  assert.equal(validNpcConfig(npc({ minSec: 91 })), false, 'min above max would make a spawn window impossible');
  assert.equal(validNpcConfig(npc({ minSec: 4 })), false);
  assert.equal(validNpcConfig(npc({ maxSec: 3601 })), false);
  assert.equal(validNpcConfig(npc({ maxConcurrent: 0 })), false);
  assert.equal(validNpcConfig(npc({ maxConcurrent: 9 })), false);
  assert.equal(validNpcConfig(npc({ active: 'yes' })), false);
  assert.equal(validNpcConfig(npc({ behaviors: { talk: true, rest: false } })), true);
  assert.equal(validNpcConfig(npc({ behaviors: { talk: 'sometimes' } })), false);
  assert.equal(validNpcConfig(npc({ behaviors: null })), false);
  // Reached through the whole gate too, since that is how it arrives.
  assert.equal(validCharacterData(sheet({ npc: npc() })), true);
  assert.equal(validCharacterData(sheet({ npc: npc({ maxSec: 4 }) })), false);
});

test('junk instead of an object is refused rather than throwing', () => {
  for (const bad of [null, undefined, 42, 'sheet', [], true]) {
    assert.doesNotThrow(() => validCharacterData(bad));
    assert.equal(validCharacterData(bad), false, `${JSON.stringify(bad)} must not pass`);
  }
});
