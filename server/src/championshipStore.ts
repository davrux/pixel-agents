/**
 * The season table: who has scored what, per zone.
 *
 * Per ACCOUNT and per zone, which is the shape every other tally here has — a board hangs in a
 * room, and a zone chooses what it is. Keyed by `user_id` with a cascade, because unlike the
 * track records (which are a fact about the track and may be held by a computer driver) this is
 * personal data: delete the account and the season entry goes with it, which is the rule in
 * AGENTS.md § Memory and the one `userDataCascade.int.test.ts` enforces.
 */
import { db } from './db.js';
import { bySeason, type StandingRow } from '@pixel/shared/office/race/championship.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS race_points (
    zone_id TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    points INTEGER NOT NULL DEFAULT 0,
    starts INTEGER NOT NULL DEFAULT 0,
    wins INTEGER NOT NULL DEFAULT 0,
    best_place INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (zone_id, user_id)
  )
`);

/**
 * Record one finish. `place` is 1-based; 0 means they did not finish and scores nothing.
 *
 * An upsert, so a driver's first race creates their row. `best_place` keeps the SMALLEST non-zero
 * place, which needs the `MIN` to skip zero — otherwise a single retirement would reset somebody's
 * best finish of the season to "none".
 */
export function scoreFinish(zoneId: string, userId: string, place: number, points: number): void {
  if (!userId) return;
  db.prepare(
    `INSERT INTO race_points (zone_id, user_id, points, starts, wins, best_place)
     VALUES (?, ?, ?, 1, ?, ?)
     ON CONFLICT(zone_id, user_id) DO UPDATE SET
       points = race_points.points + excluded.points,
       starts = race_points.starts + 1,
       wins = race_points.wins + excluded.wins,
       best_place = CASE
         WHEN excluded.best_place = 0 THEN race_points.best_place
         WHEN race_points.best_place = 0 THEN excluded.best_place
         ELSE MIN(race_points.best_place, excluded.best_place)
       END`,
  ).run(zoneId, userId, points, place === 1 ? 1 : 0, place > 0 ? place : 0);
}

/** The season table for a zone, in order. Names are resolved by the caller, which has the store. */
export function seasonTable(zoneId: string): StandingRow[] {
  const rows = db
    .prepare('SELECT user_id, points, starts, wins, best_place FROM race_points WHERE zone_id = ?')
    .all(zoneId) as Array<{ user_id: string; points: number; starts: number; wins: number; best_place: number }>;
  return rows
    .map((r) => ({
      userId: r.user_id,
      name: r.user_id,
      points: r.points,
      starts: r.starts,
      wins: r.wins,
      bestPlace: r.best_place,
    }))
    .sort(bySeason);
}

/** Wipe a zone's season — the delete path, and `/race reset` for whoever owns the zone. */
export function clearSeason(zoneId: string): void {
  db.prepare('DELETE FROM race_points WHERE zone_id = ?').run(zoneId);
}
