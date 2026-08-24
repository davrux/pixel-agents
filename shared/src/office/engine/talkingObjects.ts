/**
 * Talking objects — furniture that speaks by itself: the hour, and quotes.
 *
 * The behaviour of the 'talkingObject' Action (see types.ts): a piece carrying
 * it announces the time every full hour, and a speech bubble reading `9:00`
 * appears over it for every viewer at once. It also says a random line from the
 * world's quote pool at a random moment every 20 to 60 minutes — see
 * QuoteSchedule at the bottom of this file.
 *
 * Both come out of the same tick and travel as the same SpokenLine, so a piece
 * that talks needs no configuration beyond the action: there is no property
 * choosing between the two, because a talking object does both.
 *
 * Every line also lands in the zone's chat log, attributed to the piece — which
 * is why a SpokenLine carries a name it does not need for the bubble. A bubble
 * is a moment you have to be looking at; the log is what somebody who was in
 * the room can still read, and it is where the world's own lines belong next to
 * the players'.
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
  /** Who said it, for the chat log — a bubble needs no name, a transcript does
   *  (see speakerName). Resolved here rather than on the client for the usual
   *  reason: the client has no catalog label for a piece it only knows by tile,
   *  and two viewers must not disagree about what the whale is called. */
  from: string;
}

/**
 * What a talking object is called when it speaks into the chat.
 *
 * The placement's own name first — a mapper who names an object in Tiled has
 * said what it is — then the catalog label the art carries ("Talking Whale"),
 * and only then a generic word. The last case is unreachable from a real map,
 * because every furniture tile carries a label; it exists so a placement of an
 * id no catalog knows says something rather than `undefined:`.
 */
export function speakerName(f: PlacedFurniture): string {
  const named = typeof f.name === 'string' ? f.name.trim() : '';
  return named || entryFor(f)?.label?.trim() || 'Talking object';
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

/** What the talking objects say when the hour turns: one line each, all the
 *  same text — they are all reading the same clock.
 *
 *  Takes the talkers rather than the whole furniture list because the caller
 *  already has them: `talkingObjects` is a scan with an `entryFor` per
 *  placement, and the quote schedule below needs the same list on EVERY tick,
 *  so OfficeState keeps it as derived layout state and both triggers read it.
 *  (Filtering 158 placements 20 times a second would cost about a third of the
 *  whole tick — see AGENTS.md on measuring, and `getCatalogEntry`.) */
export function hourChimes(talkers: readonly PlacedFurniture[], nowMs: number): SpokenLine[] {
  const text = hourText(nowMs);
  return talkers.map((f) => ({ col: f.col, row: f.row, text, from: speakerName(f) }));
}

/* ── Quotes ────────────────────────────────────────────────────────────────
 *
 * The other thing a talking object says. Not the hour: a line out of a pool the
 * repo carries as a text file (assets/quotes/talking-objects.txt), at a random
 * moment inside a 20-to-60-minute window, rolled again after each one.
 *
 * Three decisions worth stating, because each could plausibly have gone the
 * other way:
 *
 *   - The RANDOMNESS is the server's, like the clock. One roll decides both when
 *     and what, and the line is broadcast, so everybody at the whale sees the
 *     same quote at the same moment. A client-side roll would give each viewer
 *     their own whale, which is the same mistake as a client-side clock.
 *   - The SCHEDULE is per placement, keyed by uid. Two whales in a zone drift
 *     apart within the first hour instead of chanting in unison — and unison is
 *     what a shared timer would give, since they would both fire on one tick.
 *   - The POOL is injected, not read from disk here. This module runs in the
 *     engine, which is headless and has no business owning a file path; the
 *     server loads and validates the file (server/src/quotes.ts) and hands the
 *     lines in through OfficeState.setQuotes, the same shape as setNpcDecider.
 */

/** The window a quote waits in. A talking object picks a moment uniformly
 *  inside it, says one line, then rolls again — so "every 20 to 60 minutes"
 *  means each wait is its own draw, not a fixed cadence with jitter. */
export const QUOTE_MIN_MS = 20 * 60_000;
export const QUOTE_MAX_MS = 60 * 60_000;

/** How long to wait before the next quote, from a random number in [0, 1). */
export function quoteDelayMs(rnd: number): number {
  const r = rnd < 0 ? 0 : rnd > 1 ? 1 : rnd;
  return Math.round(QUOTE_MIN_MS + r * (QUOTE_MAX_MS - QUOTE_MIN_MS));
}

/** One line out of the pool, or null when there is nothing to say. The
 *  `length - 1` clamp is for the `rnd() === 1` a hand-written generator can
 *  produce; Math.random never does, and an out-of-range index would be a
 *  bubble reading `undefined`. */
export function pickQuote(quotes: readonly string[], rnd: number): string | null {
  if (quotes.length === 0) return null;
  const i = Math.min(quotes.length - 1, Math.max(0, Math.floor(rnd * quotes.length)));
  return quotes[i];
}

/**
 * When each talking object says its next quote.
 *
 * A class rather than a function because the next moment is STATE, and it is
 * the one piece of talking-object state that is not derivable from the clock:
 * `dueAt` holds one timestamp per placement that talks.
 *
 * The random source is a constructor parameter for the same reason `nowMs` is a
 * parameter of `update`: with `Math.random` the interval is untestable, and
 * "somewhere between 20 and 60 minutes" is exactly the kind of claim that is
 * either verified or merely believed.
 */
export class QuoteSchedule {
  private quotes: readonly string[] = [];
  private rnd: () => number;
  /** uid → the moment this placement says its next quote. Keyed by something
   *  that comes and goes, so `prune` below is not optional — see AGENTS.md
   *  § Memory; a Tiled re-import regenerates every uid. */
  private readonly dueAt = new Map<string, number>();

  constructor(rnd: () => number = Math.random) {
    this.rnd = rnd;
  }

  /** Install the world's quote pool (see the header: the server owns the file).
   *  Safe to call at any time — a pool arriving after the first tick simply
   *  starts the first wait then.
   *
   *  The random source may be replaced with it, and for the same reason `update`
   *  takes `nowMs`: whoever owns the world owns both, and pinning it is the only
   *  way a test can assert "this quote, twenty minutes after that one" through
   *  the real engine rather than through this class in isolation. */
  setQuotes(quotes: readonly string[], rnd?: () => number): void {
    this.quotes = quotes;
    if (rnd) this.rnd = rnd;
  }

  /**
   * The quotes due right now, one line at most per talker.
   *
   * A talker with no schedule yet gets one and says nothing: the first wait is
   * counted from when the room started ticking, so arriving at a whale is never
   * greeted by an instant quote it had been holding.
   *
   * `hourJustChimed` is the collision rule. Both triggers can land on the same
   * tick, and the client keeps ONE bubble per speaker — the second line would
   * silently replace the first, so a quote landing on the hour would eat the
   * announcement. The hour wins (it is the thing that is only true for a
   * moment) and the quote rolls a fresh wait.
   */
  chimes(talkers: readonly PlacedFurniture[], nowMs: number, hourJustChimed: boolean): SpokenLine[] {
    if (this.quotes.length === 0) return [];
    const out: SpokenLine[] = [];
    for (const f of talkers) {
      const due = this.dueAt.get(f.uid);
      if (due === undefined || nowMs < due) {
        if (due === undefined) this.dueAt.set(f.uid, nowMs + quoteDelayMs(this.rnd()));
        continue;
      }
      this.dueAt.set(f.uid, nowMs + quoteDelayMs(this.rnd()));
      if (hourJustChimed) continue;
      const text = pickQuote(this.quotes, this.rnd());
      if (text) out.push({ col: f.col, row: f.row, text, from: speakerName(f) });
    }
    return out;
  }

  /** Forget the placements that are no longer in the map (a layout rebuild, a
   *  Tiled re-import). Bounded by the talkers that exist, not by every talker
   *  the room has ever held. */
  prune(live: ReadonlySet<string>): void {
    for (const uid of this.dueAt.keys()) if (!live.has(uid)) this.dueAt.delete(uid);
  }
}
