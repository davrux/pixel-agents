/**
 * The boot report that says how much stored art is still spelled out as pixels.
 *
 * Art is stored and served as a PNG sheet; a row written before that keeps working, because
 * `unpackArt` passes SpriteData through untouched. So there is no bug here to find — which is
 * exactly why nobody could see that there was anything left to convert. The conversion itself
 * stays manual on purpose (`scripts/repack-art.sh --apply`, and its header says why a boot with
 * nobody watching must not rewrite somebody's art), so the report is the whole feature.
 *
 * Two properties, and the first is the one that matters most for a boot line: it must say NOTHING
 * on a healthy world. A task that always prints something teaches everybody to ignore the boot.
 *
 * TEST BOUNDARIES:
 *   @real-dependency: SQLite -- Mock? NO. The task is one SQL query, and what is under test is
 *       whether that query tells a packed row from an unpacked one. Stubbing the database would
 *       leave nothing behind.
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'pixel-unpacked-art-'));
process.env.PIXEL_STREAM_DATA_DIR = dir;
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));

const { db } = await import('../db.js');
const { appStore } = await import('../appStore.js');
const { CLEANUP_TASKS } = await import('./startupCleanup.js');

const task = CLEANUP_TASKS.find((t) => t.name === 'report-unpacked-art');

/** Run the task, capturing what it warned about. */
function warnings(): string[] {
  const said: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => void said.push(args.map(String).join(' '));
  try {
    assert.ok(task, 'report-unpacked-art is not registered in CLEANUP_TASKS');
    task.run();
  } finally {
    console.warn = original;
  }
  return said;
}

test('a world whose art is packed produces no boot line at all', () => {
  // A packed row is what every save writes today: the sheet as base64 under `png`.
  db.prepare('INSERT INTO assets(type, name, data, updatedAt) VALUES(?, ?, ?, ?)').run(
    'character',
    'char_9',
    JSON.stringify({ name: 'Nine', png: 'iVBORw0KGgo=', frame: { w: 16, h: 32 }, dirs: ['down'] }),
    Date.now(),
  );
  assert.deepEqual(warnings(), []);
});

test('a row still stored as pixels is counted and named', () => {
  db.prepare('INSERT INTO assets(type, name, data, updatedAt) VALUES(?, ?, ?, ?)').run(
    'character',
    'char_legacy',
    JSON.stringify({ name: 'Old', down: [[['#ff0000', '']]], up: [[['']]], right: [[['']]] }),
    Date.now(),
  );
  const said = warnings();
  assert.equal(said.length, 1, `expected exactly one line, got ${said.length}`);
  assert.match(said[0], /1 art row\(s\) are still stored as pixels/);
  // It points at the tool rather than doing the work: the row must survive the report untouched.
  assert.match(said[0], /repack-art\.sh --apply/);
  assert.ok(Array.isArray((appStore.assetRow('character', 'char_legacy') as { down?: unknown })?.down), 'the report changed the row');
});

test('an asset type that never held a sheet is not accused', () => {
  // Only character/pet/playerAvatar rows are sheets (PACKED_ART_TYPES). Anything else has no
  // `png` field by design, and counting it would make the line permanent and meaningless.
  db.prepare('INSERT INTO assets(type, name, data, updatedAt) VALUES(?, ?, ?, ?)').run(
    'gallery',
    'whatever',
    JSON.stringify({ some: 'config' }),
    Date.now(),
  );
  const said = warnings();
  assert.equal(said.length, 1, 'the count changed — a non-sheet type was counted');
  assert.match(said[0], /1 art row\(s\)/);
});
