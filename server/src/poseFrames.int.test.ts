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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as fs from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';

import { poseChain, poseFrame, posePlaybackLength, sheetRowForDir, standColumn } from '@pixel/shared/office/sprites/poseFrames.js';
import { DEFAULT_CHARACTER_SPEC, PET_SPRITE_SPEC, type CharacterSpec } from '@pixel/shared/office/sprites/characterSpec.js';
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

test('a pet track can be APPENDED without moving the columns that already exist', () => {
  // The recipe for closing an art gap, pinned because getting it wrong is silent. The bundled pet
  // sheets are exactly six columns — walk 0-2, sit 3-4, idle 5 — so the poses the engine asks for
  // and nobody drew (`drink`, `talk`) resolve to column 5, the idle frame. Adding them means a
  // wider sheet plus a track appended to PET_SPRITE_SPEC, and the property that makes that safe is
  // the same append-only rule the tilesets have: a track claims the NEXT free columns, so the ones
  // already drawn keep their meaning. INSERTING a track instead would silently renumber every
  // frame after it and every existing sheet would animate the wrong pictures.
  const cols = (spec: CharacterSpec, pose: string, available: number): number[] =>
    Array.from({ length: posePlaybackLength(spec, pose, available) }, (_, f) => poseFrame(spec, pose, f, available).col);

  // Where the tracks sit today, spelled out, because these numbers ARE the sheets on disk.
  assert.deepEqual(cols(PET_SPRITE_SPEC, 'walk', 8), [0, 1, 2, 1], 'walk is columns 0-2, ping-pong');
  assert.deepEqual(cols(PET_SPRITE_SPEC, 'sit', 8), [3, 4]);
  assert.deepEqual(cols(PET_SPRITE_SPEC, 'idle', 8), [5]);
  assert.deepEqual(cols(PET_SPRITE_SPEC, 'talk', 8), [6, 7], 'talk was appended, so it took 6-7');
  // `drink` has no track: the engine asks for it at a coffee station and it lands on the idle frame.
  assert.deepEqual(cols(PET_SPRITE_SPEC, 'drink', 8), [5], 'an unanswered pose falls back to idle');

  // The append-only rule, demonstrated with the track that is still missing: adding `drink` after
  // `talk` must not move a single column that is already drawn.
  const withDrink: CharacterSpec = {
    frame: { w: 16, h: 16 },
    tracks: [...PET_SPRITE_SPEC.tracks, { name: 'drink', frames: 2, play: 'loop' }],
  };
  assert.deepEqual(cols(withDrink, 'drink', 10), [8, 9], 'an appended track takes the next free columns');
  for (const pose of ['walk', 'sit', 'idle', 'talk']) {
    assert.deepEqual(
      cols(withDrink, pose, 10),
      cols(PET_SPRITE_SPEC, pose, 8),
      `appending a track moved ${pose} — every sheet already drawn would animate the wrong pictures`,
    );
  }

  // And a spec ahead of its art degrades instead of tearing. This is not hypothetical: a pet
  // OVERRIDE saved in a database before the sheets grew is still six columns wide, and it is asked
  // for a talk track it does not have.
  assert.deepEqual(cols(PET_SPRITE_SPEC, 'talk', 6), [5], 'a six-column sheet must fall back, not draw a gap');
  assert.deepEqual(cols(PET_SPRITE_SPEC, 'walk', 6), [0, 1, 2, 1], 'and its other poses keep working');
});

test('the pet editor lists its tracks in the sheets\' own column order', () => {
  // Two lists have to agree and only one of them is data: `PET_SPRITE_SPEC` says what the bundled
  // sheets contain, and the editor's `PET_TRACKS` decides what `deriveSpecTracks` hands each
  // column when a sheet arrives without a usable spec. The editor's list is read as TEXT because
  // it lives in the client, which the server suite cannot import — the alternative was no check.
  //
  // This is a real regression, caught while the talk track was being drawn: `sleep` sat fourth in
  // PET_TRACKS with a default of two frames, so deriving a spec for the new 8-column sheet gave
  // columns 6-7 to SLEEP and nothing to talk. It was invisible while the sheets were 6 columns.
  const src = readFileSync(join(import.meta.dirname, '..', '..', 'client', 'src', 'editor', 'CharacterEditor.ts'), 'utf8');
  const block = src.match(/export const PET_TRACKS: TrackDef\[\] = \[([\s\S]*?)\];/);
  assert.ok(block, 'PET_TRACKS not found — did it move?');
  const listed = [...block[1].matchAll(/name: '([a-z]+)'[^}]*def: (\d+)/g)].map((m) => ({ name: m[1], def: Number(m[2]) }));
  assert.ok(listed.length >= 4, `parsed ${listed.length} tracks from PET_TRACKS`);

  // The spec's tracks must be a PREFIX of the editor's list, in order and with the same frame
  // counts. A prefix, not an equality: the editor may offer a track nobody has drawn yet (`drink`),
  // and that one has to come AFTER everything the sheets contain.
  PET_SPRITE_SPEC.tracks.forEach((track, i) => {
    assert.equal(
      listed[i]?.name,
      track.name,
      `PET_TRACKS position ${i} is '${listed[i]?.name}' where the sheets have '${track.name}' — ` +
        `deriving a spec would hand that column to the wrong track`,
    );
    assert.equal(listed[i]?.def, track.frames, `'${track.name}' defaults to ${listed[i]?.def} frames, the sheets have ${track.frames}`);
  });
  assert.equal(
    listed.filter((t) => t.name === 'sleep').length,
    0,
    'sleep is offered again: the engine has no sleep state, so those frames can never be drawn',
  );
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

test('a pose with no art of its own borrows it, and every resolver borrows the same', () => {
  // The point of the chain: a new pose costs no art. `drink` borrows `coffee`, `feed` borrows
  // `drink` and therefore `coffee` too, and a sheet with none of them still lands on idle and then
  // the stand column. So a pose can be added to the engine without touching a single sheet.
  assert.deepEqual(poseChain('drink'), ['drink', 'coffee', 'idle']);
  assert.deepEqual(poseChain('feed'), ['feed', 'drink', 'coffee', 'idle'], 'the chain is transitive');
  assert.deepEqual(poseChain('idle'), ['idle'], 'idle does not borrow from itself');
  assert.deepEqual(poseChain('walk'), ['walk', 'idle']);

  // A sheet that has coffee art but no drink art: the drink pose must draw the coffee columns,
  // and the LENGTH must come from the same track — otherwise the frame counter advances over one
  // track and the renderer draws out of another, which is an animation playing the wrong pictures
  // with nothing to point at.
  const withCoffee: CharacterSpec = {
    frame: { w: 16, h: 32 },
    tracks: [
      { name: 'walk', frames: 3, play: 'pingpong' },
      { name: 'coffee', frames: 2, play: 'loop' },
    ],
  };
  const cols = (pose: string): number[] =>
    Array.from({ length: posePlaybackLength(withCoffee, pose, 5) }, (_, f) => poseFrame(withCoffee, pose, f, 5).col);
  assert.deepEqual(cols('coffee'), [3, 4], 'the lender itself');
  assert.deepEqual(cols('drink'), [3, 4], 'drink borrowed the coffee columns');
  assert.deepEqual(cols('feed'), [3, 4], 'feed borrowed them through drink');

  // And with no coffee either, the borrow ends at the stand column rather than drawing a gap.
  const walkOnly: CharacterSpec = { frame: { w: 16, h: 32 }, tracks: [{ name: 'walk', frames: 3, play: 'pingpong' }] };
  assert.deepEqual(
    Array.from({ length: posePlaybackLength(walkOnly, 'feed', 3) }, (_, f) => poseFrame(walkOnly, 'feed', f, 3).col),
    [standColumn(walkOnly)],
  );
});

test('the borrow table has no cycles', () => {
  // `poseChain` carries a visited set, so a link back cannot hang — it truncates, which is worse
  // in a quiet way: two poses would each borrow from the other and neither would be wrong enough
  // to notice. The table is read from source because it is private on purpose; what is asserted is
  // the graph, not the function that walks it.
  const src = readFileSync(
    join(import.meta.dirname, '..', '..', 'shared', 'src', 'office', 'sprites', 'poseFrames.ts'),
    'utf8',
  );
  const block = src.match(/const POSE_FALLBACK: Readonly<Record<string, string>> = \{([\s\S]*?)\};/);
  assert.ok(block, 'POSE_FALLBACK not found — did it move or change shape?');
  const links = new Map([...block[1].matchAll(/(\w+):\s*'(\w+)'/g)].map((m) => [m[1], m[2]]));
  assert.ok(links.size > 0, 'parsed no links out of POSE_FALLBACK');

  for (const start of links.keys()) {
    const seen = new Set<string>();
    let at: string | undefined = start;
    while (at) {
      assert.equal(seen.has(at), false, `POSE_FALLBACK cycles: ${[...seen, at].join(' → ')}`);
      seen.add(at);
      at = links.get(at);
    }
  }
});
