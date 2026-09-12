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
import { KART_RADIUS_PX, KART_MAX_SPEED_PX_PER_SEC } from '../constants.js';
import { isWalkable } from '../layout/tileMap.js';
import { TILE_SIZE } from '../types.js';
import type { Kart, KartInput, KartWorld } from './kart.js';
import { nextGate } from './track.js';

/** How far ahead a perfect driver looks, in tiles. Scaled by skill. */
const LOOK_TILES = 9;
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

/** How far the road holds along a heading, in tiles, sweeping a corridor a kart wide. */
function room(kart: Kart, world: KartWorld, heading: number, maxTiles: number): number {
  const px = -Math.sin(heading) * KART_RADIUS_PX;
  const py = Math.cos(heading) * KART_RADIUS_PX;
  const ok = (x: number, y: number): boolean =>
    isWalkable(Math.floor(x / TILE_SIZE), Math.floor(y / TILE_SIZE), world.tileMap, world.blockedTiles);
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
  const level = Math.max(0, Math.min(1, skill.level));
  const look = Math.max(4, Math.round(LOOK_TILES * (0.55 + 0.45 * level)));
  const target = nextGate(world.track, kart.gate);
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

  const speed = Math.hypot(kart.vx, kart.vy);
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
  const throttle = (ahead >= lift && speed < limit) || speed < crawl ? 1 : ahead < look * 0.22 || speed > limit * 1.25 ? -1 : 0;

  return { throttle, steer: diff > 0.05 ? 1 : diff < -0.05 ? -1 : 0 };
}
