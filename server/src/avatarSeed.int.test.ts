/**
 * A new player's first avatar, seeded from a gallery skin.
 *
 * This is a regression test with a date on it. When bundled sheets stopped being decoded at
 * boot and became the FILES they are, the seed kept going through `JSON.parse(JSON.stringify())`
 * — and a Buffer does not survive that: it becomes `{"type":"Buffer","data":[137,80,78,71,…]}`.
 * The consequences were both invisible and expensive. The stored row grew to 10 267 bytes of
 * number array for a 2.8 KB sheet, and since nothing recognised that shape as art any more, the
 * `playerAvatar` message stopped carrying a URL and shipped the array itself to every viewer in
 * the zone. Measured on a fresh account 2026-08-27; the fix took the message from over 10 KB to
 * 358 bytes.
 *
 * So the properties are: what comes out is STORABLE (no Buffer, base64), it is ADDRESSABLE (the
 * URL builder finds art in it), and it describes its own geometry — read from the PNG header,
 * because decoding a sheet to count its rows would be the very cost that was just removed.
 */
import { strict as assert } from 'node:assert';
import { PNG } from 'pngjs';
import * as fs from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';

import { avatarSeedFrom } from './art/avatarSeed.js';
import { artBytes, withArtUrl } from './art/artUrl.js';
import { ASSETS_ROOT } from './assets.js';

const CHAR_FRAME = { w: 16, h: 32 };
const sheetFile = path.join(ASSETS_ROOT, 'assets', 'characters', 'char_0.png');

/** A bundled entry, in the shape the loader produces. */
const bundled = (): Record<string, unknown> => ({
  png: fs.readFileSync(sheetFile),
  spec: { frame: { w: 16, h: 32 }, tracks: [{ name: 'walk', frames: 7, play: 'pingpong' }] },
  name: 'Nora',
});

test('a bundled sheet is seeded as base64 with its geometry, never as a JSON Buffer', () => {
  const seed = avatarSeedFrom(bundled());
  assert.equal(typeof seed.png, 'string', 'a Buffer here is the bug: JSON.stringify turns it into an array');
  assert.equal(Buffer.compare(Buffer.from(seed.png as string, 'base64'), fs.readFileSync(sheetFile)), 0);
  assert.deepEqual(seed.frame, CHAR_FRAME, 'the row must say what its cells are');
  // char_0 is four rows tall; the header says so, and nothing decoded the image to find out.
  assert.deepEqual(seed.dirs, ['down', 'up', 'right', 'left']);
  assert.equal(seed.name, 'Nora', 'the metadata rides along');

  // The shape that broke: what JSON does to a Buffer, and what it costs.
  const roundTripped = JSON.parse(JSON.stringify(bundled())) as { png: { data: number[] } };
  assert.ok(Array.isArray(roundTripped.png.data), 'the old path produced this');
  // Measured: 2.6× for char_0 (10 267 bytes of array against 3 968 of base64), and the real
  // damage was not the ratio but that the array travelled at all.
  assert.ok(
    JSON.stringify(roundTripped).length > 2 * JSON.stringify(seed).length,
    `the array shape must be markedly bigger; got ${JSON.stringify(roundTripped).length} vs ${JSON.stringify(seed).length}`,
  );
});

test('the seed is addressable — the URL builder finds art in it', () => {
  const seed = avatarSeedFrom(bundled());
  assert.ok(artBytes(seed), 'without this the announce path falls back to sending the data itself');
  const msg = withArtUrl('character', 'pa:someone', seed, CHAR_FRAME) as Record<string, unknown>;
  assert.ok(typeof msg.url === 'string' && (msg.url as string).includes('/art/character/pa%3Asomeone?v='));
  assert.deepEqual(msg.artFrame, CHAR_FRAME);
  assert.equal(msg.png, undefined, 'and the sheet itself must not be in the message');
  assert.ok(JSON.stringify(msg).length < 1024, `the announce message is ${JSON.stringify(msg).length} bytes`);
});

test('a stored (SpriteData) skin is still cloned, and the clone is independent', () => {
  const stored = { name: 'Legacy', down: [[['#ff0000']]], up: [[['#00ff00']]], right: [[['#0000ff']]] };
  const seed = avatarSeedFrom(stored as unknown as Record<string, unknown>);
  assert.deepEqual(seed, stored, 'no pixels are packed here — the store does that on write');
  (seed.down as string[][][])[0][0][0] = '#000000';
  assert.equal(stored.down[0][0][0], '#ff0000', 'a seed must not share arrays with the gallery entry');
});

test('a sheet with fewer rows than four says so', () => {
  // Three rows is what every sheet drawn before `left` became a row has; the sprite store
  // completes the fourth by mirroring, and it may only do that if the row count is honest.
  const three = new PNG({ width: 7 * 16, height: 3 * 32 });
  three.data.fill(0);
  const seed = avatarSeedFrom({ png: PNG.sync.write(three), spec: { frame: CHAR_FRAME, tracks: [] } });
  assert.deepEqual(seed.dirs, ['down', 'up', 'right']);
});
