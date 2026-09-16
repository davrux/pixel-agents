/**
 * A computer driver carries speed through a corner, and skill is what tells two of them apart.
 *
 * The driver could always get round; what it could not do was go quickly, and the report was
 * "es ist langsam". Measured on the committed raceway before this: a lone driver at the top skill
 * averaged **49 % of the car's top speed** and had the brakes on for 30 % of all ticks, while the
 * one clause written to slow it down — the narrow-bridge check — fired on 1 %. The cause was
 * geometric rather than a tuning number: the road was probed along a straight ray, and a car in a
 * corner points at the outside of it, so the probe ran into the kerb within a couple of tiles
 * however wide and sweeping the corner was. It is a lookahead of a road that does not bend.
 *
 * Probing the ARC the car is about to drive — the curvature comes from pure pursuit, off the same
 * aim the steering uses — takes the same driver to 99 % and 65.6 s for three laps against 150.1 s.
 * What this file pins is that pair of claims, because both of them are ways the change can rot:
 *
 *  1. **Speed is carried.** A lone driver averages most of the car's pace and does not fall off.
 *  2. **Skill still orders the field.** Once nobody is held back by the road, nothing in the
 *     geometry tells a quick driver from a slow one, and for one measurement the whole grid drove
 *     identical laps (65.6 s against 65.7 s for half the skill). Pace is what skill means now.
 *  3. **A cautious driver still gets round.** The first version derived the aim distance from the
 *     skill-scaled horizon, so a driver that looked less far ahead committed to a TIGHTER arc, ran
 *     out of road on every candidate line and crawled: 25 % of top speed and no finish in four
 *     minutes. The two distances are separate for that reason and this is the test that says so.
 *
 * TEST BOUNDARIES:
 *   @real-dependency: the three committed tracks through the real importer and OfficeState --
 *       Mock? NO. Every claim here is about what a real road does to a real driver, and a corner
 *       invented in a fixture would be a corner chosen to pass.
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { before } from 'node:test';

import { KART_MAX_SPEED_PX_PER_SEC, RACE_TICK_HZ } from '@pixel/shared/office/constants.js';
import { OfficeState } from '@pixel/shared/office/engine/officeState.js';
import { buildDynamicCatalog } from '@pixel/shared/office/layout/furnitureCatalog';
import { racerInput } from '@pixel/shared/office/race/racerDriver.js';
import { isRough, wrapAngle, type RaceGate } from '@pixel/shared/office/race/track.js';
import { TILE_SIZE, type OfficeLayout } from '@pixel/shared/office/types';

import { buildFurnitureCatalogAndSprites } from './assets.js';
import { importTmjToLayout } from './tiled/mapBridge.js';
import { loadTiledRegistry } from './tiled/tiledRegistry.js';

const ROOT = join(import.meta.dirname, '..', '..');
const TRACKS = ['raceway', 'monza', 'figure8', 'ring', 'valley'] as const;
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

interface Run {
  finished: boolean;
  seconds: number;
  meanSpeed: number;
  falls: number;
  /** Seconds the wrong-way warning was up. On a clean lap this is zero. */
  wrongWaySec: number;
  /**
   * Seconds spent OFF the racing surface. Zero on a lap driven properly, and the measurement that
   * the corner cap exists for: before it, the quickest driver spent 21 % of the Ring in the grass.
   */
  offRoadSec: number;
}

/** One computer driver of a given skill, alone on a track, driven to the flag. */
function drive(zone: string, level: number): Run {
  const os = new OfficeState(layouts.get(zone) as never);
  const track = os.raceTrack();
  assert.ok(track, `${zone} is not a track`);
  // The player first, and their own car after: a kart is spawned for whoever is on the track.
  const driver = os.addPlayer('char_0', 'Line', undefined, `line-${zone}-${level}`);
  const ch = os.characters.get(driver);
  assert.ok(ch);
  const kart = [...os.karts.values()].find((k) => k.ownerId === driver);
  assert.ok(kart, `${zone}: no kart was spawned for the player`);
  ch.x = kart.x;
  ch.y = kart.y;
  assert.equal(os.boardKart(driver), true, 'could not board the kart on the grid');
  // Alone: a full grid mixes traffic into a measurement about the racing line, and computer
  // drivers now get a car MADE for them at the start rather than taking a parked one.
  os.setRaceSetup({ bots: 0 });
  assert.equal(os.startRace(), true, 'the race would not start');
  const inner = os as unknown as { tileMap: number[][]; blockedTiles: Set<string>; walls: unknown };
  const world = { tileMap: inner.tileMap, blockedTiles: inner.blockedTiles, walls: inner.walls, track } as never;
  let ticks = 0;
  let falls = 0;
  let sum = 0;
  let n = 0;
  let wrong = 0;
  let off = 0;
  let last = kart.state;
  const max = Math.round(240 / DT);
  while (!kart.finished && ticks < max) {
    if (os.raceInfo().phase !== 'countdown') {
      kart.input = racerInput(kart, world, { level });
      sum += Math.hypot(kart.vx, kart.vy);
      n++;
    }
    os.update(DT);
    if (kart.state === 'fall' && last !== 'fall') falls++;
    if (kart.wrongWay) wrong++;
    if (isRough(track, Math.floor(kart.x / TILE_SIZE), Math.floor(kart.y / TILE_SIZE))) off++;
    last = kart.state;
    ticks++;
  }
  return {
    finished: kart.finished,
    seconds: ticks * DT,
    meanSpeed: sum / Math.max(1, n),
    falls,
    wrongWaySec: wrong * DT,
    offRoadSec: off * DT,
  };
}

test('a quick driver carries most of the car through every committed track', () => {
  for (const zone of TRACKS) {
    const run = drive(zone, 1);
    const share = run.meanSpeed / KART_MAX_SPEED_PX_PER_SEC;
    assert.equal(run.finished, true, `${zone}: never finished (${run.seconds.toFixed(1)} s)`);
    assert.equal(run.falls, 0, `${zone}: fell off ${run.falls} time(s) while driving its own line`);
    // 90 %, against the 49 % this replaced and the 99 % it measures — the margin is for a map
    // with a genuinely tight corner in it, not for a regression back to a straight-line probe.
    assert.ok(share > 0.9, `${zone}: averaged only ${(share * 100).toFixed(0)} % of top speed`);
  }
});

/**
 * A quick driver stays ON the road, and that is what the corner cap is for.
 *
 * The Ring is the circuit that made it necessary and the one this test is really about: two long
 * straights and two sustained 180° bends of 6.2 tiles' centreline radius. The tyres allow 346 px/s
 * there, so nothing in the physics stopped the quick driver arriving flat out — it simply could
 * not hold the line it entered with. Measured before the cap: **21 % of the race off the road**,
 * and 55.3 s against the middling driver's 43.4, so the fastest car on the grid finished behind
 * the middle of it.
 *
 * Asserted as time OFF the racing surface rather than as a lap time, because a lap time regresses
 * for a dozen reasons and this one has a cause you can point at.
 */
test('a quick driver never has to use the grass', () => {
  for (const zone of TRACKS) {
    const run = drive(zone, 1);
    assert.equal(run.finished, true, `${zone}: never finished`);
    assert.equal(
      run.offRoadSec.toFixed(1),
      '0.0',
      `${zone}: the quick driver spent ${run.offRoadSec.toFixed(1)} s of ${run.seconds.toFixed(1)} off the road`,
    );
  }
});

test('skill orders the field, and the cautious one still gets round', () => {
  for (const zone of TRACKS) {
    const quick = drive(zone, 1);
    const middling = drive(zone, 0.6);
    const slow = drive(zone, 0.3);
    for (const [name, run] of [['middling', middling], ['slow', slow]] as const) {
      assert.equal(run.finished, true, `${zone}: the ${name} driver never finished`);
      assert.equal(run.falls, 0, `${zone}: the ${name} driver fell off ${run.falls} time(s)`);
    }
    assert.ok(
      quick.seconds < middling.seconds && middling.seconds < slow.seconds,
      `${zone}: skill did not order the field — ${quick.seconds.toFixed(1)} / ${middling.seconds.toFixed(1)} / ${slow.seconds.toFixed(1)} s`,
    );
    // A beginner's lap is still a lap: the slowest driver on the grid runs at PACE_FLOOR, so it
    // may not take half again as long as the quickest. This is the shape of the crawl that the
    // skill-scaled aim distance produced, where the slow one took four times as long and DNF'd.
    assert.ok(
      slow.seconds < quick.seconds * 1.5,
      `${zone}: the slow driver crawled — ${slow.seconds.toFixed(1)} s against ${quick.seconds.toFixed(1)}`,
    );
  }
});

/**
 * A clean lap is never called the wrong way round.
 *
 * Reported from Monza: "durch die erste Kurve kommt kurz Wrong Way". Measured before the fix, on
 * a lap driven perfectly by the computer: SIX spells, two a lap, at the same two corners every
 * time. The rule asked only whether the car was losing ground on the gate ahead, and a ninety-tile
 * leg that bends does exactly that for over a second while you drive it correctly.
 *
 * Two things had to change and this covers both: the rule now wants the car to be GAINING on the
 * gate behind as well (a corner that turns away loses ground on both ends, a car turned round does
 * not), and a circuit gets a checkpoint every twenty tiles instead of four however long it is.
 *
 * Driven by the computer rather than by a script, because the claim is about a lap somebody could
 * actually drive — a hand-written path round the centreline would prove nothing about corners.
 */
test('the wrong-way warning never fires on a lap driven properly', () => {
  for (const zone of TRACKS) {
    const run = drive(zone, 1);
    assert.equal(run.finished, true, `${zone}: never finished`);
    assert.equal(
      run.wrongWaySec.toFixed(1),
      '0.0',
      `${zone}: the warning was up for ${run.wrongWaySec.toFixed(1)} s of a clean ${run.seconds.toFixed(1)} s run`,
    );
  }
});

/** …and it still fires when a car IS turned round, which is the half a stricter rule could break. */
test('a car driven backwards is still warned', () => {
  const os = new OfficeState(layouts.get('raceway') as never);
  const track = os.raceTrack();
  assert.ok(track);
  const driver = os.addPlayer('char_0', 'Backwards', undefined, 'backwards');
  const ch = os.characters.get(driver);
  assert.ok(ch);
  const kart = [...os.karts.values()].find((k) => k.ownerId === driver);
  assert.ok(kart);
  ch.x = kart.x;
  ch.y = kart.y;
  assert.equal(os.boardKart(driver), true);
  os.setRaceSetup({ bots: 0 });
  assert.equal(os.startRace(), true);
  while (os.raceInfo().phase === 'countdown') os.update(DT);
  const inner = os as unknown as { tileMap: number[][]; blockedTiles: Set<string>; walls: unknown };
  const world = { tileMap: inner.tileMap, blockedTiles: inner.blockedTiles, walls: inner.walls, track } as never;
  // Driven properly for three seconds first, so it is somewhere real — BETWEEN two gates, on the
  // road, with a gate behind it to gain on. Turning a car round on top of the gate it just passed
  // is not driving backwards, it is standing at a checkpoint, and the rule is right to say nothing.
  for (let i = 0; i < Math.round(3 / DT); i++) {
    kart.input = racerInput(kart, world, { level: 1 });
    os.update(DT);
  }
  assert.equal(kart.wrongWay, false, 'three clean seconds already tripped the warning');
  // Now turn it round and hold the throttle down.
  kart.heading = wrapAngle(kart.heading + Math.PI);
  kart.vx = 0;
  kart.vy = 0;
  for (let i = 0; i < Math.round(4 / DT); i++) {
    kart.input = { throttle: 1, steer: 0 };
    os.update(DT);
    if (kart.wrongWay) break;
  }
  assert.equal(kart.wrongWay, true, 'a kart driven back down the course was not warned');
});

/**
 * A boost pad is on the road, off the grid, and worth having.
 *
 * The placement rules are the interesting half: a pad belongs on a STRAIGHT, because the ceiling
 * it raises is taken back by drag within a second or so and a corner is where you cannot spend it;
 * and nowhere near the starting grid, because a pad under one column of the grid is a free launch
 * for whoever drew it, which is the opposite of the choice a pad is meant to be.
 */
test('every circuit has boost pads, on its road and clear of its grid', () => {
  for (const zone of TRACKS) {
    const layout = layouts.get(zone) as unknown as {
      cols: number;
      surfaces?: Record<string, number[]>;
      tileActions?: Array<{ kind?: string } | null>;
    };
    const pads = layout.surfaces?.boost ?? [];
    assert.ok(pads.length >= 8, `${zone}: only ${pads.length} boost cells`);
    const os = new OfficeState(layout as never);
    const track = os.raceTrack();
    assert.ok(track);
    for (const cell of pads) {
      const col = cell % layout.cols;
      const row = (cell - col) / layout.cols;
      // ON the racing surface — that is the whole difference from `rough`, and a pad in the grass
      // would be a reward for leaving the road.
      assert.equal(isRough(track, col, row), false, `${zone}: a pad at (${col}, ${row}) is off the racing surface`);
    }
    // …and clear of the grid. Measured as the nearest grid slot to any pad.
    const slots: Array<{ col: number; row: number }> = [];
    (layout.tileActions ?? []).forEach((a, i) => {
      if (a?.kind === 'raceStart') slots.push({ col: i % layout.cols, row: Math.floor(i / layout.cols) });
    });
    assert.ok(slots.length > 0, `${zone}: no grid to measure against`);
    let nearest = Infinity;
    for (const cell of pads) {
      const col = cell % layout.cols;
      const row = (cell - col) / layout.cols;
      for (const s of slots) nearest = Math.min(nearest, Math.hypot(s.col - col, s.row - row));
    }
    assert.ok(nearest > 12, `${zone}: a boost pad is ${nearest.toFixed(0)} tiles from a grid slot`);
  }
});

/**
 * Running wide still counts as passing the checkpoint.
 *
 * Reported as "wenn man nicht genau die Strecke erwischt, steht da oft wrong way", and the cause
 * was that a gate stopped at the edge of the tarmac. Missing one is not a small thing: the leg you
 * are then on points at a gate BEHIND you, so every metre of correct driving reads as going
 * backwards and the warning stays up until you turn round and fetch it. Measured before the fix:
 * not one of the 575 gate cells across the three circuits was on the verge, while 190 drivable
 * verge cells sat directly beside a gate without belonging to it.
 *
 * Driven on the VERGE rather than on the road, gate by gate, which is the mistake this is about —
 * and the lap has to complete, because a gate that is missed is a lap that never ends.
 */
/**
 * A checkpoint is ONE cell thick, and it is still a wall.
 *
 * Reported from Tiled: "warum sind die Race-Gates doppelt gesetzt, immer zwei nebeneinander?" They
 * were, and it was the first fix for a real problem — a line across the road rounds to a STAIRCASE
 * of cells, a staircase touches only at its corners, and a kart travelling diagonally can slip
 * between two of them. Sampling half a tile along the road as well as across it closed those
 * corners by making the whole band two cells thick everywhere.
 *
 * Closing the corner where there IS one is the smaller answer, and these are the two properties
 * that says it worked: every gate is a single 4-CONNECTED run (so nothing can pass through it),
 * and no gate is more than one cell thick across its own line (so it is not drawn twice). Measured
 * across the five circuits: 1.13 to 1.31 tiles, where a doubled band is 2.3.
 */
test('every gate is one cell thick and still unbroken', () => {
  for (const zone of TRACKS) {
    const os = new OfficeState(layouts.get(zone) as never);
    const track = os.raceTrack();
    assert.ok(track, `${zone} is not a track`);
    track.gates.forEach((gate, i) => {
      const cells = [...gate.tiles].map((k) => k.split(',').map(Number) as [number, number]);
      assert.ok(cells.length > 3, `${zone} gate ${i} is only ${cells.length} cells wide`);
      // One 4-connected run: a flood fill from any cell reaches all of them.
      const have = new Set(gate.tiles);
      const seen = new Set<string>([[...gate.tiles][0]]);
      const queue = [[...gate.tiles][0]];
      while (queue.length > 0) {
        const [c, r] = (queue.pop() as string).split(',').map(Number);
        for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const k = `${c + dc},${r + dr}`;
          if (have.has(k) && !seen.has(k)) {
            seen.add(k);
            queue.push(k);
          }
        }
      }
      assert.equal(seen.size, have.size, `${zone} gate ${i} is in pieces a kart could pass between`);
      // …and one cell thick, measured across its OWN long axis rather than against the direction of
      // the next gate: on a bend those differ by most of a right angle and the measurement would
      // be of the corner, not of the gate.
      const mx = cells.reduce((a, p) => a + p[0], 0) / cells.length;
      const my = cells.reduce((a, p) => a + p[1], 0) / cells.length;
      let sxx = 0;
      let sxy = 0;
      let syy = 0;
      for (const [c, r] of cells) {
        sxx += (c - mx) ** 2;
        sxy += (c - mx) * (r - my);
        syy += (r - my) ** 2;
      }
      const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
      const ax = Math.cos(th);
      const ay = Math.sin(th);
      let lo = Infinity;
      let hi = -Infinity;
      for (const [c, r] of cells) {
        const across = (c - mx) * -ay + (r - my) * ax;
        lo = Math.min(lo, across);
        hi = Math.max(hi, across);
      }
      assert.ok(hi - lo < 1.6, `${zone} gate ${i} is ${(hi - lo).toFixed(2)} tiles thick — drawn twice?`);
    });
  }
});

test('a lap driven on the verge still passes every gate', () => {
  for (const zone of TRACKS) {
    const os = new OfficeState(layouts.get(zone) as never);
    const track = os.raceTrack();
    assert.ok(track);
    const driver = os.addPlayer('char_0', 'Wide', undefined, `wide-${zone}`);
    const ch = os.characters.get(driver);
    assert.ok(ch);
    const kart = [...os.karts.values()].find((k) => k.ownerId === driver);
    assert.ok(kart);
    ch.x = kart.x;
    ch.y = kart.y;
    assert.equal(os.boardKart(driver), true);
    os.setRaceSetup({ bots: 0 });
    assert.equal(os.startRace(), true);
    while (os.raceInfo().phase === 'countdown') os.update(DT);

    const inner = os as unknown as { tileMap: number[][]; blockedTiles: Set<string> };
    const drivable = (c: number, r: number): boolean =>
      (inner.tileMap[r]?.[c] ?? -1) !== -1 && !inner.blockedTiles.has(`${c},${r}`);
    const gates: readonly RaceGate[] = track.gates;
    for (let g = 1; g <= gates.length; g++) {
      const gate = gates[g % gates.length];
      const cells = [...gate.tiles].map((k) => k.split(',').map(Number) as [number, number]);
      // A cell of this gate that is OFF the racing surface: the verge, where a car that ran wide
      // actually is.
      const onVerge = cells.find(([col, row]) => isRough(track, col, row));
      if (!onVerge) {
        // No verge to cover — the BRIDGE is the case, where beside the road there is only air.
        // What must still hold is that there is nothing drivable beside the gate to slip past on.
        const escape = cells.some(([col, row]) =>
          [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dc, dr]) =>
            drivable(col + dc, row + dr) && !gate.tiles.has(`${col + dc},${row + dr}`) && isRough(track, col + dc, row + dr),
          ),
        );
        assert.equal(escape, false, `${zone}: gate ${gate.index} has no verge but there is verge beside it`);
        // Cross it on the road instead, so the lap still advances.
        kart.x = gate.x;
        kart.y = gate.y;
        kart.vx = 0;
        kart.vy = 0;
        kart.input = { throttle: 0, steer: 0 };
        os.update(DT);
        assert.equal(kart.gate, gate.index, `${zone}: crossing gate ${gate.index} did not count`);
        continue;
      }
      kart.x = onVerge[0] * 16 + 8;
      kart.y = onVerge[1] * 16 + 8;
      kart.vx = 0;
      kart.vy = 0;
      kart.input = { throttle: 0, steer: 0 };
      os.update(DT);
      assert.equal(
        kart.gate,
        gate.index,
        `${zone}: crossing gate ${gate.index} on the verge did not count (still at ${kart.gate})`,
      );
    }
    assert.equal(kart.lap, 1, `${zone}: a full lap on the verge did not complete a lap`);
  }
});
