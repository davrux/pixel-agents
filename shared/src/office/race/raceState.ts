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
import { RACE_COUNTDOWN_MS, RACE_GRACE_MS, RACE_MAX_MS, RACE_RESULTS_MS } from '../constants.js';
import type { RaceTrack } from './track.js';

export type RacePhase = 'idle' | 'countdown' | 'racing' | 'done';

/**
 * The phase order the WIRE uses: the index is `RaceSync.phase`.
 *
 * Never reorder and never remove — a client decodes the number, so a phase that moves means every
 * older build shows a countdown when a race has finished. Appending is safe.
 */
export const RACE_PHASES: readonly RacePhase[] = ['idle', 'countdown', 'racing', 'done'];

/** What a race announces as it happens. The room turns these into chat lines and banners. */
export type RaceNoticeKind = 'lap' | 'finalLap' | 'finished' | 'lapRecord' | 'raceRecord' | 'won';

export interface RaceNotice {
  kind: RaceNoticeKind;
  /** Who it is about — a kart id; the room resolves the name. */
  kartId: number;
  /** A time in ms where the notice carries one (a lap, a total), else 0. */
  ms: number;
  /** 1-based place for `finished`, else 0. */
  place: number;
}

/** One kart's race. Absent from `entries` means it is not in this race at all. */
export interface RaceEntry {
  kartId: number;
  /** Whether a person is driving it. The race ends when the PEOPLE are home — a computer driver
   *  still circulating must not keep everybody on a results board they have finished with. */
  human: boolean;
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
  /** The leader is on the last lap and near the flag: the chequered-flag moment. Latched, so it
   *  cannot flicker off when the leader is bumped backwards a few pixels. */
  finalLap: boolean;
  /** The track's standing records when this race started, so "a new record" is measured against
   *  what was there BEFORE it — not against something set earlier in the same race. */
  recordLapMs: number;
  recordRaceMs: number;
  /** When the winner came home, in race ms — the grace period runs from here. 0 until somebody
   *  has finished. */
  wonAtMs: number;
  /** Drained by the room each tick. Bounded: a handful per lap. */
  notices: RaceNotice[];
}

export function createRace(): Race {
  return {
    phase: 'idle',
    timerMs: 0,
    laps: 0,
    entries: new Map(),
    finished: 0,
    finalLap: false,
    recordLapMs: 0,
    recordRaceMs: 0,
    wonAtMs: 0,
    notices: [],
  };
}

/** Take what the race has announced since the last call. */
export function takeNotices(race: Race): RaceNotice[] {
  if (race.notices.length === 0) return [];
  const out = race.notices;
  race.notices = [];
  return out;
}

/** Is this kart in the running race? False in `idle`, and false for a kart that joined late. */
export function racing(race: Race, kartId: number): boolean {
  return race.phase === 'racing' && race.entries.has(kartId);
}

/**
 * Start the lights for these karts. Returns false if a race is already under way or nobody is in
 * a kart — a race with no drivers is a countdown nobody watches.
 */
export function startRace(
  race: Race,
  track: RaceTrack,
  entrants: readonly { kartId: number; human: boolean }[],
  records: { lapMs: number; raceMs: number } = { lapMs: 0, raceMs: 0 },
): boolean {
  if (race.phase !== 'idle' && race.phase !== 'done') return false;
  if (entrants.length === 0) return false;
  race.phase = 'countdown';
  race.timerMs = RACE_COUNTDOWN_MS;
  race.laps = track.laps;
  race.finished = 0;
  race.finalLap = false;
  race.wonAtMs = 0;
  race.notices = [];
  // Snapshotted, so "a new record" is measured against what stood BEFORE this race rather than
  // against something set two laps ago by the same driver.
  race.recordLapMs = records.lapMs;
  race.recordRaceMs = records.raceMs;
  race.entries = new Map(
    entrants.map((e) => [
      e.kartId,
      { kartId: e.kartId, human: e.human, place: 0, finishedMs: null, lapStartMs: 0, lastLapMs: 0, bestLapMs: 0 },
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
    // Over when the PEOPLE are home. A computer driver still circulating must not keep everybody
    // staring at a race they have finished with — the same rule Dust Racing uses. With nobody
    // human in it (a demonstration grid) every entry has to be home instead, or it would end the
    // instant it started.
    const humans = [...race.entries.values()].filter((e) => e.human);
    const waiting = humans.length > 0 ? humans : [...race.entries.values()];
    // …or the grace period after the winner has run out. Somebody who ends up in the pit and
    // stops trying must not hold the rest of the field for six minutes.
    const graceUp = race.wonAtMs > 0 && race.timerMs - race.wonAtMs >= RACE_GRACE_MS;
    if (waiting.every((e) => e.finishedMs !== null) || graceUp || race.timerMs >= RACE_MAX_MS) {
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
  if (race.recordLapMs === 0 || lapMs < race.recordLapMs) {
    // Against the record as it STOOD, and raised as we go, so a driver who beats it twice is
    // congratulated twice only if the second one is faster still.
    race.recordLapMs = lapMs;
    race.notices.push({ kind: 'lapRecord', kartId, ms: lapMs, place: 0 });
  } else {
    race.notices.push({ kind: 'lap', kartId, ms: lapMs, place: 0 });
  }
  if (lap < race.laps) return false;
  race.finished++;
  entry.place = race.finished;
  entry.finishedMs = race.timerMs;
  race.notices.push({ kind: entry.place === 1 ? 'won' : 'finished', kartId, ms: race.timerMs, place: entry.place });
  if (entry.place === 1) race.wonAtMs = race.timerMs;
  if (entry.place === 1 && (race.recordRaceMs === 0 || race.timerMs < race.recordRaceMs)) {
    race.recordRaceMs = race.timerMs;
    race.notices.push({ kind: 'raceRecord', kartId, ms: race.timerMs, place: 1 });
  }
  return true;
}

/**
 * The chequered flag: the leader is on the last lap and nearly home.
 *
 * Latched once true, deliberately — a leader shoved backwards a few pixels would otherwise put
 * the flag away again, and a banner that blinks reads as a fault. `fraction` is how far round the
 * lap the leader is, 0…1 (see `lapFraction`).
 */
export function markFinalLap(race: Race, leaderLap: number, fraction: number): void {
  if (race.finalLap || race.phase !== 'racing') return;
  if (leaderLap >= race.laps - 1 && (race.laps === 1 || fraction >= FINAL_LAP_AT)) {
    race.finalLap = true;
    race.notices.push({ kind: 'finalLap', kartId: 0, ms: 0, place: 0 });
  }
}

/** How far round their last lap the leader has to be for the flag to come out. */
export const FINAL_LAP_AT = 0.95;

/**
 * Take a kart out of the running race — its driver left the zone.
 *
 * Without this a race cannot END: `tickRace` waits for everyone to be home, and a kart nobody is
 * in never crosses the line, so the field would circulate until the six-minute timeout with the
 * computer drivers still on track. Measured after a test client disconnected mid-race.
 *
 * The places already earned are untouched: somebody who finished third stays third whether or not
 * the driver behind them walked away.
 */
export function retireKart(race: Race, kartId: number): void {
  const entry = race.entries.get(kartId);
  if (!entry || entry.finishedMs !== null) return;
  race.entries.delete(kartId);
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

/**
 * m:ss.cc, or a dash for "no time".
 *
 * Shared so the chat line and the HUD cannot disagree about what a time looks like — the same
 * reason the pose cadences live in one table.
 */
export function raceClock(ms: number): string {
  if (!ms || ms <= 0) return '—';
  const total = Math.round(ms);
  const m = Math.floor(total / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const cs = Math.floor((total % 1000) / 10);
  return `${m}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}
