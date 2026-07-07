/**
 * Conference-monitor names — an optional short label attached to a monitor block cell
 * (per world, x, y, z), persisted in pixel.db. A named monitor's video call is keyed by
 * NAME (see shared conferenceKey), so monitors sharing a name share a room and the room
 * survives the block being moved; unnamed monitors fall back to a per-position room.
 * The server sends all of a world's monitor names on join and broadcasts a `monitorName`
 * message when one is set/cleared; the client shows it as the call's title.
 */
import { db } from '../db.js';
import { cleanName } from '@pixel/shared';

db.exec('CREATE TABLE IF NOT EXISTS voxel_monitors (world TEXT, x INTEGER, y INTEGER, z INTEGER, name TEXT NOT NULL, PRIMARY KEY (world, x, y, z))');
const getStmt = db.prepare('SELECT name FROM voxel_monitors WHERE world = ? AND x = ? AND y = ? AND z = ?');
const getAllStmt = db.prepare('SELECT x, y, z, name FROM voxel_monitors WHERE world = ?');
const setStmt = db.prepare(
  'INSERT INTO voxel_monitors (world, x, y, z, name) VALUES (?, ?, ?, ?, ?) ON CONFLICT(world, x, y, z) DO UPDATE SET name = excluded.name',
);
const delStmt = db.prepare('DELETE FROM voxel_monitors WHERE world = ? AND x = ? AND y = ? AND z = ?');

/** Clamp an untrusted monitor name (whitespace-collapsed, length-capped). */
export function cleanMonitorName(n: unknown): string {
  return cleanName(n, 32);
}

export const monitors = {
  get(world: string, x: number, y: number, z: number): string {
    const row = getStmt.get(world, x, y, z) as { name: string } | undefined;
    return row?.name ?? '';
  },
  all(world: string): { x: number; y: number; z: number; name: string }[] {
    return getAllStmt.all(world) as { x: number; y: number; z: number; name: string }[];
  },
  set(world: string, x: number, y: number, z: number, name: string): void {
    setStmt.run(world, x, y, z, name);
  },
  delete(world: string, x: number, y: number, z: number): void {
    delStmt.run(world, x, y, z);
  },
};
