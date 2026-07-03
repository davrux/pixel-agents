/**
 * Per-user survival inventory, persisted in pixel.db so a logged-in player keeps the
 * blocks/materials/tools they collected across reconnects (and, like Luanti, across
 * worlds — inventory is the player's bag, not per-world). Stored as a compact JSON map
 * of item-id → count. Saved on leave; loaded on join. Anonymous (no login) is not
 * persisted → starts empty each session.
 */
import { db } from '../db.js';

db.exec('CREATE TABLE IF NOT EXISTS voxel_inventory (user_id TEXT PRIMARY KEY, items TEXT)');
const getStmt = db.prepare('SELECT items FROM voxel_inventory WHERE user_id = ?');
const setStmt = db.prepare(
  'INSERT INTO voxel_inventory (user_id, items) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET items = excluded.items',
);

const MAX_JSON = 16 * 1024; // guard against a runaway blob

export const voxelInventory = {
  /** The user's saved inventory as a Map<itemId, count>, or null (anonymous / never saved). */
  get(userId: string): Map<number, number> | null {
    if (!userId) return null;
    const r = getStmt.get(userId) as { items: string } | undefined;
    if (!r?.items) return null;
    try {
      const obj = JSON.parse(r.items) as Record<string, number>;
      const m = new Map<number, number>();
      for (const [k, v] of Object.entries(obj)) {
        const id = Number(k);
        if (Number.isFinite(id) && Number.isFinite(v) && v > 0) m.set(id, v);
      }
      return m;
    } catch {
      return null;
    }
  },
  set(userId: string, items: Map<number, number>): void {
    if (!userId) return;
    const obj: Record<string, number> = {};
    for (const [id, c] of items) if (c > 0) obj[id] = c;
    const json = JSON.stringify(obj);
    if (json.length > MAX_JSON) return;
    setStmt.run(userId, json);
  },
};
