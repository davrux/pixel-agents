/**
 * Per-user TimeTracking connection details, on the shared SQLite connection
 * (db.ts) like every other store here.
 *
 * One row per pixel-agents user: which TimeTracking server they book against
 * and the login to do it with. The password is sealed (secrets.ts) rather than
 * hashed, because the server has to replay the login — see that file for why.
 * `view()` is the only shape that ever leaves the server: it reports *that* an
 * account is configured and under which name, never the secret.
 */
import { db } from '../db.js';
import { open, seal } from './secrets.js';

export interface TimeTrackingConfig {
  /** Origin of the TimeTracking install, no trailing slash, no `/api` suffix. */
  baseUrl: string;
  username: string;
  password: string;
}

/** What the client is allowed to know about its own configuration. */
export interface TimeTrackingView {
  configured: boolean;
  baseUrl: string;
  username: string;
}

interface Row {
  user_id: string;
  base_url: string;
  username: string;
  secret: string;
  updated_at: number;
}

/**
 * Normalise a user-typed server address to an origin we can safely append API
 * paths to. Returns null for anything that isn't a plain http(s) URL — which
 * also keeps `javascript:`/`file:` and other schemes out of the fetch below.
 *
 * A trailing `/api` is trimmed: the docs write the endpoint as
 * `https://host/api`, so people paste that, and every path we build already
 * starts with `/api`.
 */
export function normalizeBaseUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.trim().length === 0 || raw.length > 300) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const path = url.pathname.replace(/\/+$/, '').replace(/\/api$/i, '');
  return `${url.origin}${path}`;
}

class TimeTrackingStore {
  private readonly db = db;

  constructor() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS timetracking (
        user_id TEXT PRIMARY KEY,
        base_url TEXT NOT NULL,
        username TEXT NOT NULL,
        secret TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  /** Full config including the decrypted password, or null when the user has
   *  none — or when the sealed value can no longer be opened (rotated key), in
   *  which case they are simply treated as unconfigured and asked again. */
  get(userId: string): TimeTrackingConfig | null {
    if (!userId) return null;
    const row = this.db.prepare('SELECT * FROM timetracking WHERE user_id = ?').get(userId) as Row | undefined;
    if (!row) return null;
    const password = open(row.secret);
    if (password === null) return null;
    return { baseUrl: row.base_url, username: row.username, password };
  }

  /** Whether this user has (openable) credentials stored. */
  has(userId: string): boolean {
    return this.get(userId) !== null;
  }

  view(userId: string): TimeTrackingView {
    const cfg = this.get(userId);
    return cfg
      ? { configured: true, baseUrl: cfg.baseUrl, username: cfg.username }
      : { configured: false, baseUrl: '', username: '' };
  }

  set(userId: string, cfg: TimeTrackingConfig): void {
    this.db
      .prepare(
        `INSERT INTO timetracking(user_id, base_url, username, secret, updated_at) VALUES(?,?,?,?,?)
         ON CONFLICT(user_id) DO UPDATE SET
           base_url = excluded.base_url, username = excluded.username,
           secret = excluded.secret, updated_at = excluded.updated_at`,
      )
      .run(userId, cfg.baseUrl, cfg.username, seal(cfg.password), Date.now());
  }

  clear(userId: string): void {
    this.db.prepare('DELETE FROM timetracking WHERE user_id = ?').run(userId);
  }

  /** Every user with a row — the poller intersects this with who is online. */
  userIds(): string[] {
    const rows = this.db.prepare('SELECT user_id FROM timetracking').all() as Array<{ user_id: string }>;
    return rows.map((r) => r.user_id);
  }
}

export const timeTrackingStore = new TimeTrackingStore();
