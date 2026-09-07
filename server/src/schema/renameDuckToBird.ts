/**
 * Rename the pet kind `duck` to `bird`, once, wherever a stored row names it.
 *
 * The kind was the species; now it is the CATEGORY, so a magpie or an owl can join without a third
 * enum value and without a second rename. The two animals that exist are still ducks — Rudi is a
 * mallard drake and says so in `assets/pets/README.md` — but their slot ids are `bird_0`/`bird_1`,
 * because an id is `${kind}_${index}` by construction and nothing may know that better than the
 * kind does.
 *
 * Two places store such an id, and both are user data rather than code:
 *
 *  • `assets` rows of type `pet` — an edited sheet, its name, its spawn config.
 *  • `zones.pets` — which variants a zone spawns, as a JSON array of those ids.
 *
 * Deliberately no `_migrations` marker, like the other schema jobs here: the question answers
 * itself, since a row either still says `duck_` or it does not. Running it twice cannot lose
 * anything — and where a `bird_N` row already exists (somebody edited the art after the rename and
 * an old `duck_N` row is still lying around), the NEW row wins and the old one is left untouched
 * rather than overwriting work with something older.
 */
import type { DatabaseSync } from 'node:sqlite';

const OLD = 'duck_';
const NEW = 'bird_';

export function renameDuckToBird(db: DatabaseSync): void {
  const has = (table: string): boolean =>
    !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);

  let assets = 0;
  const skipped: string[] = [];
  if (has('assets')) {
    const rows = db
      .prepare("SELECT name FROM assets WHERE type = 'pet' AND name LIKE 'duck\\_%' ESCAPE '\\'")
      .all() as Array<{ name: string }>;
    const exists = db.prepare("SELECT 1 FROM assets WHERE type = 'pet' AND name = ?");
    const rename = db.prepare("UPDATE assets SET name = ? WHERE type = 'pet' AND name = ?");
    for (const { name } of rows) {
      const target = NEW + name.slice(OLD.length);
      if (exists.get(target)) {
        skipped.push(`${name} (a ${target} row already exists)`);
        continue;
      }
      rename.run(target, name);
      assets++;
    }
  }

  let zones = 0;
  // WHICH column, resolved from the schema rather than assumed. It is `pets` today and was `npc`
  // before 2026-08-27, and `ZoneStore` renames it — but that happens when the STORE is
  // constructed, which is after this file runs. A pre-rename database would therefore have met a
  // `SELECT … pets` that throws "no such column", and a boot task may never keep the server from
  // starting (AGENTS.md § Operations). Both names are literals from this file, so there is nothing
  // to escape.
  const petsColumn = ((): 'pets' | 'npc' | null => {
    if (!has('zones')) return null;
    const cols = (db.prepare('PRAGMA table_info(zones)').all() as Array<{ name: string }>).map((c) => c.name);
    return cols.includes('pets') ? 'pets' : cols.includes('npc') ? 'npc' : null;
  })();
  if (petsColumn) {
    // The column holds a JSON array of ids. Rewritten as TEXT rather than through json_*: the
    // value is a list of short literals, and a string replace cannot reorder or reformat what a
    // zone's owner picked. Only the exact prefix is touched, so a zone named "duck_pond" is safe —
    // the pattern requires the quote.
    const rows = db
      .prepare(`SELECT id, ${petsColumn} AS pets FROM zones WHERE ${petsColumn} LIKE '%"duck\\_%' ESCAPE '\\'`)
      .all() as Array<{ id: string; pets: string }>;
    const update = db.prepare(`UPDATE zones SET ${petsColumn} = ? WHERE id = ?`);
    for (const { id, pets } of rows) {
      const next = pets.replaceAll('"duck_', '"bird_');
      // Only write what still parses as the same shape: a hand-edited column must not be turned
      // into something the room then fails to read.
      try {
        const parsed: unknown = JSON.parse(next);
        if (!Array.isArray(parsed)) continue;
      } catch {
        continue;
      }
      update.run(next, id);
      zones++;
    }
  }

  if (assets > 0) console.log(`[schema] renamed ${assets} stored pet row(s) from duck_* to bird_*`);
  if (zones > 0) console.log(`[schema] renamed the pet selection of ${zones} zone(s) from duck_* to bird_*`);
  for (const s of skipped) console.warn(`[schema] left ${s} alone: the newer name is already taken`);
}
