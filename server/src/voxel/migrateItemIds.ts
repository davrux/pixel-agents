/**
 * One-time migration: shift the voxel item-id bands up by +100.
 *
 * The placeable-block band was full (1..99), so a new block (the arcade cabinet,
 * id 100) needed room. We moved MATERIAL_BASE 100→200 and TOOL_BASE 200→300
 * (see shared protocol.ts), freeing block ids 101..199. Every persisted item id
 * ≥ 100 (the OLD material/tool floor) therefore shifts +100. Block ids (< 100)
 * are unchanged. The shift is uniform, so old materials (100..199) and old tools
 * (200..299) map to disjoint new ranges (200..299 / 300..399) with no collision.
 *
 * Persisted item ids live in four places (all in pixel.db):
 *   - voxel_inventory.items   {numericId: count}
 *   - voxel_durability.wear   {numericToolId: usesLeft}
 *   - voxel_chests.items      {numericId: count}
 *   - voxel_settings.json     hotbar.slots[] + wield{} — STRING ids like 'b250',
 *                             'mat:100' that embed the numeric id (blocks 'block:N'
 *                             and tool names 'pick_wood' carry no ≥100 number).
 *
 * Guarded by a _migrations row so it runs exactly once. The pure transforms are
 * exported for unit testing.
 */
import { db } from '../db.js';
import { shiftCountMapJson, shiftSettingsJson } from './itemIdShift.js';

/** Run the migration once (idempotent via the _migrations table). */
export function migrateItemIds(): void {
  db.exec('CREATE TABLE IF NOT EXISTS _migrations (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const KEY = 'voxel_item_ids_shift100';
  if (db.prepare('SELECT value FROM _migrations WHERE key = ?').get(KEY)) return;

  // Be self-contained: ensure the tables exist (stores also create them; a fresh
  // install simply has no rows to migrate). Kept in sync with the store schemas.
  db.exec('CREATE TABLE IF NOT EXISTS voxel_inventory (user_id TEXT PRIMARY KEY, items TEXT)');
  db.exec('CREATE TABLE IF NOT EXISTS voxel_durability (user_id TEXT PRIMARY KEY, wear TEXT)');
  db.exec('CREATE TABLE IF NOT EXISTS voxel_chests (world TEXT, x INTEGER, y INTEGER, z INTEGER, items TEXT, PRIMARY KEY (world, x, y, z))');
  db.exec('CREATE TABLE IF NOT EXISTS voxel_settings (user_id TEXT PRIMARY KEY, json TEXT NOT NULL)');

  const rewriteColumn = (
    table: string,
    idCols: string[],
    valueCol: string,
    transform: (json: string) => string,
  ): number => {
    const rows = db.prepare(`SELECT ${[...idCols, valueCol].join(', ')} FROM ${table}`).all() as Record<string, unknown>[];
    const upd = db.prepare(`UPDATE ${table} SET ${valueCol} = ? WHERE ${idCols.map((c) => `${c} = ?`).join(' AND ')}`);
    let n = 0;
    for (const row of rows) {
      const raw = row[valueCol];
      if (typeof raw !== 'string' || !raw) continue;
      let next: string;
      try {
        next = transform(raw);
      } catch {
        continue; // leave corrupt rows untouched
      }
      if (next !== raw) {
        upd.run(next, ...idCols.map((c) => row[c] as string | number));
        n++;
      }
    }
    return n;
  };

  const inv = rewriteColumn('voxel_inventory', ['user_id'], 'items', shiftCountMapJson);
  const dur = rewriteColumn('voxel_durability', ['user_id'], 'wear', shiftCountMapJson);
  const che = rewriteColumn('voxel_chests', ['world', 'x', 'y', 'z'], 'items', shiftCountMapJson);
  const set = rewriteColumn('voxel_settings', ['user_id'], 'json', shiftSettingsJson);

  db.prepare('INSERT INTO _migrations(key, value) VALUES(?, ?)').run(KEY, String(Date.now()));
  // eslint-disable-next-line no-console
  console.log(`[voxel] item-id shift migration: inventory=${inv} durability=${dur} chests=${che} settings=${set}`);
}
