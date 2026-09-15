/**
 * How a kart moves: kinematics on a tile map, not physics.
 *
 * The engine is grid-based by contract (AGENTS.md invariant 3) and a racer is not, so the one
 * decision this file makes is where that line falls. A kart keeps a continuous position — `x`/`y`
 * are pixels, which every pawn's already are — a heading, and a velocity VECTOR, integrated per
 * tick. What it does not have is a solver: no mass, no restitution, no contact stacking.
 *
 * The vector is the one thing I got wrong first and it is worth stating why. With a single speed
 * ALONG the heading, thrust and steering work fine, and then bumping cannot: a shove from the
 * side has nowhere to live, so it can only displace a kart by a pixel before being forgotten, and
 * pushing somebody off a bridge — the feature this whole thing is for — is impossible. A vector
 * with a tyre limit (`KART_GRIP_PX_PER_SEC2`) gives thrust, drift and a shove one shared
 * representation, and it is not one line more of physics.
 *
 * Everything here is a pure function of (kart, dt, world), so the whole model runs headless and a
 * test can drive a lap in a loop. Four rules are worth knowing before changing any of it:
 *
 *  - **Collision is per AXIS, and that is what makes walls feel right.** A blocked move is not
 *    cancelled outright; the x and y components are tried separately, so a kart scraping a wall
 *    slides along it instead of stopping dead. Cancelling both is the difference between a racer
 *    and a maze.
 *  - **`canStep` is not the arbiter here, unlike everywhere else.** It refuses to leave the
 *    ground, which is exactly what a kart must be allowed to do: driving off a bridge is the
 *    point. So a kart checks WALLS (an edge between tiles) and blocked tiles, and treats "no
 *    ground" as a fall rather than as a refusal.
 *  - **A gate may only be the next one.** Progress is a ring walked in order; anything else is
 *    ignored, which is what makes cutting and reversing worthless without a single extra check.
 *  - **Falling is a state with a timer, not a teleport.** The kart stops being simulated, the
 *    client has something to draw, and the respawn puts it at the last gate facing the next.
 */
import {
  KART_POWER_GRIP_SHARE,
  KART_SLIDE_ANGLE_RAD,
  KART_SLIDE_ALIGN_PER_SEC,
  KART_BUMP_GAIN,
  KART_BUMP_MIN_PX_PER_SEC,
  KART_BUMP_TRANSFER,
  KART_DRAG_PER_SEC,
  BOOST_ACCEL_FACTOR,
  BOOST_CARRY_SEC,
  BOOST_SPEED_FACTOR,
  KART_FALL_SEC,
  KART_RESPAWN_REACH_TILES,
  KART_MAX_REVERSE_PX_PER_SEC,
  KART_RADIUS_PX,
  KART_RECOVER_SEC,
  KART_STEER_AT_REST,
  KART_STUCK_SEC,
  KART_STUCK_SPEED_PX_PER_SEC,
  KART_WRONG_WAY_SEC,
  KART_STEER_RAD_PER_SEC,
  ROUGH_GRIP,
  ROUGH_SPEED,
} from '../constants.js';
import { isWalkable } from '../layout/tileMap.js';
import { TILE_SIZE, type GroundMap, type WallEdges } from '../types.js';
import { crossingBlocked } from '../wallEdges.js';
import { DEFAULT_KART_SPEC, kartSpec } from './kartSpec.js';
import { gateAt, headingFrom, isBoost, isRough, nextGate, nextPoint, wrapAngle, type RaceTrack } from './track.js';

/** What a driver is asking for, clamped to three values each — a keyboard, not an axis. */
export interface KartInput {
  /** 1 = throttle, -1 = brake/reverse, 0 = coast. */
  throttle: -1 | 0 | 1;
  /** 1 = right, -1 = left, 0 = straight. */
  steer: -1 | 0 | 1;
}

export type KartState = 'idle' | 'drive' | 'fall';

export interface Kart {
  id: number;
  /** Pixel centre. */
  x: number;
  y: number;
  /** Radians, 0 = east, growing clockwise on screen (y points down). */
  heading: number;
  /** Velocity, px/s. Thrust goes along the heading; what is left sideways is drift and shove. */
  vx: number;
  vy: number;
  state: KartState;
  /** The character driving, or null for a parked kart. */
  driverId: number | null;
  input: KartInput;
  /** Last gate passed, as an index into the track's gates. */
  gate: number;
  lap: number;
  /** Counts down while falling. */
  fallTimer: number;
  /** Milliseconds of raised speed ceiling left from a boost pad. Engine-only: the client sees the
   *  speed, which is the whole of what a boost looks like. */
  boostMs: number;
  /** Set once the kart has crossed the finish for the last lap. Owned by the RACE, never by the
   *  model: without a race running there is no finish, because there is no lap limit. */
  finished: boolean;
  /** Which `KartSpec` this one is built to. An unknown id drives as the default. */
  spec: string;
  /** Which car it looks like — an index into VEHICLE_ART, taken from its grid slot so a field of
   *  eight tells itself apart. Presentation, but a shared DECISION: every viewer must agree. */
  art: number;
  /**
   * Is it sliding right now — the tyres past their limit, the kart pointing somewhere other than
   * where it is going?
   *
   * A DECISION and not presentation, so it is synced rather than re-derived on each client: the
   * client has no velocity vector to derive it from (the wire carries a pose, not a state), and
   * two viewers guessing from successive positions would disagree about where the marks go.
   */
  sliding: boolean;
  /**
   * The car's own lap clock, in ms — running whether or not a race is.
   *
   * Practice is where you learn a circuit, and a practice lap with no time on it is driving in
   * circles. The RACE keeps its own times as well, because a race's best lap is scoped to that
   * race; these are the car's, for as long as it is out.
   */
  lapMs: number;
  lastLapMs: number;
  bestLapMs: number;
  /** Travelling the wrong way round the circuit. A world fact, so every viewer warns the same
   *  driver at the same moment. */
  wrongWay: boolean;
  /** How long, in ms, this car has been losing ground — what the warning is actually made of. */
  wrongMs: number;
  /** How far it was from the point it is heading for, last tick. -1 before the first one. */
  /**
   * How long, in ms, the engine has been asking for something and the ground has not moved.
   *
   * Measured here and not by whoever is steering, because the wall is what took the movement and
   * only the physics saw it happen. What to DO about it is the driver's business: a computer
   * driver backs out (`recoverMs`), and a human is simply told nothing and reverses if they like.
   */
  stuckMs: number;
  /**
   * Counts down while a wedged kart backs itself out. Set when `stuckMs` crosses the threshold.
   *
   * Two numbers rather than one because this is a Schmitt trigger and a single accumulator cannot
   * be one: the condition that STARTS the manoeuvre (jammed for a while) is not the condition that
   * sustains it (moving backwards is moving, which would clear the jam and drive straight back in).
   */
  recoverMs: number;
}

export interface KartWorld {
  tileMap: GroundMap;
  blockedTiles: Set<string>;
  walls?: WallEdges;
  track: RaceTrack;
}

export const NEUTRAL_INPUT: KartInput = { throttle: 0, steer: 0 };

export function createKart(id: number, at: { x: number; y: number }, heading: number): Kart {
  return {
    id,
    x: at.x,
    y: at.y,
    heading,
    vx: 0,
    vy: 0,
    state: 'idle',
    driverId: null,
    input: { ...NEUTRAL_INPUT },
    gate: 0,
    lap: 0,
    fallTimer: 0,
    boostMs: 0,
    finished: false,
    spec: DEFAULT_KART_SPEC.id,
    art: 0,
    sliding: false,
    wrongWay: false,
    wrongMs: 0,
    stuckMs: 0,
    recoverMs: 0,
    lapMs: 0,
    lastLapMs: 0,
    bestLapMs: 0,
  };
}

const tileOf = (px: number): number => Math.floor(px / TILE_SIZE);


/** Is this pixel on ground a kart may be on? Walls are edges and handled by the mover. */
function onTrack(world: KartWorld, x: number, y: number): boolean {
  return isWalkable(tileOf(x), tileOf(y), world.tileMap, world.blockedTiles);
}

/** May a kart move between these two pixels — i.e. is there a wall edge in the way? */
function crossable(world: KartWorld, fromX: number, fromY: number, toX: number, toY: number): boolean {
  const c0 = tileOf(fromX);
  const r0 = tileOf(fromY);
  const c1 = tileOf(toX);
  const r1 = tileOf(toY);
  if (c0 === c1 && r0 === r1) return true;
  const cols = world.tileMap.length > 0 ? world.tileMap[0].length : 0;
  // Only ever one step in one axis per call (the mover splits the move), so this is the same
  // question `canStep` asks — minus the "must be ground" half, which is a fall and not a refusal.
  return !crossingBlocked(world.walls, cols, c0, r0, c1, r1);
}

/** A tile that is blocked (furniture, a collision cell) stops a kart; open air does not. */
function solid(world: KartWorld, x: number, y: number): boolean {
  const col = tileOf(x);
  const row = tileOf(y);
  const rows = world.tileMap.length;
  const cols = rows > 0 ? world.tileMap[0].length : 0;
  if (col < 0 || row < 0 || col >= cols || row >= rows) return true; // the map's edge is a wall
  return world.blockedTiles.has(`${col},${row}`);
}

/**
 * Which of the four ways a BODY can face is closest to a kart's heading.
 *
 * Sixteen headings for the kart, four for its driver, and that asymmetry is the point: the kart is
 * drawn from above where a turn is a different picture, while a character's art is four
 * three-quarter views. Quadrants rather than nearest-axis, so the diagonals go to the horizontal
 * facings — a driver seen from the side reads as driving, one seen head-on reads as parked.
 */
export function facingFromHeading(heading: number): 0 | 1 | 2 | 3 {
  const a = wrapAngle(heading);
  const q = Math.PI / 4;
  if (a < q || a >= 7 * q) return 2; // east → RIGHT
  if (a < 3 * q) return 0; // south → DOWN
  if (a < 5 * q) return 1; // west → LEFT
  return 3; // north → UP
}

/**
 * One tick of one kart. Returns what the room has to react to, so the caller decides what a lap
 * or a finish MEANS (a message, a score, a chequered flag) while this file stays pure.
 */
export function updateKart(kart: Kart, dt: number, world: KartWorld): { lapped: boolean; fell: boolean } {
  if (kart.state === 'fall') {
    kart.fallTimer -= dt;
    if (kart.fallTimer <= 0) respawn(kart, world);
    return { lapped: false, fell: false };
  }

  // The lap clock runs for anybody who is out there, race or no race.
  if (kart.driverId !== null && !kart.finished) kart.lapMs += dt * 1000;
  const input = kart.driverId === null || kart.finished ? NEUTRAL_INPUT : kart.input;
  // Every number the handling reads comes from the spec, so a second kind of kart is a row in a
  // table rather than a branch in here (see kartSpec.ts).
  const spec = kartSpec(kart.spec);
  const fx = Math.cos(kart.heading);
  const fy = Math.sin(kart.heading);

  // ── steering ──────────────────────────────────────────────────────────────
  // Scaled by how fast it is going, so a parked kart can still be aimed (slowly) but nobody
  // pirouettes. Reversing steers the other way round, like a real vehicle.
  let along = kart.vx * fx + kart.vy * fy;
  if (input.steer !== 0) {
    // Yaw from a RADIUS, not a fixed rate: a kart on a circle of `KART_TURN_RADIUS_PX` turns at
    // `speed / radius`, which is what makes a corner cost more grip the faster you take it. The
    // floor keeps a parked kart aimable and the ceiling keeps a slow one from pirouetting.
    const speed = Math.abs(along);
    const yaw = Math.max(
      KART_STEER_RAD_PER_SEC * KART_STEER_AT_REST,
      Math.min(KART_STEER_RAD_PER_SEC, speed / spec.turnRadius),
    );
    const sign = along < 0 ? -1 : 1; // reversing steers the other way round, like a real vehicle
    kart.heading = wrapAngle(kart.heading + input.steer * sign * yaw * dt);
  }

  // ── thrust, drag and grip ─────────────────────────────────────────────────
  // Recomputed after the turn, so thrust goes where the kart NOW points.
  const hx = Math.cos(kart.heading);
  const hy = Math.sin(kart.heading);
  along = kart.vx * hx + kart.vy * hy;
  // Sideways velocity: drift, and where a bump from the flank lives.
  let side = -kart.vx * hy + kart.vy * hx;

  // What the engine or the brakes ask of the tyres, as a share of everything they have. A tyre
  // has ONE budget for going and for turning (the friction circle), so this is subtracted from
  // what is left for the corner — which is the whole of "too much gas in a corner throws you off".
  const power = input.throttle !== 0 ? KART_POWER_GRIP_SHARE : 0;
  // Off the racing surface everything is worse: less grip and a lower ceiling. Slow rather than
  // fatal — a run-off you cannot drive out of is a wall with grass painted on it.
  const offRoad = isRough(world.track, tileOf(kart.x), tileOf(kart.y));
  const surface = offRoad ? ROUGH_GRIP : 1;
  // A BOOST pad: road that throws you down it. The shove lands whether or not the throttle is
  // down — lifting on one is not a way to refuse it — and only while the car is actually on the
  // pad, so what you get is the length of it and not a switch you flicked.
  const boosting = !offRoad && isBoost(world.track, tileOf(kart.x), tileOf(kart.y)) && kart.driverId !== null;
  if (input.throttle > 0) along += spec.accel * dt * (offRoad ? ROUGH_SPEED : 1);
  else if (input.throttle < 0) along -= spec.brake * dt;
  if (boosting && along >= 0) along += spec.accel * BOOST_ACCEL_FACTOR * dt;
  along -= along * Math.min(1, KART_DRAG_PER_SEC * dt);
  // The raised ceiling OUTLIVES the pad, and it has to. The cap is applied every tick, so without
  // this the extra speed is cut away the instant the car rolls off the last cell — measured, a lap
  // improved by three tenths of a second, which is a pad that may as well not be there. Held up
  // for BOOST_CARRY_SEC, the ordinary drag is what takes the speed back, and a pad becomes a run
  // down the straight instead of four tiles of nothing.
  kart.boostMs = boosting ? BOOST_CARRY_SEC * 1000 : Math.max(0, kart.boostMs - dt * 1000);
  const ceiling = spec.maxSpeed * (offRoad ? ROUGH_SPEED : kart.boostMs > 0 ? BOOST_SPEED_FACTOR : 1);
  along = Math.max(-KART_MAX_REVERSE_PX_PER_SEC, Math.min(ceiling, along));

  // The tyres kill at most this much sideways speed this tick — a LIMIT, not a fraction. Beyond
  // it the kart slides, and that is the drift.
  const lateral = spec.grip * surface * Math.sqrt(Math.max(0, 1 - power * power));
  const bite = lateral * dt;
  side -= Math.sign(side) * Math.min(Math.abs(side), bite);

  if (Math.abs(along) < 1 && input.throttle === 0) along = 0;
  // The sideways deadzone has to be far below a pixel per second, and this is the line that made
  // the whole tyre model invisible: a full-lock corner at top speed builds sideways speed at
  // about 0.8 px/s per tick, so a threshold of 1 wiped the slide out on every single tick and the
  // kart tracked its steering exactly. Measured after the fix, the same corner reaches 14°.
  if (Math.abs(side) < 0.05) side = 0;
  kart.vx = hx * along - hy * side;
  kart.vy = hy * along + hx * side;

  // The nose follows the slide. Without this a sliding kart crabs — pointing one way, travelling
  // another, forever — which reads as a bug and not as a drift. Steering adds yaw, this takes it
  // away, and holding a turn settles at a steady angle instead of spinning.
  if (side !== 0 && Math.abs(along) > 1) {
    const slip = Math.atan2(side, Math.abs(along));
    kart.heading = wrapAngle(kart.heading + slip * Math.min(1, KART_SLIDE_ALIGN_PER_SEC * dt));
    // Far enough past the tyres' limit that a viewer would call it sliding. The threshold is the
    // renderer's cue for skid marks, so it is a world fact and not a drawing detail.
    kart.sliding = Math.abs(slip) > KART_SLIDE_ANGLE_RAD && Math.abs(along) > 40;
  } else kart.sliding = false;

  kart.state = kart.driverId === null ? 'idle' : 'drive';

  // ── moving ────────────────────────────────────────────────────────────────
  const dx = kart.vx * dt;
  const dy = kart.vy * dt;
  if (dx !== 0 || dy !== 0) {
    // Per axis, so a glancing hit slides instead of stopping, and the blocked component is the
    // only one that is lost. Cancelling both is the difference between a racer and a maze.
    if (crossable(world, kart.x, kart.y, kart.x + dx, kart.y) && !solid(world, kart.x + dx, kart.y)) kart.x += dx;
    else kart.vx *= -0.15; // a nudge back off the wall, and most of the pace gone
    if (crossable(world, kart.x, kart.y, kart.x, kart.y + dy) && !solid(world, kart.x, kart.y + dy)) kart.y += dy;
    else kart.vy *= -0.15;
  }

  // ── wedged ────────────────────────────────────────────────────────────────
  // Asking for something and going nowhere. Counted after the move, which is the only place the
  // wall's veto is visible: the velocity above says the kart is driving, and the position says it
  // is not. The recovery is a COUNTDOWN and not a re-test, so backing out cannot cancel itself.
  if (kart.recoverMs > 0) kart.recoverMs = Math.max(0, kart.recoverMs - dt * 1000);
  else if (kart.driverId !== null && input.throttle !== 0 && Math.hypot(kart.vx, kart.vy) < KART_STUCK_SPEED_PX_PER_SEC) {
    kart.stuckMs += dt * 1000;
    if (kart.stuckMs >= KART_STUCK_SEC * 1000) {
      kart.stuckMs = 0;
      kart.recoverMs = KART_RECOVER_SEC * 1000;
    }
  } else kart.stuckMs = 0;

  // ── off the edge ──────────────────────────────────────────────────────────
  if (!onTrack(world, kart.x, kart.y)) {
    kart.state = 'fall';
    kart.fallTimer = KART_FALL_SEC;
    kart.vx = 0;
    kart.vy = 0;
    return { lapped: false, fell: true };
  }

  // ── gates ─────────────────────────────────────────────────────────────────
  const here = gateAt(world.track, tileOf(kart.x), tileOf(kart.y));
  if (here && here.index === nextGate(world.track, kart.gate).index) {
    kart.gate = here.index;
    if (here.index === 0) {
      kart.lap++;
      // A lap is only a TIME once there has been a previous crossing to measure from — the run
      // out of the pits to the line is not a lap and must not become somebody's record.
      if (kart.lap > 1) {
        kart.lastLapMs = kart.lapMs;
        if (kart.bestLapMs === 0 || kart.lapMs < kart.bestLapMs) kart.bestLapMs = kart.lapMs;
      }
      kart.lapMs = 0;
      // What a completed lap MEANS — a finish, a time, a place — belongs to the race and not to
      // the model: with no race running there is no lap limit at all, and driving round the ring
      // for as long as you like is the normal state of a track.
      return { lapped: true, fell: false };
    }
  }
  return { lapped: false, fell: false };
}

/**
 * Solid road near a point, or null — where a fallen kart is put back.
 *
 * Four conditions, and each one is a way a respawn goes wrong:
 *
 *  - **Ground**, or the car is put back into the drop it just fell into.
 *  - **Not rough**, because being handed back the grass is being handed back the accident. This
 *    is what makes it "back on the track" rather than "back on the map".
 *  - **Every one of the eight neighbours is ground**, so a car whose body is 26 px across a 16 px
 *    cell cannot be set down on the lip of a bridge with half of itself over the edge.
 *  - **No nearer the next gate than where it fell.** Without it, a drop beside a corner is a
 *    shortcut: the nearest road across a void can be further round the lap than the road you left,
 *    and falling off would become the fast way round.
 *
 * Searched nearest-first, so what comes back is the least the map can get away with.
 */
function roadNear(world: KartWorld, x: number, y: number, gate: number): { x: number; y: number } | null {
  const col = tileOf(x);
  const row = tileOf(y);
  const target = nextPoint(world.track, gate);
  const fellGap = Math.hypot(target.x - x, target.y - y);
  const reach = KART_RESPAWN_REACH_TILES;
  const solid = (c: number, r: number): boolean => {
    if (!isWalkable(c, r, world.tileMap, world.blockedTiles)) return false;
    if (isRough(world.track, c, r)) return false;
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (!isWalkable(c + dc, r + dr, world.tileMap, world.blockedTiles)) return false;
      }
    }
    return true;
  };
  const spots: Array<{ c: number; r: number; d: number }> = [];
  for (let dr = -reach; dr <= reach; dr++) {
    for (let dc = -reach; dc <= reach; dc++) {
      const d = Math.hypot(dc, dr);
      if (d > reach) continue;
      spots.push({ c: col + dc, r: row + dr, d });
    }
  }
  spots.sort((a, b) => a.d - b.d);
  for (const spot of spots) {
    if (!solid(spot.c, spot.r)) continue;
    const px = spot.c * TILE_SIZE + TILE_SIZE / 2;
    const py = spot.r * TILE_SIZE + TILE_SIZE / 2;
    if (Math.hypot(target.x - px, target.y - py) < fellGap) continue;
    return { x: px, y: py };
  }
  return null;
}

/**
 * Put a fallen kart back on the road it fell off, pointing at what it was heading for.
 *
 * The last GATE is the fallback and not the rule any more. On a circuit with four gates that was
 * most of a lap for a wheel over a kerb, which is a punishment out of all proportion — a kart game
 * hands you back the track where you left it. The gate stays as the answer for a car that fell
 * somewhere the map has no road within `KART_RESPAWN_REACH_TILES`, because there the alternative
 * is nothing at all.
 */
export function respawn(kart: Kart, world: KartWorld): void {
  const spot = roadNear(world, kart.x, kart.y, kart.gate);
  if (spot) {
    kart.x = spot.x;
    kart.y = spot.y;
    // At the thing it was driving towards — the next gate, or a stage's finish line. `headingFrom`
    // is a property of a GATE and says nothing about a point halfway down a straight.
    const target = nextPoint(world.track, kart.gate);
    kart.heading = wrapAngle(Math.atan2(target.y - kart.y, target.x - kart.x));
  } else {
    const gate = world.track.gates[kart.gate] ?? world.track.gates[0];
    kart.x = gate.x;
    kart.y = gate.y;
    kart.heading = headingFrom(world.track, gate);
  }
  kart.vx = 0;
  kart.vy = 0;
  kart.fallTimer = 0;
  kart.state = kart.driverId === null ? 'idle' : 'drive';
}

/**
 * Push two overlapping karts apart and trade the speed along the line between them.
 *
 * The whole of "bumping" is here, and it is deliberately not an impulse solver: the pair is
 * separated so they cannot tunnel, and each one's speed ALONG THE NORMAL is handed to the other
 * at `KART_BUMP_TRANSFER`. That gives the three things the feature is for — a faster kart shoves a
 * slower one, both lose something so ramming is a trade, and a shove has a direction, so a kart
 * hit from the side leaves the road. A minimum nudge is added so touching at a crawl still counts.
 *
 * Called for each pair once per tick; with eight karts that is 28 comparisons.
 */
export function bumpKarts(a: Kart, b: Kart): boolean {
  if (a.state === 'fall' || b.state === 'fall') return false;
  let nx = b.x - a.x;
  let ny = b.y - a.y;
  const dist = Math.hypot(nx, ny);
  const touching = KART_RADIUS_PX * 2;
  if (dist >= touching) return false;
  if (dist < 0.001) {
    // Exactly on top of each other: pick a direction rather than dividing by zero. Derived from
    // the ids so two clients — and two runs — separate them the same way.
    nx = a.id <= b.id ? 1 : -1;
    ny = 0;
  } else {
    nx /= dist;
    ny /= dist;
  }
  const overlap = (touching - dist) / 2 + 0.01;
  a.x -= nx * overlap;
  a.y -= ny * overlap;
  b.x += nx * overlap;
  b.y += ny * overlap;

  // How fast they are closing along that line. With a velocity vector this is the whole
  // exchange: what a kart carries INTO the contact is what it hands over.
  const closing = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
  // What b receives is MORE than what a gives away (see KART_BUMP_GAIN): a bump is a designed
  // effect, not a conserved impulse, because at the physical share a shove slides a kart six
  // pixels and nobody can be pushed off anything.
  const shove = Math.max(KART_BUMP_MIN_PX_PER_SEC, Math.max(0, closing) * KART_BUMP_GAIN);
  // b is pushed along the normal and a loses what it gave away, so ramming is a trade rather
  // than a free win. The shove lands on the VECTOR, which is why it can send somebody sideways
  // off a bridge instead of just nudging them a pixel.
  b.vx += nx * shove;
  b.vy += ny * shove;
  a.vx -= nx * Math.max(0, closing) * KART_BUMP_TRANSFER;
  a.vy -= ny * Math.max(0, closing) * KART_BUMP_TRANSFER;
  return true;
}

/**
 * Is this car going the wrong way — decided against the direction of the LEG it is on.
 *
 * The leg is the straight line from the gate just passed to the point being driven towards, and
 * the question is whether the car's velocity has a component along it or against it. Not where the
 * car is POINTING (a car spun by a bump points backwards for a moment while still sliding
 * forwards, and warning for that is noise), and not the distance to the next gate either, which is
 * what this replaced twice:
 *
 *  - `raceProgress` clamps its fraction to the leg so a running order stays monotone, which means
 *    progress stops falling exactly when a car is most obviously going backwards.
 *  - Raw distance to the next gate fires on a CORNER. A leg that bends takes the car away from the
 *    point it is heading for while it is being driven perfectly: measured on Monza, six spells on
 *    a clean three-lap run, twice a lap, at the same two corners — "durch die erste Kurve kommt
 *    kurz Wrong Way".
 *  - Requiring it to be gaining on the gate BEHIND as well fixes that and breaks the other half: a
 *    circuit has a checkpoint every twenty tiles now, which at racing speed is a second, so a car
 *    turned round passes the gate behind it before the counter can reach its threshold. Measured:
 *    it never warned at all.
 *
 * The chord is what has neither problem. A leg twenty tiles long is close enough to straight that
 * driving it correctly keeps the dot product positive through any corner this world can draw, and
 * a car driven back down the road has it firmly negative for as long as that lasts.
 *
 * The counter lives on the CAR rather than being recomputed, because "for how long" is the whole
 * point: a spin crosses the line for a moment, and a warning that fires on a single tick of that
 * is the false alarm all of this exists to avoid.
 */
export function updateWrongWay(kart: Kart, world: KartWorld, dt: number): void {
  const driving = kart.driverId !== null && kart.state === 'drive' && !kart.finished;
  const speed = Math.hypot(kart.vx, kart.vy);
  // Below a crawl the question is meaningless: a stopped car is going neither way, and asking
  // would flap the warning every time somebody nudged it.
  if (!driving || speed < 30) {
    kart.wrongMs = 0;
    kart.wrongWay = false;
    return;
  }
  const ahead = nextPoint(world.track, kart.gate);
  const behind = world.track.gates[kart.gate] ?? world.track.gates[0];
  const lx = ahead.x - behind.x;
  const ly = ahead.y - behind.y;
  const leg = Math.hypot(lx, ly);
  if (leg < 1) {
    kart.wrongMs = 0;
    kart.wrongWay = false;
    return;
  }
  // The cosine between where the car is going and where this leg goes. A bend is normal, so only
  // a genuine reversal counts — the same threshold `goingBackwards` uses, and for the same reason.
  const along = (kart.vx * lx + kart.vy * ly) / (speed * leg);
  if (along < -0.35) kart.wrongMs += dt * 1000;
  else kart.wrongMs = 0;
  kart.wrongWay = kart.wrongMs >= KART_WRONG_WAY_SEC * 1000;
}
