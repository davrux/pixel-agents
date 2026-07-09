/**
 * Per-world boat persistence (Luanti boats survive restarts / empty-room disposal).
 * One row per world holding a JSON array of boat transforms {x,y,z,yaw}. Boats are
 * loaded when the room is created and saved when one is placed / comes to rest / on
 * dispose — so a boat you parked is still there after a reload.
 */
import { db } from '../db.js';

db.exec('CREATE TABLE IF NOT EXISTS voxel_boats (world TEXT PRIMARY KEY, boats TEXT)');
const getStmt = db.prepare('SELECT boats FROM voxel_boats WHERE world = ?');
const setStmt = db.prepare('INSERT INTO voxel_boats (world, boats) VALUES (?, ?) ON CONFLICT(world) DO UPDATE SET boats = excluded.boats');

export interface StoredBoat {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

export const boatStore = {
  get(world: string): StoredBoat[] {
    const r = getStmt.get(world) as { boats: string } | undefined;
    if (!r?.boats) return [];
    try {
      const arr = JSON.parse(r.boats) as StoredBoat[];
      return Array.isArray(arr) ? arr.filter((b) => [b.x, b.y, b.z, b.yaw].every(Number.isFinite)) : [];
    } catch {
      return [];
    }
  },
  set(world: string, boats: StoredBoat[]): void {
    setStmt.run(world, JSON.stringify(boats.slice(0, 200))); // cap to keep the blob sane
  },
};
