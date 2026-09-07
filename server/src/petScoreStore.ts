/**
 * Who has won the most pet scuffles, per zone — the tally the leaderboard whiteboard shows.
 *
 * Kept per pet SLOT (`dog_0`, `cat_1`) and not per instance: an instance lives ten minutes and then
 * despawns, so counting one would produce a board of strangers. A slot is what has a name — Emma,
 * Balu, Loui, Daisy, Rudi, Frieda — and the name is resolved for DISPLAY only (see
 * `assetOverrides`), never stored, because a name is presentation and an id is identity.
 *
 * Per ZONE, because a board hangs in a room and a zone chooses which animals live in it. A world
 * total would compare animals that never met.
 *
 * A row rather than a JSON blob in `settings`, and that is a decision this codebase has already
 * paid for once: five per-user blobs lived in one settings object each, and `playerPos` cost
 * 0.016 ms per write at thirteen entries and **5.3 ms at ten thousand**, because every write parsed
 * and rewrote the whole thing. One row by primary key is 0.004 ms at any size (AGENTS.md § Memory).
 *
 * No foreign key to `zones`, following `zone_admins` and `zone_acl`: zone-scoped tables in this
 * schema are cleaned by `ZoneStore.delete`, which is where this one is cleaned too. The cascade
 * rule in AGENTS.md is about ACCOUNT data, and there is none here — a tally belongs to a zone and
 * to an animal the world owns, not to a person.
 */
import { db } from './db.js';

export interface PetScore {
  /** The pet slot: `dog_0`, `cat_1`, … — the id, not the display name. */
  pet: string;
  wins: number;
  losses: number;
}

db.exec(`
  CREATE TABLE IF NOT EXISTS pet_scores (
    zone_id TEXT NOT NULL,
    pet TEXT NOT NULL,
    wins INTEGER NOT NULL DEFAULT 0,
    losses INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (zone_id, pet)
  )
`);

/**
 * Record one finished fight.
 *
 * An upsert per side, so the first fight of a slot creates its row. Two statements rather than one
 * clever one: the winner and the loser are different animals and, when a slot somehow fights
 * itself, the row would need both columns bumped — which `ON CONFLICT` handles per statement and
 * would silently drop in a combined one.
 */
const bump = db.prepare(`
  INSERT INTO pet_scores (zone_id, pet, wins, losses) VALUES (?, ?, ?, ?)
  ON CONFLICT (zone_id, pet) DO UPDATE SET wins = wins + excluded.wins, losses = losses + excluded.losses
`);

export const petScoreStore = {
  record(zoneId: string, winner: string, loser: string): void {
    if (!zoneId || !winner || !loser) return;
    bump.run(zoneId, winner, 1, 0);
    bump.run(zoneId, loser, 0, 1);
  },

  /** The board, best first. Ties go to the animal with fewer losses, then by name, so the order is
   *  stable between two reads of the same numbers. */
  table(zoneId: string): PetScore[] {
    const rows = db
      .prepare('SELECT pet, wins, losses FROM pet_scores WHERE zone_id = ? ORDER BY wins DESC, losses ASC, pet ASC')
      .all(zoneId) as Array<{ pet: string; wins: number; losses: number }>;
    return rows.map((r) => ({ pet: r.pet, wins: r.wins, losses: r.losses }));
  },

  /** Everything this zone has recorded, dropped with the zone (see ZoneStore.delete). */
  clearZone(zoneId: string): void {
    db.prepare('DELETE FROM pet_scores WHERE zone_id = ?').run(zoneId);
  },
};
