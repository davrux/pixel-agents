/**
 * Server-wide "bring your own WAD" storage: an admin uploads an IWAD they legally
 * own (e.g. the full DOOM.WAD) once, and it becomes a playable title for every
 * logged-in player. Stored as a BLOB in pixel.db keyed by a sanitized slug name —
 * deliberately NOT on the filesystem, so no user input ever becomes a path
 * (no traversal). The bytes are pure game data: never executed server-side, only
 * fed into the sandboxed js-dos (DOSBox WASM) in the browser.
 */
import { db } from './db.js';

db.exec(
  'CREATE TABLE IF NOT EXISTS arcade_wads (name TEXT PRIMARY KEY, title TEXT NOT NULL, iwad TEXT NOT NULL, data BLOB NOT NULL, size INTEGER NOT NULL, sha1 TEXT NOT NULL, uploaded_by TEXT, uploaded_at INTEGER NOT NULL)',
);
const listStmt = db.prepare('SELECT name, title, iwad, size FROM arcade_wads ORDER BY title');
const getStmt = db.prepare('SELECT iwad, data FROM arcade_wads WHERE name = ?');
const putStmt = db.prepare(
  'INSERT INTO arcade_wads (name, title, iwad, data, size, sha1, uploaded_by, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ' +
    'ON CONFLICT(name) DO UPDATE SET title=excluded.title, iwad=excluded.iwad, data=excluded.data, size=excluded.size, sha1=excluded.sha1, uploaded_by=excluded.uploaded_by, uploaded_at=excluded.uploaded_at',
);
const delStmt = db.prepare('DELETE FROM arcade_wads WHERE name = ?');

export interface WadInfo {
  name: string;
  title: string;
  iwad: string;
  size: number;
}

export const arcadeWads = {
  /** All uploaded WADs (metadata only, no blob). */
  list(): WadInfo[] {
    return listStmt.all() as unknown as WadInfo[];
  },
  /** A WAD's bytes + its in-bundle filename, or null. */
  get(name: string): { iwad: string; data: Uint8Array } | null {
    const r = getStmt.get(name) as { iwad: string; data: Uint8Array } | undefined;
    return r ? { iwad: r.iwad, data: new Uint8Array(r.data) } : null;
  },
  put(rec: { name: string; title: string; iwad: string; data: Uint8Array; sha1: string; uploadedBy: string }): void {
    putStmt.run(rec.name, rec.title, rec.iwad, rec.data, rec.data.length, rec.sha1, rec.uploadedBy || null, Date.now());
  },
  remove(name: string): void {
    delStmt.run(name);
  },
};
