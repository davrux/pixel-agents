/**
 * SQLite-backed persistence for the zone registry (Node's built-in `node:sqlite`).
 *
 * The builtin zones (protocol `ZONES`) seed the registry on first run; after that
 * zones are user-managed — created, edited and deleted at runtime. The office is
 * read-only (can never be deleted) and is kept resilient (re-seeded if missing).
 * Each zone carries its initial blank-field size (cols/rows) so its read-only
 * "Default" layout can be regenerated; the active layout may be resized later in
 * the editor (LayoutStore owns the layouts themselves).
 */
import type { DatabaseSync } from 'node:sqlite';

import { MAX_COLS, MAX_ROWS } from '@pixel/shared/office/constants.js';
import { ZONES, DEFAULT_ZONE, cleanName, MAX_NAME_LEN, type ZoneConfig } from '@pixel/shared';

import { db } from './db.js';
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
  read_only: number;
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
        read_only INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT 0,
        npc TEXT
      );
      CREATE TABLE IF NOT EXISTS zone_meta ( key TEXT PRIMARY KEY, value TEXT NOT NULL );
      CREATE TABLE IF NOT EXISTS zone_admins (
        zone_id TEXT NOT NULL, user_id TEXT NOT NULL, PRIMARY KEY (zone_id, user_id)
      );
      -- Password-locked conference monitors, keyed by their anchor tile "col,row".
      CREATE TABLE IF NOT EXISTS monitor_locks (
        zone_id TEXT NOT NULL, monitor_key TEXT NOT NULL, pw_hash TEXT NOT NULL,
        PRIMARY KEY (zone_id, monitor_key)
      );
      -- Private-zone allow-list: who besides the owner/admins may enter.
      CREATE TABLE IF NOT EXISTS zone_acl (
        zone_id TEXT NOT NULL, user_id TEXT NOT NULL, PRIMARY KEY (zone_id, user_id)
      );
    `);
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

  // ── Monitor passwords ────────────────────────────────────────────
  // Conference monitors can be locked independently of the zone, keyed by their
  // anchor tile ("col,row"). Joining the call requires the monitor password.
  monitorHasPassword(zoneId: string, monitorKey: string): boolean {
    return this.db.prepare('SELECT 1 FROM monitor_locks WHERE zone_id = ? AND monitor_key = ?').get(zoneId, monitorKey) !== undefined;
  }
  setMonitorPassword(zoneId: string, monitorKey: string, password: string | null): void {
    if (!zoneId || !monitorKey) return;
    if (password) {
      this.db
        .prepare(
          'INSERT INTO monitor_locks(zone_id, monitor_key, pw_hash) VALUES(?,?,?) ON CONFLICT(zone_id, monitor_key) DO UPDATE SET pw_hash=excluded.pw_hash',
        )
        .run(zoneId, monitorKey, hashPassword(password));
    } else {
      this.db.prepare('DELETE FROM monitor_locks WHERE zone_id = ? AND monitor_key = ?').run(zoneId, monitorKey);
    }
  }
  checkMonitorPassword(zoneId: string, monitorKey: string, password: string): boolean {
    const r = this.db
      .prepare('SELECT pw_hash FROM monitor_locks WHERE zone_id = ? AND monitor_key = ?')
      .get(zoneId, monitorKey) as { pw_hash: string } | undefined;
    if (!r) return true; // not locked
    return verifyHash(r.pw_hash, password);
  }
  /** Monitor keys ("col,row") that are locked in a zone. */
  lockedMonitors(zoneId: string): string[] {
    const rows = this.db
      .prepare('SELECT monitor_key FROM monitor_locks WHERE zone_id = ?')
      .all(zoneId) as Array<{ monitor_key: string }>;
    return rows.map((r) => r.monitor_key);
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
  removeUserFromAllZones(userId: string): void {
    this.db.prepare('DELETE FROM zone_admins WHERE user_id = ?').run(userId);
    this.db.prepare('DELETE FROM zone_acl WHERE user_id = ?').run(userId);
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
        `INSERT INTO zones(id,label,arrive_col,arrive_row,cols,rows,read_only,created_at,npc,owner_id)
         VALUES(?,?,?,?,?,?,0,?,'[]',?)`,
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

  /** Delete a zone. Read-only zones (the office) can never be deleted. */
  delete(id: string): boolean {
    const r = this.db.prepare('SELECT read_only FROM zones WHERE id = ?').get(id) as
      | { read_only: number }
      | undefined;
    if (!r || r.read_only) return false;
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
      readOnly: !!r.read_only,
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

  /** Always ensure the office exists (resilient); seed the other builtins once. */
  private seed(): void {
    const office = ZONES[DEFAULT_ZONE];
    if (office && !this.has(office.id)) this.upsertBuiltin(office);

    if (this.meta('seeded')) return;
    for (const z of Object.values(ZONES)) {
      if (z.id !== DEFAULT_ZONE && !this.has(z.id)) this.upsertBuiltin(z);
    }
    this.setMeta('seeded', '1');
  }

  private upsertBuiltin(z: ZoneConfig): void {
    const npc = z.npc == null ? null : JSON.stringify(z.npc);
    this.db
      .prepare(
        `INSERT INTO zones(id,label,arrive_col,arrive_row,cols,rows,read_only,created_at,npc)
         VALUES(?,?,?,?,?,?,?,0,?)
         ON CONFLICT(id) DO UPDATE SET label=excluded.label, read_only=excluded.read_only`,
      )
      .run(z.id, z.label, z.arrive?.col ?? null, z.arrive?.row ?? null, z.cols ?? null, z.rows ?? null, z.readOnly ? 1 : 0, npc);
  }

  private meta(key: string): string | undefined {
    return (this.db.prepare('SELECT value FROM zone_meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined)?.value;
  }
  private setMeta(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO zone_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(key, value);
  }
}
