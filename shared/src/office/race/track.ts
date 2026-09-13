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
  /** `"col,row"` of every pit box. Empty on a track with no pit lane, which simply means tyres
   *  cannot be changed there — not that they do not wear. */
  pit: ReadonlySet<string>;
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
  const pit = new Set<string>();
  const rough = new Set<string>();
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
    } else if (action.kind === 'racePit') {
      pit.add(key(col, row));
    } else if (action.kind === 'raceRough') {
      rough.add(key(col, row));
    } else if (action.kind === 'raceFinish') {
      finish = centre(col, row);
    }
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
    ? wrapAngle((stated.dir * Math.PI) / 180)
    : wrapAngle(Math.atan2(gates[1].y - gates[0].y, gates[1].x - gates[0].x));
  return {
    gates,
    grid: ordered.map(({ x, y }) => ({ x, y })),
    startHeading,
    laps: Math.max(1, Math.floor(layout.laps ?? DEFAULT_LAPS)),
    sprint: finish !== null,
    rough,
    pit,
  };
}

/** Is this tile off the racing surface — grass, sand, run-off? */
export function isRough(track: RaceTrack, col: number, row: number): boolean {
  return track.rough.has(key(col, row));
}

/** Is this tile a pit box? */
export function inPit(track: RaceTrack, col: number, row: number): boolean {
  return track.pit.has(key(col, row));
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
 * How far along the lap a kart is, as one comparable number: gates passed, minus how much of the
 * way to the next gate is left. Used for standings, never for lap counting.
 */
export function raceProgress(track: RaceTrack, lap: number, gate: number, x: number, y: number): number {
  const target = nextGate(track, gate);
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

/**
 * Is this kart travelling the wrong way round?
 *
 * Taken from the direction it is MOVING against the direction of the next gate, not from its
 * heading: a kart spun round by a bump points backwards for a moment while still sliding forwards,
 * and warning somebody for that is noise. Below a crawl the question is meaningless, so it is not
 * asked — the answer there would flap every time a stopped kart was nudged.
 */
export function goingBackwards(track: RaceTrack, gate: number, x: number, y: number, vx: number, vy: number): boolean {
  const speed = Math.hypot(vx, vy);
  if (speed < 30) return false;
  const target = nextGate(track, gate);
  const tx = target.x - x;
  const ty = target.y - y;
  const len = Math.hypot(tx, ty);
  if (len < 1) return false;
  // The cosine of the angle between where it is going and where the next gate is. A track bends,
  // so "not straight at it" is normal; only a genuine reversal counts.
  return (vx * tx + vy * ty) / (speed * len) < -0.35;
}
