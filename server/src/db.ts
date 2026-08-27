/**
 * Single shared SQLite connection for all server state — sessions, users,
 * settings, assets, layouts and zones. Previously split across layouts.db and
 * zones.db; consolidated into one pixel.db (one file, one connection).
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, renameSync } from 'node:fs';

import { bootstrapDataDir } from './dataBootstrap.js';
import { dataPath } from './paths.js';
import { maybeResetWorld } from './worldReset.js';

// Before the connection exists: creates the data directory and, on a first run,
// copies in a database from a former default location (see dataBootstrap.ts).
// Opening the connection would otherwise create an empty file first and there
// would be nothing left to adopt.
bootstrapDataDir();

export const db = new DatabaseSync(dataPath('pixel.db'));

/**
 * Two pragmas, set before anything writes, because this file is opened by more than one process.
 *
 * `busy_timeout` is the one that was missing and it cost real time to find. Opening this module
 * WRITES — the `CREATE TABLE IF NOT EXISTS` below takes SQLite's write lock — so any second
 * process that starts at the same moment gets `SQLITE_BUSY: database is locked` and dies while
 * still importing. That is not hypothetical: it is what made roughly one in eight parallel test
 * runs fail with a bare "test failed" and no assertion, on a different file every time (the one
 * that lost the race), and it is the same collision a maintenance script hits when it runs
 * against a live server — `prune-orphan-assets`, `repack-art`, a zone push. Five seconds of
 * waiting turns a crash into a pause nobody notices.
 *
 * `journal_mode = WAL` so a reader never blocks the writer at all: with one server process and
 * the occasional script, that is the shape this database actually has. It costs the two sidecar
 * files (-wal, -shm) next to pixel.db, and `VACUUM INTO` backups keep working.
 */
db.exec('PRAGMA busy_timeout = 5000');
db.exec('PRAGMA journal_mode = WAL');

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
