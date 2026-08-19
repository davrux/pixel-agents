/**
 * Personal avatars whose account is gone.
 *
 * An avatar row (`assets`, type `playerAvatar`) is keyed by the owner's `user_id` and
 * is created on that user's first join. Nothing else can reach it: it is not in the
 * shared gallery, no map places it, and only a signed-in session renders one. So when
 * the account is gone, the row is unreachable by construction.
 *
 * The product path already cleans up — `DELETE /admin/users/:id` and the `/delete`
 * command both call `deletePlayerAvatar` — which is exactly why this is defence rather
 * than a fix: a database restored from an older backup, or one where a row was removed
 * by hand (dev worlds collect this), keeps avatars nobody can log in to. They are not
 * inert: an avatar is the largest per-row asset in the table (~77 KB of sprite data,
 * measured across 40 rows = 3.1 MB).
 *
 * The `users` table is the only evidence, so the guard that matters is refusing to
 * believe an EMPTY or unreadably small one — that would make every avatar an orphan
 * and delete the lot. Same shape as the furniture prune next door: the decision is a
 * pure function, the grace period keeps recent work, and nothing here can stop a boot.
 */
import { db } from '../db.js';

import { ORPHAN_GRACE_DAYS, type StoredAsset } from './orphanAssets.js';

/** Below this, a `users` table is treated as unreadable rather than as empty.
 *  One account is a legitimate world (a fresh deployment with one admin), so the
 *  floor is 1: the case being refused is a table that answered with nothing. */
export const MIN_HEALTHY_USERS = 1;

export interface AvatarPruneDecision {
  /** Set when nothing should be deleted, with the reason to print. */
  refused?: string;
  /** Rows whose owner is gone and which are old enough to touch. */
  deletable: StoredAsset[];
  /** Owner gone, but written too recently to be sure. */
  tooYoung: StoredAsset[];
  /** Owner still exists — kept, whatever their age. */
  owned: StoredAsset[];
}

/**
 * Decide what to delete. Pure: the caller supplies the rows and the account ids, so
 * every branch here is testable without a database.
 */
export function decideAvatarPrune(
  rows: StoredAsset[],
  userIds: Set<string>,
  now = Date.now(),
  graceDays = ORPHAN_GRACE_DAYS,
): AvatarPruneDecision {
  const owned = rows.filter((r) => userIds.has(r.name));
  const orphans = rows.filter((r) => !userIds.has(r.name));
  if (userIds.size < MIN_HEALTHY_USERS) {
    return {
      refused: `the users table lists ${userIds.size} account(s) — it looks unreadable, so no avatar is deleted`,
      deletable: [],
      tooYoung: orphans,
      owned,
    };
  }
  const cutoff = now - graceDays * 24 * 60 * 60 * 1000;
  return {
    deletable: orphans.filter((r) => r.updatedAt > 0 && r.updatedAt < cutoff),
    // A row with no timestamp is not aged out: unknown is not old.
    tooYoung: orphans.filter((r) => !(r.updatedAt > 0 && r.updatedAt < cutoff)),
    owned,
  };
}

/** Every account id, lowercase as stored. */
export function accountIds(): Set<string> {
  const rows = db.prepare('SELECT user_id AS id FROM users').all() as Array<{ id: string }>;
  return new Set(rows.map((r) => r.id));
}
