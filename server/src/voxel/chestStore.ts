/**
 * Per-position chest inventory, persisted in pixel.db (one row per chest cell per
 * world). Contents are a JSON map of item-id → count, same id space as the player
 * inventory (blocks/materials/tools). Chests survive restarts; breaking a chest
 * clears its row (its contents spill as drops — see VoxelRoom).
 */
import { db } from '../db.js';

db.exec('CREATE TABLE IF NOT EXISTS voxel_chests (world TEXT, x INTEGER, y INTEGER, z INTEGER, items TEXT, PRIMARY KEY (world, x, y, z))');
const getStmt = db.prepare('SELECT items FROM voxel_chests WHERE world = ? AND x = ? AND y = ? AND z = ?');
const setStmt = db.prepare(
  'INSERT INTO voxel_chests (world, x, y, z, items) VALUES (?, ?, ?, ?, ?) ON CONFLICT(world, x, y, z) DO UPDATE SET items = excluded.items',
);
const delStmt = db.prepare('DELETE FROM voxel_chests WHERE world = ? AND x = ? AND y = ? AND z = ?');

export const chests = {
  /** A chest's contents as Map<itemId, count> (empty map if never used). */
  get(world: string, x: number, y: number, z: number): Map<number, number> {
    const r = getStmt.get(world, x, y, z) as { items: string } | undefined;
    const m = new Map<number, number>();
    if (r?.items) {
      try {
        for (const [k, v] of Object.entries(JSON.parse(r.items) as Record<string, number>)) {
          const id = Number(k);
          if (Number.isFinite(id) && Number.isFinite(v) && v > 0) m.set(id, v);
        }
      } catch {
        /* corrupt row → empty */
      }
    }
    return m;
  },
  set(world: string, x: number, y: number, z: number, items: Map<number, number>): void {
    if (!items.size) return void delStmt.run(world, x, y, z);
    const obj: Record<string, number> = {};
    for (const [id, c] of items) if (c > 0) obj[id] = c;
    setStmt.run(world, x, y, z, JSON.stringify(obj));
  },
  delete(world: string, x: number, y: number, z: number): void {
    delStmt.run(world, x, y, z);
  },
};
