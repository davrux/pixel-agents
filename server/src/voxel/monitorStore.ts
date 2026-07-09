/**
 * Conference-monitor names — an optional short label attached to a monitor block cell
 * (per world, x, y, z), persisted in pixel.db. A named monitor's video call is keyed by
 * NAME (see shared conferenceKey), so monitors sharing a name share a room and the room
 * survives the block being moved; unnamed monitors fall back to a per-position room.
 * The server sends all of a world's monitor names on join and broadcasts a `monitorName`
 * message when one is set/cleared; the client shows it as the call's title.
 */
import { db } from '../db.js';

db.exec('CREATE TABLE IF NOT EXISTS voxel_monitors (world TEXT, x INTEGER, y INTEGER, z INTEGER, name TEXT NOT NULL, PRIMARY KEY (world, x, y, z))');
const getStmt = db.prepare('SELECT name FROM voxel_monitors WHERE world = ? AND x = ? AND y = ? AND z = ?');
const getAllStmt = db.prepare('SELECT x, y, z, name FROM voxel_monitors WHERE world = ?');
const setStmt = db.prepare(
  'INSERT INTO voxel_monitors (world, x, y, z, name) VALUES (?, ?, ?, ?, ?) ON CONFLICT(world, x, y, z) DO UPDATE SET name = excluded.name',
);
const delStmt = db.prepare('DELETE FROM voxel_monitors WHERE world = ? AND x = ? AND y = ? AND z = ?');

/** Clamp an untrusted monitor name: strip control chars, collapse whitespace, trim, and
 *  cap at 32 Unicode code points (iterate by code point so a multi-byte char / emoji is
 *  never split mid-sequence). */
export function cleanMonitorName(n: unknown): string {
  if (typeof n !== 'string') return '';
  let s = '';
  for (const ch of n) s += ch.codePointAt(0)! < 32 ? ' ' : ch; // drop control chars
  s = s.replace(/\s+/g, ' ').trim();
  return [...s].slice(0, 32).join(''); // 32 code points, no split multi-byte chars
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
