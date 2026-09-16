/**
 * What makes a map a race track: gates, a starting grid, and a lap count.
 *
 * All three are read off the map's own tile actions (`raceGate`, `raceStart`) plus its `laps`
 * property, and a map IS a track exactly when it has at least two gates and one grid slot. There
 * is deliberately no boolean saying so — a flag can contradict the objects, and then a "track"
 * with no finish line is a state the code has to have an opinion about. The absence is the answer,
 * the same way a map with no `pet_feed` appliance simply never sends a pet to drink.
 *
 * **Why gates at all**, since a lap could be "cross the finish line again": because that lets a
 * kart cut the infield, or turn round on the line and score a lap per second. Every racing game
 * answers this the same way — a ring of checkpoints you may only pass IN ORDER, with the finish
 * as one of them. Two more things fall out of it for free, which is why it is worth the authoring:
 *
 *  - **Position** (1st, 2nd, …) is the gate index plus the distance to the next gate's centre,
 *    never the straight line to the finish, which on an oval ranks a kart that has just started
 *    ahead of one about to lap it.
 *  - **Respawning** has an answer with nothing extra to author: a kart that falls comes back at
 *    the last gate it passed, pointing at the next one.
 */
import { TILE_SIZE, type Action, type OfficeLayout } from '../types.js';

/** One checkpoint: every tile it covers, and the centre of those tiles in pixels. */
export interface RaceGate {
  /** Position in the lap; gate 0 is the finish line. */
  index: number;
  /** `"col,row"` for each tile the gate covers — a gate is a LINE across the road, so it is
   *  usually several tiles wide and the kart only has to touch one of them. */
  tiles: ReadonlySet<string>;
  /** Pixel centre of the covered tiles: where a respawn puts a kart, and the point distances are
   *  measured to. */
  x: number;
  y: number;
}

export interface RaceTrack {
  /** Gates in lap order, index 0 first. Always at least two on a real track. */
  gates: readonly RaceGate[];
  /** Grid slots in starting order, as pixel positions. */
  grid: readonly { x: number; y: number }[];
  /**
   * Which way the field sets off, in radians — from the start beacon if one says so, otherwise
   * worked out from where gate 1 is.
   *
   * A beacon rather than only the gate order, because the direction of a lap used to live in the
   * NUMBERING of the gates and nothing on the map showed it: a circuit that runs north is exactly
   * as valid as one that runs east, and whoever draws it should be able to SAY so.
   */
  startHeading: number;
  laps: number;
  /**
   * A point-to-point race: run the gates once and the finish ends it.
   *
   * True when the map places a `raceFinish`. Laps are not the only shape a race has, and a hill
   * climb or a rally stage needs no circuit at all — what it needs is a start, some gates in
   * order, and a line at the far end.
   */
  sprint: boolean;
  /**
   * `"col,row"` of every cell that is off the racing surface but still ground — grass, sand, the
   * run-off.
   *
   * The computer drivers steer by it as much as the physics does: their road probe stops at rough
   * exactly as it stops at a drop, or they would cut every corner across the grass and the racing
   * line would stop meaning anything.
   */
  rough: ReadonlySet<string>;
  /**
   * `"col,row"` of every BOOST pad — road that throws you down it.
   *
   * On the racing surface rather than off it, which is the difference from `rough` and the reason
   * both are surfaces rather than one flag: a pad is somewhere you aim FOR. The computer drivers
   * need know nothing about it, because driving over one is what they already do.
   */
  boost: ReadonlySet<string>;
  /**
   * `"col,row"` of every ITEM BOX — road that hands a driver something to use.
   *
   * A surface rather than a placed object, for the same reason `boost` is one: it is a fact about
   * a CELL of the road, the map paints it where the racing line goes, and nothing about it has to
   * be synced. A box never empties (a kart holds one item, so a box with nothing to give simply
   * does nothing — see race/items.ts), which is what keeps it out of the wire entirely.
   */
  itemBox: ReadonlySet<string>;
  /**
   * Where a stage ENDS, as a pixel point — the centre of its finish line, or null on a circuit.
   *
   * The gates are a ring and `nextGate` wraps, which is exactly right for a lap and exactly wrong
   * for the last gate of a point-to-point: the thing after it is the LINE, not the start. Kept
   * here so that everything which asks "where am I heading" gets one answer — the driver, the
   * standings and the respawn all used to ask `nextGate` and would have sent a car back down the
   * course.
   */
  finish: { x: number; y: number } | null;
}

const DEFAULT_LAPS = 3;

const key = (col: number, row: number): string => `${col},${row}`;
const centre = (col: number, row: number): { x: number; y: number } => ({
  x: col * TILE_SIZE + TILE_SIZE / 2,
  y: row * TILE_SIZE + TILE_SIZE / 2,
});

/**
 * The track a layout describes, or null when it describes none.
 *
 * Gate numbers may be sparse (a mapper deleting gate 3 of six should not renumber the rest), so
 * they are SORTED into lap order rather than indexed by their own number. What the engine then
 * carries is the position in that order, which is also why `RaceGate.index` is re-derived here
 * instead of copied from the property.
 */
export function raceTrack(layout: OfficeLayout): RaceTrack | null {
  const byGate = new Map<number, { tiles: Set<string>; sx: number; sy: number; n: number }>();
  const grid: Array<{ slot: number; x: number; y: number; dir: number }> = [];
  const rough = new Set<string>();
  const boost = new Set<string>();
  const itemBox = new Set<string>();
  let finish: { x: number; y: number } | null = null;
  const actions = layout.tileActions ?? [];
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i] as Action | null;
    if (!action) continue;
    const col = i % layout.cols;
    const row = (i - col) / layout.cols;
    if (action.kind === 'raceGate') {
      let g = byGate.get(action.gate);
      if (!g) {
        g = { tiles: new Set(), sx: 0, sy: 0, n: 0 };
        byGate.set(action.gate, g);
      }
      g.tiles.add(key(col, row));
      const c = centre(col, row);
      g.sx += c.x;
      g.sy += c.y;
      g.n++;
    } else if (action.kind === 'raceStart') {
      grid.push({ slot: action.slot, dir: action.dir ?? -1, ...centre(col, row) });
    } else if (action.kind === 'raceFinish') {
      finish = centre(col, row);
    }
  }
  // Off the racing surface, painted as a SURFACE. There used to be a second way to say this — one
  // `raceRough` Action per cell — and it was removed on 2026-09-16 because two ways to state one
  // fact is one way too many: no generator wrote it, the dropdown offered it, and a map that used
  // it would have had its rough painted in objects while the layer beside it said nothing.
  for (const cell of layout.surfaces?.rough ?? []) {
    const col = cell % layout.cols;
    rough.add(key(col, (cell - col) / layout.cols));
  }
  for (const cell of layout.surfaces?.boost ?? []) {
    const col = cell % layout.cols;
    boost.add(key(col, (cell - col) / layout.cols));
  }
  for (const cell of layout.surfaces?.item ?? []) {
    const col = cell % layout.cols;
    itemBox.add(key(col, (cell - col) / layout.cols));
  }
  if (byGate.size < 2 || grid.length === 0) return null;

  const gates: RaceGate[] = [...byGate.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, g], index) => ({ index, tiles: g.tiles, x: g.sx / g.n, y: g.sy / g.n }));

  const ordered = grid.sort((a, b) => a.slot - b.slot);
  // The beacon wins where one states a direction; otherwise the gates do, which is what every map
  // drawn before beacons existed means.
  const stated = ordered.find((g) => g.dir >= 0);
  const startHeading = stated
    // A COMPASS bearing, and the −90 is that word taken seriously: a beacon says 0 for north, 90
    // for east, and the engine measures its own headings from east because they are `cos`/`sin` of
    // a screen vector. It used to be authored in the engine's frame, so a mapper wanting north had
    // to write 270 and a test had to spell out which number meant which direction — reported as
    // "fängt man nicht in Norden an?". The conversion belongs here, at the one place a stated
    // bearing enters; everything downstream is radians from east as it always was.
    ? wrapAngle(((stated.dir - 90) * Math.PI) / 180)
    : wrapAngle(Math.atan2(gates[1].y - gates[0].y, gates[1].x - gates[0].x));
  return {
    gates,
    grid: ordered.map(({ x, y }) => ({ x, y })),
    startHeading,
    laps: Math.max(1, Math.floor(layout.laps ?? DEFAULT_LAPS)),
    sprint: finish !== null,
    finish,
    rough,
    boost,
    itemBox,
  };
}

/** Is this tile off the racing surface — grass, sand, run-off? */
export function isRough(track: RaceTrack, col: number, row: number): boolean {
  return track.rough.has(key(col, row));
}

/** Is this tile a boost pad? */
export function isBoost(track: RaceTrack, col: number, row: number): boolean {
  return track.boost.has(key(col, row));
}

/** Is this tile an item box? */
export function isItemBox(track: RaceTrack, col: number, row: number): boolean {
  return track.itemBox.has(key(col, row));
}

/** Which gate covers this tile, or null. */
export function gateAt(track: RaceTrack, col: number, row: number): RaceGate | null {
  const k = key(col, row);
  for (const gate of track.gates) if (gate.tiles.has(k)) return gate;
  return null;
}

/** The gate after this one, wrapping — the only one a kart may pass next. */
export function nextGate(track: RaceTrack, index: number): RaceGate {
  return track.gates[(index + 1) % track.gates.length];
}

/**
 * Which way a kart at `gate` should face: at the NEXT gate's centre.
 *
 * Derived rather than authored, so a mapper never states a heading — they draw a gate across the
 * road and the direction of travel is implied by where the next one is. That is also what makes a
 * respawn correct without a second property per gate.
 */
/**
 * Keep an angle in [0, 2pi). Not cosmetic: a kart that turns the same way for a while otherwise
 * accumulates without bound — measured at -7.1 rad after two laps of one oval — and the wire
 * carries a heading as hundredths of a radian in a `uint16`, so anything negative or past 655
 * arrives at the client pointing somewhere else entirely. It lives here rather than beside the
 * kart because `kart.ts` already imports this file, and the other direction would be a cycle.
 */
export function wrapAngle(rad: number): number {
  const full = Math.PI * 2;
  const wrapped = rad % full;
  return wrapped < 0 ? wrapped + full : wrapped;
}

export function headingFrom(track: RaceTrack, gate: RaceGate): number {
  // From the LINE the start beacon sets, for gate 0 — a grid that faces the way the beacon says
  // is the whole point of having one. Anywhere else, the next gate is the only thing that knows.
  if (gate.index === 0) return track.startHeading;
  const to = nextGate(track, gate.index);
  // Wrapped, because `atan2` answers in (-pi, pi] and the wire carries a heading unsigned.
  return wrapAngle(Math.atan2(to.y - gate.y, to.x - gate.x));
}

/**
 * What a kart that has just passed `gate` is heading for: the next gate, or — for the last gate of
 * a stage — the finish line. One answer, asked by the driver and by the standings alike.
 */
export function nextPoint(track: RaceTrack, gate: number): { x: number; y: number } {
  if (track.sprint && track.finish && gate === track.gates.length - 1) return track.finish;
  return nextGate(track, gate);
}

/**
 * How far along the lap a kart is, as one comparable number: gates passed, minus how much of the
 * way to the next gate is left. Used for standings, never for lap counting.
 */
export function raceProgress(track: RaceTrack, lap: number, gate: number, x: number, y: number): number {
  const target = nextPoint(track, gate);
  const d = Math.hypot(target.x - x, target.y - y);
  const span = Math.max(1, Math.hypot(target.x - track.gates[gate].x, target.y - track.gates[gate].y));
  // Clamped at both ends: a kart that has overshot its next gate sideways can measure FARTHER than
  // the gate it came from, and an unclamped fraction would then rank it behind somebody it has
  // just passed. Monotone within a leg is what a running order needs.
  return lap * track.gates.length + gate + Math.max(0, Math.min(1, 1 - d / span));
}

/**
 * How far round the lap, as a fraction of one lap, 0…1 — what "95 % of the last lap" means.
 *
 * Separate from `raceProgress` because that one counts laps as well, and the two are asked
 * different questions: one orders the field, this one says how near the flag the leader is.
 */
export function lapFraction(track: RaceTrack, gate: number, x: number, y: number): number {
  const whole = raceProgress(track, 0, gate, x, y);
  return Math.max(0, Math.min(1, whole / track.gates.length));
}
