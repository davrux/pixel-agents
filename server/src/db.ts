/**
 * Single shared SQLite connection for all server state — sessions, users,
 * settings, assets, layouts and zones. Previously split across layouts.db and
 * zones.db; consolidated into one pixel.db (one file, one connection).
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, renameSync } from 'node:fs';

import { dataPath } from './paths.js';
import { maybeResetWorld } from './worldReset.js';

export const db = new DatabaseSync(dataPath('pixel.db'));

migrateFromSplitDbs();
// Before any store reads or seeds: PIXEL_RESET_WORLD wipes everything but the
// accounts, once per token (see worldReset.ts). The stores then find an empty
// database and rebuild what they own.
maybeResetWorld(db);

/**
 * One-time import of the old two-file layout (layouts.db + zones.db) into the
 * single pixel.db: copies each table verbatim (schema + rows), records the
 * migration, then parks the old files as *.bak so it never runs again. A fresh
 * install (no old files) is a no-op.
 */
function migrateFromSplitDbs(): void {
  db.exec('CREATE TABLE IF NOT EXISTS _migrations (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const done = db.prepare("SELECT value FROM _migrations WHERE key = 'split_merge'").get();
  if (done) return;

  const oldFiles = ['layouts.db', 'zones.db'];
  for (const file of oldFiles) {
    const path = dataPath(file);
    if (!existsSync(path)) continue;
    const alias = file.replace(/\W/g, '_');
    db.exec(`ATTACH '${path.replace(/'/g, "''")}' AS ${alias}`);
    const tables = db
      .prepare(`SELECT name, sql FROM ${alias}.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
      .all() as Array<{ name: string; sql: string }>;
    for (const t of tables) {
      // Recreate the table verbatim in the main DB (preserves PK/constraints),
      // then copy its rows (IGNORE so a partial re-run can't duplicate).
      db.exec(t.sql.replace(/^CREATE TABLE\s+/i, 'CREATE TABLE IF NOT EXISTS main.'));
      db.exec(`INSERT OR IGNORE INTO main."${t.name}" SELECT * FROM ${alias}."${t.name}"`);
    }
    db.exec(`DETACH ${alias}`);
  }

  db.prepare('INSERT INTO _migrations(key, value) VALUES(?, ?)').run('split_merge', String(Date.now()));

  for (const file of oldFiles) {
    const path = dataPath(file);
    if (!existsSync(path)) continue;
    try {
      renameSync(path, `${path}.bak`);
    } catch {
      /* best-effort: keep going even if the rename fails */
    }
  }
}
