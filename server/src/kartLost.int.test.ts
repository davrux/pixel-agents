/**
 * A car that is getting nowhere is put back on the track — and nothing else is.
 *
 * The warning used to be the end of the story. Measured in a browser on Monza with a full field,
 * seventy-five seconds of ordinary human driving: the car ended up nose-first against the outside
 * barrier and then wedged in the infield grass between the two straights, and "WRONG WAY" stood
 * there for forty-five seconds while the field lapped it three times. The detection was right every
 * time — the car really was going backwards — but a driver pressed into a wall has nothing to do
 * about it, because the backing-out manoeuvre the physics arms (`recoverMs`) is acted on by the
 * computer drivers alone.
 *
 * So the banner is a countdown now, and the four claims below are the ways that can go wrong: it
 * has to rescue the two shapes of being lost, it must never pick up a car that is racing, it must
 * not fire while the grid is held, and it must not become a shortcut.
 *
 * TEST BOUNDARIES:
 *   @real-dependency: the three committed tracks through the real importer and OfficeState --
 *       Mock? NO. Being wedged is a fact about a real barrier on a real map; a wall invented in a
 *       fixture would be a wall chosen to pass.
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { before } from 'node:test';

import {
  KART_LOST_SEC,
  KART_RESCUE_NOTICE_SEC,
  KART_WRONG_WAY_SEC,
  RACE_TICK_HZ,
} from '@pixel/shared/office/constants.js';
import { OfficeState } from '@pixel/shared/office/engine/officeState.js';
import { buildDynamicCatalog } from '@pixel/shared/office/layout/furnitureCatalog';
import { isWalkable } from '@pixel/shared/office/layout/tileMap.js';
import type { KartInput } from '@pixel/shared/office/race/kart.js';
import { racerInput } from '@pixel/shared/office/race/racerDriver.js';
import { gateBehind, isRough, nextPoint, type RaceTrack } from '@pixel/shared/office/race/track.js';
import { TILE_SIZE, type OfficeLayout } from '@pixel/shared/office/types';

import { buildFurnitureCatalogAndSprites } from './assets.js';
import { importTmjToLayout } from './tiled/mapBridge.js';
import { loadTiledRegistry } from './tiled/tiledRegistry.js';

const ROOT = join(import.meta.dirname, '..', '..');
const TRACKS = ['raceway', 'monza'] as const;
const layouts = new Map<string, OfficeLayout>();

before(async () => {
  buildDynamicCatalog((await buildFurnitureCatalogAndSprites()) as never);
  const reg = loadTiledRegistry(ROOT);
  for (const zone of TRACKS) {
    layouts.set(
      zone,
      importTmjToLayout(
        JSON.parse(readFileSync(join(ROOT, 'assets', 'tiled', 'zones', `${zone}.tmj`), 'utf8')),
        reg,
        () => null,
      ).layout,
    );
  }
});

const DT = 1 / RACE_TICK_HZ;
/** How long a car may get nowhere before it is put back. */
const LOST_SEC = KART_LOST_SEC;

interface Sim {
  os: OfficeState;
  track: RaceTrack;
  kart: ReturnType<OfficeState['raceTrack']> extends null ? never : NonNullable<ReturnType<typeof firstKart>>;
  tileMap: number[][];
  blockedTiles: Set<string>;
}

function firstKart(os: OfficeState) {
  return [...os.karts.values()][0];
}

/** One human at the wheel, alone on a track, the lights already out. */
function seated(zone: string): Sim {
  const os = new OfficeState(layouts.get(zone) as never);
  const track = os.raceTrack();
  assert.ok(track, `${zone} is not a track`);
  // The player comes FIRST: a kart is spawned for whoever walks onto the track and belongs to
  // them, so there is nothing on the grid to take before somebody is there to own it.
  const driver = os.addPlayer('char_0', 'Lost', undefined, `lost-${zone}`);
  const ch = os.characters.get(driver);
  assert.ok(ch);
  const kart = [...os.karts.values()].find((k) => k.ownerId === driver);
  assert.ok(kart, `${zone}: no kart was spawned for the player`);
  ch.x = kart.x;
  ch.y = kart.y;
  assert.equal(os.boardKart(driver), true, 'could not board the kart on the grid');
  // Alone: computer drivers now get a car MADE for them at the start, so a lone-driver
  // fixture has to say it is alone — it is no longer a side effect of an empty grid.
  os.setRaceSetup({ bots: 0 });
  assert.equal(os.startRace(), true, 'the race would not start');
  while (os.raceInfo().phase === 'countdown') os.update(DT);
  const inner = os as unknown as { tileMap: number[][]; blockedTiles: Set<string> };
  return { os, track, kart, tileMap: inner.tileMap, blockedTiles: inner.blockedTiles } as Sim;
}

/**
 * Hold an input until the car TELEPORTS, and say when.
 *
 * A jump of more than two tiles in one tick is not something the physics can do — the car moves at
 * most a third of a tile per tick at its top speed — so it is the honest signal that something put
 * the car somewhere, and it needs no flag in the engine to report. Asking the WARNING instead does
 * not work: it flickers off for a tick whenever a sliding car drops below the speed the direction
 * question needs, which reads as a rescue that has not happened.
 */
function holdUntilMoved(sim: Sim, input: KartInput, seconds: number): number {
  const ticks = Math.round(seconds / DT);
  let last = { x: sim.kart.x, y: sim.kart.y };
  for (let i = 0; i < ticks; i++) {
    sim.kart.input = { ...input };
    sim.os.update(DT);
    if (Math.hypot(sim.kart.x - last.x, sim.kart.y - last.y) > TILE_SIZE * 2) return i * DT;
    last = { x: sim.kart.x, y: sim.kart.y };
  }
  return -1;
}

const onRoad = (sim: Sim, x: number, y: number): boolean => {
  const col = Math.floor(x / TILE_SIZE);
  const row = Math.floor(y / TILE_SIZE);
  return isWalkable(col, row, sim.tileMap, sim.blockedTiles) && !isRough(sim.track, col, row);
};

test('a car wedged against a barrier with the throttle down is put back on the road', () => {
  // The measured case, and the one the speed guard used to hide entirely: a jammed car is not going
  // the WRONG way, it is going no way at all, so it never saw the warning either.
  for (const zone of TRACKS) {
    const sim = seated(zone);
    // A real barrier on a real map: road with something solid beside it.
    const spot = barrierNear(sim);
    sim.kart.x = spot.x;
    sim.kart.y = spot.y;
    sim.kart.heading = spot.heading;
    sim.kart.vx = 0;
    sim.kart.vy = 0;
    // Full throttle into it, exactly what a driver does. Long enough to jam and be rescued.
    const moved = holdUntilMoved(sim, { throttle: 1, steer: 0 }, LOST_SEC + 1.5);
    assert.ok(moved >= 0, `${zone}: a car with full throttle against a barrier was never recovered`);
    assert.ok(
      moved >= LOST_SEC - 3 * DT && moved <= LOST_SEC + 1,
      `${zone}: recovered after ${moved.toFixed(1)} s, not around ${LOST_SEC} s`,
    );
    assert.ok(onRoad(sim, sim.kart.x, sim.kart.y), `${zone}: put back onto rough ground, not the road`);
    assert.equal(sim.kart.lostMs, 0, `${zone}: the counter was not cleared with the rescue`);
  }
});

test('a car driven back down the road is warned, then put back facing the right way', () => {
  const sim = seated('monza');
  const gate = sim.track.gates[sim.kart.gate];
  const target = nextPoint(sim.track, sim.kart.gate);
  // Mid-leg, pointing back the way it came, with the throttle open.
  sim.kart.x = gate.x;
  sim.kart.y = gate.y;
  sim.kart.heading = Math.atan2(gate.y - target.y, gate.x - target.x);
  const gapBefore = Math.hypot(target.x - sim.kart.x, target.y - sim.kart.y);

  // A driver who INSISTS, steering to hold the reverse of the leg — without which the car drifts
  // onto the grass, slows below the speed the direction question needs, and the counter clears for
  // a reason that has nothing to do with a rescue. That flicker is why the warning itself is not
  // what these probes read.
  let warnedAt = -1;
  let rescuedAt = -1;
  let peakMs = 0;
  const ticks = Math.round((LOST_SEC + 1.5) / DT);
  for (let i = 0; i < ticks; i++) {
    const back = nextPoint(sim.track, sim.kart.gate);
    const away = Math.atan2(sim.kart.y - back.y, sim.kart.x - back.x);
    const off = ((away - sim.kart.heading + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    sim.kart.input = { throttle: 1, steer: Math.abs(off) < 0.05 ? 0 : off > 0 ? 1 : -1 };
    sim.os.update(DT);
    if (warnedAt < 0 && sim.kart.wrongWay) warnedAt = i * DT;
    // The rescue is the counter going back to zero AFTER it has run its full length. The jump probe
    // cannot see this case and that is by design: a car going the wrong way ON the road is put back
    // onto the road beside it, a move of a tile or two — the whole point of a short respawn reach.
    if (rescuedAt < 0 && peakMs >= (LOST_SEC - 2 * DT) * 1000 && sim.kart.lostMs === 0) rescuedAt = i * DT;
    peakMs = Math.max(peakMs, sim.kart.lostMs);
    if (rescuedAt >= 0) break;
  }
  assert.ok(warnedAt >= 0, 'driving back down the road was never called the wrong way');
  assert.ok(warnedAt >= KART_WRONG_WAY_SEC * 0.8, `the warning came after only ${warnedAt.toFixed(2)} s`);
  assert.ok(rescuedAt >= 0, `a car driven the wrong way for ${(LOST_SEC + 1.5).toFixed(1)} s was never put back`);
  assert.ok(rescuedAt >= LOST_SEC - 3 * DT, `put back after ${rescuedAt.toFixed(2)} s, sooner than ${LOST_SEC} s`);
  assert.equal(sim.kart.wrongWay, false, 'the warning survived the rescue');
  assert.ok(onRoad(sim, sim.kart.x, sim.kart.y), 'put back onto rough ground, not the road');
  // Pointing at what it is meant to be driving towards…
  const next = nextPoint(sim.track, sim.kart.gate);
  const want = Math.atan2(next.y - sim.kart.y, next.x - sim.kart.x);
  const off = Math.abs(((sim.kart.heading - want + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
  assert.ok(off < 0.05, `put back facing ${((off * 180) / Math.PI).toFixed(0)}° away from the next gate`);
  // …and never closer to it than the trouble started, or being lost would be the fast way round.
  const gapAfter = Math.hypot(next.x - sim.kart.x, next.y - sim.kart.y);
  assert.ok(
    gapAfter >= gapBefore - TILE_SIZE,
    `the rescue gained ground: ${((gapBefore - gapAfter) / TILE_SIZE).toFixed(1)} tiles nearer the next gate`,
  );
});

/**
 * A car that went ROUND a checkpoint is not called the wrong way for the rest of the lap.
 *
 * This is the report that would not go away — "immer noch Wrong way obwohl ich richtig rum fahre",
 * and "so unspielbar". A gate is one cell thick and spans the ROAD, so a car that leaves the road
 * and rejoins past the line never touches it: `kart.gate` then names a leg the car left behind,
 * and the direction question was asked against THAT. Measured over nine minutes of deliberately
 * bad driving, the gate disagreed with where the car actually was for 12 % of ticks on the raceway
 * and 26 % on Monza, in 58 and 72 separate spells.
 *
 * What it costs is not a flicker. Driven from just past each gate with the index left one behind,
 * the car's own direction sat **166° from the stale leg on the raceway and 180° on Monza** — a
 * banner that comes on and stays on — for 1269 and 928 ticks over the 110° threshold across the
 * two circuits. Against the leg the car is standing on, the worst is 58° and 126°, and no case
 * warns at all.
 *
 * So `kart.gate` stays what it is (progress: laps, places, what a driver aims at, and not
 * derivable from a position without handing out shortcuts) and the WARNING asks the road under the
 * car instead. Both halves are asserted here, because a test that only checks the quiet side would
 * pass just as well if the warning had been deleted.
 */
test('skipping a checkpoint does not turn the car round in the eyes of the warning', () => {
  for (const zone of TRACKS) {
    const sim = seated(zone);
    let stale = 0;
    let steepest = 0;
    for (const gate of sim.track.gates) {
      // Just past the NEXT gate, driving the way that leg runs — a car that rejoined the road on
      // the far side of a checkpoint — while its own index still says it has not reached it.
      const skipped = (gate.index + 1) % sim.track.gates.length;
      const from = sim.track.gates[skipped];
      const to = nextPoint(sim.track, skipped);
      const len = Math.hypot(to.x - from.x, to.y - from.y);
      sim.kart.x = from.x + ((to.x - from.x) / len) * TILE_SIZE * 3;
      sim.kart.y = from.y + ((to.y - from.y) / len) * TILE_SIZE * 3;
      sim.kart.heading = Math.atan2(to.y - from.y, to.x - from.x);
      sim.kart.gate = gate.index;
      sim.kart.vx = 0;
      sim.kart.vy = 0;
      sim.kart.lostMs = 0;
      sim.kart.wrongMs = 0;
      sim.kart.wrongWay = false;
      sim.kart.rescueMs = 0;
      sim.kart.anchorX = sim.kart.x;
      sim.kart.anchorY = sim.kart.y;
      if (gateBehind(sim.track, sim.kart.x, sim.kart.y) === sim.kart.gate) continue; // not stale here
      stale++;
      const stuckAt = sim.kart.gate; // what the index says, and goes on saying
      // Driven properly from there — by the computer driver, because "driving on" is the claim and
      // a dumb straight line leaves the road on the first bend, spins, and then really IS going
      // backwards. What must not warn is somebody following the road.
      const world = {
        tileMap: sim.tileMap,
        blockedTiles: sim.blockedTiles,
        track: sim.track,
      } as unknown as Parameters<typeof racerInput>[1];
      let warned = 0;
      for (let i = 0; i < Math.round(4 / DT); i++) {
        sim.kart.input = racerInput(sim.kart, world, { level: 1 });
        sim.os.update(DT);
        if (sim.kart.wrongWay) warned++;
        // How wrong the stale reference IS while the car drives on, so this test cannot pass by
        // testing nothing. It is not wrong at the moment of the skip — two consecutive chords are
        // about 60° apart — it becomes wrong as the car drives away down a leg the index never
        // reached, which is exactly why the banner used to come on and stay on.
        const speed = Math.hypot(sim.kart.vx, sim.kart.vy);
        if (speed > 120) {
          const og = sim.track.gates[stuckAt];
          const oa = nextPoint(sim.track, stuckAt);
          const lx = oa.x - og.x;
          const ly = oa.y - og.y;
          const cos =
            (sim.kart.vx * lx + sim.kart.vy * ly) / (speed * Math.hypot(lx, ly));
          steepest = Math.max(steepest, Math.acos(Math.max(-1, Math.min(1, cos))));
        }
      }
      assert.equal(
        warned,
        0,
        `${zone}: a car that skipped gate ${skipped} was warned for ${(warned * DT).toFixed(1)} s while driving on`,
      );
    }
    assert.ok(stale >= 8, `${zone}: only ${stale} of its gates could be skipped, so this proves little`);
    assert.ok(
      steepest > (110 * Math.PI) / 180,
      `${zone}: the stale reference was never worse than ${((steepest * 180) / Math.PI).toFixed(0)}°, ` +
        'so this fixture no longer reproduces the bug it was written for',
    );
  }
});

/** A road cell with something solid beside it, and the way to point a car at it. */
function barrierNear(sim: Sim): { x: number; y: number; heading: number } {
  const from = { col: Math.floor(sim.kart.x / TILE_SIZE), row: Math.floor(sim.kart.y / TILE_SIZE) };
  for (let r = 2; r < 40; r++) {
    for (let dr = -r; dr <= r; dr++) {
      for (let dc = -r; dc <= r; dc++) {
        if (Math.max(Math.abs(dc), Math.abs(dr)) !== r) continue;
        const col = from.col + dc;
        const row = from.row + dr;
        if (!isWalkable(col, row, sim.tileMap, sim.blockedTiles)) continue;
        for (const [ox, oy, h] of [[1, 0, 0], [-1, 0, Math.PI], [0, 1, Math.PI / 2], [0, -1, -Math.PI / 2]] as const) {
          if (isWalkable(col + ox, row + oy, sim.tileMap, sim.blockedTiles)) continue;
          return { x: col * TILE_SIZE + TILE_SIZE / 2, y: row * TILE_SIZE + TILE_SIZE / 2, heading: h };
        }
      }
    }
  }
  assert.fail('no barrier anywhere near the grid to wedge a car against');
}

test('a car that keeps twitching against the barrier is still rescued', () => {
  // THE REGRESSION the decay exists for. The counter used to be cleared outright the moment the
  // car got anywhere at all, and a body bouncing off a wall does that every second tick — measured
  // on Monza, four and a half seconds of going the wrong way wiped by ONE tick at the wall. So the
  // countdown could be held short of its end for as long as the car kept twitching, which is the
  // whole of the reported case.
  const sim = seated('raceway');
  const spot = barrierNear(sim);
  sim.kart.x = spot.x;
  sim.kart.y = spot.y;
  sim.kart.heading = spot.heading;
  let rescued = -1;
  let last = { x: sim.kart.x, y: sim.kart.y };
  for (let i = 0; i < Math.round(25 / DT); i++) {
    // Mostly leaning on it, with a beat of nothing — the shape a bouncing car gives the counter.
    const t = (i * DT) % 0.65;
    const throttle: 1 | 0 = t < 0.5 ? 1 : 0;
    sim.kart.input = { throttle, steer: 0 };
    sim.os.update(DT);
    if (Math.hypot(sim.kart.x - last.x, sim.kart.y - last.y) > TILE_SIZE * 2) { rescued = i * DT; break; }
    last = { x: sim.kart.x, y: sim.kart.y };
  }
  assert.ok(rescued >= 0, 'a car twitching against a barrier was never rescued');
  assert.ok(onRoad(sim, sim.kart.x, sim.kart.y), 'put back onto rough ground, not the road');

  // The other half of the same claim — that getting somewhere CLEARS the counter — is pinned by
  // the clean run below rather than here, and that is the stronger test: if progress did not clear
  // it, a car racing for ninety seconds would be picked up every five of them.
});

/**
 * Being put back says so, and only for a moment.
 *
 * The rescue was silent: you were wedged, and then you were somewhere else. A teleport is the one
 * thing that happens to a driver without them doing it, and the client cannot derive it — a fall
 * looks exactly the same from the outside, which is the point: both deserve the line.
 */
test('a car that is put back says so, briefly', () => {
  const sim = seated('monza');
  assert.equal(sim.kart.rescueMs, 0, 'a car said it had been rescued before anything happened');
  const spot = barrierNear(sim);
  sim.kart.x = spot.x;
  sim.kart.y = spot.y;
  sim.kart.heading = spot.heading;
  const moved = holdUntilMoved(sim, { throttle: 1, steer: 0 }, LOST_SEC + 1.5);
  assert.ok(moved >= 0, 'the wedged car was never put back');
  assert.ok(sim.kart.rescueMs > 0, 'the car was put back without a word');
  // …and it is over quickly, rather than sitting on the screen for the rest of the lap.
  for (let i = 0; i < Math.round((KART_RESCUE_NOTICE_SEC + 0.5) / DT); i++) {
    sim.kart.input = { throttle: 0, steer: 0 };
    sim.os.update(DT);
  }
  assert.equal(sim.kart.rescueMs, 0, 'the notice never cleared');
});

test('a short reverse is not being lost', () => {
  // Backing off a kerb or out of a spin is ordinary driving, and it must cost nothing. The whole
  // reason the reset waits `KART_LOST_SEC` beyond the warning.
  const sim = seated('raceway');
  // A teleport is the signal, not the distance covered: reversing legitimately carries the car
  // most of a dozen tiles in the time this holds for.
  const moved = holdUntilMoved(sim, { throttle: -1, steer: 0 }, KART_LOST_SEC * 0.8);
  assert.equal(moved, -1, `a car reversing for a moment was put back after ${moved.toFixed(1)} s`);
});

test('the field is never picked up off the grid while the lights are still red', () => {
  // Held means the throttle is not connected yet, so a driver leaning on it is asking for thrust
  // and going nowhere — which is exactly what a car jammed against a barrier looks like. Without
  // the guard the whole grid is rescued during its own countdown.
  const os = new OfficeState(layouts.get('monza') as never);
  assert.ok(os.raceTrack());
  const driver = os.addPlayer('char_0', 'Grid', undefined, 'grid-lost');
  const ch = os.characters.get(driver);
  assert.ok(ch);
  const mine = [...os.karts.values()].find((k) => k.ownerId === driver);
  assert.ok(mine);
  ch.x = mine.x;
  ch.y = mine.y;
  assert.equal(os.boardKart(driver), true);
  assert.equal(os.startRace(), true);
  const before = new Map([...os.karts.values()].map((k) => [k.id, { x: k.x, y: k.y }]));
  let held = 0;
  while (os.raceInfo().phase === 'countdown' && held < 30 / DT) {
    for (const k of os.karts.values()) k.input = { throttle: 1, steer: 0 };
    os.update(DT);
    held++;
    // Asked while the lights are STILL red, so the tick that turns them green — where the cars are
    // legitimately stationary with the throttle already open — is not what is being measured.
    if (os.raceInfo().phase !== 'countdown') break;
    for (const k of os.karts.values()) {
      const was = before.get(k.id);
      assert.ok(was);
      assert.ok(
        Math.hypot(k.x - was.x, k.y - was.y) < 1,
        `kart ${k.id} moved ${Math.hypot(k.x - was.x, k.y - was.y).toFixed(1)} px while the grid was held`,
      );
      assert.equal(k.lostMs, 0, `kart ${k.id} was counted as lost on the grid`);
    }
  }
  assert.ok(held * DT > 1, `the countdown lasted ${(held * DT).toFixed(1)} s, so nothing was held`);
});

test('a clean run is never rescued — the only jumps are the falls', () => {
  // The claim that keeps the rescue from becoming a thing that happens to people who are racing.
  // A reset teleports the car, and so does a fall, so counting JUMPS and comparing them with the
  // falls is an independent way to see one without instrumenting the engine for it.
  //
  // This is also what pins `KART_LOST_MOVE_TILES` against the corners: the SLOWEST driver is the
  // one at risk, because the displacement is measured along a leg chord that a bend leans away
  // from — up to 55° on these circuits, so a crawl through a corner counts for little over half of
  // the ground it covers. Level 0 is the cautious end of the field.
  for (const [zone, level] of TRACKS.flatMap((z) => [[z, 2], [z, 0]] as const)) {
    const sim = seated(`${zone}`);
    const inner = sim.os as unknown as { tileMap: number[][]; blockedTiles: Set<string>; walls: unknown };
    const world = { tileMap: inner.tileMap, blockedTiles: inner.blockedTiles, walls: inner.walls, track: sim.track } as never;
    let jumps = 0;
    let falls = 0;
    let wrongTicks = 0;
    let last = { x: sim.kart.x, y: sim.kart.y };
    let wasFalling = false;
    for (let i = 0; i < Math.round(90 / DT); i++) {
      sim.kart.input = racerInput(sim.kart, world, { level });
      sim.os.update(DT);
      if (Math.hypot(sim.kart.x - last.x, sim.kart.y - last.y) > TILE_SIZE * 3) jumps++;
      if (sim.kart.state === 'fall' && !wasFalling) falls++;
      if (sim.kart.wrongWay) wrongTicks++;
      wasFalling = sim.kart.state === 'fall';
      last = { x: sim.kart.x, y: sim.kart.y };
    }
    assert.equal(jumps, falls, `${zone} at skill ${level}: ${jumps} teleports on a clean run against ${falls} falls`);
    assert.equal(wrongTicks, 0, `${zone} at skill ${level}: the warning came up on a clean run`);
    // The run has to have been a RUN: a driver that stopped on the line would pass everything
    // above by never going anywhere. A lap of the shortest circuit here is about twenty seconds.
    assert.ok(sim.kart.lap >= 1, `${zone} at skill ${level}: no lap completed, so the run proves nothing`);
  }
});
