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
import { userChildDdl } from './schema/tables.js';
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

/** How many non-expired rooms one owner may have outstanding at once — bounds
 *  unbounded table growth from a single (compromised or scripted) account, on
 *  top of the periodic prune sweep below. */
export const MAX_ACTIVE_ROOMS_PER_OWNER = 100;

/** Meeting-room passwords get a higher floor than the generic account password
 *  (userStore.ts MIN_PASSWORD_LEN=6): the link + password pair is typically
 *  handed out over email, an inherently less trusted channel than a login. */
export const MIN_MEETING_ROOM_PASSWORD_LEN = 8;

const PRUNE_INTERVAL_MS = 60 * 60 * 1000; // hourly, same cadence as appStore's session cleanup

export class MeetingRoomStore {
  private readonly db: DatabaseSync;

  constructor() {
    this.db = db;
    this.db.exec(userChildDdl('meeting_rooms'));
    // Sweep long-expired rows on startup and hourly after, so the table never
    // grows unbounded even if nobody ever calls pruneExpired() explicitly.
    this.pruneExpired();
    const t = setInterval(() => this.pruneExpired(), PRUNE_INTERVAL_MS);
    if (typeof t.unref === 'function') t.unref();
  }

  /** Non-expired rooms currently owned by `ownerId` — used to cap creation
   *  (see MAX_ACTIVE_ROOMS_PER_OWNER) so one account can't flood the table. */
  countActiveByOwner(ownerId: string): number {
    const r = this.db
      .prepare('SELECT COUNT(*) AS c FROM meeting_rooms WHERE owner_id = ? AND expires_at > ?')
      .get(ownerId, Date.now()) as { c: number };
    return r.c;
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

  /** Every room, newest first — for the admin overview (server/src/adminApi.ts). */
  listAll(): MeetingRoom[] {
    const rows = this.db
      .prepare('SELECT * FROM meeting_rooms ORDER BY created_at DESC')
      .all() as unknown as MeetingRoomRow[];
    return rows.map((r) => this.toRoom(r));
  }

  /** Every room owned by `ownerId`, newest first — the self-service "your meeting
   *  rooms" list any signed-in user gets from the kiosk (see SimRoom.ts's
   *  meetingRoomList handler), not just admins. */
  listByOwner(ownerId: string): MeetingRoom[] {
    const rows = this.db
      .prepare('SELECT * FROM meeting_rooms WHERE owner_id = ? ORDER BY created_at DESC')
      .all(ownerId) as unknown as MeetingRoomRow[];
    return rows.map((r) => this.toRoom(r));
  }

  /** Delete one room by slug (self-service or admin action — end a room early
   *  instead of waiting out its natural expiry). Idempotent: true only if a row
   *  actually existed. Callers must check ownership themselves for self-service
   *  deletes (see SimRoom.ts's meetingRoomDelete handler); admins may delete any. */
  delete(slug: string): boolean {
    const r = this.db.prepare('DELETE FROM meeting_rooms WHERE slug = ?').run(slug);
    return Number(r.changes) > 0;
  }

  /** Cleanup of long-expired rooms — called on startup and hourly (see the
   *  constructor); exposed for tests. */
  pruneExpired(graceMs = 24 * 60 * 60 * 1000): number {
    const r = this.db.prepare('DELETE FROM meeting_rooms WHERE expires_at < ?').run(Date.now() - graceMs);
    return Number(r.changes);
  }
}

/** Process-wide singleton, same convention as userStore/zoneStore. */
export const meetingRoomStore = new MeetingRoomStore();
