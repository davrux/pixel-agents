/**
 * Points: what makes a second race matter.
 *
 * A race you win and then forget is a demo of a race. Dust Racing keeps best positions per track
 * and unlocks the next one; this keeps the same idea in the shape this world already has — a
 * table per account, per zone — and adds the one thing that turns a set of results into a season:
 * a points score you can lose.
 *
 * Two decisions worth stating, because both could plausibly have gone the other way:
 *
 *  - **Points are scored for a FINISH, not for a start.** Somebody who leaves after the lights
 *    scores nothing, and somebody who limps home last scores one. That is the right way round: a
 *    championship that pays for entering rewards being present rather than driving.
 *  - **Only people score.** A computer driver takes a place on the board — it has to, or the
 *    places a person beat would be meaningless — but it carries no points anywhere, because it is
 *    scenery with a name and a season table of scenery is a list nobody reads.
 */

/**
 * Points per finishing position, first to last.
 *
 * Formula One's modern top ten, which is the one most people can read without a legend, and it
 * has the property a table wants: the gap at the front is worth more than the gap at the back, so
 * a win is worth chasing and eleventh is still worth finishing.
 */
export const POINTS: readonly number[] = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];

/** What a place is worth. Places past the table score nothing, and so does place 0 (unfinished). */
export function pointsFor(place: number): number {
  if (place < 1) return 0;
  return POINTS[place - 1] ?? 0;
}

/** One driver's season, as a board shows it. */
export interface StandingRow {
  userId: string;
  name: string;
  points: number;
  starts: number;
  wins: number;
  bestPlace: number;
}

/** Sort a season table the way everybody expects: points, then wins, then best finish. */
export function bySeason(a: StandingRow, b: StandingRow): number {
  if (b.points !== a.points) return b.points - a.points;
  if (b.wins !== a.wins) return b.wins - a.wins;
  return (a.bestPlace || 99) - (b.bestPlace || 99);
}
