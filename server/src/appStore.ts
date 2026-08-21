/**
 * SQLite-backed sessions + settings (Node's built-in `node:sqlite`).
 *
 * Sessions survive a server restart and carry the viewer's chosen username
 * (used to play task sounds only for that viewer's own agents). Expired sessions
 * are purged on startup and on an interval so the table never grows unbounded.
 */
import * as crypto from 'node:crypto';
import { isPackedArtType, packArt, unpackArt } from './art/artStore.js';

import { Direction, type PlayerSpot } from '@pixel/shared/office/types.js';

import { db } from './db.js';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // hourly

/**
 * One viewer's personal presentation preferences — what they see, never what
 * they may do. Nothing here grants anything, which is why the client is allowed
 * to set them for itself (see SimRoom's set* handlers, each keyed by the
 * SENDER's userId).
 */
export interface ViewerSettings {
  soundEnabled: boolean;
  alwaysShowLabels: boolean;
  alertVolume: number;
  cameraFollow: boolean;
  /** Open an 'iframe' action as a window over the game instead of a column
   *  pinned beside it — see client/src/ui/actionIframe.ts for what the two
   *  shapes are and why the choice is the viewer's. */
  iframeOverlay: boolean;
}

/** The defaults, in one place: `getViewerSettings` fills each missing field from
 *  here, and an anonymous viewer — who has no row to read — gets exactly this
 *  (SimRoom.onJoin). A second hand-written copy of these values is how a new
 *  preference ends up meaning one thing for a logged-in viewer and another for a
 *  guest. */
const VIEWER_SETTING_DEFAULTS: ViewerSettings = {
  soundEnabled: true,
  alwaysShowLabels: false,
  alertVolume: 1,
  cameraFollow: true,
  // False = the shape this has always had: a column beside the game, which never
  // hides the world. Opting in is the change of behaviour.
  iframeOverlay: false,
};

export function defaultViewerSettings(): ViewerSettings {
  return { ...VIEWER_SETTING_DEFAULTS };
}

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
    const sid = crypto.randomBytes(32).toString('base64url'); // 256-bit opaque id: the cookie sid AND the desktop bearer token
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

  /** Kill every active session for a user — call this on account deletion.
   *  Without it, a still-valid session (cookie or desktop bearer) for a
   *  deleted login id keeps resolving as that id (see userIdFromCookie's
   *  disabled-check, which only denies an *existing* disabled account, not
   *  one that's gone entirely) up to its normal TTL. Recreating an account
   *  with the same login id would then silently inherit that dangling
   *  session — a different logical account, same row key, no re-login. */
  deleteSessionsForUser(userId: string): void {
    this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }

  cleanupExpired(): void {
    this.db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
  }

  // ── Asset overrides (characters, furniture, floors, walls, pets) ─
  // Edited/added assets, keyed by (type, name). The bundled files are the
  // read-only defaults; a row here overrides (or adds) one asset.
  //
  // Character-shaped art (character, pet, playerAvatar) is STORED as a PNG sheet and
  // handed out as SpriteData: packed on write, unpacked on read, so no caller had to
  // learn about images and the table stopped holding 77 KB of hex per avatar. Legacy
  // rows pass through untouched — see art/artStore.ts. `assetRow` is the way to see
  // what is actually stored (artApi streams the bytes rather than re-encoding them).
  listAssets(type: string): Array<{ name: string; data: unknown }> {
    const rows = this.db
      .prepare('SELECT name, data FROM assets WHERE type = ?')
      .all(type) as Array<{ name: string; data: string }>;
    const out: Array<{ name: string; data: unknown }> = [];
    for (const r of rows) {
      try {
        const parsed = JSON.parse(r.data);
        out.push({ name: r.name, data: isPackedArtType(type) ? unpackArt(parsed) : parsed });
      } catch {
        /* skip corrupt row */
      }
    }
    return out;
  }

  getAsset<T>(type: string, name: string): T | undefined {
    const row = this.assetRow(type, name);
    if (row === undefined) return undefined;
    return (isPackedArtType(type) ? unpackArt(row) : row) as T;
  }

  /** The stored row, exactly as it is on disk (packed art stays packed). */
  assetRow(type: string, name: string): unknown {
    const r = this.db
      .prepare('SELECT data FROM assets WHERE type = ? AND name = ?')
      .get(type, name) as { data: string } | undefined;
    if (!r) return undefined;
    try {
      return JSON.parse(r.data);
    } catch {
      return undefined;
    }
  }

  saveAsset(type: string, name: string, data: unknown): void {
    const stored = isPackedArtType(type) ? packArt(type, data) : data;
    this.db
      .prepare(
        'INSERT INTO assets(type,name,data,updatedAt) VALUES(?,?,?,?) ' +
          'ON CONFLICT(type,name) DO UPDATE SET data=excluded.data, updatedAt=excluded.updatedAt',
      )
      .run(type, name, JSON.stringify(stored), Date.now());
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

  // ── Per-user viewer preferences (sound / labels / volume / windowing) ──
  // These are personal, not global: keyed by userId so one viewer can never
  // change another viewer's (or a server-wide) setting.
  getViewerSettings(userId: string): ViewerSettings {
    const all = this.getSetting<Record<string, Partial<ViewerSettings>>>('viewerSettings', {});
    const s = all[userId] ?? {};
    const d = VIEWER_SETTING_DEFAULTS;
    return {
      soundEnabled: s.soundEnabled ?? d.soundEnabled,
      alwaysShowLabels: s.alwaysShowLabels ?? d.alwaysShowLabels,
      alertVolume: typeof s.alertVolume === 'number' ? s.alertVolume : d.alertVolume,
      cameraFollow: s.cameraFollow ?? d.cameraFollow,
      iframeOverlay: s.iframeOverlay ?? d.iframeOverlay,
    };
  }
  setViewerSetting(
    userId: string,
    key: keyof ViewerSettings,
    value: boolean | number,
  ): void {
    if (!userId) return;
    const all = this.getSetting<Record<string, Record<string, unknown>>>('viewerSettings', {});
    all[userId] = { ...(all[userId] ?? {}), [key]: value };
    this.setSetting('viewerSettings', all);
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

  // ── Per-user player spot (per zone), to resume where they left off ──
  /**
   * Where a user last was in a zone and what they were doing, or null.
   *
   * Validated rather than trusted, field by field: an entry of `{}` (which is
   * what a write with undefined coordinates leaves behind, since JSON.stringify
   * drops those keys) used to come back as a truthy "position" and then blow up
   * the join. Anything that isn't a pair of integers counts as "nothing stored" —
   * you spawn at the zone's arrival point, exactly like a first-time visitor. The
   * rest of the spot is optional and is dropped individually, so a stored blob
   * from an older build (which held only `{col,row}`) still resumes the position
   * it does have.
   */
  getPlayerSpot(userId: string, zone: string): PlayerSpot | null {
    const all = this.getSetting<Record<string, unknown>>('playerPos', {});
    const raw = all[`${userId}|${zone}`];
    if (!raw || typeof raw !== 'object') return null;
    const { col, row, dir, pointId, sit, afk } = raw as Record<string, unknown>;
    if (!Number.isInteger(col) || !Number.isInteger(row)) return null;
    return {
      col: col as number,
      row: row as number,
      dir: isDirection(dir) ? dir : Direction.DOWN,
      // Bounded because it is looked up in the points map and would otherwise be
      // an unbounded string from disk; a real point uid is a furniture uid plus a
      // short suffix.
      ...(typeof pointId === 'string' && pointId.length > 0 && pointId.length <= 128
        ? { pointId }
        : {}),
      ...(sit === true ? { sit: true } : {}),
      ...(afk === true ? { afk: true } : {}),
    };
  }
  /** Remember where a player left off. A non-tile is not stored at all — writing
   *  it is what produced the `{}` entry above. */
  setPlayerSpot(userId: string, zone: string, spot: PlayerSpot): void {
    if (!Number.isInteger(spot.col) || !Number.isInteger(spot.row)) return;
    const all = this.getSetting<Record<string, PlayerSpot>>('playerPos', {});
    all[`${userId}|${zone}`] = spot;
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

/** Whether a value off disk is one of the four Direction constants. */
function isDirection(value: unknown): value is Direction {
  return value === Direction.DOWN || value === Direction.LEFT || value === Direction.RIGHT || value === Direction.UP;
}

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
