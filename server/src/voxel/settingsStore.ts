/**
 * Per-user voxel client settings, persisted server-side in pixel.db so a logged-in
 * player's preferences (camera invert/collision, auto-switch, per-item wield
 * transforms, …) follow them across devices. Stored as one opaque JSON blob per
 * user id — the client owns the shape; the server only size-caps it. Anonymous
 * (no login) is not persisted (returns null / no-op) — that's why login matters.
 */
import { db } from '../db.js';

db.exec('CREATE TABLE IF NOT EXISTS voxel_settings (user_id TEXT PRIMARY KEY, json TEXT NOT NULL)');
const getStmt = db.prepare('SELECT json FROM voxel_settings WHERE user_id = ?');
const setStmt = db.prepare(
  'INSERT INTO voxel_settings (user_id, json) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET json = excluded.json',
);

const MAX_JSON = 32 * 1024; // generous cap (a few tools' wield tables + toggles)

export const voxelSettings = {
  /** The user's saved settings object, or null (unknown user / anonymous / none). */
  get(userId: string): unknown {
    if (!userId) return null;
    const row = getStmt.get(userId) as { json: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.json);
    } catch {
      return null;
    }
  },
  /** Persist the user's settings. No-op for anonymous or oversized payloads. */
  set(userId: string, obj: unknown): void {
    if (!userId || obj === null || typeof obj !== 'object') return;
    const json = JSON.stringify(obj);
    if (json.length > MAX_JSON) return;
    setStmt.run(userId, json);
  },
};
