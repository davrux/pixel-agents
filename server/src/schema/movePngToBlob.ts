/**
 * Move each stored sheet out of its JSON row and into the `assets.png` BLOB column, once.
 *
 * Character-shaped art has been stored as a PNG for a while, but as a base64 field inside the
 * `data` JSON — so every read parsed the pixels as a string and every write encoded them into one.
 * That is packaging for a packaging that was not needed: base64 exists only because the bytes were
 * living in a text column. Measured on char_0, the stored row goes 4 041 → 3 063 bytes (−24 %), a
 * read that needs the bytes 3.64 → 1.06 µs and a write 3.08 → 0.50 µs, because `JSON.parse` sees
 * 164 bytes instead of 4 KB.
 *
 * Worth saying plainly, because the numbers above invite the wrong conclusion: **this is not a
 * speed fix.** Every path involved is cached — the merged bundle is built once per cache generation
 * and `/art/<kind>/<id>` answers with an immutable ETag — so the absolute saving is microseconds
 * per join. What it buys is a quarter of the space and a data model where the pixels are bytes.
 *
 * Nothing on the wire changes: art has travelled as a URL since protocol 8, so there is no
 * `PROTOCOL_VERSION` bump here.
 *
 * Like the other schema jobs next door it carries **no `_migrations` marker**: the question is
 * self-answering, since a row is either still holding a `png` inside its JSON or it is not. It runs
 * from `db.ts` before the stores, so no prepared statement is pointing at the table while the
 * column is added.
 *
 * A row that cannot be moved is LEFT EXACTLY AS IT WAS and logged. Readers accept both shapes on
 * purpose (`artStore.ts`), for the two cases that really occur: a database that has not run this
 * yet, and a restored backup.
 */
import type { DatabaseSync } from 'node:sqlite';

/** Does the table exist, and does it already have the column? */
function state(db: DatabaseSync): { table: boolean; column: boolean } {
  const table =
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'assets'").get() !== undefined;
  if (!table) return { table: false, column: false };
  const cols = db.prepare('PRAGMA table_info(assets)').all() as Array<{ name: string }>;
  return { table: true, column: cols.some((c) => c.name === 'png') };
}

export function movePngToBlob(db: DatabaseSync): void {
  const { table, column } = state(db);
  if (!table) return; // A fresh database: appStore creates the table with the column already there.
  if (!column) db.exec('ALTER TABLE assets ADD COLUMN png BLOB');

  // Rows whose sheet is still a base64 field inside the JSON. `json_valid` first, because a
  // corrupt row must not make json_extract the thing that fails the boot.
  const rows = db
    .prepare(
      `SELECT type, name, data FROM assets
        WHERE json_valid(data) AND json_extract(data, '$.png') IS NOT NULL`,
    )
    .all() as Array<{ type: string; name: string; data: string }>;
  if (rows.length === 0) return;

  const update = db.prepare('UPDATE assets SET data = ?, png = ? WHERE type = ? AND name = ?');
  let moved = 0;
  let before = 0;
  let after = 0;
  const failed: string[] = [];

  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.data) as Record<string, unknown>;
      const { png, ...meta } = parsed;
      if (typeof png !== 'string' || png.length === 0) {
        failed.push(`${row.type}/${row.name}`);
        continue;
      }
      const bytes = Buffer.from(png, 'base64');
      // Two sanity checks before overwriting anything: base64 that decodes to nothing, or bytes
      // that are not a PNG, mean this row is not what it claims and is better left alone than
      // rewritten into a column where the next reader would trust it.
      if (bytes.length === 0 || bytes.readUInt32BE(0) !== 0x89504e47) {
        failed.push(`${row.type}/${row.name}`);
        continue;
      }
      const metaJson = JSON.stringify(meta);
      update.run(metaJson, bytes, row.type, row.name);
      before += row.data.length;
      after += metaJson.length + bytes.length;
      moved++;
    } catch {
      failed.push(`${row.type}/${row.name}`);
    }
  }

  if (moved > 0) {
    const saved = before - after;
    console.log(
      `[schema] moved ${moved} art sheet(s) out of JSON into the assets.png column: ` +
        `${(before / 1024).toFixed(1)} → ${(after / 1024).toFixed(1)} KB (${((saved / before) * 100).toFixed(1)} % smaller)`,
    );
  }
  if (failed.length > 0) {
    console.warn(
      `[schema] ${failed.length} art row(s) left as they were, their png field is not a PNG: ${failed.slice(0, 5).join(', ')}`,
    );
  }
}
