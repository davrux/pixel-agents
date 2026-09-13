/**
 * A track's records: the fastest lap and the fastest race, per zone and per lap count.
 *
 * A time with nothing to beat is a stopwatch, which is what a race without records is — Dust
 * Racing keeps them per track AND per lap count, and so does this: a three-lap record has nothing
 * to say about a five-lap one, so they cannot share a row.
 *
 * Its own table rather than a blob in `settings`, following `pet_scores` for the same two reasons:
 * one row by primary key costs 0.004 ms at any size where a JSON object is re-parsed and rewritten
 * whole, and this is written from the simulation's thread. No foreign key to `zones` — that is the
 * rule for ACCOUNT data, not for per-zone tallies — so `ZoneStore.delete` clears it, exactly as it
 * clears the pet scores.
 *
 * The holder is stored as a NAME and not as a user id, deliberately: a computer driver can hold a
 * record, a guest account may be deleted, and what a board needs to show is who did it.
 */
import { db } from './db.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS race_records (
    zone_id TEXT NOT NULL,
    laps INTEGER NOT NULL,
    kind TEXT NOT NULL,
    ms INTEGER NOT NULL,
    holder TEXT NOT NULL DEFAULT '',
    at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (zone_id, laps, kind)
  )
`);

export type RaceRecordKind = 'lap' | 'race';

export interface RaceRecords {
  lapMs: number;
  lapBy: string;
  raceMs: number;
  raceBy: string;
}

const EMPTY: RaceRecords = { lapMs: 0, lapBy: '', raceMs: 0, raceBy: '' };

/** What stands for this track at this lap count. Zeroes when nobody has set one. */
export function raceRecords(zoneId: string, laps: number): RaceRecords {
  const rows = db
    .prepare('SELECT kind, ms, holder FROM race_records WHERE zone_id = ? AND laps = ?')
    .all(zoneId, laps) as Array<{ kind: string; ms: number; holder: string }>;
  const out = { ...EMPTY };
  for (const r of rows) {
    if (r.kind === 'lap') {
      out.lapMs = r.ms;
      out.lapBy = r.holder;
    } else if (r.kind === 'race') {
      out.raceMs = r.ms;
      out.raceBy = r.holder;
    }
  }
  return out;
}

/**
 * Store a time if it beats what is there. Returns true when it did.
 *
 * The comparison is in SQL rather than read-then-write: two races in two zones of one process
 * share this connection, and a record is exactly the kind of value that a lost update makes
 * nonsense of.
 */
export function offerRecord(zoneId: string, laps: number, kind: RaceRecordKind, ms: number, holder: string): boolean {
  if (!Number.isFinite(ms) || ms <= 0) return false;
  const clean = holder.slice(0, 64);
  const result = db
    .prepare(
      `INSERT INTO race_records (zone_id, laps, kind, ms, holder, at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(zone_id, laps, kind) DO UPDATE SET ms = excluded.ms, holder = excluded.holder, at = excluded.at
       WHERE excluded.ms < race_records.ms`,
    )
    .run(zoneId, laps, kind, Math.round(ms), clean, Date.now());
  return result.changes > 0;
}

/** Every record a zone holds — for a board, and for the delete path. */
export function clearRaceRecords(zoneId: string): void {
  db.prepare('DELETE FROM race_records WHERE zone_id = ?').run(zoneId);
}
