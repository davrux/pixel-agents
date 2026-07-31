/**
 * User accounts: the central identity for players. Each user has a stable
 * lowercase login id (`user_id`, the owner key everything per-user is stored
 * under — agents resolve to it via their token), an optional free display `username`
 * (falls back to the login id), a password (scrypt; `pw_algo` records the scheme
 * so we can switch later), an `is_admin` flag (set once, stays), and a per-user
 * `agent_token` their Claude agents authenticate the feed with.
 */
import * as crypto from 'node:crypto';

import { cleanName } from '@pixel/shared';

import { db } from './db.js';
import { hashPassword, verifyHash } from './pwhash.js';

export const MIN_PASSWORD_LEN = 6;
/** Upper bound so a huge password can't turn scrypt into a CPU DoS. */
export const MAX_PASSWORD_LEN = 128;

/**
 * Account role, which decides what a user may do:
 * - `admin` — full control (user management, any zone, any monitor).
 * - `user`  — may create + edit their OWN Pixels rooms.
 */
export type Role = 'admin' | 'user';
export const ROLES: readonly Role[] = ['admin', 'user'];
export function isRole(v: unknown): v is Role {
  return typeof v === 'string' && (ROLES as readonly string[]).includes(v);
}

export interface User {
  userId: string;
  /** Free display name; empty → display falls back to the login id. */
  username: string;
  role: Role;
  /** Convenience mirror of `role === 'admin'` (kept in sync in the DB). */
  isAdmin: boolean;
  agentToken: string;
  hasPassword: boolean;
  /** Suspended by an admin: can't log in and any existing session dies
   *  immediately (see auth.ts). A softer alternative to deleting the account —
   *  their data (avatar, meeting rooms, …) stays put and comes back on re-enable. */
  disabled: boolean;
}

interface UserRow {
  user_id: string;
  username: string | null;
  pw_hash: string | null;
  pw_algo: string | null;
  is_admin: number;
  role: string | null;
  agent_token: string;
  created_at: number;
  disabled: number;
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

/** Whether a password meets the policy: a string of MIN..MAX length. */
export function isValidPassword(password: unknown): password is string {
  return typeof password === 'string' && password.length >= MIN_PASSWORD_LEN && password.length <= MAX_PASSWORD_LEN;
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
    // Migration: add the role column and backfill from the legacy is_admin flag
    // (admins → 'admin', everyone else → 'user').
    const cols = this.db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'role')) {
      this.db.exec('ALTER TABLE users ADD COLUMN role TEXT');
      this.db.exec("UPDATE users SET role = CASE WHEN is_admin != 0 THEN 'admin' ELSE 'user' END WHERE role IS NULL");
    }
    if (!cols.some((c) => c.name === 'disabled')) {
      this.db.exec('ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0');
    }
  }

  private toUser(r: UserRow): User {
    const role: Role = isRole(r.role) ? r.role : r.is_admin !== 0 ? 'admin' : 'user';
    return {
      userId: r.user_id,
      username: r.username ?? '',
      role,
      isAdmin: role === 'admin',
      agentToken: r.agent_token,
      hasPassword: !!r.pw_hash,
      disabled: !!r.disabled,
    };
  }

  /** Number of admin accounts — used to protect the last admin from deletion/demotion. */
  adminCount(): number {
    const r = this.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' OR is_admin != 0").get() as { n: number };
    return Number(r.n);
  }

  /** Admins who aren't disabled — used to protect the last *usable* admin from
   *  being suspended (unlike adminCount(), a disabled admin doesn't count). */
  enabledAdminCount(): number {
    const r = this.db
      .prepare("SELECT COUNT(*) AS n FROM users WHERE (role = 'admin' OR is_admin != 0) AND disabled = 0")
      .get() as { n: number };
    return Number(r.n);
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

  /** All accounts, ordered by login id (for /users all). */
  list(): User[] {
    const rows = this.db.prepare('SELECT * FROM users ORDER BY user_id').all() as unknown as UserRow[];
    return rows.map((r) => this.toUser(r));
  }

  getByAgentToken(token: string): User | undefined {
    if (!token) return undefined;
    const r = this.db.prepare('SELECT * FROM users WHERE agent_token = ?').get(token) as UserRow | undefined;
    return r ? this.toUser(r) : undefined;
  }

  /** Create a user (factored so a future register page can reuse it). The
   *  caller must have validated the password; throws on a duplicate login id. */
  createUser(loginId: string, password: string, opts: { isAdmin?: boolean; role?: Role } = {}): User {
    const id = normalizeLoginId(loginId);
    if (!id) throw new Error('invalid login id');
    if (this.row(id)) throw new Error('user exists');
    const role: Role = opts.role ?? (opts.isAdmin ? 'admin' : 'user');
    const token = crypto.randomBytes(24).toString('base64url');
    this.db
      .prepare('INSERT INTO users(user_id, username, pw_hash, pw_algo, is_admin, role, agent_token, created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(id, null, hashPassword(password), 'scrypt', role === 'admin' ? 1 : 0, role, token, Date.now());
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

  /** Set the free display name: non-whitespace control characters stripped,
   *  any remaining whitespace run (tabs, newlines, non-breaking spaces, …)
   *  collapsed to one plain space (cleanName — same rule as zone labels),
   *  trimmed, ≤32 chars; empty clears it (display falls back to the login id).
   *  Server-side — never trust the client. */
  setUsername(userId: string, username: string): void {
    const stripped = String(username ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '');
    const name = cleanName(stripped, 32);
    this.db.prepare('UPDATE users SET username = ? WHERE user_id = ?').run(name || null, userId);
  }

  markAdmin(userId: string): void {
    this.setAdmin(userId, true);
  }
  setAdmin(userId: string, on: boolean): void {
    this.setRole(userId, on ? 'admin' : 'user');
  }

  /** Set a user's role (keeps the legacy is_admin flag in sync). Takes effect on
   *  the user's next login for anything resolved at join time. */
  setRole(userId: string, role: Role): void {
    this.db.prepare('UPDATE users SET role = ?, is_admin = ? WHERE user_id = ?').run(role, role === 'admin' ? 1 : 0, userId);
  }

  /** Suspend/restore an account (see User.disabled). Takes effect immediately —
   *  auth.ts checks this on every session resolution, not just at login. */
  setDisabled(userId: string, on: boolean): void {
    this.db.prepare('UPDATE users SET disabled = ? WHERE user_id = ?').run(on ? 1 : 0, userId);
  }

  /** Delete a user row. Returns true if it existed. (Caller cleans up the user's
   *  avatar/prefs/zone-admin rows.) */
  deleteUser(userId: string): boolean {
    const r = this.db.prepare('DELETE FROM users WHERE user_id = ?').run(userId);
    return Number(r.changes) > 0;
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
