/**
 * One-shot world wipe on startup: keep the accounts, drop everything else.
 *
 * A deployment accumulates state that is no longer authored where it is stored —
 * maps that now come from Tiled pushes, an `assets` override layer left over from
 * the in-game editors, zones and their rights, saved positions into rooms that no
 * longer exist. `PIXEL_RESET_WORLD=<token>` clears that out once, at the next
 * start, before any store has read or seeded anything: the stores then find an
 * empty database and rebuild what they own (the default zone is re-created and
 * renders as an empty field until a map is pushed).
 *
 * **The token is what makes it a one-shot.** It is remembered in `_migrations`,
 * so leaving the variable in a deploy's .env is harmless — every later restart
 * sees the same token and does nothing. Changing it to a new value arms the wipe
 * again; that is the only way to repeat it.
 *
 * A copy of the database is written next to it first (`pixel-before-reset-*.db`,
 * a consistent `VACUUM INTO` snapshot, not a file copy), because this is not
 * undoable and a container's volume is where the only copy lives.
 *
 * **What survives is an allow-list** ({@link KEEP_TABLES} plus the personal
 * avatars in `assets`) — everything else is deleted, including tables added
 * after this was written. That is deliberate: a new table holding *world* data
 * is then covered for free, and a new table holding *account* data announces
 * itself by being emptied. If you add one of the latter, add it here in the same
 * change.
 */
import type { DatabaseSync } from 'node:sqlite';

import { dataPath } from './paths.js';

/** Tables whose contents survive the wipe. */
const KEEP_TABLES = new Set([
  // The accounts themselves: login id, display name, password, admin flag,
  // per-user agent token.
  'users',
  // Schema/one-time-operation bookkeeping — deleting this would re-run
  // migrations against an already-migrated database, and it holds this very
  // reset's token.
  '_migrations',
]);

/** Asset rows that survive: a user's own avatar belongs to their account, the
 *  rest of the table is the editor-era override layer this wipe is for. */
const KEEP_ASSET_TYPE = 'playerAvatar';

/** Marker key in `_migrations`. */
const MARKER = 'world_reset';

export function maybeResetWorld(db: DatabaseSync): void {
  const token = (process.env.PIXEL_RESET_WORLD ?? '').trim();
  if (!token) return;
  const done = db.prepare(`SELECT value FROM _migrations WHERE key = '${MARKER}'`).get() as
    | { value: string }
    | undefined;
  // Already wiped for this token — the normal case on every restart after the
  // one that did it.
  if (done && done.value.split('|')[0] === token) return;

  const tables = (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string }>
  ).map((t) => t.name);
  if (!tables.includes('users')) {
    // A brand-new database has nothing to wipe; record the token so the same
    // .env doesn't keep arming a no-op.
    recordDone(db, token, 0);
    console.log('[reset] fresh database — nothing to wipe');
    return;
  }

  const backup = dataPath(`pixel-before-reset-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
  try {
    db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
    console.log(`[reset] backup written: ${backup}`);
  } catch (err) {
    // No backup, no wipe: losing the only copy of a deployment's database
    // because a disk was full is not a trade worth making.
    console.error(`[reset] ABORTED — could not write a backup: ${(err as Error)?.message}`);
    return;
  }

  const count = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
  let removed = 0;
  db.exec('BEGIN');
  try {
    for (const table of tables) {
      if (KEEP_TABLES.has(table)) continue;
      const quoted = `"${table.replace(/"/g, '""')}"`;
      const where = table === 'assets' ? ` WHERE type <> '${KEEP_ASSET_TYPE}'` : '';
      const n = count(`SELECT count(*) AS n FROM ${quoted}${where}`);
      if (n === 0) continue;
      db.exec(`DELETE FROM ${quoted}${where}`);
      removed += n;
      console.log(`[reset]   ${table}: ${n} row(s) deleted`);
    }
    recordDone(db, token, removed);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    console.error(`[reset] FAILED, database unchanged: ${(err as Error)?.message}`);
    return;
  }
  // Outside the transaction: reclaim the space the old maps and sprite sheets took.
  db.exec('VACUUM');
  const kept = count("SELECT count(*) AS n FROM users");
  const avatars = count(`SELECT count(*) AS n FROM assets WHERE type = '${KEEP_ASSET_TYPE}'`);
  console.log(`[reset] done — ${removed} row(s) removed, kept ${kept} account(s) and ${avatars} avatar(s)`);
}

function recordDone(db: DatabaseSync, token: string, removed: number): void {
  // Token first, then when and how much — the token is the identity, the rest is
  // for whoever wonders later what this did.
  db.prepare('INSERT OR REPLACE INTO _migrations(key, value) VALUES(?, ?)').run(
    MARKER,
    `${token}|${new Date().toISOString()}|${removed}`,
  );
}
