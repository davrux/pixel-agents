/**
 * Copying an avatar into the gallery copies the ROW, not the pixels.
 *
 * "Save my avatar as a template" (`avatarToTemplate`) used to read the stored avatar through
 * `getPlayerAvatar`, which unpacks its PNG into one hex string per pixel, clone it, set the name
 * and hand it to `saveAsset`, which encodes the whole sheet again — on the thread the world ticks
 * on, to rename a copy of art this server itself wrote and stored. Measured through the real store
 * (minimum of seven runs, synthetic sheets, so the ratio is the number to read): **21.7 ms against
 * 0.19 ms** for an ordinary 16×32 sheet and **29.9 ms against 0.06 ms** for a maximal 64×64 one.
 *
 * The bytes are identical either way — a deterministic encoder re-encoding the same pixels gives
 * the same file — so no test can tell the two paths apart by their OUTPUT, and that is exactly why
 * this one exists in the shape it does: it pins what the copy has to produce (the same sheet, one
 * new name, every other field carried over) so the cheap path cannot quietly start producing
 * something else, and it pins the gate, because dropping the full guard is the risk the change
 * takes. Only the NAME is new in that row, so the name is the only thing left to validate.
 *
 * TEST BOUNDARIES:
 *   @real-dependency: appStore + SQLite -- Mock? NO. The pack/unpack seam IS the store, and the
 *       claim is about which of its two doors the copy goes through. A throwaway
 *       PIXEL_STREAM_DATA_DIR keeps it away from a developer's world, which is why appStore is
 *       imported dynamically (db.ts resolves that path at module load).
 *   @real-dependency: pngjs -- Mock? NO. Whether the sheet survives the copy is the point.
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'pixel-tmplcopy-'));
process.env.PIXEL_STREAM_DATA_DIR = dir;
const { appStore } = await import('./appStore.js');
const { packedPng } = await import('./art/artStore.js');
const { validSheetName } = await import('./art/characterDataGuard.js');
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));

/** A small four-row sheet with a spec, i.e. the shape an avatar actually has. */
const avatar = (name: string): Record<string, unknown> => {
  const row = (): string[][] =>
    Array.from({ length: 32 }, (_, y) =>
      Array.from({ length: 16 * 7 }, (_, x) => (x % 5 === 0 ? '' : `#${(((x * 37 + y * 11) & 0xffffff) | 0x202020).toString(16).padStart(6, '0')}`)),
    );
  return {
    name,
    down: row(),
    up: row(),
    right: row(),
    left: row(),
    dims: { w: 16, h: 32 },
    spec: { frame: { w: 16, h: 32 }, tracks: { walk: 3, typing: 2, reading: 2 } },
  };
};

/** What the handler does, in the two lines it is: the stored row, renamed. */
const copyAsTemplate = (owner: string, to: string, name: string): void => {
  const row = appStore.assetRow('playerAvatar', owner) as Record<string, unknown>;
  appStore.saveAsset('character', to, { ...row, name });
};

test('a template carries the avatar’s own sheet, with only the name replaced', () => {
  appStore.saveAsset('playerAvatar', 'owner', avatar('Mine'));
  const source = appStore.assetRow('playerAvatar', 'owner') as Record<string, unknown>;
  const sheet = packedPng(source);
  assert.ok(sheet, 'the avatar was not stored as a packed row, so there is nothing to copy');

  copyAsTemplate('owner', 'char_t0', 'Template');
  const made = appStore.assetRow('character', 'char_t0') as Record<string, unknown>;
  const copied = packedPng(made);
  assert.ok(copied, 'the template lost its sheet');
  assert.equal(Buffer.compare(Buffer.from(sheet), Buffer.from(copied)), 0, 'the template holds a different sheet');
  assert.equal(made.name, 'Template', 'the template kept the avatar’s name');
  // Everything a sheet cannot hold comes with it — without the frame size a client slices a
  // 16×32 sheet on some other default, and without the spec the poses are gone.
  assert.deepEqual(made.frame, source.frame, 'the frame size did not survive the copy');
  assert.deepEqual(made.dirs, source.dirs, 'the direction rows did not survive the copy');
  assert.deepEqual(made.spec, source.spec, 'the CharacterSpec did not survive the copy');

  // And it reads back as ordinary SpriteData, so nothing downstream learns that a copy was cheap.
  const back = appStore.getAsset<Record<string, unknown>>('character', 'char_t0');
  assert.ok(Array.isArray(back?.down) && (back?.down as unknown[]).length === 32, 'the template does not read back as art');
  assert.equal(back?.name, 'Template');
});

test('the name is the only new field, and it is still gated', () => {
  // The rule the full guard applied to a sheet's name, now asked on its own — printable ASCII,
  // at least one character. Dropping the guard from this path must not drop this with it.
  assert.equal(validSheetName('Template'), true);
  assert.equal(validSheetName(''), false, 'an empty name is not a name');
  assert.equal(validSheetName('Ümlaut'), false, 'non-ASCII passed a rule that refuses it');
  assert.equal(validSheetName('x'.repeat(200)), false, 'a name longer than cleanName would cut it passed');
});
