/**
 * Storing art as a PNG must be invisible to every caller.
 *
 * `appStore` packs character-shaped art on write and unpacks it on read, so the whole
 * server keeps handing over SpriteData. That is only true if the round trip is exact —
 * and the failure mode if it is not is quiet: an avatar comes back a shade off, or one
 * frame short, and nobody notices until somebody compares two screenshots.
 *
 * So: save through the real store, read back through the real store, compare deeply.
 * Then the two cases that are easy to get wrong — a LEGACY row (SpriteData written
 * before packing existed) must still read back untouched, and a pet must keep its
 * 16×16 geometry rather than being sliced on the character default.
 *
 * TEST BOUNDARIES:
 *   @real-dependency: appStore + SQLite -- Mock? NO. The pack/unpack seam IS the store;
 *       a stub would test my own assumption about it. A throwaway
 *       PIXEL_STREAM_DATA_DIR keeps it away from a developer's world, which is why
 *       appStore is imported dynamically (db.ts resolves that path at module load).
 *   @real-dependency: pngjs -- Mock? NO. It is the codec whose fidelity is the point.
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'pixel-artstore-'));
process.env.PIXEL_STREAM_DATA_DIR = dir;
const { appStore } = await import('./appStore.js');
const { packedPng } = await import('./art/artStore.js');
const { db } = await import('./db.js');
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));

/**
 * Same art, whatever the hex case and whatever order the keys ended up in: the decoder
 * canonicalises colours to upper case and a packed row lists its metadata before its
 * pixels (see art/artStore.ts). "Same colours in the same places" is what the round trip
 * owes its callers, so compare structurally with every string folded to lower case.
 */
const fold = (v: unknown): unknown =>
  typeof v === 'string' ? v.toLowerCase() : Array.isArray(v) ? v.map(fold) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fold(x)])) : v;
const sameArt = (a: unknown, b: unknown): void => assert.deepEqual(fold(a), fold(b));

/** A frame of `w`×`h` in one colour, with a couple of gaps and a translucent pixel. */
function frame(w: number, h: number, colour: string) {
  const f = Array.from({ length: h }, () => Array.from({ length: w }, () => colour));
  f[0][0] = '';
  f[1][1] = '#12345680';
  return f;
}
const character = (name: string) => ({
  name,
  down: [frame(16, 32, '#ff0000'), frame(16, 32, '#ee0000')],
  up: [frame(16, 32, '#00ff00'), frame(16, 32, '#00ee00')],
  right: [frame(16, 32, '#0000ff'), frame(16, 32, '#0000ee')],
  spec: { frame: { w: 16, h: 32 }, tracks: [{ name: 'walk', frames: 2, play: 'pingpong' }] },
});

test('a character survives save → read unchanged, and is stored as a PNG', () => {
  const data = character('Probe');
  appStore.saveAsset('character', 'char_probe', data);
  sameArt(appStore.getAsset('character', 'char_probe'), data);

  const row = appStore.assetRow('character', 'char_probe') as Record<string, unknown>;
  assert.ok(Buffer.isBuffer(row.png), 'the row should hold the sheet BYTES, not pixels and not base64');
  assert.equal(row.down, undefined, 'pixels must not be stored alongside the sheet');
  assert.ok(packedPng(row)!.length > 0);

  // And the sheet is in its own column, not inside the JSON. Two things follow from that and both
  // are worth pinning: nothing base64-encodes the pixels any more, and `data` stays small enough
  // that JSON.parse never walks an image.
  const stored = db.prepare("SELECT data, png FROM assets WHERE type = 'character' AND name = 'char_probe'").get() as {
    data: string;
    png: Uint8Array | null;
  };
  assert.equal(JSON.parse(stored.data).png, undefined, 'the sheet must not also be in the JSON column');
  assert.ok(stored.png && stored.png.byteLength > 0, 'the assets.png column is empty');
  assert.ok(stored.data.length < 500, `the JSON half should be metadata only, got ${stored.data.length} B`);

  // The point of the exercise: hex per pixel is what got expensive.
  const packed = stored.data.length + stored.png.byteLength;
  const raw = JSON.stringify(data).length;
  assert.ok(packed * 4 < raw, `packed ${packed} vs raw ${raw} — expected a large saving`);
});

test('a pet keeps its own 16×16 geometry', () => {
  const pet = {
    name: 'Probe pet',
    down: [frame(16, 16, '#abcdef')],
    up: [frame(16, 16, '#fedcba')],
    right: [frame(16, 16, '#123456')],
  };
  appStore.saveAsset('pet', 'dog_probe', pet);
  const back = appStore.getAsset<typeof pet>('pet', 'dog_probe')!;
  // Six columns come back because decodePetPng slices a fixed grid; the frames the
  // caller stored must be the first ones, unchanged, and the rest empty.
  sameArt(back.down[0], pet.down[0]);
  sameArt(back.right[0], pet.right[0]);
  assert.equal(back.down[0].length, 16, 'a pet frame is 16 rows tall, not 32');
});

test('a legacy row written before packing still reads back as it was', () => {
  const data = character('Legacy');
  // Straight into the table, bypassing saveAsset — exactly what an un-migrated world has.
  db.prepare('INSERT INTO assets(type,name,data,updatedAt) VALUES(?,?,?,?)').run(
    'character',
    'char_legacy',
    JSON.stringify(data),
    Date.now(),
  );
  assert.deepEqual(appStore.getAsset('character', 'char_legacy'), data, 'a legacy row must not be transformed at all');
  assert.equal(packedPng(appStore.assetRow('character', 'char_legacy')), null, 'a legacy row has no sheet to stream');
});

test('listAssets unpacks too — the merge path reads through it', () => {
  const names = (appStore.listAssets('character') as Array<{ name: string; data: { down?: unknown[] } }>).map((e) => ({
    name: e.name,
    frames: e.data.down?.length ?? 0,
  }));
  for (const n of names) assert.ok(n.frames > 0, `${n.name} came back without pixels`);
  assert.ok(names.length >= 2);
});

test('a fourth row survives the round trip, and a three-row sheet stays three rows', () => {
  // Authored left art is the reason left is a row at all: a mirror gets an asymmetric
  // detail wrong, so what the artist drew has to come back exactly.
  const withLeft = { ...character('Lefty'), left: [frame(16, 32, '#010203'), frame(16, 32, '#040506')] };
  appStore.saveAsset('character', 'char_lefty', withLeft);
  const back = appStore.getAsset<typeof withLeft>('character', 'char_lefty')!;
  sameArt(back.left, withLeft.left);
  sameArt(back.right, withLeft.right);

  // And the other direction: art with no left row must NOT gain an empty one — an empty
  // row draws an invisible character when facing left, which is worse than none.
  const noLeft = character('Righty');
  appStore.saveAsset('character', 'char_righty', noLeft);
  const plain = appStore.getAsset<Record<string, unknown>>('character', 'char_righty')!;
  assert.equal(plain.left, undefined, 'an empty left row was invented');
});
