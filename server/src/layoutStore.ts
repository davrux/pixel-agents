/**
 * layoutStore.ts — SQLite-backed persistence for office layouts.
 *
 * Replaces the old single ~/.pixel-agents/layout.json file. Layouts are stored
 * in a SQLite database (Node's built-in `node:sqlite`, no native dependency) so
 * the user can manage several named layouts: load, save, delete and "new from
 * current".
 *
 * The bundled default layout is exposed as a virtual, read-only entry named
 * "Default": it is always present in the list, can always be loaded, but can
 * never be overwritten or deleted. User layouts live in the `layouts` table;
 * the currently-active layout name is kept in the `meta` table.
 */
import { DatabaseSync } from 'node:sqlite';

import { dataPath } from './paths.js';

/** Reserved name of the read-only bundled default layout. */
export const DEFAULT_LAYOUT_NAME = 'Default';

const DB_FILE = 'layouts.db';
const META_ACTIVE = 'activeLayout';

/** Maximum length / character set for a user-supplied layout name. */
const NAME_RE = /^[\x20-\x7e]{1,40}$/;

export interface LayoutListEntry {
  name: string;
  /** Unix epoch ms of last save (0 for the virtual default). */
  updatedAt: number;
  /** Read-only entries (the Default) cannot be saved-over or deleted. */
  readOnly: boolean;
}

export class LayoutStore {
  private readonly db: DatabaseSync;
  private readonly bundledDefault: Record<string, unknown> | null;

  constructor(bundledDefault: Record<string, unknown> | null) {
    this.bundledDefault = bundledDefault;
    this.db = new DatabaseSync(dataPath(DB_FILE));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS layouts (
        name       TEXT PRIMARY KEY,
        data       TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  /** True if `name` is a valid, non-reserved user layout name. */
  static isValidUserName(name: string): boolean {
    return NAME_RE.test(name) && name !== DEFAULT_LAYOUT_NAME;
  }

  /** All layouts, Default first, then user layouts alphabetically. */
  list(): LayoutListEntry[] {
    const rows = this.db
      .prepare('SELECT name, updated_at FROM layouts ORDER BY name COLLATE NOCASE')
      .all() as Array<{ name: string; updated_at: number }>;
    const users = rows.map((r) => ({
      name: r.name,
      updatedAt: r.updated_at,
      readOnly: false,
    }));
    return [{ name: DEFAULT_LAYOUT_NAME, updatedAt: 0, readOnly: true }, ...users];
  }

  /** Name of the active layout (defaults to Default when unset/dangling). */
  getActiveName(): string {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(META_ACTIVE) as
      | { value: string }
      | undefined;
    const name = row?.value;
    if (!name || name === DEFAULT_LAYOUT_NAME) return DEFAULT_LAYOUT_NAME;
    return this.has(name) ? name : DEFAULT_LAYOUT_NAME;
  }

  private setActiveName(name: string): void {
    this.db
      .prepare(
        'INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(META_ACTIVE, name);
  }

  /** Does a user layout with this name exist? */
  has(name: string): boolean {
    const row = this.db.prepare('SELECT 1 FROM layouts WHERE name = ?').get(name);
    return row !== undefined;
  }

  /** Resolve a layout's data by name. Default returns the bundled layout. */
  resolve(name: string): Record<string, unknown> | null {
    if (name === DEFAULT_LAYOUT_NAME) return this.bundledDefault;
    const row = this.db.prepare('SELECT data FROM layouts WHERE name = ?').get(name) as
      | { data: string }
      | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.data) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  /** Data of the currently-active layout. */
  getActiveLayout(): Record<string, unknown> | null {
    return this.resolve(this.getActiveName());
  }

  /** True when the active layout is writable (i.e. not the read-only Default). */
  isActiveWritable(): boolean {
    return this.getActiveName() !== DEFAULT_LAYOUT_NAME;
  }

  private upsert(name: string, data: Record<string, unknown>, now: number): void {
    this.db
      .prepare(
        `INSERT INTO layouts(name, data, updated_at) VALUES(?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
      )
      .run(name, JSON.stringify(data), now);
  }

  /**
   * Autosave to the active layout. No-op (returns false) when the active layout
   * is the read-only Default — the user must "save as" to start persisting.
   */
  saveActive(data: Record<string, unknown>, now: number): boolean {
    const active = this.getActiveName();
    if (active === DEFAULT_LAYOUT_NAME) return false;
    this.upsert(active, data, now);
    return true;
  }

  /**
   * Create or overwrite a named layout and make it active.
   * Throws on a reserved/invalid name.
   */
  saveAs(name: string, data: Record<string, unknown>, now: number): void {
    if (!LayoutStore.isValidUserName(name)) {
      throw new Error('invalid layout name');
    }
    this.upsert(name, data, now);
    this.setActiveName(name);
  }

  /** Make an existing layout (or Default) active. Returns false if missing. */
  setActive(name: string): boolean {
    if (name === DEFAULT_LAYOUT_NAME) {
      this.setActiveName(DEFAULT_LAYOUT_NAME);
      return true;
    }
    if (!this.has(name)) return false;
    this.setActiveName(name);
    return true;
  }

  /**
   * Delete a user layout. The Default cannot be deleted. If the deleted layout
   * was active, the active layout falls back to Default. Returns false if the
   * name is reserved or unknown.
   */
  delete(name: string): boolean {
    if (name === DEFAULT_LAYOUT_NAME) return false;
    if (!this.has(name)) return false;
    const wasActive = this.getActiveName() === name;
    this.db.prepare('DELETE FROM layouts WHERE name = ?').run(name);
    if (wasActive) {
      this.setActiveName(DEFAULT_LAYOUT_NAME);
    }
    return true;
  }

  close(): void {
    this.db.close();
  }
}
