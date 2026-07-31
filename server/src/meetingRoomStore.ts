/**
 * SQLite-backed ad-hoc meeting rooms — created on the fly by clicking a "Meeting
 * Room Kiosk" furniture item (see SimRoom.ts: the `meetingRoomCreate` handler).
 * Each room has a random unguessable slug (the shareable link), an owner, an
 * expiry, and an optional password (hashed like every other password here, see
 * pwhash.ts). Guests reach it at /meet/<slug> with no pixel-agents account
 * required — see meetingRoomApi.ts, which is the only other reader of this store.
 */
import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { db } from './db.js';
import { hashPassword, verifyHash } from './pwhash.js';

export interface MeetingRoom {
  slug: string;
  ownerId: string;
  label: string;
  createdAt: number;
  expiresAt: number;
  hasPassword: boolean;
}

interface MeetingRoomRow {
  slug: string;
  owner_id: string;
  label: string;
  created_at: number;
  expires_at: number;
  pw_hash: string | null;
}

export class MeetingRoomStore {
  private readonly db: DatabaseSync;

  constructor() {
    this.db = db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meeting_rooms (
        slug TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        label TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        pw_hash TEXT
      );
      CREATE INDEX IF NOT EXISTS meeting_rooms_owner ON meeting_rooms(owner_id);
      CREATE INDEX IF NOT EXISTS meeting_rooms_expires ON meeting_rooms(expires_at);
    `);
  }

  private toRoom(r: MeetingRoomRow): MeetingRoom {
    return {
      slug: r.slug,
      ownerId: r.owner_id,
      label: r.label,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      hasPassword: !!r.pw_hash,
    };
  }

  private row(slug: string): MeetingRoomRow | undefined {
    return this.db.prepare('SELECT * FROM meeting_rooms WHERE slug = ?').get(slug) as MeetingRoomRow | undefined;
  }

  /** Create a new room with a fresh, unguessable slug (128 bits — retried on the
   *  astronomically unlikely collision). `ttlMs` sets the expiry from now. */
  create(ownerId: string, ttlMs: number, opts: { label?: string; password?: string } = {}): MeetingRoom {
    let slug = '';
    for (let i = 0; i < 5 && !slug; i++) {
      const candidate = randomBytes(16).toString('base64url');
      if (!this.row(candidate)) slug = candidate;
    }
    if (!slug) throw new Error('could not allocate a room slug');
    const now = Date.now();
    this.db
      .prepare('INSERT INTO meeting_rooms(slug, owner_id, label, created_at, expires_at, pw_hash) VALUES(?,?,?,?,?,?)')
      .run(slug, ownerId, opts.label ?? '', now, now + ttlMs, opts.password ? hashPassword(opts.password) : null);
    return this.toRoom(this.row(slug)!);
  }

  /** Look up a room by slug — undefined if it never existed. Callers still need
   *  isExpired() themselves (an expired row isn't deleted here, so a "this link
   *  has expired" message can be shown instead of a bare "not found"). */
  get(slug: string): MeetingRoom | undefined {
    const r = this.row(slug);
    return r ? this.toRoom(r) : undefined;
  }

  isExpired(room: MeetingRoom): boolean {
    return Date.now() >= room.expiresAt;
  }

  verifyPassword(slug: string, password: string): boolean {
    const r = this.row(slug);
    if (!r) return false;
    if (!r.pw_hash) return true; // not locked
    return verifyHash(r.pw_hash, password);
  }

  /** Best-effort cleanup of long-expired rooms. Not called on every request —
   *  wire it to an occasional sweep (e.g. on server startup) if desired. */
  pruneExpired(graceMs = 24 * 60 * 60 * 1000): number {
    const r = this.db.prepare('DELETE FROM meeting_rooms WHERE expires_at < ?').run(Date.now() - graceMs);
    return Number(r.changes);
  }
}

/** Process-wide singleton, same convention as userStore/zoneStore. */
export const meetingRoomStore = new MeetingRoomStore();
