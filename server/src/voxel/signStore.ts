/**
 * Sign text — a short string attached to a sign block cell (per world, x, y, z),
 * persisted in pixel.db. The server sends all of a world's signs on join and
 * broadcasts a `sign` message when one is edited or cleared; the client renders the
 * text in-world above the block.
 */
import { db } from '../db.js';
import { SIGN_MAX_LEN } from '@pixel/shared';

db.exec('CREATE TABLE IF NOT EXISTS voxel_signs (world TEXT, x INTEGER, y INTEGER, z INTEGER, text TEXT NOT NULL, PRIMARY KEY (world, x, y, z))');
const getAllStmt = db.prepare('SELECT x, y, z, text FROM voxel_signs WHERE world = ?');
const setStmt = db.prepare(
  'INSERT INTO voxel_signs (world, x, y, z, text) VALUES (?, ?, ?, ?, ?) ON CONFLICT(world, x, y, z) DO UPDATE SET text = excluded.text',
);
const delStmt = db.prepare('DELETE FROM voxel_signs WHERE world = ? AND x = ? AND y = ? AND z = ?');

/** Clamp untrusted sign text: control chars → space, collapse whitespace, length-cap. */
export function cleanSignText(t: unknown): string {
  if (typeof t !== 'string') return '';
  let out = '';
  for (const ch of t) out += ch.charCodeAt(0) < 32 ? ' ' : ch; // drop control chars
  return out.replace(/\s+/g, ' ').trim().slice(0, SIGN_MAX_LEN);
}

export const signs = {
  all(world: string): { x: number; y: number; z: number; text: string }[] {
    return getAllStmt.all(world) as { x: number; y: number; z: number; text: string }[];
  },
  set(world: string, x: number, y: number, z: number, text: string): void {
    setStmt.run(world, x, y, z, text);
  },
  delete(world: string, x: number, y: number, z: number): void {
    delStmt.run(world, x, y, z);
  },
};
