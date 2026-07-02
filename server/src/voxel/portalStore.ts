/**
 * Generic portals — a block cell in a world that teleports whoever stands on it
 * to a destination: another voxel world ({kind:'voxel',world,seed?}) or a 2D zone
 * ({kind:'zone',id}). Stored per (world, x, y, z) in pixel.db. The server detects
 * a player stepping onto a portal (in onMove) and sends them the destination.
 */
import { db } from '../db.js';

export type PortalDest = { kind: 'voxel'; world: string; seed?: number } | { kind: 'zone'; id: string };

db.exec(
  'CREATE TABLE IF NOT EXISTS portals (world TEXT, x INTEGER, y INTEGER, z INTEGER, dest TEXT NOT NULL, PRIMARY KEY (world, x, y, z))',
);
const getStmt = db.prepare('SELECT dest FROM portals WHERE world = ? AND x = ? AND y = ? AND z = ?');
const setStmt = db.prepare(
  'INSERT INTO portals (world, x, y, z, dest) VALUES (?, ?, ?, ?, ?) ON CONFLICT(world, x, y, z) DO UPDATE SET dest = excluded.dest',
);
const delStmt = db.prepare('DELETE FROM portals WHERE world = ? AND x = ? AND y = ? AND z = ?');

/** Validate an untrusted destination object → a clean PortalDest, or null. */
export function cleanDest(d: unknown): PortalDest | null {
  if (!d || typeof d !== 'object') return null;
  const o = d as Record<string, unknown>;
  if (o.kind === 'voxel' && typeof o.world === 'string' && o.world) {
    const dest: PortalDest = { kind: 'voxel', world: o.world.slice(0, 40) };
    if (Number.isFinite(o.seed)) dest.seed = (o.seed as number) >>> 0;
    return dest;
  }
  if (o.kind === 'zone' && typeof o.id === 'string' && o.id) return { kind: 'zone', id: o.id.slice(0, 40) };
  return null;
}

export const portals = {
  get(world: string, x: number, y: number, z: number): PortalDest | null {
    const row = getStmt.get(world, x, y, z) as { dest: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.dest) as PortalDest;
    } catch {
      return null;
    }
  },
  set(world: string, x: number, y: number, z: number, dest: PortalDest | null): void {
    if (dest) setStmt.run(world, x, y, z, JSON.stringify(dest));
    else delStmt.run(world, x, y, z);
  },
};
