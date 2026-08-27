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

test('a bundled sheet is seeded as the file bytes with its geometry, never through JSON', () => {
  const seed = avatarSeedFrom(bundled());
  assert.ok(Buffer.isBuffer(seed.png), 'the sheet must stay bytes — the store writes them to a BLOB column');
  assert.equal(Buffer.compare(seed.png as Buffer, fs.readFileSync(sheetFile)), 0, 'byte-for-byte the bundled file');
  assert.deepEqual(seed.frame, CHAR_FRAME, 'the row must say what its cells are');
  // char_0 is four rows tall; the header says so, and nothing decoded the image to find out.
  assert.deepEqual(seed.dirs, ['down', 'up', 'right', 'left']);
  assert.equal(seed.name, 'Nora', 'the metadata rides along');

  // The shape that broke, kept as the record of what a JSON round trip does to a Buffer. This is
  // why the seed exists at all, and why it must not gain one: `{"type":"Buffer","data":[137,80,…]}`
  // is 10 267 bytes for a 2 899-byte sheet, and the damage was not the ratio — it was that the
  // array then travelled to every viewer in the zone as the avatar's art.
  const roundTripped = JSON.parse(JSON.stringify(bundled())) as { png: { data: number[] } };
  assert.ok(Array.isArray(roundTripped.png.data), 'the old path produced this');
  assert.ok(
    JSON.stringify(roundTripped).length > 3 * (seed.png as Buffer).length,
    `a JSON'd Buffer must be markedly bigger than the bytes; got ${JSON.stringify(roundTripped).length} vs ${(seed.png as Buffer).length}`,
  );
});

test('the seed is stored as bytes in a column, and the JSON never sees the sheet', async () => {
  // Where the Buffer regression can still happen: the write. `saveAsset` splits the row, so the
  // sheet goes into `assets.png` and the JSON half holds only what a sheet cannot carry. If that
  // split ever goes away, `JSON.stringify` gets the Buffer again and this fails on both counts.
  const { appStore } = await import('./appStore.js');
  const { db } = await import('./db.js');
  appStore.setPlayerAvatar('seedtest', avatarSeedFrom(bundled()));

  const stored = db.prepare("SELECT data, png FROM assets WHERE type = 'playerAvatar' AND name = 'seedtest'").get() as {
    data: string;
    png: Uint8Array | null;
  };
  assert.ok(stored, 'nothing was stored');
  assert.equal(JSON.parse(stored.data).png, undefined, 'the sheet must not be in the JSON column');
  assert.match(stored.data, /^\{(?!.*"type":"Buffer").*\}$/s, 'a JSON-encoded Buffer is in the row');
  assert.ok(stored.png, 'the assets.png column is empty');
  assert.equal(Buffer.compare(Buffer.from(stored.png), fs.readFileSync(sheetFile)), 0, 'the stored bytes are not the sheet');
  // And it reads back as the same row a caller started with.
  const back = appStore.assetRow('playerAvatar', 'seedtest') as Record<string, unknown>;
  assert.ok(Buffer.isBuffer(back.png));
  assert.equal(back.name, 'Nora');
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
