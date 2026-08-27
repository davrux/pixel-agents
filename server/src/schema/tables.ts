/**
 * The DDL for every table that carries a foreign key to `users`, in one place.
 *
 * Two readers need the exact same statement and would otherwise drift apart: the store that
 * creates the table on a fresh database, and {@link ensureUserForeignKeys} which rebuilds it on
 * an existing one. A constraint that exists in only one of the two is worse than none, because
 * then whether a deployment cascades depends on how old its database is.
 *
 * **Why foreign keys at all.** Deleting an account used to be a hand-maintained list of DELETEs
 * at each call site, and the two call sites had already drifted: `/delete` (the slash command)
 * left the user's meeting rooms behind where `DELETE /admin/users/:id` removed them. Measured on
 * this repo's own dev world 2026-08-27, 22 rows belonged to accounts that no longer existed —
 * arcade saves, voxel rows, a zone_customers entry, a meeting room. `ON DELETE CASCADE` moves
 * that rule from "every caller remembers" to "the schema enforces", which is the only version
 * that stays true when the next call site is written.
 *
 * `node:sqlite`'s DatabaseSync enforces foreign keys by default (`PRAGMA foreign_keys` reads 1 on
 * a fresh connection), so nothing has to be switched on — but no table declared a REFERENCES
 * clause, so the enforcement had nothing to enforce.
 *
 * **What is deliberately NOT foreign-keyed:**
 *  • `assets`. A user's private avatar is one row of a shared table, keyed (type='playerAvatar',
 *    name=userId); a foreign key cannot be conditional on another column's value. It keeps its
 *    explicit delete plus the orphan-avatar task in `maintenance/startupCleanup.ts`, which is why
 *    that task exists at all.
 *  • Everything keyed by ZONE. `zoneStore.delete()` already deletes its zone-keyed rows by hand
 *    and says why. A zones foreign key would also reach `player_pos`, and that table is written
 *    from the room's tick (`checkpointSpots`, every 5 s per moving player): deleting a zone with
 *    somebody standing in it would turn the next checkpoint into a foreign-key error inside the
 *    tick loop. An admin action must not be able to crash a room, so the zone side stays explicit.
 *  • `zones.owner_id`. Deleting the owner must not delete the zone — it becomes ownerless. That is
 *    ON DELETE SET NULL semantics, and it is already implemented and tested as an explicit UPDATE.
 *  • The twelve tables no code references (`voxel_*`, `dm_*`, `portals`, `monitor_locks`,
 *    `arcade_wads`, `zone_customers`). They exist only in databases adopted from the pre-fork
 *    layout; nothing creates them, so a fresh deployment has none of them. Marrying dead tables
 *    would only make them look alive.
 */

/** The parent. Created by `db.ts` before anything else so a child's INSERT can never hit
 *  "no such table: main.users" — SQLite resolves a foreign key at DML time, not at CREATE time,
 *  and a test that imports one store in isolation would otherwise fail on the parent's absence.
 *  The column migrations that grew this table (role, disabled) stay in `userStore`. */
export const USERS_DDL = `
  CREATE TABLE IF NOT EXISTS users (
    user_id TEXT PRIMARY KEY,
    username TEXT,
    pw_hash TEXT,
    pw_algo TEXT,
    is_admin INTEGER NOT NULL DEFAULT 0,
    agent_token TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS users_agent_token ON users(agent_token);
`;

const CASCADE = 'REFERENCES users(user_id) ON DELETE CASCADE';

/** One child table: how to create it, and which column points at the account. */
export interface ChildTable {
  table: string;
  /** The account column. Its orphans are deleted before the constraint can exist. */
  column: string;
  ddl: string;
  /** Recreated after a rebuild — dropping the table drops its indexes with it. */
  indexes?: string;
  /**
   * A column whose declared TYPE is load-bearing, checked as well as the constraint.
   *
   * SQLite's affinity converts silently: an integer written to a TEXT column comes back as a
   * string. Only stated where that conversion would change behaviour rather than just the
   * storage class — otherwise this would become a second, worse copy of the DDL.
   */
  requireType?: { column: string; type: string };
  /** Why this table holds personal data, for the boot report and for review. */
  holds: string;
}

/**
 * Every table whose rows belong to one account.
 *
 * This list is the contract: `ensureUserForeignKeys` rebuilds what is on it, and
 * `userDataCascade.int.test.ts` asserts that each entry really declares CASCADE *and* that no
 * OTHER table has an unconstrained user column — so a table added later is caught by a failing
 * test rather than by somebody noticing stale rows years on.
 */
export const USER_CHILD_TABLES: readonly ChildTable[] = [
  {
    table: 'sessions',
    column: 'user_id',
    holds: 'login sessions (the cookie sid and the desktop bearer token)',
    ddl: `
      CREATE TABLE IF NOT EXISTS sessions (
        sid TEXT PRIMARY KEY,
        user_id TEXT NOT NULL ${CASCADE},
        expires INTEGER NOT NULL
      )`,
  },
  {
    table: 'arcade_saves',
    column: 'user_id',
    holds: 'arcade game saves',
    ddl: `
      CREATE TABLE IF NOT EXISTS arcade_saves (
        user_id TEXT ${CASCADE},
        game TEXT,
        data BLOB NOT NULL,
        updated INTEGER NOT NULL,
        PRIMARY KEY (user_id, game)
      )`,
  },
  {
    table: 'zone_admins',
    column: 'user_id',
    holds: 'per-zone admin grants',
    ddl: `
      CREATE TABLE IF NOT EXISTS zone_admins (
        zone_id TEXT NOT NULL,
        user_id TEXT NOT NULL ${CASCADE},
        PRIMARY KEY (zone_id, user_id)
      )`,
  },
  {
    table: 'zone_acl',
    column: 'user_id',
    holds: 'private-zone allow-list membership',
    ddl: `
      CREATE TABLE IF NOT EXISTS zone_acl (
        zone_id TEXT NOT NULL,
        user_id TEXT NOT NULL ${CASCADE},
        PRIMARY KEY (zone_id, user_id)
      )`,
  },
  {
    table: 'meeting_rooms',
    column: 'owner_id',
    holds: 'meeting rooms the user owns',
    ddl: `
      CREATE TABLE IF NOT EXISTS meeting_rooms (
        slug TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL ${CASCADE},
        label TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        pw_hash TEXT
      )`,
    indexes: `
      CREATE INDEX IF NOT EXISTS meeting_rooms_owner ON meeting_rooms(owner_id);
      CREATE INDEX IF NOT EXISTS meeting_rooms_expires ON meeting_rooms(expires_at);
    `,
  },
  {
    table: 'player_pos',
    column: 'user_id',
    holds: 'where the user last stood in each zone',
    ddl: `
      CREATE TABLE IF NOT EXISTS player_pos (
        user_id TEXT NOT NULL ${CASCADE},
        zone TEXT NOT NULL,
        col INTEGER NOT NULL,
        row INTEGER NOT NULL,
        -- Direction is 0..3 (shared/office/types.ts), so INTEGER. A TEXT column would have
        -- SQLite's TEXT affinity turn Direction.LEFT into the string '1', which the reader's
        -- isDirection() then rejects — every resumed player would face DOWN.
        dir INTEGER NOT NULL,
        point_id TEXT,
        sit INTEGER NOT NULL DEFAULT 0,
        afk INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, zone)
      )`,
    // `dir` must really be INTEGER, and this is checked rather than assumed because the mistake is
    // silent: the column was first written as TEXT, and SQLite's TEXT affinity turns
    // Direction.LEFT (1) into the string '1', which the reader's isDirection() rejects — so every
    // resumed player faced DOWN, with the right value in the database. Caught by
    // playerResume.int.test.ts, not by reading the code.
    requireType: { column: 'dir', type: 'INTEGER' },
  },
  {
    table: 'user_prefs',
    column: 'user_id',
    holds: 'pinned skins and viewer settings',
    ddl: `
      CREATE TABLE IF NOT EXISTS user_prefs (
        user_id TEXT NOT NULL ${CASCADE},
        kind TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (user_id, kind)
      )`,
  },
] as const;

/** The kinds stored in `user_prefs`. One row per (user, kind) — see `appStore`. */
export const PREF_KINDS = {
  /** Pinned skin for the user's AGENTS (their agent labels are their user id). */
  charSkin: 'char_skin',
  /** Pinned skin for the user's own player avatar. */
  playerSkin: 'player_skin',
  /** Viewer settings, as a JSON object — the one kind whose value is not a scalar. */
  viewer: 'viewer',
} as const;

/** Lookup by table name, bounded by the constant list above. */
const byName = new Map(USER_CHILD_TABLES.map((t) => [t.table, t]));

/**
 * The CREATE (plus indexes) for one account-owned table, for the store that owns it.
 *
 * A store execs this instead of spelling the table out itself, so the constraint cannot exist on a
 * fresh database and be missing from the rebuild — or the other way round. An unknown name throws
 * at startup, which is the right moment to find a typo.
 */
export function userChildDdl(table: string): string {
  const spec = byName.get(table);
  if (!spec) throw new Error(`no DDL for account-owned table "${table}" (see USER_CHILD_TABLES)`);
  return `${spec.ddl};${spec.indexes ?? ''}`;
}
