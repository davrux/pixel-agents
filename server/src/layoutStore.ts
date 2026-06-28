/**
 * SQLite-backed persistence for zone layouts (Node's built-in `node:sqlite`,
 * no native dependency).
 *
 * Per-zone: every zone (office, plaza, …) has its own
 *   - read-only virtual "Default" entry — the zone's builtin layout (the bundled
 *     office layout, or a generated one registered via `registerZoneDefault`).
 *     It can always be loaded but never overwritten or deleted; to keep changes
 *     the user saves a copy ("New from current").
 *   - set of named user layouts, stored in the `layouts` table under a composite
 *     key `"<zone>/<name>"` so zones never clobber each other.
 *   - active-layout pointer in `meta`, keyed `"active/<zone>"`.
 *
 * Editing one zone therefore can never touch another zone's layout.
 */
import { DatabaseSync } from 'node:sqlite';

import { dataPath } from './paths.js';

export const DEFAULT_LAYOUT_NAME = 'Default';
export const DEFAULT_ZONE_ID = 'office';

const DB_FILE = 'layouts.db';
/** Printable ASCII, but never '/' (reserved as the zone/name separator). */
const NAME_RE = /^[\x20-\x2e\x30-\x7e]{1,40}$/;

export interface LayoutListEntry {
  name: string;
  updatedAt: number;
  readOnly: boolean;
}

type Layout = Record<string, unknown>;

export class LayoutStore {
  private readonly db: DatabaseSync;
  /** Per-zone builtin (read-only Default) layouts. */
  private readonly defaults = new Map<string, Layout | null>();

  constructor(bundledDefault: Layout | null) {
    this.db = new DatabaseSync(dataPath(DB_FILE));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS layouts (
        name TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta ( key TEXT PRIMARY KEY, value TEXT NOT NULL );
    `);
    // The office's Default is the bundled layout.
    this.defaults.set(DEFAULT_ZONE_ID, bundledDefault);
    this.migrateLegacy();
  }

  /** Register a generated zone's builtin layout as its read-only Default. */
  registerZoneDefault(zone: string, layout: Layout | null): void {
    this.defaults.set(zone, layout);
  }

  static isValidUserName(name: string): boolean {
    return NAME_RE.test(name) && name !== DEFAULT_LAYOUT_NAME;
  }

  list(zone: string): LayoutListEntry[] {
    const prefix = `${zone}/`;
    const rows = this.db
      .prepare('SELECT name, updated_at FROM layouts WHERE name LIKE ? ORDER BY name COLLATE NOCASE')
      .all(`${prefix}%`) as Array<{ name: string; updated_at: number }>;
    const users = rows.map((r) => ({
      name: r.name.slice(prefix.length),
      updatedAt: r.updated_at,
      readOnly: false,
    }));
    return [{ name: DEFAULT_LAYOUT_NAME, updatedAt: 0, readOnly: true }, ...users];
  }

  getActiveName(zone: string): string {
    const row = this.meta(this.activeKey(zone));
    if (!row || row === DEFAULT_LAYOUT_NAME) return DEFAULT_LAYOUT_NAME;
    return this.has(zone, row) ? row : DEFAULT_LAYOUT_NAME;
  }

  has(zone: string, name: string): boolean {
    return this.db.prepare('SELECT 1 FROM layouts WHERE name = ?').get(this.rowKey(zone, name)) !== undefined;
  }

  /** Resolve a layout by name. Default is always the zone's read-only builtin. */
  resolve(zone: string, name: string): Layout | null {
    if (name === DEFAULT_LAYOUT_NAME) return this.defaults.get(zone) ?? null;
    const row = this.db.prepare('SELECT data FROM layouts WHERE name = ?').get(this.rowKey(zone, name)) as
      | { data: string }
      | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.data) as Layout;
    } catch {
      return null;
    }
  }

  getActiveLayout(zone: string): Layout | null {
    return this.resolve(zone, this.getActiveName(zone));
  }

  /** Autosave to the zone's active layout. No-op on the read-only Default. */
  saveActive(zone: string, data: Layout, now: number): boolean {
    const active = this.getActiveName(zone);
    if (active === DEFAULT_LAYOUT_NAME) return false;
    this.upsert(this.rowKey(zone, active), data, now);
    return true;
  }

  saveAs(zone: string, name: string, data: Layout, now: number): void {
    if (!LayoutStore.isValidUserName(name)) throw new Error('invalid layout name');
    this.upsert(this.rowKey(zone, name), data, now);
    this.setMeta(this.activeKey(zone), name);
  }

  setActive(zone: string, name: string): boolean {
    if (name === DEFAULT_LAYOUT_NAME) {
      this.setMeta(this.activeKey(zone), DEFAULT_LAYOUT_NAME);
      return true;
    }
    if (!this.has(zone, name)) return false;
    this.setMeta(this.activeKey(zone), name);
    return true;
  }

  delete(zone: string, name: string): boolean {
    if (name === DEFAULT_LAYOUT_NAME || !this.has(zone, name)) return false;
    const wasActive = this.getActiveName(zone) === name;
    this.db.prepare('DELETE FROM layouts WHERE name = ?').run(this.rowKey(zone, name));
    if (wasActive) this.setMeta(this.activeKey(zone), DEFAULT_LAYOUT_NAME);
    return true;
  }

  /** Remove all of a zone's layouts + its active pointer (when a zone is deleted). */
  deleteZoneLayouts(zone: string): void {
    this.db.prepare('DELETE FROM layouts WHERE name LIKE ?').run(`${zone}/%`);
    this.db.prepare('DELETE FROM meta WHERE key = ?').run(this.activeKey(zone));
  }

  close(): void {
    this.db.close();
  }

  // ── internals ───────────────────────────────────────────────────
  private rowKey(zone: string, name: string): string {
    return `${zone}/${name}`;
  }
  private activeKey(zone: string): string {
    return `active/${zone}`;
  }

  /** One-time, idempotent migration of pre-per-zone data: unprefixed user
   *  layouts and the old single `activeLayout` pointer belonged to the office. */
  private migrateLegacy(): void {
    const legacy = this.db
      .prepare("SELECT name FROM layouts WHERE name NOT LIKE '%/%'")
      .all() as Array<{ name: string }>;
    for (const { name } of legacy) {
      const target = this.rowKey(DEFAULT_ZONE_ID, name);
      if (this.db.prepare('SELECT 1 FROM layouts WHERE name = ?').get(target)) {
        this.db.prepare('DELETE FROM layouts WHERE name = ?').run(name); // dupe → drop
      } else {
        this.db.prepare('UPDATE layouts SET name = ? WHERE name = ?').run(target, name);
      }
    }
    const oldActive = this.meta('activeLayout');
    if (oldActive && !this.meta(this.activeKey(DEFAULT_ZONE_ID))) {
      this.setMeta(this.activeKey(DEFAULT_ZONE_ID), oldActive);
    }
  }

  private meta(key: string): string | undefined {
    return (this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined)?.value;
  }
  private setMeta(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(key, value);
  }
  private upsert(name: string, data: Layout, now: number): void {
    this.db
      .prepare(
        `INSERT INTO layouts(name,data,updated_at) VALUES(?,?,?)
         ON CONFLICT(name) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at`,
      )
      .run(name, JSON.stringify(data), now);
  }
}
