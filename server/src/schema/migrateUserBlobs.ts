/**
 * Move the per-user settings BLOBS into `player_pos` and `user_prefs`, once.
 *
 * Five things were stored as one JSON object per kind in the `settings` table, keyed inside by
 * user id: `playerPos`, `charPrefs`, `playerPrefs`, `viewerSettings`, `spectatorPrefs`. Every read
 * parsed the whole object and every write rewrote it, which is why this moved — measured on this
 * repo 2026-08-27, a spot write cost 0.016 ms at thirteen entries and 5.3 ms at ten thousand, on
 * the thread the simulation ticks on.
 *
 * Two conversions happen here rather than at read time, which is the other half of the point:
 *
 *  • **The numeric skin index.** A pref written long ago held `3` where it now holds `"char_3"`.
 *    That was converted on EVERY read by a function that never wrote its result back — a
 *    migration that could not finish. It runs once, here, and is then gone.
 *  • **`spectatorPrefs` is dropped, not moved.** Nothing in the repo reads or writes it any more
 *    (checked across every file type): a stored flag no code consults is not data, and carrying it
 *    into a new table would only make it look alive. The count is logged if there was anything.
 *
 * A row whose account no longer exists is skipped — the foreign key on the new tables forbids it,
 * and those are exactly the rows nothing was deleting. The blobs are removed only after their
 * contents are in the new tables, inside the same transaction, so a crash halfway leaves the old
 * shape intact and the migration simply runs again.
 */
import { PREF_KINDS } from './tables.js';

import type { DatabaseSync } from 'node:sqlite';

const MARKER = 'user_blobs_to_tables';

/** The blob keys this consumes. `settings` keeps everything else (voiceNs, arcade defaults, …). */
const BLOB_KEYS = ['playerPos', 'charPrefs', 'playerPrefs', 'viewerSettings', 'spectatorPrefs'] as const;

function readBlob(db: DatabaseSync, key: string): Record<string, unknown> {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  if (!row) return {};
  try {
    const parsed = JSON.parse(row.value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** An old skin pref: a string passes through, an integer N was always the skin named `char_N`,
 *  and junk (the old "-1 = random") is dropped so the user falls back to a diverse skin. */
function skinId(val: unknown): string | null {
  if (typeof val === 'string' && val.length > 0 && val.length <= 64) return val;
  if (typeof val === 'number' && Number.isInteger(val) && val >= 0) return `char_${val}`;
  return null;
}

export function migrateUserBlobs(db: DatabaseSync): void {
  db.exec('CREATE TABLE IF NOT EXISTS _migrations (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  if (db.prepare('SELECT value FROM _migrations WHERE key = ?').get(MARKER)) return;

  const present = BLOB_KEYS.filter((k) => db.prepare('SELECT 1 FROM settings WHERE key = ?').get(k) !== undefined);
  if (present.length === 0) {
    // A fresh world, or one already migrated by hand: record it so this never looks again.
    db.prepare('INSERT OR REPLACE INTO _migrations(key, value) VALUES(?, ?)').run(MARKER, new Date().toISOString());
    return;
  }

  const accounts = new Set(
    (db.prepare('SELECT user_id FROM users').all() as Array<{ user_id: string }>).map((r) => r.user_id),
  );
  const putPref = db.prepare(
    `INSERT INTO user_prefs(user_id, kind, value) VALUES(?, ?, ?)
       ON CONFLICT(user_id, kind) DO UPDATE SET value = excluded.value`,
  );
  const putSpot = db.prepare(
    `INSERT INTO player_pos(user_id, zone, col, row, dir, point_id, sit, afk, updated_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, zone) DO NOTHING`,
  );

  const counts = { prefs: 0, spots: 0, skipped: 0, spectators: 0 };
  const now = Date.now();
  try {
    db.exec('BEGIN');

    for (const [kind, blobKey] of [
      [PREF_KINDS.charSkin, 'charPrefs'],
      [PREF_KINDS.playerSkin, 'playerPrefs'],
    ] as const) {
      for (const [userId, val] of Object.entries(readBlob(db, blobKey))) {
        const skin = skinId(val);
        if (!skin) continue;
        if (!accounts.has(userId)) {
          counts.skipped++;
          continue;
        }
        putPref.run(userId, kind, skin);
        counts.prefs++;
      }
    }

    for (const [userId, val] of Object.entries(readBlob(db, 'viewerSettings'))) {
      if (!val || typeof val !== 'object' || Array.isArray(val)) continue;
      if (!accounts.has(userId)) {
        counts.skipped++;
        continue;
      }
      putPref.run(userId, PREF_KINDS.viewer, JSON.stringify(val));
      counts.prefs++;
    }

    // `${userId}|${zone}` was the key. A user id cannot contain a pipe (normalizeLoginId), so the
    // FIRST pipe splits it; a zone id could not contain one either, but splitting this way means a
    // stray one lands in the zone rather than truncating the account.
    for (const [key, val] of Object.entries(readBlob(db, 'playerPos'))) {
      const cut = key.indexOf('|');
      if (cut <= 0) continue;
      const userId = key.slice(0, cut);
      const zone = key.slice(cut + 1);
      if (!zone || !val || typeof val !== 'object' || Array.isArray(val)) continue;
      const spot = val as Record<string, unknown>;
      // The same validation the reader applied: anything that is not a pair of integers was
      // never a position (a write with undefined coordinates left `{}` behind).
      if (!Number.isInteger(spot.col) || !Number.isInteger(spot.row)) continue;
      if (!accounts.has(userId)) {
        counts.skipped++;
        continue;
      }
      const pointId = typeof spot.pointId === 'string' && spot.pointId.length > 0 && spot.pointId.length <= 128 ? spot.pointId : null;
      putSpot.run(
        userId,
        zone,
        spot.col as number,
        spot.row as number,
        Number.isInteger(spot.dir) ? (spot.dir as number) : 0, // 0 = Direction.DOWN
        pointId,
        spot.sit === true ? 1 : 0,
        spot.afk === true ? 1 : 0,
        now,
      );
      counts.spots++;
    }

    counts.spectators = Object.keys(readBlob(db, 'spectatorPrefs')).length;

    for (const key of present) db.prepare('DELETE FROM settings WHERE key = ?').run(key);
    db.prepare('INSERT OR REPLACE INTO _migrations(key, value) VALUES(?, ?)').run(MARKER, new Date().toISOString());
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* nothing open */
    }
    // The old blobs are untouched, so the server starts and behaves as before — minus the move.
    console.error(`[schema] per-user settings NOT moved into tables: ${(err as Error)?.message}`);
    return;
  }

  console.log(
    `[schema] per-user settings moved out of the settings blobs: ${counts.prefs} preference(s), ${counts.spots} player position(s)` +
      (counts.skipped > 0 ? `, ${counts.skipped} skipped (account no longer exists)` : '') +
      (counts.spectators > 0 ? `, ${counts.spectators} unused spectator flag(s) dropped` : ''),
  );
}
