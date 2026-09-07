/**
 * The `duck` → `bird` rename, on the two places a stored id lives.
 *
 * The pet kind was a species and is a CATEGORY now, so an owl or a magpie needs no fourth enum
 * value. The two animals that exist are still ducks — Rudi is a mallard drake — but their slot ids
 * are `bird_0`/`bird_1`, because an id is `${kind}_${index}` by construction. Code was renamed by
 * hand; USER DATA has to be carried across, and that is what this pins:
 *
 *  • an `assets` row of type `pet` (an edited sheet, its name, its spawn config)
 *  • `zones.pets` — the JSON array of ids saying which variants a zone spawns
 *
 * Three properties beyond "it renames things", each one a way this could go wrong quietly:
 *
 *  1. **It runs on the column that is actually there.** The zone column is `pets` today and was
 *     `npc` before 2026-08-27, and `ZoneStore` renames it when the STORE is built — which is after
 *     the schema jobs run. A `SELECT … pets` against an old database throws "no such column", and a
 *     boot task may never keep the server from starting. This test drives both spellings.
 *  2. **It never overwrites newer work.** If a `bird_N` row already exists, a leftover `duck_N` is
 *     left where it is rather than replacing art somebody saved after the rename.
 *  3. **It is idempotent and quiet on a fresh world**, like the other stateless schema jobs — no
 *     `_migrations` marker, because a row either still says `duck_` or it does not.
 *
 * TEST BOUNDARIES:
 *   @real-dependency: node:sqlite in memory -- Mock? NO. The whole subject is what SQL does to
 *       rows, and the bug this test caught on its first run was in the SQL itself: an escaped quote
 *       inside a template literal collapsed `ESCAPE '\'` into `ESCAPE ''`, which SQLite refuses.
 *       A stubbed database would have "passed".
 */
import { strict as assert } from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { renameDuckToBird } from './schema/renameDuckToBird.js';

/** A database with the two tables this touches, `zones` under the given column name. */
function world(petsColumn: 'pets' | 'npc' | null = 'pets'): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE assets (type TEXT NOT NULL, name TEXT NOT NULL, data TEXT, PRIMARY KEY (type, name))`);
  if (petsColumn) {
    db.exec(`CREATE TABLE zones (id TEXT PRIMARY KEY, label TEXT NOT NULL, ${petsColumn} TEXT)`);
  }
  return db;
}

const assetNames = (db: DatabaseSync): string[] =>
  (db.prepare("SELECT name FROM assets WHERE type = 'pet' ORDER BY name").all() as Array<{ name: string }>).map(
    (r) => r.name,
  );
const zonePets = (db: DatabaseSync, col = 'pets'): Record<string, string | null> =>
  Object.fromEntries(
    (db.prepare(`SELECT id, ${col} AS p FROM zones`).all() as Array<{ id: string; p: string | null }>).map((r) => [
      r.id,
      r.p,
    ]),
  );

test('a stored pet row and a zone selection both move to the new name', () => {
  const db = world();
  const put = db.prepare("INSERT INTO assets(type, name, data) VALUES('pet', ?, ?)");
  put.run('duck_0', '{"name":"Rudi"}');
  put.run('duck_1', '{"name":"Frieda"}');
  put.run('dog_0', '{"name":"Emma"}');
  const zone = db.prepare('INSERT INTO zones(id, label, pets) VALUES(?, ?, ?)');
  zone.run('garden', 'Garden', '["dog_0","duck_1"]');
  zone.run('all', 'All', null); // null = every active variant, must stay null
  zone.run('none', 'None', '[]'); // "no pets" is a choice

  renameDuckToBird(db);

  assert.deepEqual(assetNames(db), ['bird_0', 'bird_1', 'dog_0'], 'the stored sheets kept the old ids');
  // The data rides along untouched — this renames a KEY, it does not rewrite what is under it.
  const rudi = db.prepare("SELECT data FROM assets WHERE type='pet' AND name='bird_0'").get() as { data: string };
  assert.equal(rudi.data, '{"name":"Rudi"}');

  const pets = zonePets(db);
  assert.equal(pets.garden, '["dog_0","bird_1"]', 'the zone still spawns a variant nobody offers');
  assert.equal(pets.all, null, 'null means every variant and must stay null');
  assert.equal(pets.none, '[]', '"no pets" must not become "all"');
});

test('it works on the column name a pre-rename database still has', () => {
  // The trap: this job runs BEFORE ZoneStore renames `npc` to `pets`, so on an older world the
  // column has the old name. Assuming `pets` threw "no such column" and took the boot with it.
  const db = world('npc');
  db.prepare('INSERT INTO zones(id, label, npc) VALUES(?, ?, ?)').run('garden', 'Garden', '["duck_0"]');
  renameDuckToBird(db);
  assert.equal(zonePets(db, 'npc').garden, '["bird_0"]');
});

test('newer work is never overwritten by a leftover', () => {
  // Somebody edited the bird after the rename, and an old duck row is still lying around. The new
  // row is the real one; the old id keeps its name rather than replacing it.
  const db = world();
  const put = db.prepare("INSERT INTO assets(type, name, data) VALUES('pet', ?, ?)");
  put.run('duck_0', '{"name":"old"}');
  put.run('bird_0', '{"name":"new"}');

  renameDuckToBird(db);

  assert.deepEqual(assetNames(db), ['bird_0', 'duck_0'], 'the leftover was renamed over the newer row');
  const kept = db.prepare("SELECT data FROM assets WHERE type='pet' AND name='bird_0'").get() as { data: string };
  assert.equal(kept.data, '{"name":"new"}', 'the newer sheet was replaced by an older one');
});

test('a second run changes nothing, and a fresh world is untouched', () => {
  const db = world();
  db.prepare("INSERT INTO assets(type, name, data) VALUES('pet', 'duck_0', '{}')").run();
  db.prepare('INSERT INTO zones(id, label, pets) VALUES(?, ?, ?)').run('g', 'G', '["duck_0"]');
  renameDuckToBird(db);
  const after = { assets: assetNames(db), zones: zonePets(db) };
  renameDuckToBird(db);
  assert.deepEqual({ assets: assetNames(db), zones: zonePets(db) }, after, 'running it twice moved something');

  // And with neither table present it must simply do nothing rather than throw: this runs at boot,
  // before the stores create what they own.
  const bare = new DatabaseSync(':memory:');
  renameDuckToBird(bare);

  // A zone whose NAME merely contains the word is not a selection and must not be touched.
  const db2 = world();
  db2.prepare('INSERT INTO zones(id, label, pets) VALUES(?, ?, ?)').run('duck_pond', 'Duck Pond', '["cat_0"]');
  renameDuckToBird(db2);
  assert.deepEqual(Object.keys(zonePets(db2)), ['duck_pond'], 'a zone id was rewritten');
  assert.equal(zonePets(db2).duck_pond, '["cat_0"]');
});
