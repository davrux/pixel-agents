/**
 * Talking objects — furniture that speaks by itself: the hour, and quotes.
 *
 * The behaviour of the 'talkingObject' Action (see types.ts): a piece carrying
 * it announces the time every full hour, and a speech bubble reading
 * `9 UHR, 9 UHR !!!` appears over it for every viewer at once. It also says a random line from the
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
 * The ZONE, on the other hand, is hardcoded (ANNOUNCE_TIMEZONE below). It used
 * to be the process's own, which made the announcement depend on how the
 * container was started: a plain image runs on UTC, so the whale said the wrong
 * hour until somebody remembered `TZ=Europe/Berlin` — and nothing in the world
 * would look broken, it would just be an hour or two out. The zone the whale
 * speaks in is a property of what it SAYS ("9 UHR", in German), not of where the
 * process happens to run, so it belongs in the code that says it.
 *
 * ── What "every full hour" means when nobody is watching ──
 *
 * The room does not tick with no clients in it (see SimRoom.tick), and it is
 * disposed once the last one leaves, so a zone nobody is in has no clock of its
 * own — which is right: an announcement with no audience is not an event. The
 * consequence is stated by `announceDue` below: the first tick after somebody
 * arrives ADOPTS the hour rather than announcing it. Arriving at 9:05 is not
 * being present at 9:00, and a bubble shouting `9 UHR, 9 UHR !!!` five minutes
 * late is worse than none — it is wrong. From then on the hour is announced when
 * it turns.
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
 * The zone every talking object reads, whatever the server's own is.
 *
 * Hardcoded on purpose — see the header. A deployment may set `TZ` for its logs
 * or leave it at UTC; the whale is unaffected either way, and DST is handled
 * because a named zone carries its own rules (CET in January, CEST in July).
 */
export const ANNOUNCE_TIMEZONE = 'Europe/Berlin';

/** Built once: an Intl formatter is expensive to construct and constant here. */
const berlinFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: ANNOUNCE_TIMEZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
});

/** The wall-clock fields in ANNOUNCE_TIMEZONE for an instant. `Intl` is the only
 *  thing in the platform that can answer "what hour is it THERE" — a fixed
 *  offset could not, since Germany has two. */
function announceClock(nowMs: number): { year: number; month: number; day: number; hour: number } {
  const parts = berlinFormat.formatToParts(nowMs);
  const num = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
  return { year: num('year'), month: num('month'), day: num('day'), hour: num('hour') };
}

/**
 * The hour, as a talking object says it: `9 UHR, 9 UHR !!!`, `14 UHR, 14 UHR !!!`.
 *
 * The hour and nothing else — no minutes, because they are always `00` and a
 * clock that says so twice an hour is only saying it is on the hour. It is
 * called out twice: this is a whale shouting the time across a room, not a
 * status line, and the announcement it replaced (`Es ist 9:00 UHR`) read like
 * one.
 *
 * German, and only German — asked for that way, and it is the world's own voice
 * rather than a viewer's, so there is deliberately nothing here that varies per
 * person. A bubble one viewer reads in German and another in English would need
 * the hour to stop being a broadcast, which is the one thing it must stay: every
 * viewer at the whale is being told the same thing at the same moment.
 *
 * 24-hour and no leading zero, which is one decision each. No leading zero
 * because that is how the hour is spoken; 24-hour because `9 UHR` twice a day
 * from a statue with no am/pm to show would be the one thing a clock must not
 * be, ambiguous.
 *
 * The hour is Berlin's and the WORLD's, not the viewer's: a world where the whale
 * says a different hour to each person standing at it is not one world, and one
 * where it depends on how the container was started is not one either.
 */
export function hourText(nowMs: number): string {
  const h = announceClock(nowMs).hour;
  return `${h} UHR, ${h} UHR !!!`;
}

/**
 * The identity of "this hour" in ANNOUNCE_TIMEZONE — equal at every moment
 * inside one hour there, different in the next. Packed as `YYYYMMDDHH` because
 * that is all this is ever used for (an equality test in announceDue), and a
 * calendar hour is the thing being compared.
 *
 * Not `nowMs - (nowMs % 3_600_000)`: that truncates to a UTC hour, which in a
 * zone offset by a half hour (+05:30 and friends) lands thirty minutes early —
 * and Berlin's own offset changes twice a year, so no arithmetic on the instant
 * answers this. Being a calendar hour also decides what DST does, and both
 * answers are the sane ones: the hour that repeats on the October change is
 * announced once, and the hour the March change skips is not announced at all.
 */
export function hourStamp(nowMs: number): number {
  const { year, month, day, hour } = announceClock(nowMs);
  return ((year * 100 + month) * 100 + day) * 100 + hour;
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
 * moment inside a 20-to-60-minute window, rolled again after each one. WHICH
 * line is not a draw but a deal: the pool is shuffled once at the start and
 * said through in that order, so no line comes twice before every line has come
 * once (QuoteDeck).
 *
 * Three decisions worth stating, because each could plausibly have gone the
 * other way:
 *
 *   - The RANDOMNESS is the server's, like the clock. The server rolls when, the
 *     server deals what (a shuffled deck, see QuoteDeck), and the line is
 *     broadcast, so everybody at the whale sees the same quote at the same
 *     moment. A client-side roll would give each viewer their own whale, which
 *     is the same mistake as a client-side clock.
 *   - The SCHEDULE is per placement, keyed by uid, and independent of the hour.
 *     Two whales in a zone drift apart within the first hour instead of chanting
 *     in unison — and unison is what a shared timer would give, since they would
 *     both fire on one tick. The hour does not move a quote either: 20 to 60
 *     minutes is the whole rule, with no exception for what o'clock it lands on.
 *   - The POOL is injected, not read from disk here. This module runs in the
 *     engine, which is headless and has no business owning a file path; the
 *     server loads and validates the file (server/src/quotes.ts) and hands the
 *     lines in through OfficeState.setQuotes, the same shape as setPetDecider.
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

/**
 * The pool as a shuffled deck: every line once, in a random order, then the
 * whole pool again in a fresh order.
 *
 * An independent draw per quote (what this used to be) repeats itself — with 25
 * lines, one quote in 25 is the one just said, and a viewer who hears the same
 * line twice in an afternoon takes the pool for five lines long. A deck says
 * each line exactly once before any line comes twice, which is what "random"
 * means to somebody listening.
 *
 * The one place a deck CAN repeat is the boundary: the last card of one pass and
 * the first of the next may be the same line. Rather than reshuffling until they
 * differ (a loop whose length is a random variable, and a loop that never ends
 * on a pool of one), the offending first card is swapped with a random card
 * further down the deck — one roll, always terminates, and every other card of
 * the new pass is as random as before. A pool of one line has nothing to swap
 * with and repeats, which is the only honest thing a pool of one can do.
 *
 * The shuffle is Fisher-Yates walking FORWARD, so a die that always rolls 0
 * leaves the pool in file order — which is what lets a test with a pinned die
 * say "the first line, then the second" rather than working out where an
 * all-zero backward shuffle would have put them.
 */
export class QuoteDeck {
  private deck: string[] = [];
  private next = 0;
  /** The line said most recently, across passes; what the boundary rule checks. */
  private last: string | null = null;

  constructor(private readonly quotes: readonly string[], private readonly rnd: () => number) {
    this.deck = shuffled(quotes, rnd);
  }

  get size(): number {
    return this.quotes.length;
  }

  /** The next line, or null when the pool is empty. */
  draw(): string | null {
    const n = this.deck.length;
    if (n === 0) return null;
    if (this.next >= n) {
      this.deck = shuffled(this.quotes, this.rnd);
      this.next = 0;
      if (n > 1 && this.deck[0] === this.last) {
        const j = 1 + Math.min(n - 2, Math.max(0, Math.floor(this.rnd() * (n - 1))));
        [this.deck[0], this.deck[j]] = [this.deck[j], this.deck[0]];
      }
    }
    const text = this.deck[this.next++];
    this.last = text;
    return text;
  }
}

/** A uniformly random permutation of `items` (Fisher-Yates), leaving the input
 *  alone. Walks forward so `rnd` ≡ 0 is the identity — see QuoteDeck. The
 *  `length - 1` clamp is for the `rnd() === 1` a hand-written generator can
 *  produce; Math.random never does, and an out-of-range index would put an
 *  `undefined` in the deck and a bubble reading `undefined` on the whale. */
export function shuffled<T>(items: readonly T[], rnd: () => number): T[] {
  const out = items.slice();
  for (let i = 0; i < out.length - 1; i++) {
    const span = out.length - i;
    const j = i + Math.min(span - 1, Math.max(0, Math.floor(rnd() * span)));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
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
  /** One deck per room, shared by every talker in it: two whales in a zone
   *  draw from the same pass, so the viewer who can see both never hears one
   *  line from each within the hour. Empty until setQuotes. */
  private deck = new QuoteDeck([], Math.random);
  private rnd: () => number;
  /** uid → the moment this placement says its next quote. Keyed by something
   *  that comes and goes, so `prune` below is not optional — see AGENTS.md
   *  § Memory; a Tiled re-import regenerates every uid. */
  private readonly dueAt = new Map<string, number>();

  constructor(rnd: () => number = Math.random) {
    this.rnd = rnd;
  }

  /** Install the world's quote pool (see the header: the server owns the file)
   *  and shuffle it — the deck's first pass is dealt here, at the start of the
   *  service, so the die is rolled `quotes.length - 1` times before the first
   *  wait is scheduled (a test with a scripted die has to account for that).
   *  Safe to call at any time — a pool arriving after the first tick simply
   *  starts the first wait then.
   *
   *  The random source may be replaced with it, and for the same reason `update`
   *  takes `nowMs`: whoever owns the world owns both, and pinning it is the only
   *  way a test can assert "this quote, twenty minutes after that one" through
   *  the real engine rather than through this class in isolation. */
  setQuotes(quotes: readonly string[], rnd?: () => number): void {
    if (rnd) this.rnd = rnd;
    this.deck = new QuoteDeck(quotes, this.rnd);
  }

  /**
   * The quotes due right now, one line at most per talker.
   *
   * A talker with no schedule yet gets one and says nothing: the first wait is
   * counted from when the room started ticking, so arriving at a whale is never
   * greeted by an instant quote it had been holding.
   *
   * Nothing here knows about the hour. This clock is deliberately independent of
   * the announcement's: a wait of 20 to 60 minutes means exactly that, whatever
   * o'clock it happens to run out at. An earlier version had the hour suppress a
   * quote that came due on the same tick, because the client keeps ONE bubble
   * per speaker and the second line replaces the first — but both lines go into
   * the zone chat now, so the displaced one is read rather than lost, and a
   * schedule that quietly skips its turn is the worse trade: it makes the
   * interval a claim with an exception in it.
   */
  chimes(talkers: readonly PlacedFurniture[], nowMs: number): SpokenLine[] {
    if (this.deck.size === 0) return [];
    const out: SpokenLine[] = [];
    for (const f of talkers) {
      const due = this.dueAt.get(f.uid);
      if (due === undefined || nowMs < due) {
        if (due === undefined) this.dueAt.set(f.uid, nowMs + quoteDelayMs(this.rnd()));
        continue;
      }
      this.dueAt.set(f.uid, nowMs + quoteDelayMs(this.rnd()));
      const text = this.deck.draw();
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
