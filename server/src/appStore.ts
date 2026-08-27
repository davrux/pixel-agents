/**
 * SQLite-backed sessions + settings (Node's built-in `node:sqlite`).
 *
 * Sessions survive a server restart and carry the viewer's chosen username
 * (used to play task sounds only for that viewer's own agents). Expired sessions
 * are purged on startup and on an interval so the table never grows unbounded.
 */
import * as crypto from 'node:crypto';
import type { StatementSync } from 'node:sqlite';
import { isPackedArtType, packArt, unpackArt } from './art/artStore.js';

import { Direction, type PlayerSpot } from '@pixel/shared/office/types.js';

import { db } from './db.js';
import { PREF_KINDS, userChildDdl } from './schema/tables.js';
import { migrateUserBlobs } from './schema/migrateUserBlobs.js';

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
  /**
   * Prepared once, because these five run on the paths that must not scale with the world: a
   * join reads a spot and a pinned skin, and the tick's spot checkpoint writes one row every five
   * seconds per moving player. Preparing inside the call would recompile the statement each time.
   * Safe to hold: the foreign-key migration that rebuilds tables runs in `db.ts`, before this
   * constructor, so none of these can be left pointing at a dropped table.
   */
  private readonly prefGet: StatementSync;
  private readonly prefPut: StatementSync;
  private readonly prefDel: StatementSync;
  private readonly spotGet: StatementSync;
  private readonly spotPut: StatementSync;

  constructor() {
    // Sessions are keyed by user_id now (password auth replaced the free-text
    // username login); a legacy username-based table is just dropped — those
    // sessions are invalid under the new model and re-login is required.
    const cols = this.db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
    if (cols.some((c) => c.name === 'username') && !cols.some((c) => c.name === 'user_id')) {
      this.db.exec('DROP TABLE sessions');
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings ( key TEXT PRIMARY KEY, value TEXT NOT NULL );
      CREATE TABLE IF NOT EXISTS assets (
        type TEXT NOT NULL, name TEXT NOT NULL, data TEXT NOT NULL, updatedAt INTEGER NOT NULL,
        -- Character-shaped art keeps its sheet HERE, not inside the data column. See splitArt
        -- below; an existing database gets this column from schema/movePngToBlob.ts.
        png BLOB,
        PRIMARY KEY (type, name)
      );
    `);
    // The three account-owned tables this store writes. Their DDL is shared with the migration
    // that adds the cascade to an older database (schema/tables.ts), so the constraint cannot be
    // present on a fresh world and missing on an upgraded one.
    this.db.exec(userChildDdl('sessions'));
    this.db.exec(userChildDdl('player_pos'));
    this.db.exec(userChildDdl('user_prefs'));
    // Then the one-time move of the per-user settings BLOBS into those tables.
    migrateUserBlobs(this.db);

    this.prefGet = this.db.prepare('SELECT value FROM user_prefs WHERE user_id = ? AND kind = ?');
    this.prefPut = this.db.prepare(
      `INSERT INTO user_prefs(user_id, kind, value) VALUES(?, ?, ?)
         ON CONFLICT(user_id, kind) DO UPDATE SET value = excluded.value`,
    );
    this.prefDel = this.db.prepare('DELETE FROM user_prefs WHERE user_id = ? AND kind = ?');
    this.spotGet = this.db.prepare('SELECT col, row, dir, point_id, sit, afk FROM player_pos WHERE user_id = ? AND zone = ?');
    this.spotPut = this.db.prepare(
      `INSERT INTO player_pos(user_id, zone, col, row, dir, point_id, sit, afk, updated_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, zone) DO UPDATE SET
           col = excluded.col, row = excluded.row, dir = excluded.dir, point_id = excluded.point_id,
           sit = excluded.sit, afk = excluded.afk, updated_at = excluded.updated_at`,
    );
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
      .prepare('SELECT name, data, png FROM assets WHERE type = ?')
      .all(type) as Array<{ name: string; data: string; png: Uint8Array | null }>;
    const out: Array<{ name: string; data: unknown }> = [];
    for (const r of rows) {
      try {
        const parsed = joinArt(JSON.parse(r.data), r.png);
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

  /** The stored row, exactly as it is on disk (packed art stays packed, its sheet a Buffer). */
  assetRow(type: string, name: string): unknown {
    const r = this.db
      .prepare('SELECT data, png FROM assets WHERE type = ? AND name = ?')
      .get(type, name) as { data: string; png: Uint8Array | null } | undefined;
    if (!r) return undefined;
    try {
      return joinArt(JSON.parse(r.data), r.png);
    } catch {
      return undefined;
    }
  }

  saveAsset(type: string, name: string, data: unknown): void {
    const stored = isPackedArtType(type) ? packArt(type, data) : data;
    const { meta, png } = splitArt(stored);
    this.db
      .prepare(
        'INSERT INTO assets(type,name,data,updatedAt,png) VALUES(?,?,?,?,?) ' +
          'ON CONFLICT(type,name) DO UPDATE SET data=excluded.data, updatedAt=excluded.updatedAt, png=excluded.png',
      )
      .run(type, name, JSON.stringify(meta), Date.now(), png);
  }

  /** Revert an asset to its bundled default. Returns true if a row was removed. */
  deleteAsset(type: string, name: string): boolean {
    const r = this.db.prepare('DELETE FROM assets WHERE type = ? AND name = ?').run(type, name);
    return Number(r.changes) > 0;
  }

  // ── Per-user preferences ────────────────────────────────────────
  // One row per (user, kind) in `user_prefs`, not a JSON blob per kind in `settings`. The blobs
  // were read and rewritten WHOLE on every access: measured 2026-08-27, 0.016 ms per write at
  // thirteen stored users and 5.3 ms at ten thousand, on the thread the simulation ticks on. And
  // nothing ever removed an entry, so they only grew. Now the row is found by primary key and
  // deleted by the foreign key when the account goes (see schema/tables.ts).

  /** One preference, or undefined. */
  private pref(userId: string, kind: string): string | undefined {
    if (!userId) return undefined;
    return (this.prefGet.get(userId, kind) as { value: string } | undefined)?.value;
  }

  /**
   * Write one preference.
   *
   * A failure is swallowed on purpose, and there is exactly one that can happen: the account was
   * deleted between the message arriving and this write, so the foreign key refuses the row. That
   * is the correct outcome — a preference for a deleted account must not exist — and it must not
   * become an exception inside a message handler.
   */
  private putPref(userId: string, kind: string, value: string): void {
    if (!userId) return;
    try {
      this.prefPut.run(userId, kind, value);
    } catch {
      /* account gone */
    }
  }

  private dropPref(userId: string, kind: string): void {
    if (userId) this.prefDel.run(userId, kind);
  }

  /** Pinned skin per user for their AGENTS (an agent's label is its owner's user id).
   *  Read once when a room starts, to seed the engine's skin prefs. */
  getCharPrefs(): Record<string, string> {
    const rows = this.db
      .prepare('SELECT user_id, value FROM user_prefs WHERE kind = ?')
      .all(PREF_KINDS.charSkin) as Array<{ user_id: string; value: string }>;
    const out: Record<string, string> = {};
    for (const r of rows) out[r.user_id] = r.value;
    return out;
  }
  /** One user's pinned agent skin — the lookup a join needs, without reading everyone's. */
  getCharPref(userId: string): string | null {
    return this.pref(userId, PREF_KINDS.charSkin) ?? null;
  }
  setCharPref(userId: string, skin: string): void {
    this.putPref(userId, PREF_KINDS.charSkin, skin);
  }
  /** Remove a user's pinned skin (e.g. when that character was deleted). */
  clearCharPref(userId: string): void {
    this.dropPref(userId, PREF_KINDS.charSkin);
  }

  /** A user's pinned player-avatar skin, or null. Nothing writes this any more — it is read to
   *  seed a first avatar from a pin made by an older build (see SimRoom.ensurePlayerAvatar). */
  getPlayerPref(userId: string): string | null {
    return this.pref(userId, PREF_KINDS.playerSkin) ?? null;
  }
  /** Unpin a user's player-avatar skin (fall back to a random skin on spawn). */
  clearPlayerPref(userId: string): void {
    this.dropPref(userId, PREF_KINDS.playerSkin);
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
    const s = this.viewerRow(userId);
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
    this.putPref(userId, PREF_KINDS.viewer, JSON.stringify({ ...this.viewerRow(userId), [key]: value }));
  }

  /** The stored object for one viewer, or `{}`. The one preference kind whose value is not a
   *  scalar: five independent switches that a client sets one at a time. */
  private viewerRow(userId: string): Partial<ViewerSettings> {
    const raw = this.pref(userId, PREF_KINDS.viewer);
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Partial<ViewerSettings>) : {};
    } catch {
      return {};
    }
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
    if (!userId) return null;
    const raw = this.spotGet.get(userId, zone) as
      | { col: number; row: number; dir: number; point_id: string | null; sit: number; afk: number }
      | undefined;
    if (!raw) return null;
    if (!Number.isInteger(raw.col) || !Number.isInteger(raw.row)) return null;
    const pointId = raw.point_id;
    return {
      col: raw.col,
      row: raw.row,
      dir: isDirection(raw.dir) ? raw.dir : Direction.DOWN,
      // Bounded because it is looked up in the points map and would otherwise be
      // an unbounded string from disk; a real point uid is a furniture uid plus a
      // short suffix.
      ...(typeof pointId === 'string' && pointId.length > 0 && pointId.length <= 128 ? { pointId } : {}),
      ...(raw.sit ? { sit: true as const } : {}),
      ...(raw.afk ? { afk: true as const } : {}),
    };
  }
  /**
   * Remember where a player left off. A non-tile is not stored at all — writing
   * it is what produced the `{}` entry the reader above still guards against.
   *
   * One row by primary key. This is the hot path of the whole store: `checkpointSpots` calls it
   * every five seconds for every moving player, on the tick thread, which is why it must not
   * depend on how many accounts have ever played. A failure means the account was deleted while
   * they were still standing there — the foreign key then refuses the row, which is right, and
   * the tick must not care.
   */
  setPlayerSpot(userId: string, zone: string, spot: PlayerSpot): void {
    if (!userId || !Number.isInteger(spot.col) || !Number.isInteger(spot.row)) return;
    try {
      this.spotPut.run(
        userId,
        zone,
        spot.col,
        spot.row,
        spot.dir,
        spot.pointId ?? null,
        spot.sit ? 1 : 0,
        spot.afk ? 1 : 0,
        Date.now(),
      );
    } catch {
      /* account gone */
    }
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

/**
 * The two halves of a stored art row: the metadata that belongs in JSON, and the sheet that does
 * not.
 *
 * A sheet used to be a base64 field inside `data`, which meant every read parsed the pixels as a
 * string and every write encoded them into one — pure packaging for a packaging that was not
 * needed. Measured on char_0: 4 041 stored bytes became 3 063 (−24 %), a read that needs the bytes
 * went 3.64 → 1.06 µs and a write 3.08 → 0.50 µs, because `JSON.parse` now sees 164 bytes instead
 * of 4 KB. None of those paths is hot — the merged bundle is cached process-wide and `/art/...` is
 * served with an immutable ETag — so this is a storage and data-model change, not a speed fix.
 *
 * Everything else (`gallery`, NPC config, anything a future type stores) has no `png` and travels
 * exactly as before, which is why this lives here rather than in a branch per asset type.
 */
function splitArt(stored: unknown): { meta: unknown; png: Uint8Array | null } {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return { meta: stored, png: null };
  const { png, ...meta } = stored as Record<string, unknown>;
  if (Buffer.isBuffer(png)) return { meta, png };
  // A base64 string can still arrive from an older caller or a restored row; store the bytes.
  if (typeof png === 'string' && png.length > 0) return { meta, png: Buffer.from(png, 'base64') };
  return { meta: stored, png: null };
}

/** Put the sheet back on the row the way every reader expects to find it. */
function joinArt(meta: unknown, png: Uint8Array | null): unknown {
  if (!png || !meta || typeof meta !== 'object' || Array.isArray(meta)) return meta;
  return { ...(meta as Record<string, unknown>), png: Buffer.from(png.buffer, png.byteOffset, png.byteLength) };
}

/** Whether a value off disk is one of the four Direction constants. */
function isDirection(value: unknown): value is Direction {
  return value === Direction.DOWN || value === Direction.LEFT || value === Direction.RIGHT || value === Direction.UP;
}
