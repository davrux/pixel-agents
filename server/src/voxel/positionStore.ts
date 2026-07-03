/**
 * Per-user, per-world last position, persisted in pixel.db so a logged-in player
 * respawns where they left off (not always at origin). Saved on leave; loaded on
 * join. Anonymous (no login) is not persisted → spawns at the world origin.
 */
import { db } from '../db.js';

db.exec('CREATE TABLE IF NOT EXISTS voxel_positions (user_id TEXT, world TEXT, x REAL, y REAL, z REAL, PRIMARY KEY (user_id, world))');
const getStmt = db.prepare('SELECT x, y, z FROM voxel_positions WHERE user_id = ? AND world = ?');
const setStmt = db.prepare(
  'INSERT INTO voxel_positions (user_id, world, x, y, z) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id, world) DO UPDATE SET x = excluded.x, y = excluded.y, z = excluded.z',
);

export const voxelPositions = {
  /** The user's last position in `world`, or null (anonymous / never saved). */
  get(userId: string, world: string): { x: number; y: number; z: number } | null {
    if (!userId) return null;
    const r = getStmt.get(userId, world) as { x: number; y: number; z: number } | undefined;
    return r ?? null;
  },
  set(userId: string, world: string, x: number, y: number, z: number): void {
    if (!userId || ![x, y, z].every(Number.isFinite)) return;
    setStmt.run(userId, world, x, y, z);
  },
};
