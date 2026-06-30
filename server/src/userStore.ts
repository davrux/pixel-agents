/**
 * User accounts: the central identity for players. Each user has a stable
 * lowercase login id (`user_id`, the owner key everything per-user is stored
 * under — agents resolve to it via their token), an optional free display `username`
 * (falls back to the login id), a password (scrypt; `pw_algo` records the scheme
 * so we can switch later), an `is_admin` flag (set once, stays), and a per-user
 * `agent_token` their Claude agents authenticate the feed with.
 */
import * as crypto from 'node:crypto';

import { db } from './db.js';

export const MIN_PASSWORD_LEN = 6;

export interface User {
  userId: string;
  /** Free display name; empty → display falls back to the login id. */
  username: string;
  isAdmin: boolean;
  agentToken: string;
  hasPassword: boolean;
}

interface UserRow {
  user_id: string;
  username: string | null;
  pw_hash: string | null;
  pw_algo: string | null;
  is_admin: number;
  agent_token: string;
  created_at: number;
}

// scrypt cost parameters (memory ≈ 128·N·r ≈ 16 MB, well within the default cap).
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 } as const;

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

/** Verify a password against a self-describing `scrypt$N$r$p$salt$hash` string. */
function verifyHash(stored: string | null, password: string): boolean {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts[0] !== 'scrypt' || parts.length !== 6) return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64');
  let actual: Buffer;
  try {
    actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
    });
  } catch {
    return false;
  }
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

/** Normalise a raw login id to its canonical key: lowercase, printable ASCII,
 *  ≤32 chars. "Meik" and "meik" collapse to the same user. */
export function normalizeLoginId(raw: unknown): string {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^\x21-\x7e]/g, '')
    .slice(0, 32);
}

/** Whether a password meets the minimum policy (length only, for now). */
export function isValidPassword(password: unknown): password is string {
  return typeof password === 'string' && password.length >= MIN_PASSWORD_LEN;
}

class UserStore {
  private readonly db = db;

  constructor() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        user_id TEXT PRIMARY KEY,
        username TEXT,
        pw_hash TEXT,
        pw_algo TEXT,
        is_admin INTEGER NOT NULL DEFAULT 0,
        agent_token TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS users_agent_token ON users(agent_token);
    `);
  }

  private toUser(r: UserRow): User {
    return {
      userId: r.user_id,
      username: r.username ?? '',
      isAdmin: r.is_admin !== 0,
      agentToken: r.agent_token,
      hasPassword: !!r.pw_hash,
    };
  }

  /** Display name for a user (free username, else the login id). */
  static displayName(u: User): string {
    return u.username || u.userId;
  }

  private row(userId: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE user_id = ?').get(userId) as UserRow | undefined;
  }

  get(loginId: string): User | undefined {
    const r = this.row(normalizeLoginId(loginId));
    return r ? this.toUser(r) : undefined;
  }

  exists(loginId: string): boolean {
    return this.row(normalizeLoginId(loginId)) !== undefined;
  }

  getByAgentToken(token: string): User | undefined {
    if (!token) return undefined;
    const r = this.db.prepare('SELECT * FROM users WHERE agent_token = ?').get(token) as UserRow | undefined;
    return r ? this.toUser(r) : undefined;
  }

  /** Create a user (factored so a future register page can reuse it). The
   *  caller must have validated the password; throws on a duplicate login id. */
  createUser(loginId: string, password: string, opts: { isAdmin?: boolean } = {}): User {
    const id = normalizeLoginId(loginId);
    if (!id) throw new Error('invalid login id');
    if (this.row(id)) throw new Error('user exists');
    const token = crypto.randomBytes(24).toString('base64url');
    this.db
      .prepare(
        'INSERT INTO users(user_id, username, pw_hash, pw_algo, is_admin, agent_token, created_at) VALUES(?,?,?,?,?,?,?)',
      )
      .run(id, null, hashPassword(password), 'scrypt', opts.isAdmin ? 1 : 0, token, Date.now());
    return this.toUser(this.row(id)!);
  }

  verifyPassword(loginId: string, password: string): boolean {
    const r = this.row(normalizeLoginId(loginId));
    return r ? verifyHash(r.pw_hash, password) : false;
  }

  setPassword(userId: string, password: string): void {
    this.db
      .prepare('UPDATE users SET pw_hash = ?, pw_algo = ? WHERE user_id = ?')
      .run(hashPassword(password), 'scrypt', userId);
  }

  /** Set the free display name: control characters stripped (Unicode letters +
   *  spaces kept), trimmed, ≤32 chars; empty clears it (display falls back to
   *  the login id). Server-side — never trust the client. */
  setUsername(userId: string, username: string): void {
    const name = String(username ?? '')
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
      .trim()
      .slice(0, 32);
    this.db.prepare('UPDATE users SET username = ? WHERE user_id = ?').run(name || null, userId);
  }

  markAdmin(userId: string): void {
    this.db.prepare('UPDATE users SET is_admin = 1 WHERE user_id = ?').run(userId);
  }

  regenerateAgentToken(userId: string): string {
    const token = crypto.randomBytes(24).toString('base64url');
    this.db.prepare('UPDATE users SET agent_token = ? WHERE user_id = ?').run(token, userId);
    return token;
  }
}

/** Process-wide singleton. */
export const userStore = new UserStore();
export { UserStore };
