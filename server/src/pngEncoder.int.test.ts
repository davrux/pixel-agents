/**
 * The encoder has to be the decoder's exact inverse, or every sprite the server
 * re-serves as an image drifts a little from what the editor saved.
 *
 * "Exact" is testable here because both directions are lossless and the alphabet is
 * small: SpriteData is hex strings, PNG is RGBA bytes, and `rgbaToHex`/`hexToRgba`
 * agree on the one lossy edge — an alpha below PNG_ALPHA_THRESHOLD is a gap, not a
 * colour. So the test is a round trip over the REAL bundled art (every character and
 * pet sheet on disk), plus the cases hand-written art never contains: semi-transparent
 * pixels, a ragged frame, and a direction with fewer frames than its neighbour.
 *
 * Encoding again after decoding is deliberately checked too. Byte equality is not
 * promised (pngjs picks its own filters), but a second decode must yield identical
 * sprite data — that is the property callers depend on.
 *
 * TEST BOUNDARIES:
 *   @real-dependency: assets/characters + assets/pets PNGs -- Mock? NO. Synthetic
 *       sheets would agree with my own assumptions about the layout; the shipped art
 *       is what the pipeline actually has to survive.
 *   @real-dependency: pngjs -- Mock? NO. It is the codec under test on both sides.
 */
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';

import {
  CHARACTER_DIRECTIONS,
  PET_DIRECTIONS,
  PET_FRAME_H,
  PET_FRAME_W,
  PET_FRAMES_PER_ROW,
} from './core/assets/constants.js';
import { decodeCharacterPng, decodePetPng } from './core/assets/pngDecoder.js';
import { encodeDirectionalSheet } from './core/assets/pngEncoder.js';
import { ASSETS_ROOT } from './assets.js';

const charDir = path.join(ASSETS_ROOT, 'assets', 'characters');
const petDir = path.join(ASSETS_ROOT, 'assets', 'pets');
const list = (dir: string): string[] =>
  fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.png')).sort() : [];

test('every bundled character sheet survives decode → encode → decode unchanged', () => {
  const files = list(charDir);
  assert.ok(files.length >= 6, `expected the bundled roster, found ${files.length} files`);
  for (const f of files) {
    const first = decodeCharacterPng(fs.readFileSync(path.join(charDir, f)));
    const frameW = 16;
    const frameH = 32;
    const again = decodeCharacterPng(encodeDirectionalSheet(first as never, CHARACTER_DIRECTIONS, frameW, frameH));
    assert.deepEqual(again, first, `${f} changed on the round trip`);
  }
});

test('every bundled pet sheet survives the round trip', () => {
  const files = list(petDir);
  assert.ok(files.length >= 6, `expected the bundled pets, found ${files.length} files`);
  for (const f of files) {
    const first = decodePetPng(fs.readFileSync(path.join(petDir, f)));
    const again = decodePetPng(encodeDirectionalSheet(first as never, PET_DIRECTIONS, PET_FRAME_W, PET_FRAME_H));
    assert.deepEqual(again, first, `${f} changed on the round trip`);
  }
});

test('semi-transparency, a ragged frame and a short direction all round-trip', () => {
  const px = (v: string) => Array.from({ length: PET_FRAME_H }, () => Array.from({ length: PET_FRAME_W }, () => v));
  const full = px('#FF000080'); // 50 % red — survives as #RRGGBBAA, per the decoder
  const ragged = px('#00FF00');
  ragged[3] = ['#0000FF']; // one short row: the rest of it is a gap
  ragged.length = 9; // and the frame stops early
  const sprites = { down: [full, ragged], up: [px('#FFFFFF')], right: [] } as never;

  // PET_FRAMES_PER_ROW columns on purpose: decodePetPng always slices six, so a
  // narrower sheet would make it read past the image (that is what `cols` is for).
  const decoded = decodePetPng(
    encodeDirectionalSheet(sprites, PET_DIRECTIONS, PET_FRAME_W, PET_FRAME_H, PET_FRAMES_PER_ROW),
  );
  assert.equal(decoded.down[0][0][0], '#FF000080', 'alpha was dropped');
  assert.equal(decoded.down[1][3][0], '#0000FF');
  assert.equal(decoded.down[1][3][1], '', 'a short row must read back as gaps');
  assert.equal(decoded.down[1][10]?.[0], '', 'a short frame must read back as gaps');
  assert.equal(decoded.up[0][0][0], '#FFFFFF');
  assert.equal(decoded.right[0][0][0], '', 'a direction with no frames is a transparent row');
  // Six columns were requested, so every direction reads back six frames.
  assert.equal(decoded.right.length, PET_FRAMES_PER_ROW);
  assert.equal(decoded.down.length, PET_FRAMES_PER_ROW);
});

test('an alpha below the decoder threshold is a gap, not a black pixel', () => {
  const one = Array.from({ length: PET_FRAME_H }, () => Array.from({ length: PET_FRAME_W }, () => '#123456' + '01'));
  const decoded = decodePetPng(
    encodeDirectionalSheet({ down: [one] } as never, PET_DIRECTIONS, PET_FRAME_W, PET_FRAME_H, PET_FRAMES_PER_ROW),
  );
  assert.equal(decoded.down[0][0][0], '');
});
