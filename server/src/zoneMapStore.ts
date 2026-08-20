/**
 * SQLite-backed persistence for zone maps (Node's built-in `node:sqlite`, no
 * native dependency): **one map per zone, keyed by the zone id.**
 *
 * This used to be a LayoutStore with a whole naming layer on top — a read-only
 * virtual "Default" per zone (the bundled or generated builtin), a set of named
 * user layouts under composite keys `"<zone>/<name>"`, and an active-layout
 * pointer in `meta` under `"active/<zone>"`. All of that existed to serve the
 * in-game editor: you saved variants, switched between them, and could always
 * fall back to the builtin.
 *
 * With authoring moved to Tiled, a zone has exactly one map and it arrives by
 * being pushed (see tiled/zonePushApi.ts). Variants live where the mapper keeps
 * them, as `.tmj` files. So the name, the pointer and the builtins are gone and
 * the row key IS the zone id — which is also what makes "we only have zones"
 * true in the data and not just in the UI.
 *
 * The table is still called `layouts`: renaming it would buy nothing and cost a
 * copy of every map.
 */
import type { DatabaseSync } from 'node:sqlite';

import type { OfficeLayout } from '@pixel/shared/office/types.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { migrateLayout } from '@pixel/shared/office/layout/layoutSerializer.js';

import { ASSETS_ROOT } from './assets.js';

import { db } from './db.js';

type Layout = Record<string, unknown>;

/**
 * How many columns a ground set's sheet has — what a version-1 layout needs to be
 * read at all, since its cells stored a (pattern, swatch) pair that only becomes a
 * tile id once the column count is known (see migrateLayout).
 *
 * Injected at boot rather than imported, so this store stays free of the Tiled
 * reader: it is a table of JSON blobs, and it should not need assets on disk to
 * answer a query. Unset (the default) means every v1 cell migrates to VOID, which
 * is visible instead of silently wrong.
 */
let groundColumnsOf: (setName: string) => number | undefined = () => undefined;
export function setGroundColumnsResolver(resolve: (setName: string) => number | undefined): void {
  groundColumnsOf = resolve;
}


/**
 * Where an image placement's file is, for the v2 → v3 migration: the tile's own path is
 * not in a v2 layout, so the only thing left is the convention the importer falls back on
 * (`png/src/images/<imageId>.png`) — checked against the disk rather than assumed, and
 * any extension the directory happens to hold.
 *
 * Returning nothing drops that placement (migrateLayout says so): a picture whose file
 * nobody has draws nothing either way, and carrying the id forward only carries the hole.
 */
function imageSrcFor(imageId: string): string | undefined {
  const dir = path.join(ASSETS_ROOT, 'assets', 'tiled', 'png', 'src', 'images');
  for (const ext of ['png', 'PNG', 'jpg', 'jpeg', 'webp']) {
    const rel = `png/src/images/${imageId}.${ext}`;
    if (fs.existsSync(path.join(ASSETS_ROOT, 'assets', 'tiled', rel))) return rel;
  }
  // Last try: any file whose stem matches, whatever it is called.
  try {
    const hit = fs.readdirSync(dir).find((f) => f.replace(/\.[^.]+$/, '') === imageId);
    return hit ? `png/src/images/${hit}` : undefined;
  } catch {
    return undefined;
  }
}

export class ZoneMapStore {
  private readonly db: DatabaseSync;

  constructor() {
    this.db = db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS layouts (
        name TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta ( key TEXT PRIMARY KEY, value TEXT NOT NULL );
    `);
    this.migrateFromNamedLayouts();
  }

  /** The zone's map, or null if none has been pushed yet. */
  get(zone: string): Layout | null {
    const row = this.db.prepare('SELECT data, updated_at FROM layouts WHERE name = ?').get(zone) as
      | { data: string; updated_at: number }
      | undefined;
    if (!row) return null;
    let parsed: Layout;
    try {
      parsed = JSON.parse(row.data) as Layout;
    } catch {
      return null;
    }
    // Migrate on first read, keeping the original timestamp: a map's updated_at is
    // when a HUMAN last pushed it, and a format bump is not an edit.
    const { layout: migrated, unresolved } = migrateLayout(parsed as unknown as OfficeLayout, groundColumnsOf, imageSrcFor);
    if (migrated === (parsed as unknown as OfficeLayout)) return parsed;
    if (unresolved.length > 0) {
      // NOT persisted. Every cell of an unresolved set became a hole, and writing
      // that back replaces the map with an empty one — which is exactly what
      // happened once, when this ran before the resolver was wired up. A map is
      // recoverable from its .tmj; a silently emptied database row is not obviously
      // broken until someone opens the zone.
      console.error(
        `[zone-maps] ${zone}: NOT migrating — no column count for ${unresolved.join(', ')}. ` +
          `Those tilesets are missing or the resolver is not wired yet; the stored map is left untouched. Re-push the zone once they are there.`,
      );
      return parsed;
    }
    this.db.prepare('UPDATE layouts SET data = ? WHERE name = ?').run(JSON.stringify(migrated), zone);
    console.log(`[zone-maps] ${zone}: layout migrated to version ${migrated.version}`);
    return migrated as unknown as Layout;
  }

  has(zone: string): boolean {
    return this.db.prepare('SELECT 1 FROM layouts WHERE name = ?').get(zone) !== undefined;
  }

  /** Replace the zone's map (an import/push is the only caller). */
  put(zone: string, data: Layout, now: number): void {
    this.db
      .prepare(
        `INSERT INTO layouts(name,data,updated_at) VALUES(?,?,?)
         ON CONFLICT(name) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at`,
      )
      .run(zone, JSON.stringify(data), now);
  }

  /** Drop a zone's map — called when the zone itself is deleted. */
  delete(zone: string): void {
    this.db.prepare('DELETE FROM layouts WHERE name = ?').run(zone);
  }

  /**
   * One-time, idempotent migration from the named-layouts model: whatever each
   * zone's `active/<zone>` pointer named becomes that zone's single map, every
   * other saved variant of it is dropped, and the pointer goes.
   *
   * Deliberately keyed off the pointer rather than "newest row wins": the active
   * one is what players were actually standing in, and picking any other would
   * silently swap a live world. A zone whose pointer named the builtin "Default"
   * has no row to keep — it comes out of this with no map, which is honest: its
   * content only ever existed as code, and code no longer generates maps.
   */
  private migrateFromNamedLayouts(): void {
    const pointers = this.db
      .prepare("SELECT key, value FROM meta WHERE key LIKE 'active/%'")
      .all() as Array<{ key: string; value: string }>;
    for (const { key, value } of pointers) {
      const zone = key.slice('active/'.length);
      if (!zone) continue;
      const row = this.db.prepare('SELECT data, updated_at FROM layouts WHERE name = ?').get(`${zone}/${value}`) as
        | { data: string; updated_at: number }
        | undefined;
      if (row && !this.has(zone)) {
        this.db
          .prepare('INSERT INTO layouts(name,data,updated_at) VALUES(?,?,?)')
          .run(zone, row.data, row.updated_at);
      }
      this.db.prepare('DELETE FROM layouts WHERE name LIKE ?').run(`${zone}/%`);
      this.db.prepare('DELETE FROM meta WHERE key = ?').run(key);
    }
    // Rows left over from a zone that never had a pointer (or whose pointer was
    // already migrated in an earlier run) — nothing names them any more.
    this.db.prepare("DELETE FROM layouts WHERE name LIKE '%/%'").run();
  }
}
