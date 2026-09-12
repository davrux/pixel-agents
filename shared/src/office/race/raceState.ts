/**
 * The race itself: lights, laps, places and times.
 *
 * A track is drivable whenever it exists; a RACE is something somebody starts. That split is the
 * decision this file is built around and it was asked for in those words — without a race running
 * you drive around as long as you like, and the three-lap limit only exists once the lights have
 * gone out. So the phases are not a mode switch on the zone: `idle` IS the world, and a race is a
 * bounded episode inside it.
 *
 *   idle ──/race──▶ countdown ──lights out──▶ racing ──everyone home──▶ done ──▶ idle
 *
 * Four rules, each one a decision rather than a mechanism:
 *
 *  - **Only what happens on the track is in here; nothing moves a kart.** This file records that
 *    a lap was completed and decides what it means; the engine owns position. That is what lets
 *    the whole thing be driven by a test in a loop with no world at all.
 *  - **A lap counts only when the race does.** In `idle` the engine still advances `lap` and
 *    `gate` — they are how a kart knows where it is on the ring, and a free-roam lap counter is
 *    pleasant — but nobody finishes, so nothing ends.
 *  - **Times are measured from the LIGHTS, not from the start command.** Whoever typed `/race`
 *    would otherwise carry the countdown in their total.
 *  - **A race ends when everyone is home OR the clock runs out.** Without the second half one
 *    driver who wanders off into the pit keeps a zone in `racing` forever, and nobody else can
 *    start the next one.
 */
import { RACE_COUNTDOWN_MS, RACE_MAX_MS, RACE_RESULTS_MS } from '../constants.js';
import type { RaceTrack } from './track.js';

export type RacePhase = 'idle' | 'countdown' | 'racing' | 'done';

/**
 * The phase order the WIRE uses: the index is `RaceSync.phase`.
 *
 * Never reorder and never remove — a client decodes the number, so a phase that moves means every
 * older build shows a countdown when a race has finished. Appending is safe.
 */
export const RACE_PHASES: readonly RacePhase[] = ['idle', 'countdown', 'racing', 'done'];

/** One kart's race. Absent from `entries` means it is not in this race at all. */
export interface RaceEntry {
  kartId: number;
  /** 1-based finishing position, or 0 while still running. */
  place: number;
  /** Total race time when it finished, in ms; null while still running. */
  finishedMs: number | null;
  /** Milliseconds into the race when the current lap began. */
  lapStartMs: number;
  lastLapMs: number;
  /** 0 until a lap has been completed. */
  bestLapMs: number;
}

export interface Race {
  phase: RacePhase;
  /** Counts DOWN in `countdown` and `done`, and UP in `racing`. One field, because every reader
   *  wants "the number on screen" and the phase already says which it is. */
  timerMs: number;
  /** How many laps this race is. Taken from the track when it starts, so a re-imported map with a
   *  different lap count cannot change a race that is already running. */
  laps: number;
  entries: Map<number, RaceEntry>;
  /** How many have finished — the next finisher's place. */
  finished: number;
}

export function createRace(): Race {
  return { phase: 'idle', timerMs: 0, laps: 0, entries: new Map(), finished: 0 };
}

/** Is this kart in the running race? False in `idle`, and false for a kart that joined late. */
export function racing(race: Race, kartId: number): boolean {
  return race.phase === 'racing' && race.entries.has(kartId);
}

/**
 * Start the lights for these karts. Returns false if a race is already under way or nobody is in
 * a kart — a race with no drivers is a countdown nobody watches.
 */
export function startRace(race: Race, track: RaceTrack, kartIds: readonly number[]): boolean {
  if (race.phase !== 'idle' && race.phase !== 'done') return false;
  if (kartIds.length === 0) return false;
  race.phase = 'countdown';
  race.timerMs = RACE_COUNTDOWN_MS;
  race.laps = track.laps;
  race.finished = 0;
  race.entries = new Map(
    kartIds.map((kartId) => [
      kartId,
      { kartId, place: 0, finishedMs: null, lapStartMs: 0, lastLapMs: 0, bestLapMs: 0 },
    ]),
  );
  return true;
}

/** Abandon a running race and hand the track back. Safe to call in any phase. */
export function stopRace(race: Race): void {
  race.phase = 'idle';
  race.timerMs = 0;
  race.entries.clear();
  race.finished = 0;
}

/**
 * How many lamps are lit, 0-3, and whether the last one is GREEN.
 *
 * Presentation reads this rather than doing its own arithmetic on the timer, because the moment
 * the lights go out is the moment the karts are released and the two must be the same instant.
 */
export function lights(race: Race): { lit: number; go: boolean } {
  if (race.phase === 'countdown') {
    // Three seconds of lamps and then a beat of green before the world starts moving.
    const secs = Math.ceil((race.timerMs - RACE_GREEN_MS) / 1000);
    if (secs <= 0) return { lit: 3, go: true };
    return { lit: Math.max(0, 3 - secs + 1), go: false };
  }
  return { lit: 0, go: false };
}

/** How long the green light stays up before the countdown ends. */
export const RACE_GREEN_MS = 700;

/** Advance the clock. Returns what changed, so the caller can react without re-deriving it. */
export function tickRace(race: Race, dtMs: number): { started: boolean; ended: boolean } {
  if (race.phase === 'countdown') {
    race.timerMs -= dtMs;
    if (race.timerMs <= 0) {
      race.phase = 'racing';
      race.timerMs = 0;
      return { started: true, ended: false };
    }
    return { started: false, ended: false };
  }
  if (race.phase === 'racing') {
    race.timerMs += dtMs;
    if (race.finished >= race.entries.size || race.timerMs >= RACE_MAX_MS) {
      race.phase = 'done';
      race.timerMs = RACE_RESULTS_MS;
      return { started: false, ended: true };
    }
    return { started: false, ended: false };
  }
  if (race.phase === 'done') {
    race.timerMs -= dtMs;
    if (race.timerMs <= 0) stopRace(race);
  }
  return { started: false, ended: false };
}

/**
 * Record that a kart crossed the line. Returns true if that finished its race.
 *
 * `lap` is the kart's lap count AFTER the crossing, so the first crossing of a three-lap race
 * arrives as 1 and the last as 3.
 */
export function completeLap(race: Race, kartId: number, lap: number): boolean {
  const entry = race.entries.get(kartId);
  if (!entry || race.phase !== 'racing' || entry.finishedMs !== null) return false;
  const lapMs = race.timerMs - entry.lapStartMs;
  entry.lastLapMs = lapMs;
  if (entry.bestLapMs === 0 || lapMs < entry.bestLapMs) entry.bestLapMs = lapMs;
  entry.lapStartMs = race.timerMs;
  if (lap < race.laps) return false;
  race.finished++;
  entry.place = race.finished;
  entry.finishedMs = race.timerMs;
  return true;
}

/**
 * Live positions, for everyone who has not finished yet.
 *
 * `progress` comes from the caller (`raceProgress` needs the track and the kart's position, which
 * this file deliberately knows nothing about), so this is only the ordering — and a kart that has
 * already finished keeps the place it earned rather than being re-sorted by where it coasted to.
 */
export function standings(race: Race, progress: (kartId: number) => number): void {
  const running = [...race.entries.values()].filter((e) => e.finishedMs === null);
  running.sort((a, b) => progress(b.kartId) - progress(a.kartId));
  for (let i = 0; i < running.length; i++) running[i].place = race.finished + i + 1;
}
