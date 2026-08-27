/**
 * Give every account-owned table its `ON DELETE CASCADE`, once, on an existing database.
 *
 * A fresh database gets the constraint from the store that creates the table (both read the same
 * DDL — see `tables.ts`). An existing one cannot: SQLite has no `ALTER TABLE ADD CONSTRAINT`, so
 * the table has to be rebuilt. That is what this does, following SQLite's own procedure — foreign
 * keys off, rebuild inside a transaction, keys back on, then `foreign_key_check` to prove the
 * result is sound.
 *
 * It is destructive in exactly one way, and that is the point: a row whose account is already gone
 * cannot be kept, because the constraint it is about to live under forbids it. So the rules from
 * `maintenance/startupCleanup.ts` apply here too, and two of them are load-bearing:
 *
 *  • **A backup first.** One `VACUUM INTO` snapshot beside the database before anything is
 *    deleted or rebuilt (not a file copy — WAL means the log holds writes the main file does not).
 *    No backup, no migration.
 *  • **A refusal when the evidence looks broken.** If `users` is empty while child tables hold
 *    rows, then "every row is an orphan" is far more likely to mean a half-restored database than
 *    a world where everybody left. That is a deployment to fix, not a licence to delete, so the
 *    whole migration stands down and says so.
 *
 * And it must never keep the server from starting: any failure is logged and the next boot tries
 * again. The stores keep working either way — they only lose the cascade, which is what they had
 * before this file existed.
 *
 * **There is deliberately no `_migrations` marker.** The other one-time jobs here have one because
 * they read DATA and cannot tell from the result whether they have run. This one asks the SCHEMA,
 * which answers directly: `PRAGMA foreign_key_list` per table, seven cheap queries, and it is
 * already-done or it is not. A marker would be worse than redundant — the day a table is ADDED to
 * `USER_CHILD_TABLES`, every deployment that had already recorded the marker would skip it
 * forever, and the new table would silently keep its rows after the account was gone. That is
 * exactly the bug this file exists to prevent, so the check has to stay stateless.
 */
import { dataPath } from '../paths.js';
import { USER_CHILD_TABLES, type ChildTable } from './tables.js';

import type { DatabaseSync } from 'node:sqlite';

/** Does this table exist? A fresh database has none of them yet. */
function exists(db: DatabaseSync, table: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;
}

/** Does `column` already carry a cascading foreign key to `users`? */
function hasCascade(db: DatabaseSync, spec: ChildTable): boolean {
  const fks = db.prepare(`PRAGMA foreign_key_list(${spec.table})`).all() as Array<{
    table?: string;
    from?: string;
    on_delete?: string;
  }>;
  return fks.some((fk) => fk.table === 'users' && fk.from === spec.column && (fk.on_delete ?? '').toUpperCase() === 'CASCADE');
}

/**
 * Is the table already in the shape this build expects — constraint AND any load-bearing column
 * type? Both, because a table can carry the foreign key and still store a column with the wrong
 * affinity, and a check that only asked about the constraint would call such a table done forever.
 * `player_pos.dir` is the case that exists: as TEXT it silently converts a Direction into a string
 * the reader rejects (see the note on that column).
 */
function upToDate(db: DatabaseSync, spec: ChildTable): boolean {
  if (!hasCascade(db, spec)) return false;
  const want = spec.requireType;
  if (!want) return true;
  const col = (db.prepare(`PRAGMA table_info(${spec.table})`).all() as Array<{ name: string; type: string }>).find(
    (c) => c.name === want.column,
  );
  return (col?.type ?? '').toUpperCase() === want.type.toUpperCase();
}

function columnsOf(db: DatabaseSync, table: string): string[] {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return cols.map((c) => c.name);
}

/** Rows in `spec.table` whose account does not exist. */
function orphanCount(db: DatabaseSync, spec: ChildTable): number {
  const r = db
    .prepare(
      `SELECT COUNT(*) AS n FROM ${spec.table}
        WHERE ${spec.column} IS NOT NULL AND ${spec.column} NOT IN (SELECT user_id FROM users)`,
    )
    .get() as { n: number };
  return Number(r.n);
}

/**
 * Rebuild one table with its constraint, copying every column both versions share.
 *
 * The column intersection matters: a table may have grown a column in a database older than the
 * DDL here (or, the other way round, be missing one this build added), and `INSERT INTO … SELECT *`
 * would then fail or silently shift values into the wrong columns.
 */
function rebuild(db: DatabaseSync, spec: ChildTable): void {
  const tmp = `${spec.table}__fkmig`;
  db.exec(`DROP TABLE IF EXISTS ${tmp}`);
  db.exec(spec.ddl.replace(`IF NOT EXISTS ${spec.table}`, tmp).replace(`EXISTS ${spec.table}`, tmp));
  const shared = columnsOf(db, tmp).filter((c) => columnsOf(db, spec.table).includes(c));
  const list = shared.join(', ');
  db.exec(`INSERT INTO ${tmp} (${list}) SELECT ${list} FROM ${spec.table}`);
  db.exec(`DROP TABLE ${spec.table}`);
  db.exec(`ALTER TABLE ${tmp} RENAME TO ${spec.table}`);
  if (spec.indexes) db.exec(spec.indexes);
}

/**
 * Bring the schema up to date. Cheap and silent when there is nothing to do: one lookup per
 * account-owned table, which is the state of every boot after the first.
 *
 * Runs from `db.ts` before any store touches a row, because a store's own
 * `CREATE TABLE IF NOT EXISTS` would otherwise be a no-op over the old, unconstrained table and
 * the rebuild would then have to happen underneath live prepared statements.
 */
export function ensureUserForeignKeys(db: DatabaseSync): void {
  if (!exists(db, 'users')) return; // Nothing can reference an account table that is not there yet.

  const todo = USER_CHILD_TABLES.filter((s) => exists(db, s.table) && !upToDate(db, s));
  if (todo.length === 0) return; // The normal case, every boot: seven PRAGMA reads and out.

  const orphans = todo.map((spec) => ({ spec, n: orphanCount(db, spec) }));
  const totalOrphans = orphans.reduce((sum, o) => sum + o.n, 0);
  const accounts = Number((db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n);
  const rows = todo.reduce((sum, s) => sum + Number((db.prepare(`SELECT COUNT(*) AS n FROM ${s.table}`).get() as { n: number }).n), 0);

  // The evidence check. "No accounts, but rows that belong to accounts" is a broken database.
  if (accounts === 0 && rows > 0) {
    console.error(
      `[schema] user foreign keys NOT added: the users table is empty while ${rows} account-owned rows exist. ` +
        `That looks like a half-restored database, and every row would count as an orphan. Fix the deployment; this retries next boot.`,
    );
    return;
  }

  // A backup before the first destructive step, for the same reason PIXEL_RESET_WORLD writes one.
  const backup = dataPath(`pixel-before-fk-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
  try {
    db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
  } catch (err) {
    console.error(`[schema] user foreign keys NOT added — could not write a backup: ${(err as Error)?.message}`);
    return;
  }

  try {
    // Off, and outside the transaction: SQLite ignores a change to this pragma inside one, and
    // dropping a referenced table needs it off anyway.
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN');
    for (const { spec, n } of orphans) {
      if (n > 0) {
        db.exec(
          `DELETE FROM ${spec.table}
            WHERE ${spec.column} IS NOT NULL AND ${spec.column} NOT IN (SELECT user_id FROM users)`,
        );
      }
      rebuild(db, spec);
    }
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* nothing open */
    }
    console.error(`[schema] user foreign keys NOT added: ${(err as Error)?.message} (backup kept at ${backup})`);
    return;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }

  // Prove it rather than assume it: this lists every row that violates any constraint.
  const violations = db.prepare('PRAGMA foreign_key_check').all() as unknown[];
  if (violations.length > 0) {
    console.error(`[schema] user foreign keys added but ${violations.length} rows violate them — backup at ${backup}`);
    return;
  }

  const deleted = orphans.filter((o) => o.n > 0).map((o) => `${o.n} ${o.spec.table}`);
  console.log(
    `[schema] rebuilt with ON DELETE CASCADE: ${todo.map((s) => s.table).join(', ')}` +
      (totalOrphans > 0 ? `; deleted ${deleted.join(', ')} row(s) belonging to accounts that no longer exist` : '') +
      `; backup at ${backup}`,
  );
  if (totalOrphans === 0) {
    // Nothing was destroyed, so the snapshot is just disk. Say where it is rather than removing
    // it silently — a copy of a database is never deleted by a migration that just changed it.
    console.log(`[schema] no orphaned rows found; the backup above can be removed once the world looks right`);
  }
}
