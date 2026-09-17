/**
 * The first track is drivable, and the engine puts karts on its grid.
 *
 * The model has its own tests on a hand-built oval; this one is about the MAP and the wiring:
 * `raceway.tmj` goes through the real importer, the real `OfficeState`, and then an autopilot
 * drives it. That last part is the test I actually wanted — an oval can satisfy every unit test
 * and still be undrivable (a corner too tight for the turn rate, a kerb that eats the racing
 * line, a gate a kart passes beside rather than over), and none of that shows up in geometry.
 *
 * The autopilot aims at the next gate and looks a few tiles ahead: if the line it wants is over
 * the pit, it tries a wider one. The first version had no lookahead at all — aim at the gate,
 * full throttle — and it drove straight into the infield on the first corner, because the
 * straight line between two gates of an oval cuts the middle out. That is the autopilot being too
 * stupid rather than the track being wrong, and it is worth recording: any future AI driver needs
 * the same lookahead, and a test that only aims is a test of the geometry of a circle.
 *
 * TEST BOUNDARIES:
 *   @real-dependency: the committed .tmj, loadTiledRegistry, importTmjToLayout, OfficeState --
 *       Mock? NO. The claim is "this map works", and every layer of that sentence is one of these.
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { before } from 'node:test';

import {
  KART_MAX_SPEED_PX_PER_SEC,
  KART_PARK_REACH_TILES,
  KART_RADIUS_PX,
  KART_RESPAWN_REACH_TILES,
  RACE_TICK_HZ,
} from '@pixel/shared/office/constants.js';
import { OfficeState } from '@pixel/shared/office/engine/officeState.js';
import { buildDynamicCatalog } from '@pixel/shared/office/layout/furnitureCatalog';
import { parkNear, type Kart, type KartWorld } from '@pixel/shared/office/race/kart.js';
import { isRough, raceTrack, type RaceTrack } from '@pixel/shared/office/race/track.js';
import type { OfficeLayout } from '@pixel/shared/office/types';

import { buildFurnitureCatalogAndSprites } from './assets.js';
import { sanitizeLayoutActions, sanitizeLayoutImages, sanitizeLayoutTexts } from './layoutSanitize.js';
import { importTmjToLayout } from './tiled/mapBridge.js';
import { loadTiledRegistry } from './tiled/tiledRegistry.js';

const ROOT = join(import.meta.dirname, '..', '..');
let layout: OfficeLayout;

before(async () => {
  buildDynamicCatalog((await buildFurnitureCatalogAndSprites()) as never);
  const registry = loadTiledRegistry(ROOT);
  const tmj = JSON.parse(readFileSync(join(ROOT, 'assets', 'tiled', 'zones', 'raceway.tmj'), 'utf8'));
  layout = importTmjToLayout(tmj, registry, () => null).layout;
});

const TILE = 16;

const world = (): OfficeState => new OfficeState(layout as never);

/** The engine's own map, as `parkNear` and `respawn` want it — the same object `updateKarts` builds. */
const kartWorld = (os: OfficeState, track: RaceTrack): KartWorld => {
  const inner = os as unknown as Pick<KartWorld, 'tileMap' | 'blockedTiles' | 'walls'>;
  return { tileMap: inner.tileMap, blockedTiles: inner.blockedTiles, walls: inner.walls, track };
};

test('the committed map imports as a track: four gates, a grid, its lap count', () => {
  const track = raceTrack(layout);
  assert.ok(track, 'raceway.tmj is not recognised as a race track');
  // A COUNT is not written down here, the same way the lap count is read off the map: a circuit
  // gets a checkpoint roughly every twenty tiles, so the number follows the length of the lap and
  // changing the shape must not be a test edit. What matters is that there are enough of them to
  // mean something and that they are evenly spread.
  assert.ok(track.gates.length >= 8, `only ${track.gates.length} gates on a lap this long`);
  assert.deepEqual(track.gates.map((g) => g.index), track.gates.map((_, i) => i), 'gates are not in lap order');
  // Whatever the map says, not a number written here as well: the distance is a track design
  // decision and changing it must not be a test edit.
  assert.equal(track.laps, (layout as { laps?: number }).laps, 'the laps property did not survive the import');
  assert.equal(track.grid.length, 12, `grid slots: ${track.grid.length}`);
  // Each gate is a LINE across the road, or a kart drives past it — and it has to span whatever
  // the road IS at that column. Gate 2 sits on the bridge, which is three tiles rather than five.
  for (const gate of track.gates) {
    assert.ok(gate.tiles.size >= 3, `gate ${gate.index} is only ${gate.tiles.size} tiles wide`);
  }
});

test('the map survives the save path: a stored track is still a track', () => {
  // The regression this pins cost a live world: `sanitizeAction` is an ALLOW-LIST that runs on
  // every write, so the gates and the grid were stripped the moment the map was stored and the
  // zone came up with a perfectly good road and no karts on it. Nothing in the importer or the
  // model can see that — both work on a layout that never went through a save.
  const stored = sanitizeLayoutImages(
    sanitizeLayoutActions(sanitizeLayoutTexts(JSON.parse(JSON.stringify(layout)))),
  ) as unknown as OfficeLayout;
  const track = raceTrack(stored);
  assert.ok(track, 'the stored map is no longer a race track');
  assert.ok(track.gates.length >= 8, `only ${track.gates.length} gates survived a save`);
  assert.equal(track.grid.length, 12, `grid slots after a save: ${track.grid.length}`);
  assert.equal(track.laps, (layout as { laps?: number }).laps, 'the lap count did not survive a save');
});

/**
 * One car per person on the track, parked BESIDE its owner — and nothing else.
 *
 * Two claims have moved through this test, each from a report. It used to assert a kart in EVERY
 * slot, which is what the engine did: a lone driver walked up to a grid of eleven cars and set off
 * with ten of them standing there ("Autos für Computer-Driver müssen vor dem Start nicht angezeigt
 * werden. Für jeden Spieler auf der Karte ein Auto"). Then the one car per person still stood on
 * the grid, so arriving meant identifying yours among the parked ones and walking over — and the
 * car spawns with its owner now instead ("Außerdem wird später das Cart zusammen mit dem Spieler
 * spawnen", "Mach das Cart-Spawnen beim Spieler-Join").
 *
 * What is asserted is therefore the PLACE as well as the lifecycle, and the place has three parts:
 * within reach of its owner, on ground a car's body fits on, and far enough from the next car that
 * the two are not shoving each other apart on the first tick.
 */
test('a car appears beside each person on the track and for nobody else', () => {
  const os = world();
  const track = os.raceTrack();
  assert.ok(track);
  assert.equal(os.karts.size, 0, 'an empty track had cars parked on it');
  const names = ['One', 'Two', 'Three'];
  const ids = names.map((n) => os.addPlayer('char_0', n, undefined, n.toLowerCase()));
  assert.equal(os.karts.size, ids.length, `${ids.length} people got ${os.karts.size} cars`);
  for (const id of ids) {
    const mine = [...os.karts.values()].filter((k) => k.ownerId === id);
    assert.equal(mine.length, 1, `a player owns ${mine.length} cars`);
    const kart = mine[0];
    const ch = os.characters.get(id);
    assert.ok(ch);
    assert.equal(kart.driverId, null, 'a kart started with a driver');
    assert.equal(kart.state, 'idle');
    const away = Math.hypot(kart.x - ch.x, kart.y - ch.y) / TILE;
    assert.ok(away > 0 && away <= KART_PARK_REACH_TILES, `a car parked ${away.toFixed(1)} tiles from its owner`);
    // On road, not on the verge: the search refuses rough ground, so the car is somewhere it can
    // be driven away from rather than somewhere it has to be dragged out of.
    assert.equal(isRough(track, Math.floor(kart.x / TILE), Math.floor(kart.y / TILE)), false, 'a car parked on rough');
    // …and you can get in from where you landed, without walking a step. This is the assertion
    // that pins `KART_PARK_REACH_TILES` inside `KART_BOARD_REACH_TILES` — as a behaviour rather
    // than as arithmetic between two constants, which is the thing that actually has to hold: a
    // car that spawns with you and is then out of reach of E is a car that did not spawn with you.
    assert.equal(os.boardKart(id), true, 'a player could not board the car parked beside them');
    assert.equal(os.kartOf(id)?.id, kart.id, 'boarding put somebody in the wrong car');
    assert.equal(os.boardKart(id), true, 'a player could not get back out');
  }
  // Two cars on one cell is one car as far as a viewer is concerned, and a shoving match as far as
  // `bumpKarts` is concerned — three arrivals at one point is exactly the case that finds it.
  const cars = [...os.karts.values()];
  for (let a = 0; a < cars.length; a++) {
    for (let b = a + 1; b < cars.length; b++) {
      const gap = Math.hypot(cars[a].x - cars[b].x, cars[a].y - cars[b].y);
      assert.ok(gap >= KART_RADIUS_PX * 2, `two parked cars are ${gap.toFixed(1)} px apart`);
    }
  }
  // A colour per owner, so you can follow your own car in a field of identical ones.
  assert.equal(new Set(cars.map((k) => k.art)).size, cars.length, 'two people got the same colour');
  // …and it goes with them. A car whose owner has left is a ghost in the middle of the road.
  os.removePlayer(ids[0]);
  assert.equal(os.karts.size, ids.length - 1, 'a car outlived its owner');
});

/**
 * Nowhere to park falls back to the grid, which is where every car used to stand.
 *
 * Most of a circuit's walkable area is rough — measured: 6224 of raceway's 7867 cells, and no cell
 * a car's body fits on within `KART_PARK_REACH_TILES` of 63 % of them — so this is not a
 * theoretical branch. It is reached by somebody who joined during a race (no car is handed out on
 * a live grid) and then walked into the outfield before the flag.
 */
test('a person with no room beside them gets a grid slot', () => {
  const os = world();
  const track = os.raceTrack();
  assert.ok(track);
  const id = os.addPlayer('char_0', 'Wanderer', undefined, 'wanderer');
  const ch = os.characters.get(id);
  assert.ok(ch);
  // Out into the outfield, and the car it arrived with taken away — which is the state a player
  // who joined mid-race is in when the race ends.
  const far = [...(os as unknown as { walkableTiles: Array<{ col: number; row: number }> }).walkableTiles].find(
    (t) => isRough(track, t.col, t.row) && !parkNear(kartWorld(os, track), t.col * TILE + 8, t.row * TILE + 8, []),
  );
  assert.ok(far, 'this circuit has no cell without parking, so the fallback cannot be reached');
  ch.tileCol = far.col;
  ch.tileRow = far.row;
  ch.x = far.col * TILE + TILE / 2;
  ch.y = far.row * TILE + TILE / 2;
  os.karts.clear();
  os.update(1 / RACE_TICK_HZ);
  const mine = [...os.karts.values()].filter((k) => k.ownerId === id);
  assert.equal(mine.length, 1, `a player in the outfield owns ${mine.length} cars`);
  assert.ok(
    track.grid.some((slot) => Math.hypot(slot.x - mine[0].x, slot.y - mine[0].y) < 1),
    'the fallback did not put the car on a grid slot',
  );
});

test('an autopilot drives three laps without falling off', () => {
  const os = world();
  const track = os.raceTrack();
  assert.ok(track);
  // Alone on the track: what is under test is the MAP — whether this circuit can be driven — and
  // a grid full of opponents would mix their bumping into the answer. Racing them has its own
  // test (race.int.test.ts). One person on the track is now one car, so being alone is the
  // default rather than something to arrange.
  // A real driver, boarded the real way. Setting `driverId` by hand does not work and the reason
  // is a safety rule rather than an accident: `updateKarts` frees a kart whose driver is not in
  // the zone, so a made-up id empties the seat on the very next tick.
  const driver = os.addPlayer('char_0', 'Autopilot', undefined, 'autopilot');
  const ch = os.characters.get(driver);
  assert.ok(ch);
  const kart = [...os.karts.values()].find((k) => k.ownerId === driver)!;
  ch.x = kart.x;
  ch.y = kart.y;
  assert.equal(os.boardKart(driver), true, 'could not board the kart on the grid');
  // Without a race there is no finish, because there is no lap limit — that is the whole of
  // "drive around as long as you like". So the autopilot starts one, and sits out the lights.
  os.setRaceSetup({ bots: 0 });
  assert.equal(os.startRace(), true, 'a race would not start with a kart on the grid');

  const dt = 1 / RACE_TICK_HZ;
  let falls = 0;
  let ticks = 0;
  const maxTicks = Math.round(180 / dt); // three minutes of simulated time is generous
  let lastState: Kart['state'] = kart.state;
  const inner = os as unknown as { tileMap: number[][]; blockedTiles: Set<string> };
  /** How far the road holds along a heading, in tiles, up to `max`. This is the whole difference
   *  between a driver and a projectile, and it is the second thing this autopilot got wrong: the
   *  first version aimed at the gate with no lookahead at all and drove into the infield on the
   *  first corner, because the straight line between two gates of an oval cuts the middle out. */
  const ok = (x: number, y: number): boolean => {
    const col = Math.floor(x / TILE);
    const row = Math.floor(y / TILE);
    const cell = inner.tileMap[row]?.[col];
    return cell !== undefined && cell !== -1 && !inner.blockedTiles.has(`${col},${row}`);
  };
  /** How far the road holds along a heading, in tiles, up to `max`. Two details earned their
   *  place the hard way, both of them corner cuts that a single centre ray called clear:
   *  the steps are HALF a tile, because at whole tiles the ray strides straight over the one
   *  cell where the infield pokes into the road; and it sweeps a CORRIDOR a kart wide rather
   *  than a line, because the bodywork clips an inside corner the centre misses entirely. */
  const room = (heading: number, max: number): number => {
    const px = -Math.sin(heading) * KART_RADIUS_PX;
    const py = Math.cos(heading) * KART_RADIUS_PX;
    for (let t = 1; t <= max * 2; t++) {
      const x = kart.x + Math.cos(heading) * t * (TILE / 2);
      const y = kart.y + Math.sin(heading) * t * (TILE / 2);
      if (!ok(x, y) || !ok(x + px, y + py) || !ok(x - px, y - py)) return (t - 1) / 2;
    }
    return max;
  };
  const LOOK = 7;
  const OFFSETS = [0];
  for (let deg = 10; deg <= 120; deg += 10) OFFSETS.push((deg * Math.PI) / 180, (-deg * Math.PI) / 180);

  while (!kart.finished && ticks < maxTicks) {
    if (os.raceInfo().phase === 'countdown') {
      // Held on the grid: the throttle is simply not connected yet.
      os.update(dt);
      ticks++;
      continue;
    }
    const target = track.gates[(kart.gate + 1) % track.gates.length];
    const toGate = Math.atan2(target.y - kart.y, target.x - kart.x);
    // Widen the line until the road holds. Tried smallest correction first, both ways round, so
    // the answer is the least it can get away with; ties go to the straighter line.
    let want = toGate;
    let bestRoom = -1;
    for (const off of OFFSETS) {
      const r = room(toGate + off, LOOK);
      if (r > bestRoom) {
        bestRoom = r;
        want = toGate + off;
        if (r === LOOK) break;
      }
    }
    let diff = want - kart.heading;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    // Throttle is looked up along the COURSE, not the heading: a kart slides, and the wall it
    // hits is the one the velocity points at. Never reverse — a negative throttle here flips the
    // sign of every steering correction and the autopilot drives the track backwards.
    const speed = Math.hypot(kart.vx, kart.vy);
    const course = speed > 5 ? Math.atan2(kart.vy, kart.vx) : kart.heading;
    const ahead = room(course, 8);
    const throttle = ahead >= 5 || speed < 40 ? 1 : 0;
    kart.input = { throttle, steer: diff > 0.05 ? 1 : diff < -0.05 ? -1 : 0 };
    os.update(dt);
    if (kart.state === 'fall' && lastState !== 'fall') falls++;
    lastState = kart.state;
    ticks++;
  }

  assert.equal(kart.finished, true, `never finished: lap ${kart.lap}, gate ${kart.gate}, ${ticks} ticks`);
  assert.equal(kart.lap, track.laps, `finished on lap ${kart.lap} of ${track.laps}`);
  assert.equal(os.raceInfo().entries.get(kart.id)?.place, 1, 'the only finisher did not come first');
  assert.equal(falls, 0, `fell off ${falls} time(s) while following the racing line`);
  // A lap of this oval is about 150 tiles of road; three of them at the speed limit cannot be
  // done in under twenty seconds, and taking three minutes would mean it was crawling.
  const seconds = ticks * dt;
  assert.ok(seconds > 20 && seconds < 170, `three laps took ${seconds.toFixed(1)} s`);
});

/**
 * Road with a drop beside it, found rather than assumed.
 *
 * The bridge used to be a column range on a rectangle's top straight and these tests knew where it
 * was. The circuit is a CURVE now, so the span is stated as a fraction of the lap and lands on a
 * diagonal — and a test that knows a column is a test that breaks when the track is redrawn, which
 * is exactly what it should not be. Both tests below ask the MAP where the drop is.
 */
function bridgeCell(os: OfficeState): { col: number; row: number; away: { dc: number; dr: number } } {
  const inner = os as unknown as { tileMap: number[][]; blockedTiles: Set<string> };
  const track = os.raceTrack()!;
  const ground = (c: number, r: number): boolean => (inner.tileMap[r]?.[c] ?? -1) !== -1;
  let best: { col: number; row: number; away: { dc: number; dr: number } } | null = null;
  for (let row = 1; row < inner.tileMap.length - 1; row++) {
    for (let col = 1; col < (inner.tileMap[row]?.length ?? 0) - 1; col++) {
      if (!ground(col, row) || inner.blockedTiles.has(`${col},${row}`)) continue;
      if (isRough(track, col, row)) continue; // road, not the run-off
      // A drop within three tiles, with nothing but ground in between: that is a bridge edge.
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        let d = 1;
        while (d <= 3 && ground(col + dc * d, row + dr * d) && !inner.blockedTiles.has(`${col + dc * d},${row + dr * d}`)) d++;
        if (d <= 3 && !ground(col + dc * d, row + dr * d)) {
          best ??= { col, row, away: { dc, dr } };
        }
      }
    }
  }
  assert.ok(best, 'this circuit has no road with a drop beside it — where did the bridge go?');
  return best;
}

test('the bridge has no barrier: a shove there puts you in the air', () => {
  // The first thing asked of this whole feature — "Brücken über Abgründen, da könnte man dann
  // jemanden von der Brücke bumpen" — and it needs no new concept: only ground makes a cell
  // drivable, so a bridge is road with the barrier left off. What this pins is the DIFFERENCE:
  // the same shove is survivable on the ordinary straight and is not on the bridge.
  const os = world();
  const track = os.raceTrack();
  assert.ok(track);
  const span = bridgeCell(os);

  // Sideways speed is killed by the tyres at KART_GRIP_PX_PER_SEC2, so a shove carries about
  // `v² / (2·grip)` pixels — 170 px/s is barely a tile and would prove nothing.
  const SHOVE = 620;
  const shoved = (col: number, row: number, vx: number, vy: number): boolean => {
    const driver = os.characters.size > 1 ? null : os.addPlayer('char_0', 'Victim', undefined, 'victim');
    if (driver !== null) {
      const ch = os.characters.get(driver)!;
      const mine = [...os.karts.values()].find((k) => k.ownerId === driver)!;
      ch.x = mine.x;
      ch.y = mine.y;
      os.boardKart(driver);
    }
    const kart = [...os.karts.values()][0];
    kart.x = col * TILE + TILE / 2;
    kart.y = row * TILE + TILE / 2;
    kart.heading = 0;
    kart.vx = vx;
    kart.vy = vy;
    kart.state = 'drive';
    kart.fallTimer = 0;
    for (let i = 0; i < Math.round(1.2 / (1 / RACE_TICK_HZ)); i++) {
      kart.input = { throttle: 0, steer: 0 };
      os.update(1 / RACE_TICK_HZ);
      if ((kart.state as string) === 'fall') return true;
    }
    return false;
  };

  // Off the edge the map itself found.
  assert.equal(
    shoved(span.col, span.row, span.away.dc * SHOVE, span.away.dr * SHOVE),
    true,
    'a kart shoved off the bridge stayed on it',
  );
  // The same shove on the start-finish straight is caught by the barrier, in BOTH directions —
  // that straight has a wall either side, which is what makes the bridge the exception.
  const safeCol = Math.floor(track.gates[0].x / TILE);
  const safeRow = Math.floor(track.gates[0].y / TILE);
  for (const [vx, vy] of [[0, SHOVE], [0, -SHOVE], [SHOVE, 0], [-SHOVE, 0]] as const) {
    assert.equal(shoved(safeCol, safeRow, vx, vy), false, 'the barrier let a kart through on the start-finish straight');
  }
});

test('falling off the bridge costs seconds, not the lap', () => {
  // The report this changed for: "man sollte nur im äußersten Notfall zurückgesetzt werden und
  // dann auch nicht so weit weg". A respawn used to go to the last gate, and this circuit has
  // four — so clipping the bridge handed the track back a quarter of a lap behind, for a wheel
  // over a kerb. What it must do instead is put the car back on the road it left.
  const os = world();
  const track = os.raceTrack();
  assert.ok(track);
  const span = bridgeCell(os);
  const driver = os.addPlayer('char_0', 'Faller', undefined, 'faller');
  const ch = os.characters.get(driver)!;
  // Their own car: a kart is spawned for whoever is on the track and belongs to them.
  const kart = [...os.karts.values()].find((k) => k.ownerId === driver)!;
  ch.x = kart.x;
  ch.y = kart.y;
  assert.equal(os.boardKart(driver), true);

  kart.x = span.col * TILE + TILE / 2;
  kart.y = span.row * TILE + TILE / 2;
  kart.heading = 0;
  kart.vx = span.away.dc * 620;
  kart.vy = span.away.dr * 620;
  kart.state = 'drive';
  const dt = 1 / RACE_TICK_HZ;
  let fellAt: { x: number; y: number } | null = null;
  for (let i = 0; i < Math.round(6 / dt); i++) {
    kart.input = { throttle: 0, steer: 0 };
    os.update(dt);
    if (!fellAt && (kart.state as string) === 'fall') fellAt = { x: kart.x, y: kart.y };
  }
  assert.ok(fellAt, 'the shove did not put it off the bridge');
  assert.notEqual(kart.state, 'fall', 'never came back');

  const home = Math.hypot(kart.x - fellAt.x, kart.y - fellAt.y) / TILE;
  assert.ok(home <= KART_RESPAWN_REACH_TILES, `put back ${home.toFixed(1)} tiles from where it fell`);
  // …and NOT at a gate, which is the whole point: every one of them is further away than the
  // search is even allowed to look.
  for (const g of track.gates) {
    assert.ok(
      Math.hypot(kart.x - g.x, kart.y - g.y) / TILE > KART_RESPAWN_REACH_TILES,
      `the respawn went back to gate ${g.index}`,
    );
  }
  // It is ON the road, not on the grass and not over the drop.
  const col = Math.floor(kart.x / TILE);
  const row = Math.floor(kart.y / TILE);
  assert.equal(isRough(track, col, row), false, 'put back on the grass rather than on the road');
  const inner = os as unknown as { tileMap: number[][] };
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      assert.notEqual(inner.tileMap[row + dr]?.[col + dc], -1, 'put back on the lip of the drop');
    }
  }
});

test('a kart cannot leave the map, barrier or no barrier', () => {
  const os = world();
  const driver = os.addPlayer('char_0', 'Wall', undefined, 'wall');
  const kart = [...os.karts.values()].find((k) => k.ownerId === driver)!;
  kart.driverId = driver;
  kart.state = 'drive';
  // Straight at the outer barrier, flat out, for a while.
  kart.heading = Math.PI / 2; // south, towards the bottom edge
  for (let i = 0; i < RACE_TICK_HZ * 4; i++) {
    kart.input = { throttle: 1, steer: 0 };
    os.update(1 / RACE_TICK_HZ);
  }
  assert.ok(kart.x >= 0 && kart.y >= 0, 'left the map to the north or west');
  assert.ok(kart.x <= layout.cols * 16 && kart.y <= layout.rows * 16, 'left the map to the south or east');
  assert.ok(Math.hypot(kart.vx, kart.vy) < KART_MAX_SPEED_PX_PER_SEC, 'gained speed by driving into a wall');
});

/**
 * The paddock is REACHABLE, which is the whole reason it was rebuilt.
 *
 * The report: "raceRecords steht irgendwo auf der Bahn, nur eine Action wo man raten muss wo sie
 * ist". It was an Action on a bare tile — nothing to see and nothing to walk to. It is a
 * leaderboard you can see from the grid now, and the claim worth pinning is not where it stands
 * but that a person who arrives on this map can get to it: an action with no reachable approach
 * tile is exactly as useless as an invisible one.
 *
 * Asked of the ENGINE rather than of the offsets in the generator, because "eight tiles out from
 * the centreline" means something different on a curve than on a straight, and the question is
 * never the offset — it is whether you can walk there.
 */
test('you can walk from the grid to the timing board and to the water', () => {
  const os = world();
  const spawnTiles = (layout.tileActions ?? [])
    .map((a, i) => ({ a, i }))
    .filter((x) => (x.a as { kind?: string } | null)?.kind === 'spawnPoint')
    .map((x) => ({ col: x.i % layout.cols, row: Math.floor(x.i / layout.cols) }));
  // ONE arrival marker. There were six, because the SET of them is also the pool an automatic
  // placement falls back to — which is what used to keep a busy arrival out of the landscaped
  // infield. The ring search does that better (see the spreading test above), and with one marker
  // the pool IS the arrival tile, so the infield cannot be drawn at all.
  assert.equal(spawnTiles.length, 1, `the map marks ${spawnTiles.length} arrival points`);

  for (const kind of ['raceRecords', 'appliance', 'portal']) {
    const item = layout.furniture.find((f) => (f.action as { kind?: string } | undefined)?.kind === kind);
    assert.ok(item, `nothing placed on this map carries a "${kind}" action`);
    // A fresh walker per action, standing where an arrival lands, asked to do exactly what a
    // click does: walk to it. The engine says no if there is no approach tile it can reach.
    const who = os.addPlayer('char_0', `W-${kind}`, undefined, `w-${kind}`);
    const ch = os.characters.get(who);
    assert.ok(ch);
    ch.tileCol = spawnTiles[0].col;
    ch.tileRow = spawnTiles[0].row;
    ch.x = spawnTiles[0].col * TILE + TILE / 2;
    ch.y = spawnTiles[0].row * TILE + TILE / 2;
    // An APPLIANCE is deliberately not an `isClickAction`, so it has a door of its own
    // (`useAppliance` / the `applianceApproach` message). Using the wrong one here would have
    // reported the water as unreachable while it was perfectly fine — which is what it did.
    const reached = kind === 'appliance'
      ? os.useAppliance(who, item.col, item.row)
      : os.walkPlayerToAction(who, item.col, item.row);
    assert.equal(
      reached,
      true,
      `"${kind}" is placed at (${item.col}, ${item.row}) and cannot be walked to from the grid`,
    );
  }
});

/**
 * Several people arriving at once arrive TOGETHER.
 *
 * The arrival tile holds one person; the rest used to be scattered over the whole spawnable pool,
 * which on a race map is the six grid-lane markers — measured on Monza, a median of 15 tiles from
 * the arrival point and up to 25, i.e. the far end of the grid. (On an ordinary map, where nothing
 * is marked, the pool is every walkable cell and it was the whole floor.) The cells AROUND the
 * arrival point are tried first now, nearest ring first.
 */
test('a busy arrival point spreads into the cells beside it', () => {
  const os = world();
  const actions = (layout.tileActions ?? []) as Array<{ kind?: string } | null>;
  const i = actions.findIndex((a) => a?.kind === 'spawnPoint');
  assert.ok(i >= 0, 'the map marks no arrival point');
  const at = { col: i % layout.cols, row: Math.floor(i / layout.cols) };
  const far: number[] = [];
  for (let n = 0; n < 10; n++) {
    const id = os.addPlayer('char_0', `P${n}`, at, `spread-${n}`);
    const ch = os.characters.get(id);
    assert.ok(ch);
    far.push(Math.max(Math.abs(ch.tileCol - at.col), Math.abs(ch.tileRow - at.row)));
  }
  assert.equal(far[0], 0, 'the first arrival did not get the arrival tile');
  const worst = Math.max(...far);
  assert.ok(worst <= 3, `the tenth arrival landed ${worst} tiles away`);
  // …and on distinct tiles: spreading that stacks people is not spreading.
  const where = new Set(
    [...os.characters.values()].map((c) => `${c.tileCol},${c.tileRow}`),
  );
  assert.equal(where.size, 10, `ten arrivals ended up on ${where.size} tiles`);
});

/**
 * The river has a bank, and the bank is a picture.
 *
 * Reported as hard staircase edges against the grass: the water is a decal in VOID cells and the
 * land is the cells beside them, so the waterline was the cell grid itself — a run of 16 px steps
 * down a diagonal. The fix draws a waterline INTO the land cells, one tile per mask of which
 * neighbours are wet.
 *
 * Asserted through the IMPORTER rather than against the .tmj, and that is the whole reason this
 * test exists: the first version painted the shore with tiles that carried no `DecalTile` class
 * and no `id`, so the importer dropped every one of them in silence. The map had them, the
 * generator's own render showed them, and the game had nothing.
 */
test('the gorge has a drawn shoreline, on the land and nowhere else', () => {
  const l = layout as unknown as {
    decals?: Array<{ id: string; col: number; row: number }>;
    tiles: number[];
    cols: number;
    rows: number;
  };
  const decals = l.decals ?? [];
  const shore = decals.filter((d) => d.id.startsWith('TRACK_SHORE_'));
  assert.ok(shore.length > 20, `the map carries only ${shore.length} shore cells`);
  // Where the gorge is: a VOID cell with the water decal in it.
  const wet = new Set(
    decals.filter((d) => d.id.startsWith('OW_')).map((d) => `${d.col},${d.row}`),
  );
  assert.ok(wet.size > 100, `the map carries only ${wet.size} water cells`);
  const track = raceTrack(layout);
  assert.ok(track);
  for (const d of shore) {
    const at = `${d.col},${d.row}`;
    // On LAND. A shore tile in the water would be a second waterline inside the river.
    assert.equal(wet.has(at), false, `a shore tile sits in the water at ${at}`);
    assert.notEqual(l.tiles[d.row * l.cols + d.col], -1, `a shore tile sits on a void cell at ${at}`);
    // Off the racing surface: the bridge is the other thing beside the gorge, and a waterline over
    // its deck reads as a river running across the road rather than under it.
    assert.equal(isRough(track, d.col, d.row), true, `a shore tile sits on the racing surface at ${at}`);
    // And touching the water, or it is a waterline with no water in it.
    const touches = [-1, 0, 1].some((dr) =>
      [-1, 0, 1].some((dc) => (dc !== 0 || dr !== 0) && wet.has(`${d.col + dc},${d.row + dr}`)),
    );
    assert.ok(touches, `a shore tile at ${at} touches no water at all`);
  }
});

/**
 * One of everything, and the two exceptions are named.
 *
 * "Bau von allen Teilen mal was auf raceway, so dass man weiß was es alles gibt." The empty layers
 * say which KINDS of thing a map can hold; this circuit is the one that shows what each of them
 * looks like in use, so the claim to keep is that none of them is quietly empty again after the
 * next redraw. Checked through the IMPORTER rather than against the .tmj, because a placement that
 * the importer drops is a placement that does not exist — which is exactly what happened to the
 * picture: it was in the file, typed after the tile's class instead of the object's, and it
 * arrived as nothing at all with no notice printed.
 */
test('the raceway carries one of every kind of content the format has', () => {
  const l = layout as unknown as {
    furniture: Array<{ action?: { kind?: string } }>;
    images?: unknown[];
    texts?: unknown[];
    decals?: Array<{ occludes?: boolean }>;
    surfaces?: Record<string, number[]>;
    tileActions?: Array<{ kind?: string } | null>;
  };
  assert.ok(l.furniture.length >= 8, `only ${l.furniture.length} placements`);
  assert.ok((l.images ?? []).length >= 1, 'no picture on the map');
  assert.ok((l.texts ?? []).length >= 2, 'no text labels on the map');
  assert.ok((l.surfaces?.rough ?? []).length > 100, 'nothing is marked as off the racing surface');
  // BOTH decal layers: one that lies under everybody and one that sorts against them. A map with
  // only the second has never used the first, and the difference is the whole reason the layer's
  // own `occludes` decides it rather than the tile.
  const flat = (l.decals ?? []).filter((d) => !d.occludes).length;
  const standing = (l.decals ?? []).filter((d) => d.occludes).length;
  assert.ok(flat > 0, 'nothing painted on the flat decal layer');
  assert.ok(standing > 0, 'nothing painted on the standing decal layer');
  // And the actions a circuit is made of, plus the three the paddock adds.
  const kinds = new Set<string>();
  for (const a of l.tileActions ?? []) if (a?.kind) kinds.add(a.kind);
  for (const f of l.furniture) if (f.action?.kind) kinds.add(f.action.kind);
  for (const want of ['raceGate', 'raceStart', 'spawnPoint', 'raceRecords', 'appliance', 'portal']) {
    assert.ok(kinds.has(want), `nothing on the raceway carries a "${want}" action`);
  }
});
