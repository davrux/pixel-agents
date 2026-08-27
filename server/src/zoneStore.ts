/**
 * SQLite-backed persistence for the zone registry (Node's built-in `node:sqlite`).
 *
 * A zone row is everything about a zone that is NOT its map: label, arrival tile,
 * owner, privacy/ACL, password, NPC set. The map itself lives one-per-zone in
 * zoneMapStore.ts and arrives by being pushed from Tiled, which is also what
 * brings a new zone into existence (see tiled/zoneImport.ts) — there is no
 * builtin table of zones any more, and nothing creates one from in-game.
 *
 * The default zone (protocol DEFAULT_ZONE) is ensured on first run and can never
 * be deleted: it is where a client that names no zone lands. `cols`/`rows` are the
 * size a zone renders at until its first map arrives.
 */
import type { DatabaseSync } from 'node:sqlite';

import { MAX_COLS, MAX_ROWS } from '@pixel/shared/office/constants.js';
import { DEFAULT_ZONE, cleanName, MAX_NAME_LEN, type ZoneConfig } from '@pixel/shared';

import { db } from './db.js';
import { userChildDdl } from './schema/tables.js';
import { hashPassword, verifyHash } from './pwhash.js';

const MIN_SIZE = 6;
const LABEL_RE = new RegExp(`^[\\x20-\\x7e]{1,${MAX_NAME_LEN}}$`);

interface ZoneRow {
  id: string;
  label: string;
  arrive_col: number | null;
  arrive_row: number | null;
  cols: number | null;
  rows: number | null;
  created_at: number;
  npc: string | null;
  pw_hash: string | null;
  owner_id: string | null;
  is_private: number;
}

/** How many zones one owner may have outstanding at once — same DoS-prevention
 *  reasoning as MAX_ACTIVE_ROOMS_PER_OWNER for meeting rooms. */
export const MAX_ZONES_PER_OWNER = 20;

export class ZoneStore {
  private readonly db: DatabaseSync;

  constructor() {
    this.db = db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS zones (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        arrive_col INTEGER, arrive_row INTEGER,
        cols INTEGER, rows INTEGER,
        created_at INTEGER NOT NULL DEFAULT 0,
        npc TEXT
      );
      -- Per-arcade-cabinet game allow-list override, keyed by anchor tile "col,row".
      -- A cabinet with no row here just follows the global default (see
      -- arcadeDefaults.ts) — only cabinets an admin has explicitly curated get one.
      CREATE TABLE IF NOT EXISTS arcade_cabinet_games (
        zone_id TEXT NOT NULL, cabinet_key TEXT NOT NULL, game_ids TEXT NOT NULL,
        PRIMARY KEY (zone_id, cabinet_key)
      );
    `);
    // The two account-keyed tables come from the shared DDL (they cascade on user delete);
    // the private-zone allow-list note lives with them there.
    this.db.exec(userChildDdl('zone_admins'));
    this.db.exec(userChildDdl('zone_acl'));
    this.migrateColumns();
    this.seed();
  }

  // ── Zone passwords ───────────────────────────────────────────────
  // A locked zone requires the password to enter (hash stored like an account
  // password). Admins and the zone's admins bypass it.
  zoneHasPassword(id: string): boolean {
    const r = this.db.prepare('SELECT pw_hash FROM zones WHERE id = ?').get(id) as { pw_hash: string | null } | undefined;
    return !!r?.pw_hash;
  }
  /** Set or clear a zone's password. Empty/null clears the lock. */
  setZonePassword(id: string, password: string | null): boolean {
    if (!this.has(id)) return false;
    this.db.prepare('UPDATE zones SET pw_hash = ? WHERE id = ?').run(password ? hashPassword(password) : null, id);
    return true;
  }
  checkZonePassword(id: string, password: string): boolean {
    const r = this.db.prepare('SELECT pw_hash FROM zones WHERE id = ?').get(id) as { pw_hash: string | null } | undefined;
    if (!r) return false;
    if (!r.pw_hash) return true; // not locked
    return verifyHash(r.pw_hash, password);
  }

  // ── Arcade cabinet game overrides ─────────────────────────────────
  // Per-cabinet curation of the (global, content-driven) arcade catalog — see
  // arcadeDefaults.ts for how this combines with the global default list.
  // Admin-only (server/src/adminApi.ts uses the plain admin() guard, not
  // zoneCapabilityAuth — unlike monitors, zone owners don't get this).
  /** This cabinet's own game-id list, or null if it just follows the default. */
  cabinetGamesOverride(zoneId: string, cabinetKey: string): string[] | null {
    const r = this.db
      .prepare('SELECT game_ids FROM arcade_cabinet_games WHERE zone_id = ? AND cabinet_key = ?')
      .get(zoneId, cabinetKey) as { game_ids: string } | undefined;
    if (!r) return null;
    try {
      const ids = JSON.parse(r.game_ids);
      return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : null;
    } catch {
      return null;
    }
  }
  /** Set this cabinet's own game-id list, or clear it (null) to follow the default again. */
  setCabinetGames(zoneId: string, cabinetKey: string, gameIds: string[] | null): void {
    if (!zoneId || !cabinetKey) return;
    if (gameIds) {
      this.db
        .prepare(
          'INSERT INTO arcade_cabinet_games(zone_id, cabinet_key, game_ids) VALUES(?,?,?) ON CONFLICT(zone_id, cabinet_key) DO UPDATE SET game_ids=excluded.game_ids',
        )
        .run(zoneId, cabinetKey, JSON.stringify(gameIds));
    } else {
      this.db.prepare('DELETE FROM arcade_cabinet_games WHERE zone_id = ? AND cabinet_key = ?').run(zoneId, cabinetKey);
    }
  }
  /** Every cabinet key in this zone that has its own override (for the admin list view). */
  cabinetKeysWithOverride(zoneId: string): string[] {
    const rows = this.db
      .prepare('SELECT cabinet_key FROM arcade_cabinet_games WHERE zone_id = ?')
      .all(zoneId) as Array<{ cabinet_key: string }>;
    return rows.map((r) => r.cabinet_key);
  }

  // ── Per-zone admins ──────────────────────────────────────────────
  // A zone admin may layout/edit THAT zone (not the shared galleries). Global
  // admins can edit every zone regardless. (See SimRoom.canEditZone.)
  isZoneAdmin(zoneId: string, userId: string): boolean {
    if (!zoneId || !userId) return false;
    return (
      this.db.prepare('SELECT 1 FROM zone_admins WHERE zone_id = ? AND user_id = ?').get(zoneId, userId) !==
      undefined
    );
  }
  setZoneAdmin(zoneId: string, userId: string, on: boolean): void {
    if (!zoneId || !userId) return;
    if (on) {
      this.db
        .prepare('INSERT OR IGNORE INTO zone_admins(zone_id, user_id) VALUES(?, ?)')
        .run(zoneId, userId);
    } else {
      this.db.prepare('DELETE FROM zone_admins WHERE zone_id = ? AND user_id = ?').run(zoneId, userId);
    }
  }
  /** Drop all per-user grants (zone-admin, ACL membership) and ownerships — e.g.
   *  when the account is deleted. Zones the user OWNED are never deleted here:
   *  they become ownerless (owner_id NULL) but keep their layout, privacy and
   *  ACL as-is — only an admin can manage them further after that. */
  /**
   * A deleted account's zones become ownerless rather than disappearing.
   *
   * All this used to do besides was delete the user's rows from zone_admins and zone_acl; both
   * tables now declare ON DELETE CASCADE, so the row is gone before this runs. What is left is
   * the part a cascade must NOT do: deleting an owner may not delete their zones — everyone
   * else's world would go with them — which is SET NULL semantics, spelled out here because
   * `zones` is not rebuilt for one nullable column (see schema/tables.ts).
   */
  disownZonesOf(userId: string): void {
    this.db.prepare('UPDATE zones SET owner_id = NULL WHERE owner_id = ?').run(userId);
  }
  listZoneAdmins(zoneId: string): string[] {
    const rows = this.db
      .prepare('SELECT user_id FROM zone_admins WHERE zone_id = ? ORDER BY user_id')
      .all(zoneId) as Array<{ user_id: string }>;
    return rows.map((r) => r.user_id);
  }

  // ── Ownership + privacy ──────────────────────────────────────────
  // A private zone rejects entry for anyone but the owner, its zone-admins
  // (co-editors — trusted the same as the owner), global admins, and anyone on
  // its ACL. Unlike a zone password (a shared secret), this is identity-based:
  // no secret to leak, and the owner can revoke a single person without
  // resetting access for everyone else.
  zoneOwner(zoneId: string): string | null {
    const r = this.db.prepare('SELECT owner_id FROM zones WHERE id = ?').get(zoneId) as
      | { owner_id: string | null }
      | undefined;
    return r?.owner_id ?? null;
  }
  /** Admin-only override (see adminApi.ts): take/transfer/revoke ownership —
   *  the migration path for zones that predate this feature or lost their
   *  owner when that account was deleted. `null` clears it (ownerless again). */
  setOwner(zoneId: string, ownerId: string | null): boolean {
    if (!this.has(zoneId)) return false;
    this.db.prepare('UPDATE zones SET owner_id = ? WHERE id = ?').run(ownerId, zoneId);
    return true;
  }
  isPrivate(zoneId: string): boolean {
    const r = this.db.prepare('SELECT is_private FROM zones WHERE id = ?').get(zoneId) as
      | { is_private: number }
      | undefined;
    return !!r?.is_private;
  }
  /** Only the owner may flip this (see permissions.ts zone.managePrivacy) — a
   *  zone-admin co-editor can layout the room but not lock people out of it. */
  setPrivate(zoneId: string, on: boolean): boolean {
    if (!this.has(zoneId)) return false;
    this.db.prepare('UPDATE zones SET is_private = ? WHERE id = ?').run(on ? 1 : 0, zoneId);
    return true;
  }
  isAclMember(zoneId: string, userId: string): boolean {
    if (!zoneId || !userId) return false;
    return this.db.prepare('SELECT 1 FROM zone_acl WHERE zone_id = ? AND user_id = ?').get(zoneId, userId) !== undefined;
  }
  aclAdd(zoneId: string, userId: string): void {
    if (!zoneId || !userId) return;
    this.db.prepare('INSERT OR IGNORE INTO zone_acl(zone_id, user_id) VALUES(?, ?)').run(zoneId, userId);
  }
  aclRemove(zoneId: string, userId: string): void {
    this.db.prepare('DELETE FROM zone_acl WHERE zone_id = ? AND user_id = ?').run(zoneId, userId);
  }
  listAcl(zoneId: string): string[] {
    const rows = this.db
      .prepare('SELECT user_id FROM zone_acl WHERE zone_id = ? ORDER BY user_id')
      .all(zoneId) as Array<{ user_id: string }>;
    return rows.map((r) => r.user_id);
  }
  /** Full entry check for a private zone: owner, zone-admin, ACL member, or a
   *  global admin (checked by the caller, not here — see SimRoom gateEntry). */
  canEnterPrivateZone(zoneId: string, userId: string): boolean {
    if (!this.isPrivate(zoneId)) return true;
    if (!userId) return false;
    if (this.zoneOwner(zoneId) === userId) return true;
    if (this.isZoneAdmin(zoneId, userId)) return true;
    return this.isAclMember(zoneId, userId);
  }

  /** Add columns introduced after the table first shipped. The `npc` per-zone
   *  spawn set is new: existing non-office zones predate it, so default them to
   *  "no NPCs" (the office keeps null = all). Runs once (only when the column is
   *  actually missing). */
  private migrateColumns(): void {
    const cols = this.db.prepare('PRAGMA table_info(zones)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'npc')) {
      this.db.exec('ALTER TABLE zones ADD COLUMN npc TEXT');
      this.db.prepare('UPDATE zones SET npc = ? WHERE id != ?').run('[]', DEFAULT_ZONE);
    }
    if (!cols.some((c) => c.name === 'pw_hash')) {
      this.db.exec('ALTER TABLE zones ADD COLUMN pw_hash TEXT');
    }
    // Ownership + privacy: existing zones predate this feature and get no owner
    // (owner_id NULL — nobody's, stays public; only an admin can claim/manage
    // one via the admin site if that's ever wanted).
    if (!cols.some((c) => c.name === 'owner_id')) {
      this.db.exec('ALTER TABLE zones ADD COLUMN owner_id TEXT');
    }
    if (!cols.some((c) => c.name === 'is_private')) {
      this.db.exec('ALTER TABLE zones ADD COLUMN is_private INTEGER NOT NULL DEFAULT 0');
    }
  }

  static slugify(label: string): string {
    const s = label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return s.length ? s.slice(0, 32) : 'zone';
  }

  list(): ZoneConfig[] {
    const rows = this.db
      .prepare('SELECT * FROM zones ORDER BY (id = ?) DESC, created_at ASC, label COLLATE NOCASE')
      .all(DEFAULT_ZONE) as unknown as ZoneRow[];
    return rows.map((r) => this.toConfig(r));
  }

  get(id: string): ZoneConfig | null {
    const r = this.db.prepare('SELECT * FROM zones WHERE id = ?').get(id) as ZoneRow | undefined;
    return r ? this.toConfig(r) : null;
  }

  has(id: string): boolean {
    return this.db.prepare('SELECT 1 FROM zones WHERE id = ?').get(id) !== undefined;
  }

  /** Create a user zone from a label + initial size, owned by `ownerId` (absent
   *  for e.g. an anonymous open-dev caller — those zones stay ownerless/public).
   *  Returns the new id, or null if the input is invalid OR `ownerId` already
   *  owns MAX_ZONES_PER_OWNER zones (bounds unbounded creation, same reasoning
   *  as meeting rooms). The id is a unique slug derived from the label. */
  create(label: string, cols: number, rows: number, now: number, ownerId?: string): string | null {
    const clean = cleanName(label);
    if (!LABEL_RE.test(clean)) return null;
    if (ownerId && this.countByOwner(ownerId) >= MAX_ZONES_PER_OWNER) return null;
    const c = this.clampSize(cols);
    const r = this.clampSize(rows);
    const id = this.uniqueId(ZoneStore.slugify(clean));
    const arrive = { col: Math.floor(c / 2), row: Math.floor(r / 2) };
    // New zones start with no NPCs (empty set) — you enable variants per zone.
    this.db
      .prepare(
        `INSERT INTO zones(id,label,arrive_col,arrive_row,cols,rows,created_at,npc,owner_id)
         VALUES(?,?,?,?,?,?,?,'[]',?)`,
      )
      .run(id, clean, arrive.col, arrive.row, c, r, now, ownerId || null);
    return id;
  }

  /** How many zones `ownerId` currently owns — used to cap creation. */
  countByOwner(ownerId: string): number {
    const r = this.db.prepare('SELECT COUNT(*) AS c FROM zones WHERE owner_id = ?').get(ownerId) as { c: number };
    return r.c;
  }

  /** Set which NPC variants spawn in a zone. null = all active variants. */
  setNpc(id: string, variants: string[] | null): boolean {
    if (!this.has(id)) return false;
    const value = variants === null ? null : JSON.stringify(variants.filter((v) => typeof v === 'string'));
    this.db.prepare('UPDATE zones SET npc = ? WHERE id = ?').run(value, id);
    return true;
  }

  /** Edit a zone's label and/or arrival tile. Never changes read-only (hidden). */
  edit(id: string, patch: { label?: string; arrive?: { col: number; row: number } }): boolean {
    const r = this.db.prepare('SELECT * FROM zones WHERE id = ?').get(id) as ZoneRow | undefined;
    if (!r) return false;
    const label = patch.label !== undefined ? cleanName(patch.label) : r.label;
    if (!LABEL_RE.test(label)) return false;
    const arriveCol = patch.arrive ? Math.floor(patch.arrive.col) : r.arrive_col;
    const arriveRow = patch.arrive ? Math.floor(patch.arrive.row) : r.arrive_row;
    this.db
      .prepare('UPDATE zones SET label=?, arrive_col=?, arrive_row=? WHERE id=?')
      .run(label, arriveCol, arriveRow, id);
    return true;
  }

  /** Delete a zone. The default zone can never be deleted — it is where a client
   *  with no zone of its own lands, so there has to be one. Also
   *  clears the zone-keyed rows in zone_admins/zone_acl/arcade_cabinet_games —
   *  these aren't foreign-keyed to zones, so a plain `DELETE FROM zones` would
   *  otherwise leave them orphaned (harmless zombie rows a zone id could
   *  later collide with if reused, and clutter in the tables regardless). */
  delete(id: string): boolean {
    if (id === DEFAULT_ZONE || !this.has(id)) return false;
    this.db.prepare('DELETE FROM zone_admins WHERE zone_id = ?').run(id);
    this.db.prepare('DELETE FROM zone_acl WHERE zone_id = ?').run(id);
    this.db.prepare('DELETE FROM arcade_cabinet_games WHERE zone_id = ?').run(id);
    this.db.prepare('DELETE FROM zones WHERE id = ?').run(id);
    return true;
  }

  close(): void {
    // The DB connection is process-shared (see db.ts) — nothing to close here.
  }

  // ── internals ───────────────────────────────────────────────────
  private toConfig(r: ZoneRow): ZoneConfig {
    let npc: string[] | null = null; // null = all active variants
    if (r.npc != null) {
      try {
        const p = JSON.parse(r.npc);
        if (Array.isArray(p)) npc = p.filter((x): x is string => typeof x === 'string');
      } catch {
        /* corrupt → treat as all */
      }
    }
    return {
      id: r.id,
      label: r.label,
      arrive: r.arrive_col != null && r.arrive_row != null ? { col: r.arrive_col, row: r.arrive_row } : undefined,
      cols: r.cols ?? undefined,
      rows: r.rows ?? undefined,
      npc,
      locked: !!r.pw_hash,
      ownerId: r.owner_id ?? undefined,
      private: !!r.is_private,
    };
  }

  private clampSize(n: number): number {
    const v = Math.floor(Number(n));
    if (!Number.isFinite(v)) return MIN_SIZE;
    return Math.max(MIN_SIZE, Math.min(Math.max(MAX_COLS, MAX_ROWS), v));
  }

  private uniqueId(base: string): string {
    let id = base;
    for (let i = 2; this.has(id); i++) id = `${base}-${i}`;
    return id;
  }

  /**
   * Make sure the default zone exists — nothing else is seeded.
   *
   * There used to be a builtin table (protocol `ZONES`) whose entries were
   * upserted here on first run, one of which shipped a bundled layout and one a
   * code-generated one. Content comes from Tiled now, so the only thing that must
   * exist unconditionally is the id a client lands in when it names no zone; it
   * starts out with no map and renders as an empty field until one is pushed.
   */
  private seed(): void {
    if (this.has(DEFAULT_ZONE)) return;
    // Label = the id: a placeholder, renameable in-game (editZone). Hardcoding a
    // display name here would put content back into code, and the id is the only
    // thing this function actually knows.
    this.db
      .prepare("INSERT INTO zones(id,label,created_at,npc) VALUES(?,?,?,'[]')")
      .run(DEFAULT_ZONE, DEFAULT_ZONE, Date.now());
  }

}
