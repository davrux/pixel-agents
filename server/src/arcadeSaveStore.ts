/**
 * Arcade savegames, persisted server-side per (user_id, game) in pixel.db. The blob
 * is the DOS game's changed files (a js-dos `ci.persist(true)` bundle) — opaque to
 * us. Server-wide + per user, so a player's saves follow them across devices and
 * across BOTH worlds (2D Pixels + 3D Voxel), exactly like their voxel inventory.
 * Anonymous (no user id) is not persisted.
 */
import { db } from './db.js';

db.exec('CREATE TABLE IF NOT EXISTS arcade_saves (user_id TEXT, game TEXT, data BLOB NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY (user_id, game))');
const getStmt = db.prepare('SELECT data FROM arcade_saves WHERE user_id = ? AND game = ?');
const delStmt = db.prepare('DELETE FROM arcade_saves WHERE user_id = ? AND game = ?');
const setStmt = db.prepare(
  'INSERT INTO arcade_saves (user_id, game, data, updated) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, game) DO UPDATE SET data = excluded.data, updated = excluded.updated',
);

/** Max stored save size — DOS savegames are tiny (KB); this is a generous guard. */
export const ARCADE_SAVE_MAX_BYTES = 4 * 1024 * 1024;

export const arcadeSaves = {
  /** The user's saved bytes for a game, or null if none / anonymous. */
  get(userId: string, game: string): Uint8Array | null {
    if (!userId || !game) return null;
    const row = getStmt.get(userId, game) as { data: Uint8Array } | undefined;
    return row?.data ? new Uint8Array(row.data) : null;
  },
  /** Persist the user's save bytes for a game (no-op for anonymous / oversized). */
  set(userId: string, game: string, data: Uint8Array): void {
    if (!userId || !game || !data?.length || data.length > ARCADE_SAVE_MAX_BYTES) return;
    setStmt.run(userId, game, data, Date.now());
  },
  /** Delete a user's save for a game (reset to the bundle's fresh defaults). */
  remove(userId: string, game: string): void {
    if (userId && game) delStmt.run(userId, game);
  },
};
