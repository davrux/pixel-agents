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
 * with lateral grip (`KART_LATERAL_GRIP_PER_SEC`) gives thrust, drift and a shove one shared
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
  KART_ACCEL_PX_PER_SEC2,
  KART_LATERAL_GRIP_PER_SEC,
  KART_BRAKE_PX_PER_SEC2,
  KART_BUMP_GAIN,
  KART_BUMP_MIN_PX_PER_SEC,
  KART_BUMP_TRANSFER,
  KART_DRAG_PER_SEC,
  KART_FALL_SEC,
  KART_MAX_REVERSE_PX_PER_SEC,
  KART_MAX_SPEED_PX_PER_SEC,
  KART_RADIUS_PX,
  KART_STEER_AT_REST,
  KART_STEER_RAD_PER_SEC,
} from '../constants.js';
import { isWalkable } from '../layout/tileMap.js';
import { TILE_SIZE, type GroundMap, type WallEdges } from '../types.js';
import { crossingBlocked } from '../wallEdges.js';
import { gateAt, headingFrom, nextGate, type RaceTrack } from './track.js';

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
  /** Set once the kart has crossed the finish for the last lap. */
  finished: boolean;
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
    finished: false,
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
 * One tick of one kart. Returns what the room has to react to, so the caller decides what a lap
 * or a finish MEANS (a message, a score, a chequered flag) while this file stays pure.
 */
export function updateKart(kart: Kart, dt: number, world: KartWorld): { lapped: boolean; fell: boolean } {
  if (kart.state === 'fall') {
    kart.fallTimer -= dt;
    if (kart.fallTimer <= 0) respawn(kart, world);
    return { lapped: false, fell: false };
  }

  const input = kart.driverId === null || kart.finished ? NEUTRAL_INPUT : kart.input;
  const fx = Math.cos(kart.heading);
  const fy = Math.sin(kart.heading);

  // ── steering ──────────────────────────────────────────────────────────────
  // Scaled by how fast it is going, so a parked kart can still be aimed (slowly) but nobody
  // pirouettes. Reversing steers the other way round, like a real vehicle.
  let along = kart.vx * fx + kart.vy * fy;
  if (input.steer !== 0) {
    const grip = KART_STEER_AT_REST + (1 - KART_STEER_AT_REST) * Math.min(1, Math.abs(along) / KART_MAX_SPEED_PX_PER_SEC);
    const sign = along < 0 ? -1 : 1;
    kart.heading += input.steer * sign * KART_STEER_RAD_PER_SEC * grip * dt;
  }

  // ── thrust, drag and grip ─────────────────────────────────────────────────
  // Recomputed after the turn, so thrust goes where the kart NOW points.
  const hx = Math.cos(kart.heading);
  const hy = Math.sin(kart.heading);
  along = kart.vx * hx + kart.vy * hy;
  // Sideways velocity: drift, and where a bump from the flank lives.
  let side = -kart.vx * hy + kart.vy * hx;

  if (input.throttle > 0) along += KART_ACCEL_PX_PER_SEC2 * dt;
  else if (input.throttle < 0) along -= KART_BRAKE_PX_PER_SEC2 * dt;
  along -= along * Math.min(1, KART_DRAG_PER_SEC * dt);
  side -= side * Math.min(1, KART_LATERAL_GRIP_PER_SEC * dt);
  along = Math.max(-KART_MAX_REVERSE_PX_PER_SEC, Math.min(KART_MAX_SPEED_PX_PER_SEC, along));
  if (Math.abs(along) < 1 && input.throttle === 0) along = 0;
  if (Math.abs(side) < 1) side = 0;
  kart.vx = hx * along - hy * side;
  kart.vy = hy * along + hx * side;

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
      if (kart.lap >= world.track.laps) kart.finished = true;
      return { lapped: true, fell: false };
    }
  }
  return { lapped: false, fell: false };
}

/** Put a fallen kart back at the last gate it passed, pointing at the next one. */
export function respawn(kart: Kart, world: KartWorld): void {
  const gate = world.track.gates[kart.gate] ?? world.track.gates[0];
  kart.x = gate.x;
  kart.y = gate.y;
  kart.heading = headingFrom(world.track, gate);
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
