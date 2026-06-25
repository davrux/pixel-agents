/**
 * SQLite-backed persistence for office layouts (Node's built-in `node:sqlite`,
 * no native dependency).
 *
 * - User layouts live in the `layouts` table; the active layout name lives in
 *   `meta`.
 * - "Default" is a virtual, READ-ONLY entry: always the bundled layout. It can
 *   always be loaded but never overwritten or deleted — to keep changes the
 *   user saves a copy ("New from current"). This is intentional and permanent.
 */
import { DatabaseSync } from 'node:sqlite';

import { dataPath } from './paths.js';

export const DEFAULT_LAYOUT_NAME = 'Default';

const DB_FILE = 'layouts.db';
const META_ACTIVE = 'activeLayout';
const NAME_RE = /^[\x20-\x7e]{1,40}$/;

export interface LayoutListEntry {
  name: string;
  updatedAt: number;
  readOnly: boolean;
}

type Layout = Record<string, unknown>;

export class LayoutStore {
  private readonly db: DatabaseSync;
  private readonly bundledDefault: Layout | null;

  constructor(bundledDefault: Layout | null) {
    this.bundledDefault = bundledDefault;
    this.db = new DatabaseSync(dataPath(DB_FILE));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS layouts (
        name TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta ( key TEXT PRIMARY KEY, value TEXT NOT NULL );
    `);
  }

  static isValidUserName(name: string): boolean {
    return NAME_RE.test(name) && name !== DEFAULT_LAYOUT_NAME;
  }

  list(): LayoutListEntry[] {
    const rows = this.db
      .prepare('SELECT name, updated_at FROM layouts ORDER BY name COLLATE NOCASE')
      .all() as Array<{ name: string; updated_at: number }>;
    const users = rows.map((r) => ({ name: r.name, updatedAt: r.updated_at, readOnly: false }));
    return [{ name: DEFAULT_LAYOUT_NAME, updatedAt: 0, readOnly: true }, ...users];
  }

  getActiveName(): string {
    const row = this.meta(META_ACTIVE);
    if (!row || row === DEFAULT_LAYOUT_NAME) return DEFAULT_LAYOUT_NAME;
    return this.has(row) ? row : DEFAULT_LAYOUT_NAME;
  }

  has(name: string): boolean {
    return this.db.prepare('SELECT 1 FROM layouts WHERE name = ?').get(name) !== undefined;
  }

  /** Resolve a layout by name. Default is always the bundled (read-only) layout. */
  resolve(name: string): Layout | null {
    if (name === DEFAULT_LAYOUT_NAME) return this.bundledDefault;
    const row = this.db.prepare('SELECT data FROM layouts WHERE name = ?').get(name) as
      | { data: string }
      | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.data) as Layout;
    } catch {
      return null;
    }
  }

  getActiveLayout(): Layout | null {
    return this.resolve(this.getActiveName());
  }

  /** Autosave to the active layout. No-op on the read-only Default. */
  saveActive(data: Layout, now: number): boolean {
    const active = this.getActiveName();
    if (active === DEFAULT_LAYOUT_NAME) return false;
    this.upsert(active, data, now);
    return true;
  }

  saveAs(name: string, data: Layout, now: number): void {
    if (!LayoutStore.isValidUserName(name)) throw new Error('invalid layout name');
    this.upsert(name, data, now);
    this.setMeta(META_ACTIVE, name);
  }

  setActive(name: string): boolean {
    if (name === DEFAULT_LAYOUT_NAME) {
      this.setMeta(META_ACTIVE, DEFAULT_LAYOUT_NAME);
      return true;
    }
    if (!this.has(name)) return false;
    this.setMeta(META_ACTIVE, name);
    return true;
  }

  delete(name: string): boolean {
    if (name === DEFAULT_LAYOUT_NAME || !this.has(name)) return false;
    const wasActive = this.getActiveName() === name;
    this.db.prepare('DELETE FROM layouts WHERE name = ?').run(name);
    if (wasActive) this.setMeta(META_ACTIVE, DEFAULT_LAYOUT_NAME);
    return true;
  }

  close(): void {
    this.db.close();
  }

  // ── internals ───────────────────────────────────────────────────
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
