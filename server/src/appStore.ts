/**
 * SQLite-backed sessions + settings (Node's built-in `node:sqlite`).
 *
 * Sessions survive a server restart and carry the viewer's chosen username
 * (used to play task sounds only for that viewer's own agents). Expired sessions
 * are purged on startup and on an interval so the table never grows unbounded.
 */
import { DatabaseSync } from 'node:sqlite';
import * as crypto from 'node:crypto';

import { dataPath } from './paths.js';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // hourly

class AppStore {
  private readonly db = new DatabaseSync(dataPath('layouts.db'));

  constructor() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        sid TEXT PRIMARY KEY, username TEXT NOT NULL, expires INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings ( key TEXT PRIMARY KEY, value TEXT NOT NULL );
    `);
    this.cleanupExpired();
    const t = setInterval(() => this.cleanupExpired(), CLEANUP_INTERVAL_MS);
    if (typeof t.unref === 'function') t.unref();
  }

  // ── Sessions ─────────────────────────────────────────────────────
  createSession(username: string): string {
    const sid = crypto.randomBytes(32).toString('base64url'); // opaque, never the token
    this.db
      .prepare('INSERT INTO sessions(sid, username, expires) VALUES(?, ?, ?)')
      .run(sid, username, Date.now() + SESSION_TTL_MS);
    return sid;
  }

  /** Live session for a sid, or undefined if missing/expired (lazy-deleted). */
  getSession(sid: string | undefined): { username: string } | undefined {
    if (!sid) return undefined;
    const r = this.db.prepare('SELECT username, expires FROM sessions WHERE sid = ?').get(sid) as
      | { username: string; expires: number }
      | undefined;
    if (!r) return undefined;
    if (Date.now() > r.expires) {
      this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
      return undefined;
    }
    return { username: r.username };
  }

  cleanupExpired(): void {
    this.db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
  }

  // ── Settings (global; matches the original single-server fork) ───
  getSetting<T>(key: string, fallback: T): T {
    const r = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    if (!r) return fallback;
    try {
      return JSON.parse(r.value) as T;
    } catch {
      return fallback;
    }
  }

  setSetting(key: string, value: unknown): void {
    this.db
      .prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(key, JSON.stringify(value));
  }
}

export const appStore = new AppStore();
