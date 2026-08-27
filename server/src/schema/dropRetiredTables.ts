/**
 * Drop the tables that came in with a pre-fork database and belong to nothing.
 *
 * A database adopted from the older layout (`migrateFromSplitDbs`, and `dataBootstrap`'s adoption
 * of one from a former default path) carries fifteen tables this codebase never creates, never
 * reads and never writes: the eight `voxel_*` tables and `portals` from a voxel world that is
 * gone, `dm_keys` and `dm_messages` from a Matrix-side store, `monitor_locks`, `arcade_wads`,
 * `zone_customers`, and `zone_meta` (whose only callers were two private methods nobody called,
 * removed 2026-08-27). A fresh deployment has none of them, so they are not a schema to maintain;
 * they are somebody's data sitting in a volume, and two of them hold personal data that no account
 * deletion has ever reached, because nothing knows they are there.
 *
 * **Two independent sources of evidence, and a table needs both to be dropped:**
 *
 *  1. Its name is on {@link RETIRED_TABLES} — a decision somebody wrote down after checking that
 *     no file of any type in the repo references it.
 *  2. Its name is NOT on {@link LIVE_TABLES}, the tables this server creates. `schemaTables.int.test.ts`
 *     builds that list from the source's own `CREATE TABLE` statements and fails if either list
 *     drifts, so a table that gains a creator stops being droppable in the same change that
 *     creates it.
 *
 * A table on neither list is **reported and left alone**. That is the important asymmetry: the
 * unknown case must never resolve to "delete", or this file becomes a way for a future table to
 * disappear because nobody added it here.
 *
 * **No snapshot is written.** Every other destructive step in this codebase takes a `VACUUM INTO`
 * copy first; this one was deliberately asked for without one, so a `DROP TABLE` here is final. If
 * you are reading this because a deployment lost something it wanted, the missing backup is the
 * line to add, not the evidence rules above.
 *
 * There is no `_migrations` marker, for the same reason `ensureUserForeignKeys` has none: the
 * question is answered by the schema itself. Once a table is gone it is not found again, so the
 * steady state costs one `sqlite_master` query per boot.
 */
import type { DatabaseSync } from 'node:sqlite';

/**
 * Every table this server creates. Kept as data because two things need it: the drop below, and
 * the test that compares it against the `CREATE TABLE` statements in `server/src`.
 */
export const LIVE_TABLES: readonly string[] = [
  '_migrations',
  'arcade_cabinet_games',
  'arcade_saves',
  'assets',
  'layouts',
  'meeting_rooms',
  'meta',
  'player_pos',
  'sessions',
  'settings',
  'user_prefs',
  'users',
  'zone_acl',
  'zone_admins',
  'zones',
];

/** Tables from a retired feature, each verified to have no reference anywhere in the repo. */
export const RETIRED_TABLES: readonly string[] = [
  // A voxel world, and the portal table that belonged to it (its columns are world/x/y/z — the
  // portal FURNITURE in this game is unrelated and keeps its name in the layout, not a table).
  'voxel_boats',
  'voxel_chests',
  'voxel_durability',
  'voxel_inventory',
  'voxel_monitors',
  'voxel_positions',
  'voxel_settings',
  'voxel_signs',
  'portals',
  // Matrix device keys and message ciphertext. The personal data in this list.
  'dm_keys',
  'dm_messages',
  // Per-monitor passwords, an uploaded-WAD store, a third zone membership list, and a zone
  // key/value table — all four with no reader and no writer left.
  'monitor_locks',
  'arcade_wads',
  'zone_customers',
  'zone_meta',
];

/** Tables present in this database, excluding SQLite's own bookkeeping. */
function tablesIn(db: DatabaseSync): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{
      name: string;
    }>
  ).map((r) => r.name);
}

export function dropRetiredTables(db: DatabaseSync): void {
  const present = tablesIn(db);
  const live = new Set(LIVE_TABLES);
  const retired = new Set(RETIRED_TABLES);

  const doomed = present.filter((t) => retired.has(t) && !live.has(t));
  // Anything this file has never heard of. Named, never touched — see the header.
  const unknown = present.filter((t) => !retired.has(t) && !live.has(t));
  if (unknown.length > 0) {
    console.warn(
      `[schema] ${unknown.length} table(s) belong to neither the live schema nor the retired list and were left alone: ` +
        `${unknown.join(', ')}. If they are dead, add them to RETIRED_TABLES with the evidence; if they are alive, to LIVE_TABLES.`,
    );
  }
  if (doomed.length === 0) return;

  // Row counts before the drop, so the boot line says what was actually thrown away rather than
  // just how many tables vanished — "dropped 15 tables" does not distinguish empty from full.
  const rows = new Map<string, number>();
  for (const t of doomed) {
    try {
      rows.set(t, Number((db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get() as { n: number }).n));
    } catch {
      rows.set(t, -1); // unreadable: still dropped, but say so
    }
  }

  try {
    db.exec('BEGIN');
    for (const t of doomed) db.exec(`DROP TABLE IF EXISTS "${t}"`);
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* nothing open */
    }
    // Housekeeping never keeps the world down; the next boot tries again.
    console.error(`[schema] retired tables NOT dropped: ${(err as Error)?.message}`);
    return;
  }

  const withRows = doomed.filter((t) => (rows.get(t) ?? 0) !== 0);
  console.log(
    `[schema] dropped ${doomed.length} retired table(s) from a pre-fork database` +
      (withRows.length > 0
        ? `; these held rows: ${withRows.map((t) => `${t}=${rows.get(t)}`).join(', ')}`
        : '; all of them were empty'),
  );
}
