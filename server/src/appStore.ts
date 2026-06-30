/**
 * SQLite-backed sessions + settings (Node's built-in `node:sqlite`).
 *
 * Sessions survive a server restart and carry the viewer's chosen username
 * (used to play task sounds only for that viewer's own agents). Expired sessions
 * are purged on startup and on an interval so the table never grows unbounded.
 */
import * as crypto from 'node:crypto';

import { db } from './db.js';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // hourly

class AppStore {
  private readonly db = db;

  constructor() {
    // Sessions are keyed by user_id now (password auth replaced the free-text
    // username login); a legacy username-based table is just dropped — those
    // sessions are invalid under the new model and re-login is required.
    const cols = this.db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
    if (cols.some((c) => c.name === 'username') && !cols.some((c) => c.name === 'user_id')) {
      this.db.exec('DROP TABLE sessions');
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        sid TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings ( key TEXT PRIMARY KEY, value TEXT NOT NULL );
      CREATE TABLE IF NOT EXISTS assets (
        type TEXT NOT NULL, name TEXT NOT NULL, data TEXT NOT NULL, updatedAt INTEGER NOT NULL,
        PRIMARY KEY (type, name)
      );
    `);
    this.cleanupExpired();
    const t = setInterval(() => this.cleanupExpired(), CLEANUP_INTERVAL_MS);
    if (typeof t.unref === 'function') t.unref();
  }

  // ── Sessions ─────────────────────────────────────────────────────
  createSession(userId: string): string {
    const sid = crypto.randomBytes(32).toString('base64url'); // opaque, never the token
    this.db
      .prepare('INSERT INTO sessions(sid, user_id, expires) VALUES(?, ?, ?)')
      .run(sid, userId, Date.now() + SESSION_TTL_MS);
    return sid;
  }

  /** Live session for a sid, or undefined if missing/expired (lazy-deleted). */
  getSession(sid: string | undefined): { userId: string } | undefined {
    if (!sid) return undefined;
    const r = this.db.prepare('SELECT user_id, expires FROM sessions WHERE sid = ?').get(sid) as
      | { user_id: string; expires: number }
      | undefined;
    if (!r) return undefined;
    if (Date.now() > r.expires) {
      this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
      return undefined;
    }
    return { userId: r.user_id };
  }

  deleteSession(sid: string): void {
    this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
  }

  cleanupExpired(): void {
    this.db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
  }

  // ── Asset overrides (characters, furniture, floors, walls, pets) ─
  // Edited/added assets, keyed by (type, name). The bundled files are the
  // read-only defaults; a row here overrides (or adds) one asset.
  listAssets(type: string): Array<{ name: string; data: unknown }> {
    const rows = this.db
      .prepare('SELECT name, data FROM assets WHERE type = ?')
      .all(type) as Array<{ name: string; data: string }>;
    const out: Array<{ name: string; data: unknown }> = [];
    for (const r of rows) {
      try {
        out.push({ name: r.name, data: JSON.parse(r.data) });
      } catch {
        /* skip corrupt row */
      }
    }
    return out;
  }

  getAsset<T>(type: string, name: string): T | undefined {
    const r = this.db
      .prepare('SELECT data FROM assets WHERE type = ? AND name = ?')
      .get(type, name) as { data: string } | undefined;
    if (!r) return undefined;
    try {
      return JSON.parse(r.data) as T;
    } catch {
      return undefined;
    }
  }

  saveAsset(type: string, name: string, data: unknown): void {
    this.db
      .prepare(
        'INSERT INTO assets(type,name,data,updatedAt) VALUES(?,?,?,?) ' +
          'ON CONFLICT(type,name) DO UPDATE SET data=excluded.data, updatedAt=excluded.updatedAt',
      )
      .run(type, name, JSON.stringify(data), Date.now());
  }

  /** Revert an asset to its bundled default. Returns true if a row was removed. */
  deleteAsset(type: string, name: string): boolean {
    const r = this.db.prepare('DELETE FROM assets WHERE type = ? AND name = ?').run(type, name);
    return Number(r.changes) > 0;
  }

  // ── Per-user character skin preference (skin id, e.g. "char_3") ──
  getCharPrefs(): Record<string, string> {
    return migrateSkinPrefs(this.getSetting<Record<string, unknown>>('charPrefs', {}));
  }
  setCharPref(name: string, skin: string): void {
    const prefs = this.getCharPrefs();
    prefs[name] = skin;
    this.setSetting('charPrefs', prefs);
  }
  /** Remove a user's pinned skin (e.g. when that character was deleted). */
  clearCharPref(name: string): void {
    const prefs = this.getCharPrefs();
    if (name in prefs) {
      delete prefs[name];
      this.setSetting('charPrefs', prefs);
    }
  }

  // ── Per-user player-avatar preferences (skin id + spectator) ─────
  /** Player-avatar skin id per user (absent = default random). */
  getPlayerPrefs(): Record<string, string> {
    return migrateSkinPrefs(this.getSetting<Record<string, unknown>>('playerPrefs', {}));
  }
  setPlayerPref(name: string, skin: string): void {
    const prefs = this.getPlayerPrefs();
    prefs[name] = skin;
    this.setSetting('playerPrefs', prefs);
  }
  /** Unpin a user's player-avatar skin (fall back to a random skin on spawn). */
  clearPlayerPref(name: string): void {
    const prefs = this.getPlayerPrefs();
    if (name in prefs) {
      delete prefs[name];
      this.setSetting('playerPrefs', prefs);
    }
  }
  // ── Per-user owned avatar (private, editable sprite data) ────────
  // Stored in the assets table under a reserved type so each avatar is its own
  // indexed row (not a giant settings blob), and is NOT merged into the shared
  // template gallery (that type lives outside ASSET_TYPES). Deleting a template
  // therefore can never affect a player's avatar.
  getPlayerAvatar<T>(username: string): T | undefined {
    return this.getAsset<T>('playerAvatar', username);
  }
  hasPlayerAvatar(username: string): boolean {
    return this.getPlayerAvatar(username) !== undefined;
  }
  setPlayerAvatar(username: string, data: unknown): void {
    this.saveAsset('playerAvatar', username, data);
  }
  deletePlayerAvatar(username: string): boolean {
    return this.deleteAsset('playerAvatar', username);
  }

  /** Users who opted out of a visible player avatar (spectator mode). */
  getSpectatorPrefs(): Record<string, boolean> {
    return this.getSetting<Record<string, boolean>>('spectatorPrefs', {});
  }
  setSpectatorPref(name: string, spectator: boolean): void {
    const prefs = this.getSpectatorPrefs();
    if (spectator) prefs[name] = true;
    else delete prefs[name];
    this.setSetting('spectatorPrefs', prefs);
  }

  /** Stable per-deployment voice namespace (random, created once + persisted).
   *  Prefixes LiveKit room names so two servers sharing one LiveKit project
   *  (e.g. dev + prod, with their own DBs) never collide on the same room. */
  getVoiceNs(): string {
    let ns = this.getSetting<string>('voiceNs', '');
    if (!ns) {
      ns = 'v' + crypto.randomBytes(4).toString('hex');
      this.setSetting('voiceNs', ns);
    }
    return ns;
  }

  // ── Per-user player position (per zone), to respawn where they left ──
  /** Last player tile for a user in a zone, or null. */
  getPlayerPos(name: string, zone: string): { col: number; row: number } | null {
    const all = this.getSetting<Record<string, { col: number; row: number }>>('playerPos', {});
    return all[`${name}|${zone}`] ?? null;
  }
  setPlayerPos(name: string, zone: string, col: number, row: number): void {
    const all = this.getSetting<Record<string, { col: number; row: number }>>('playerPos', {});
    all[`${name}|${zone}`] = { col, row };
    this.setSetting('playerPos', all);
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

/** Migrate skin prefs to string ids: an old numeric palette index N → "char_N"
 *  (the index always named char_N); strings pass through; negatives/junk (the
 *  old "-1 = random") are dropped so the user falls back to a diverse skin. */
function migrateSkinPrefs(raw: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, val] of Object.entries(raw)) {
    if (typeof val === 'string') out[name] = val;
    else if (typeof val === 'number' && Number.isInteger(val) && val >= 0) out[name] = `char_${val}`;
  }
  return out;
}
