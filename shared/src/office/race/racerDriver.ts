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
 *  - **And the road is probed along the ARC it is about to drive**, not along a straight line.
 *    This is the fourth rule and the one that made it quick: see `room` for the measurement.
 *
 * Two DISTANCES, and confusing them is the mistake to avoid here. `look` is the clearance horizon
 * — how far ahead it checks that the road holds — and it is scaled by skill. `L` is the pure-
 * pursuit aim distance, which is geometry: it decides how hard the car turns, and a cautious
 * driver does not get to live on a tighter circuit than a quick one.
 *
 * Pure, deterministic and world-shaped like the rest of the model, so a test can drive a full race
 * with no room, no clients and no clock. `skill` is the one thing that makes two of them different:
 * it scales how far ahead they look, how late they lift and — since the road stopped being what
 * held anybody back — the PACE they run at, so the grid is a field rather than a train of
 * identical karts, and so a human can beat the slow ones.
 */
import { KART_RADIUS_PX, KART_MAX_SPEED_PX_PER_SEC } from '../constants.js';
import { isWalkable } from '../layout/tileMap.js';
import { TILE_SIZE } from '../types.js';
import type { Kart, KartInput, KartWorld } from './kart.js';
import { isRough, nextPoint } from './track.js';

/**
 * How far ahead a perfect driver looks — as a TIME, and converted to tiles at the speed it is
 * actually doing. Scaled by skill on top.
 *
 * It was a fixed thirteen tiles, and that is one of several numbers in this model to have been a
 * distance pretending to be a constant (`KART_BOARD_REACH_TILES` is another, and two more went
 * with the tyre model). At
 * 260 px/s thirteen tiles is 0.8 s of warning; at 370 it is half a second, which is less than the
 * car needs to shed the speed — so raising the top speed stopped working long before the road ran
 * out of width. Measured: with the fixed look, a 13-tile road and a 170 px turn radius put nobody
 * round a single corner in 200 seconds; with this one the same geometry races.
 */
const LOOK_SECONDS = 1.15;
/** How far down the road the aim point sits, as a time at the speed being carried. See `L`. */
const PURSUIT_SECONDS = 0.55;
const LOOK_TILES_MIN = 7;
const LOOK_TILES_MAX = 34;
/**
 * What the slowest driver on the grid runs at, as a fraction of the car's top speed; skill scales
 * from here to the whole of it.
 *
 * The floor is what keeps a race a race — a beginner's lap must be a lap and not a tour — and the
 * top being the car's own limit is what leaves a human something to beat: `RACER_SKILLS` tops out
 * at 0.92, so the quickest of a MEDIUM field runs at 96 % and a clean human lap wins.
 */
const PACE_FLOOR = 0.62;
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
 * How far the road holds along a heading, in tiles, sweeping a corridor a kart wide — and, with a
 * curvature, along the ARC the car is actually going to drive rather than the line it points down.
 *
 * The straight ray was the single thing holding this driver's pace down, and the number says so:
 * on the raceway it braked on 30 % of all ticks while `tight` — the clause written for the bridge
 * — fired on 1 %. A car in a corner is always pointing at the outside of it, so a tangent probe
 * runs into the kerb within a couple of tiles however wide and sweeping the corner is, and the
 * driver reads "the road is about to end" for as long as the corner lasts. It is not a lookahead
 * of the road at all; it is a lookahead of a road that does not bend.
 *
 * `curvature` is 1/radius with a sign (left is positive, as everywhere else in this file), so 0 is
 * exactly the old straight ray and there is one function rather than two — an arc probe beside a
 * ray probe is the shape where the two drift apart and only one of them learns about rough.
 */
function room(kart: Kart, world: KartWorld, heading: number, maxTiles: number, curvature = 0): number {
  // ROAD, not merely ground: grass is drivable and a driver that probed for "somewhere I can go"
  // would cut every corner across it, and the racing line would stop meaning anything.
  const ok = (x: number, y: number): boolean => {
    const col = Math.floor(x / TILE_SIZE);
    const row = Math.floor(y / TILE_SIZE);
    return isWalkable(col, row, world.tileMap, world.blockedTiles) && !isRough(world.track, col, row);
  };
  const step = TILE_SIZE / 2;
  let x = kart.x;
  let y = kart.y;
  let dir = heading;
  for (let t = 1; t <= maxTiles * 2; t++) {
    // Integrated rather than solved: a circle has a closed form, but stepping it costs the same
    // half-tile the straight probe already costs and stays right if the curvature is ever varied
    // along the arc.
    dir += curvature * step;
    x += Math.cos(dir) * step;
    y += Math.sin(dir) * step;
    // The corridor is a kart wide and turns WITH the arc, or the bodywork is measured across the
    // road on the way into a corner.
    const px = -Math.sin(dir) * KART_RADIUS_PX;
    const py = Math.cos(dir) * KART_RADIUS_PX;
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
  const level = Math.max(0, Math.min(1, skill.level));
  // From the speed it is CARRYING, not from the speed it could reach: a car crawling out of a
  // spin does not need to plan a third of the circuit.
  const reach = (Math.max(Math.hypot(kart.vx, kart.vy), KART_MAX_SPEED_PX_PER_SEC * 0.35) * LOOK_SECONDS) / TILE_SIZE;
  const look = Math.max(
    LOOK_TILES_MIN,
    Math.min(LOOK_TILES_MAX, Math.round(reach * (0.55 + 0.45 * level))),
  );
  // Where this car is going: the next gate, or the LINE if it is on a stage's final leg.
  const target = nextPoint(world.track, kart.gate);
  const toGate = Math.atan2(target.y - kart.y, target.x - kart.x);

  const speed0 = Math.hypot(kart.vx, kart.vy);
  const course0 = speed0 > 5 ? Math.atan2(kart.vy, kart.vx) : kart.heading;
  // How far down the road the car aims, as a TIME again — the pure-pursuit lookahead, and NOT the
  // clearance horizon `look`. Tying the two together is the mistake that cost a measurement: a
  // cautious driver looks less far ahead, so the same aim angle became a much tighter arc, every
  // candidate line left the road within a tile or two, and the slow half of the grid crawled round
  // at a quarter of the pace and did not finish. Skill decides when to lift; it does not get to
  // decide what geometry a corner has.
  const L = Math.max(TILE_SIZE * 4, speed0 * PURSUIT_SECONDS);
  /** The arc this car would drive if it aimed there — pure pursuit, tangent to where it is going. */
  const arcTo = (aim: number): number => {
    let a = aim - course0;
    while (a > Math.PI) a -= Math.PI * 2;
    while (a < -Math.PI) a += Math.PI * 2;
    return (2 * Math.sin(a)) / L;
  };
  // Widen the line until the road holds, smallest correction first — and judge each candidate by
  // the ARC it commits the car to, from where the car is actually going. Judged as straight lines,
  // the widest-open direction on a corner is the one that points across it, so the car lived on
  // the kerb and everything downstream read the kerb as the road running out.
  let want = toGate;
  let best = -1;
  for (const off of OFFSETS) {
    const aim = toGate + off;
    const r = room(kart, world, course0, look, arcTo(aim));
    if (r > best) {
      best = r;
      want = aim;
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
  // The curvature the car is about to drive, from pure pursuit: an arc from here, tangent to the
  // course, through the point it is aiming at. `2 sin(alpha) / L` is the standard result and it is
  // the honest answer to "how hard am I about to turn" — it comes from the same aim the steering
  // uses, so what is probed and what is driven cannot disagree.
  const ahead = room(kart, world, course, look + 1, arcTo(want));
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
  // The pace this driver runs at. It used to be Infinity outside a tight stretch, which was fine
  // while the road probe was what held everybody back — with the arc probe nobody lifts at all on
  // these three tracks, so every driver did exactly the same lap time and the grid stopped being a
  // field (measured: 65.6 s against 65.7 s for half the skill). Skill has to say something of its
  // own once the geometry stops saying it, and what a weaker driver does is carry less speed.
  const pace = KART_MAX_SPEED_PX_PER_SEC * (PACE_FLOOR + (1 - PACE_FLOOR) * level);
  const limit = tight ? Math.min(pace, KART_MAX_SPEED_PX_PER_SEC * (0.42 + 0.16 * level)) : pace;
  // The crawl floor keeps a cautious driver moving at all — but only where there is somewhere to
  // move TO. Without that second clause it fires hardest exactly when the car is jammed against a
  // wall, because being stopped is its whole trigger: full throttle, no ground, and the harder it
  // pushes the longer it stays. That is how a car spends a whole race in the barrier.
  const floor = speed < crawl && ahead > 0.5;
  const throttle = (ahead >= lift && speed < limit) || floor ? 1 : ahead < look * 0.22 || speed > limit * 1.25 ? -1 : 0;

  return { throttle, steer: diff > 0.05 ? 1 : diff < -0.05 ? -1 : 0 };
}
