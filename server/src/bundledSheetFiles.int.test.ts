/**
 * A bundled sheet stays the FILE it is — from the loader, through the message, to the route.
 *
 * Decoding them into SpriteData at boot cost 3.2 MB of heap for 25.8 KB of PNG (measured
 * 2026-08-26: 2.3 MB for six character sheets, 875 KB for six pet sheets), and every byte of it
 * existed to be encoded back into a PNG when a client asked. Nothing on the server draws.
 *
 * Three properties, and the middle one is the expensive one to get wrong: a `png` Buffer that
 * reaches a client message does not fail, it SHIPS — the whole sheet, to every viewer, on every
 * join, which is the payload the URL indirection was built to avoid. The other two are what
 * makes the file usable at all: the loader must hand over the bytes as they lie (the route
 * serves them without re-encoding, so a byte that changes here changes the picture), and the
 * URL must be addressed by their content, or a browser keeps a stale sheet for a year.
 *
 * TEST BOUNDARIES:
 *   @real-dependency: the files in assets/ -- Mock? NO. "It is the file on disk" is the claim;
 *       a synthetic buffer would only test that a variable was passed along.
 */
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';

import { CHAR_FRAME_H, CHAR_FRAME_W, PET_FRAME_H, PET_FRAME_W } from './core/assets/constants.js';
import { loadCharacterSprites, loadPetSprites } from './assetLoader.js';
import { artHash, withArtUrl } from './art/artUrl.js';
import { ASSETS_ROOT } from './assets.js';

const CHAR_FRAME = { w: CHAR_FRAME_W, h: CHAR_FRAME_H };
const PET_FRAME = { w: PET_FRAME_W, h: PET_FRAME_H };
const sha = (b: Buffer): string => createHash('sha1').update(b).digest('hex').slice(0, 12);

test('the loader hands over the bytes on disk, and no pixels at all', async () => {
  const chars = await loadCharacterSprites(ASSETS_ROOT);
  assert.ok(chars && chars.characters.length >= 6, 'the bundled roster must load');
  chars.characters.forEach((sheet, i) => {
    const file = fs.readFileSync(path.join(ASSETS_ROOT, 'assets', 'characters', `char_${i}.png`));
    assert.ok(Buffer.isBuffer(sheet.png), `char_${i}: no file bytes`);
    assert.equal(Buffer.compare(sheet.png, file), 0, `char_${i}: not the file on disk`);
    // The spec still travels — a sheet cannot be sliced without it.
    assert.ok(sheet.spec.frame.w > 0 && sheet.spec.tracks.length > 0, `char_${i}: no spec`);
    for (const row of ['down', 'up', 'right', 'left']) {
      assert.equal((sheet as unknown as Record<string, unknown>)[row], undefined, `char_${i}: ${row} was decoded`);
    }
  });

  const pets = await loadPetSprites(ASSETS_ROOT);
  assert.ok(pets, 'the bundled pets must load');
  for (const [kind, arr] of [['dog', pets.dogs], ['cat', pets.cats], ['duck', pets.ducks]] as const) {
    arr.forEach((sheet, i) => {
      const file = fs.readFileSync(path.join(ASSETS_ROOT, 'assets', 'pets', `${kind}_${i}.png`));
      assert.equal(Buffer.compare(sheet.png, file), 0, `${kind}_${i}: not the file on disk`);
      assert.equal((sheet as unknown as Record<string, unknown>).down, undefined, `${kind}_${i}: was decoded`);
    });
  }
});

test('no Buffer reaches a client message — only a URL and the frame size do', async () => {
  const chars = await loadCharacterSprites(ASSETS_ROOT);
  const pets = await loadPetSprites(ASSETS_ROOT);
  assert.ok(chars && pets);
  const entries: Array<[string, unknown, { w: number; h: number }, 'character' | 'pet']> = [
    ['char_0', chars.characters[0], CHAR_FRAME, 'character'],
    ['dog_0', pets.dogs[0], PET_FRAME, 'pet'],
  ];
  for (const [id, entry, frame, kind] of entries) {
    const msg = withArtUrl(kind, id, entry, frame) as Record<string, unknown>;
    assert.equal(msg.png, undefined, `${id}: the sheet itself is in the message`);
    assert.ok(typeof msg.url === 'string' && (msg.url as string).startsWith(`/art/${kind}/${id}?v=`), `${id}: no url`);
    assert.deepEqual(msg.artFrame, kind === 'character' ? chars.characters[0].spec.frame : frame, `${id}: wrong frame`);
    // The real bound, stated in bytes: whatever else the entry gains later, the message may
    // not grow to sheet size. A 16×32 sheet is ~3 KB of PNG; the metadata is a few hundred.
    const size = JSON.stringify(msg).length;
    assert.ok(size < 1024, `${id}: the message is ${size} bytes — something big is riding along`);
  }
});

test('the URL is addressed by the file content, so changed art is a changed URL', async () => {
  const chars = await loadCharacterSprites(ASSETS_ROOT);
  assert.ok(chars);
  const sheet = chars.characters[0];
  assert.equal(artHash(sheet), sha(sheet.png), 'the hash must be of the bytes that get served');
  // A different sheet is a different hash; the same bytes twice are the same hash.
  assert.notEqual(artHash(chars.characters[1]), artHash(sheet));
  assert.equal(artHash({ ...sheet, name: 'renamed' }), artHash(sheet), 'and a label is not art');
});
