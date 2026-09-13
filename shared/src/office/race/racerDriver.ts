/**
 * How a computer driver gets round: look ahead, aim at the next gate, lift when it will not fit.
 *
 * This exists because a race with nobody in it is not a race. Bumping — the first thing asked of
 * this whole feature — has no meaning alone, a position is a number with no one behind it, and a
 * lap time is a stopwatch. Filling the grid is what turns the track into a game, so the driver is
 * a first-class part of it rather than a demo toy.
 *
 * It is the autopilot the track's own test drives, promoted: the same three rules, which between
 * them are the difference between a driver and a projectile.
 *
 *  - **The road is probed in HALF tiles.** At whole tiles the ray strides straight over the one
 *    cell where the infield pokes into the road, and the driver reports a clear road one tick
 *    before falling into it.
 *  - **It probes a CORRIDOR a kart wide**, not a line. The bodywork clips an inside corner the
 *    centre ray misses entirely.
 *  - **The throttle is read along the COURSE, not the heading.** A kart slides; the wall it hits
 *    is the one its velocity points at.
 *
 * Pure, deterministic and world-shaped like the rest of the model, so a test can drive a full race
 * with no room, no clients and no clock. `skill` is the one thing that makes two of them different:
 * it scales how far ahead they look and how late they lift, so the grid is a field rather than a
 * train of identical karts, and so a human can beat the slow ones.
 */
import { KART_RADIUS_PX, KART_MAX_SPEED_PX_PER_SEC, TYRE_WARN } from '../constants.js';
import { isWalkable } from '../layout/tileMap.js';
import { TILE_SIZE } from '../types.js';
import type { Kart, KartInput, KartWorld } from './kart.js';
import { isRough, nextPoint } from './track.js';

/** How far ahead a perfect driver looks, in tiles. Scaled by skill. */
const LOOK_TILES = 13;
/**
 * How far away a pit box is still worth pulling into, in tiles. Beyond it, carry on and take it
 * next lap — a detour across the circuit costs more than a worn set.
 *
 * Both of these are DISTANCES, so they are really times: nine tiles at the old pace was most of a
 * second to decide in, and at the new one it is half. Measured before they grew, most of the
 * field finished a race on bald tyres having driven past the pit lane every lap — the decision
 * window had closed faster than the driver could take it.
 */
const PIT_REACH_TILES = 14;
/** Below this much road to the left and right combined, a stretch counts as tight. */
const TIGHT_TILES = 3.2;
/** Candidate steering offsets, smallest correction first, both ways round. */
const OFFSETS: readonly number[] = (() => {
  const out = [0];
  for (let deg = 10; deg <= 120; deg += 10) out.push((deg * Math.PI) / 180, (-deg * Math.PI) / 180);
  return out;
})();

/** A computer driver's competence, 0…1. Kept on the character that owns the kart. */
export interface RacerSkill {
  /** 0 = looks barely ahead and lifts late; 1 = the quick one. */
  level: number;
}

/**
 * A pit box this car could pull into from here: near, and with clear road all the way.
 *
 * Both halves matter. NEAR, because a box on the far side of the circuit is not an opportunity,
 * it is a detour through whatever lies between. CLEAR, because "near" in a straight line says
 * nothing on a track that bends — the infield of a ring is always nearer than the road round it.
 * A car already stopped in a box finds it at a distance of nothing and stays put.
 */
function pitAhead(kart: Kart, world: KartWorld): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null;
  let bestD = Infinity;
  for (const cell of world.track.pit) {
    const [c, r] = cell.split(',');
    const x = Number(c) * TILE_SIZE + TILE_SIZE / 2;
    const y = Number(r) * TILE_SIZE + TILE_SIZE / 2;
    const d = Math.hypot(x - kart.x, y - kart.y);
    if (d >= bestD || d > PIT_REACH_TILES * TILE_SIZE) continue;
    const tiles = d / TILE_SIZE;
    if (tiles > 0.4 && room(kart, world, Math.atan2(y - kart.y, x - kart.x), Math.ceil(tiles)) < tiles - 0.5) {
      continue; // something between here and there
    }
    bestD = d;
    best = { x, y };
  }
  return best;
}

/** Steer at a point and stop on it — what a pit stop is made of. */
function towards(kart: Kart, world: KartWorld, to: { x: number; y: number }): KartInput {
  const want = Math.atan2(to.y - kart.y, to.x - kart.x);
  let diff = want - kart.heading;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  const d = Math.hypot(to.x - kart.x, to.y - kart.y);
  const speed = Math.hypot(kart.vx, kart.vy);
  // Brake into it and hold still on it: the crew will not work above PIT_SPEED_PX_PER_SEC.
  const throttle = d < TILE_SIZE * 1.2 ? (speed > 10 ? -1 : 0) : d < TILE_SIZE * 5 && speed > 110 ? -1 : 1;
  const clear = room(kart, world, want, 3) >= 2.5;
  return { throttle: clear ? throttle : 0, steer: diff > 0.05 ? 1 : diff < -0.05 ? -1 : 0 };
}

/** How far the road holds along a heading, in tiles, sweeping a corridor a kart wide. */
function room(kart: Kart, world: KartWorld, heading: number, maxTiles: number): number {
  const px = -Math.sin(heading) * KART_RADIUS_PX;
  const py = Math.cos(heading) * KART_RADIUS_PX;
  // ROAD, not merely ground: grass is drivable and a driver that probed for "somewhere I can go"
  // would cut every corner across it, and the racing line would stop meaning anything.
  const ok = (x: number, y: number): boolean => {
    const col = Math.floor(x / TILE_SIZE);
    const row = Math.floor(y / TILE_SIZE);
    return isWalkable(col, row, world.tileMap, world.blockedTiles) && !isRough(world.track, col, row);
  };
  for (let t = 1; t <= maxTiles * 2; t++) {
    const x = kart.x + Math.cos(heading) * t * (TILE_SIZE / 2);
    const y = kart.y + Math.sin(heading) * t * (TILE_SIZE / 2);
    if (!ok(x, y) || !ok(x + px, y + py) || !ok(x - px, y - py)) return (t - 1) / 2;
  }
  return maxTiles;
}

/**
 * What this driver asks of its kart this tick.
 *
 * Never reverses. A negative throttle flips the sign of every steering correction — a kart steers
 * the other way round going backwards, like a real vehicle — and a driver that reaches for it in a
 * corner drives the track backwards at the reverse cap. That was a real afternoon.
 */
export function racerInput(kart: Kart, world: KartWorld, skill: RacerSkill): KartInput {
  // Home on a STAGE: slow down and stop. The gates are a ring, so the one after the last is the
  // first — and on a circuit that is exactly right, it is the cool-down lap. On a point-to-point
  // it turned the finishers round and sent them back down the course into the cars still racing,
  // which is what a ring means when the road does not actually loop.
  if (kart.finished && world.track.sprint) {
    return { throttle: Math.hypot(kart.vx, kart.vy) > 25 ? -1 : 0, steer: 0 };
  }
  // Worn out and a pit box is right there: pull in. OPPORTUNISTIC on purpose — it stops only at
  // one it is about to drive past, with clear road the whole way, and otherwise carries on and
  // takes it next lap. The first version aimed at the nearest box from anywhere on the circuit,
  // which on a short track means straight across the infield: measured at eighty falls per car
  // per race, every car, because a pit lane on the far side is a cliff with a target painted on
  // it.
  if (kart.tyre < TYRE_WARN && world.track.pit.size > 0) {
    const box = pitAhead(kart, world);
    if (box) return towards(kart, world, box);
  }
  const level = Math.max(0, Math.min(1, skill.level));
  const look = Math.max(4, Math.round(LOOK_TILES * (0.55 + 0.45 * level)));
  // Where this car is going: the next gate, or the LINE if it is on a stage's final leg.
  const target = nextPoint(world.track, kart.gate);
  const toGate = Math.atan2(target.y - kart.y, target.x - kart.x);

  // Widen the line until the road holds, smallest correction first.
  let want = toGate;
  let best = -1;
  for (const off of OFFSETS) {
    const r = room(kart, world, toGate + off, look);
    if (r > best) {
      best = r;
      want = toGate + off;
      if (r === look) break;
    }
  }
  let diff = want - kart.heading;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  // The straight line back to the next gate, for a car that is off the road — the widened line
  // above is chosen from the ROAD, and out here there is none to choose from.
  let recover = toGate - kart.heading;
  while (recover > Math.PI) recover -= Math.PI * 2;
  while (recover < -Math.PI) recover += Math.PI * 2;

  const speed = Math.hypot(kart.vx, kart.vy);
  // Wedged against something, and the physics has said so. Back out, swinging the nose towards
  // the gate while doing it — reversing steers the other way round (see `updateKart`), so the sign
  // is flipped, and a reverse that came straight back out would re-enter the same wall at the same
  // angle. This is the one place a computer driver reverses on purpose.
  if (kart.recoverMs > 0) {
    return { throttle: -1, steer: recover > 0 ? -1 : 1 };
  }
  // ALREADY off the road: drive back towards the next gate and never mind the probe, which sees
  // no road from out here and would brake for ever. Measured: one car per race sat in the grass
  // at a standstill until the flag, with nothing wrong except that it could not see a way on.
  if (isRough(world.track, Math.floor(kart.x / TILE_SIZE), Math.floor(kart.y / TILE_SIZE))) {
    return {
      throttle: speed < KART_MAX_SPEED_PX_PER_SEC * 0.35 ? 1 : 0,
      steer: recover > 0.05 ? 1 : recover < -0.05 ? -1 : 0,
    };
  }
  const course = speed > 5 ? Math.atan2(kart.vy, kart.vx) : kart.heading;
  const ahead = room(kart, world, course, look + 1);
  // How much road there is BESIDE it. A clear view forward says nothing about a narrow bridge:
  // measured, the quickest driver crossed one flat out, drifted a tile and fell — forty-five
  // times in three minutes, respawning at the gate on the bridge and doing it again. Somewhere
  // this tight is taken at a pace a slide can be caught at.
  const beside = room(kart, world, course + Math.PI / 2, 3) + room(kart, world, course - Math.PI / 2, 3);
  const tight = beside < TIGHT_TILES;
  // Lift early or late by skill, and keep a floor so a slow driver still gets moving at all. The
  // brake comes out only when the road is genuinely about to run out.
  const lift = (look * 0.62) * (1.25 - 0.45 * level);
  const crawl = KART_MAX_SPEED_PX_PER_SEC * (0.2 + 0.14 * level);
  const limit = tight ? KART_MAX_SPEED_PX_PER_SEC * (0.42 + 0.16 * level) : Infinity;
  // The crawl floor keeps a cautious driver moving at all — but only where there is somewhere to
  // move TO. Without that second clause it fires hardest exactly when the car is jammed against a
  // wall, because being stopped is its whole trigger: full throttle, no ground, and the harder it
  // pushes the longer it stays. That is how a car spends a whole race in the barrier.
  const floor = speed < crawl && ahead > 0.5;
  const throttle = (ahead >= lift && speed < limit) || floor ? 1 : ahead < look * 0.22 || speed > limit * 1.25 ? -1 : 0;

  return { throttle, steer: diff > 0.05 ? 1 : diff < -0.05 ? -1 : 0 };
}
