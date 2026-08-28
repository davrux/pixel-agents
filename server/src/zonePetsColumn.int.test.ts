/**
 * A zone's pet selection survives the column being renamed.
 *
 * `zones.npc` became `zones.pets` when everything the code called an NPC was renamed to what it
 * actually is (a pet), freeing the word NPC for the humanoid characters this world is meant to grow. The
 * column holds which pet variants an admin enabled for a zone — authored data, per zone.
 *
 * The whole risk lives in one `if`. `migrateColumns` either RENAMES the old column (values come
 * along) or ADDS a fresh one and defaults every non-default zone to `'[]'`, which is exactly right
 * for a database that never had the column and exactly a wipe for one that did. Getting that
 * branch wrong would silently empty the pet list of every zone in the world, and nothing would
 * look broken — the zones panel would simply show "0" where it used to show the animals somebody
 * chose.
 *
 * TEST BOUNDARIES:
 *   @real-dependency: SQLite + the real ZoneStore -- Mock? NO. The subject is what a migration
 *       does to rows, so the rows and the migration are both real. The old shape is built by hand
 *       first, because the point is a database that predates this build.
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'pixel-zonepets-'));
process.env.PIXEL_STREAM_DATA_DIR = dir;
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));

const { db } = await import('./db.js');

// The `zones` table as it was: the selection column still called `npc`. Built before ZoneStore is
// imported, because its constructor is what migrates.
db.exec(`
  CREATE TABLE zones (
    id TEXT PRIMARY KEY, label TEXT NOT NULL,
    arrive_col INTEGER, arrive_row INTEGER, cols INTEGER, rows INTEGER,
    read_only INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT 0,
    npc TEXT
  )`);
const put = db.prepare('INSERT INTO zones(id, label, created_at, npc) VALUES(?, ?, 0, ?)');
put.run('uponu', 'UPONU', null); // null = every active variant
put.run('garden', 'Garden', '["dog_0","duck_1"]'); // somebody chose these two
put.run('empty', 'Empty', '[]'); // and somebody chose none

const { ZoneStore } = await import('./zoneStore.js');
const zones = new ZoneStore();

test('the old column is renamed, so every zone keeps the pets somebody chose', () => {
  const cols = (db.prepare('PRAGMA table_info(zones)').all() as Array<{ name: string }>).map((c) => c.name);
  assert.ok(cols.includes('pets'), 'the column was not renamed');
  assert.equal(cols.includes('npc'), false, 'the old column is still there — both would drift apart');

  const stored = Object.fromEntries(
    (db.prepare('SELECT id, pets FROM zones').all() as Array<{ id: string; pets: string | null }>).map((r) => [r.id, r.pets]),
  );
  assert.equal(stored.garden, '["dog_0","duck_1"]', 'an authored selection was lost in the rename');
  assert.equal(stored.empty, '[]', '"no pets" is a choice and must not become "all"');
  assert.equal(stored.uponu, null, 'null means every active variant and must stay null');
});

test('the store reads them back under the new name', () => {
  const list = Object.fromEntries(zones.list().map((z) => [z.id, z.pets]));
  assert.deepEqual(list.garden, ['dog_0', 'duck_1']);
  assert.deepEqual(list.empty, []);
  assert.equal(list.uponu, null);
});

test('a second construction changes nothing', () => {
  // The migration is guarded by the column being present, not by a marker, so it has to be
  // idempotent by inspection — and a second pass must not hit the "add a fresh column" branch,
  // which would default every zone away from what it holds.
  new ZoneStore();
  const stored = (db.prepare("SELECT pets FROM zones WHERE id = 'garden'").get() as { pets: string }).pets;
  assert.equal(stored, '["dog_0","duck_1"]');
});
