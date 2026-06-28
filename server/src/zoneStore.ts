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
import { DatabaseSync } from 'node:sqlite';

import { MAX_COLS, MAX_ROWS } from '@pixel/shared/office/constants.js';
import { ZONES, DEFAULT_ZONE, type ZoneConfig } from '@pixel/shared';

import { dataPath } from './paths.js';

const DB_FILE = 'zones.db';
const MIN_SIZE = 6;
const LABEL_RE = /^[\x20-\x7e]{1,40}$/;

interface ZoneRow {
  id: string;
  label: string;
  arrive_col: number | null;
  arrive_row: number | null;
  cols: number | null;
  rows: number | null;
  read_only: number;
  created_at: number;
}

export class ZoneStore {
  private readonly db: DatabaseSync;

  constructor() {
    this.db = new DatabaseSync(dataPath(DB_FILE));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS zones (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        arrive_col INTEGER, arrive_row INTEGER,
        cols INTEGER, rows INTEGER,
        read_only INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS zone_meta ( key TEXT PRIMARY KEY, value TEXT NOT NULL );
    `);
    this.seed();
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

  /** Create a user zone from a label + initial size. Returns the new id, or null
   *  if the input is invalid. The id is a unique slug derived from the label. */
  create(label: string, cols: number, rows: number, now: number): string | null {
    if (!LABEL_RE.test(label)) return null;
    const c = this.clampSize(cols);
    const r = this.clampSize(rows);
    const id = this.uniqueId(ZoneStore.slugify(label));
    const arrive = { col: Math.floor(c / 2), row: Math.floor(r / 2) };
    this.db
      .prepare(
        `INSERT INTO zones(id,label,arrive_col,arrive_row,cols,rows,read_only,created_at)
         VALUES(?,?,?,?,?,?,0,?)`,
      )
      .run(id, label, arrive.col, arrive.row, c, r, now);
    return id;
  }

  /** Edit a zone's label and/or arrival tile. Never changes read-only (hidden). */
  edit(id: string, patch: { label?: string; arrive?: { col: number; row: number } }): boolean {
    const r = this.db.prepare('SELECT * FROM zones WHERE id = ?').get(id) as ZoneRow | undefined;
    if (!r) return false;
    const label = patch.label !== undefined ? patch.label : r.label;
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
    this.db.close();
  }

  // ── internals ───────────────────────────────────────────────────
  private toConfig(r: ZoneRow): ZoneConfig {
    return {
      id: r.id,
      label: r.label,
      arrive: r.arrive_col != null && r.arrive_row != null ? { col: r.arrive_col, row: r.arrive_row } : undefined,
      cols: r.cols ?? undefined,
      rows: r.rows ?? undefined,
      readOnly: !!r.read_only,
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
    this.db
      .prepare(
        `INSERT INTO zones(id,label,arrive_col,arrive_row,cols,rows,read_only,created_at)
         VALUES(?,?,?,?,?,?,?,0)
         ON CONFLICT(id) DO UPDATE SET label=excluded.label, read_only=excluded.read_only`,
      )
      .run(z.id, z.label, z.arrive?.col ?? null, z.arrive?.row ?? null, z.cols ?? null, z.rows ?? null, z.readOnly ? 1 : 0);
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
