/**
 * Talking objects — furniture that says the hour, by itself, on the hour.
 *
 * The behaviour of the 'talkingObject' Action (see types.ts): a piece carrying
 * it announces the time every full hour, and a speech bubble reading `9:00`
 * appears over it for every viewer at once.
 *
 * ── Why this is server-side, and why it takes `nowMs` ──
 *
 * "It is 9:00" is a DECISION, so it belongs where every other decision in this
 * world is made: the tick loop, one answer for everybody (AGENTS.md invariants
 * 1 and 2). A client that read its own clock instead would give two people
 * standing at the same whale two different worlds — the hour would land at
 * slightly different moments, and a viewer whose machine is an hour off would be
 * told the wrong time by a world that knew better.
 *
 * The clock arrives as an argument rather than being read here, for the same
 * reason the rest of the engine takes `dt`: it is what makes an hour boundary
 * something a test can drive in a millisecond instead of waiting for one.
 *
 * ── What "every full hour" means when nobody is watching ──
 *
 * The room does not tick with no clients in it (see SimRoom.tick), and it is
 * disposed once the last one leaves, so a zone nobody is in has no clock of its
 * own — which is right: an announcement with no audience is not an event. The
 * consequence is stated by `announceDue` below: the first tick after somebody
 * arrives ADOPTS the hour rather than announcing it. Arriving at 9:05 is not
 * being present at 9:00, and a bubble saying `9:00` five minutes late is worse
 * than none — it is wrong. From then on the hour is announced when it turns.
 */
import type { PlacedFurniture } from '../types.js';
import { effectiveAction, entryFor } from '../layout/furnitureCatalog.js';

/** One thing a piece of furniture says, anchored to the placement's own tile —
 *  the same (col, row) anchor every other furniture message uses, so the client
 *  can find the piece it belongs to without a new identity for furniture. */
export interface SpokenLine {
  col: number;
  row: number;
  text: string;
}

/**
 * The hour, as a talking object says it: `9:00`, `14:00`.
 *
 * 24-hour and no leading zero, which is one decision each. No leading zero
 * because that is how the hour reads out loud and how it was asked for; 24-hour
 * because `9:00` twice a day from a statue with no am/pm to show would be the
 * one thing a clock must not be, ambiguous.
 *
 * The zone is the SERVER's, deliberately: this is the world's clock, not the
 * viewer's, and a world where the whale says a different hour to each person
 * standing at it is not one world. (A per-viewer local time would also mean the
 * bubble could not be a broadcast at all.)
 */
export function hourText(nowMs: number): string {
  const at = new Date(nowMs);
  return `${at.getHours()}:00`;
}

/** The moment the hour containing `nowMs` began — the identity of "this hour",
 *  so a DST shift or a year boundary is just another number rather than a
 *  comparison of two calendar fields.
 *
 *  Not `nowMs - (nowMs % 3_600_000)`: that truncates to a UTC hour, and in a zone
 *  offset by a half hour (+05:30 and friends) every announcement would land thirty
 *  minutes early. The minutes are cleared on the LOCAL calendar. */
export function hourStamp(nowMs: number): number {
  const at = new Date(nowMs);
  at.setMinutes(0, 0, 0);
  return at.getTime();
}

/**
 * Whether the hour has turned since `lastStamp`, and the stamp to remember.
 *
 * `lastStamp` is `null` on the very first tick of a room's life, and that case
 * is the whole reason this is a function with a name: it adopts the hour and
 * announces nothing (see the header). Everything after it is a plain
 * "different hour than last time".
 */
export function announceDue(nowMs: number, lastStamp: number | null): { due: boolean; stamp: number } {
  const stamp = hourStamp(nowMs);
  return { due: lastStamp !== null && stamp !== lastStamp, stamp };
}

/** Every placement that is a talking object, in map order — the placements a
 *  chime is spoken by. Reads the placement's effective action, so a mapper can
 *  make any single piece of furniture talk with a per-placement override, the
 *  same way any other action can be overridden. */
export function talkingObjects(furniture: readonly PlacedFurniture[]): PlacedFurniture[] {
  return furniture.filter((f) => effectiveAction(f, entryFor(f))?.kind === 'talkingObject');
}

/** What the talking objects in a layout say when the hour turns: one line each,
 *  all the same text — they are all reading the same clock. */
export function hourChimes(furniture: readonly PlacedFurniture[], nowMs: number): SpokenLine[] {
  const text = hourText(nowMs);
  return talkingObjects(furniture).map((f) => ({ col: f.col, row: f.row, text }));
}
