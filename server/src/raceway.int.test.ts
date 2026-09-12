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

import { KART_MAX_SPEED_PX_PER_SEC, KART_RADIUS_PX, RACE_TICK_HZ } from '@pixel/shared/office/constants.js';
import { OfficeState } from '@pixel/shared/office/engine/officeState.js';
import { buildDynamicCatalog } from '@pixel/shared/office/layout/furnitureCatalog';
import type { Kart } from '@pixel/shared/office/race/kart.js';
import { raceTrack } from '@pixel/shared/office/race/track.js';
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

test('the committed map imports as a track: four gates, a grid, its lap count', () => {
  const track = raceTrack(layout);
  assert.ok(track, 'raceway.tmj is not recognised as a race track');
  assert.equal(track.gates.length, 4, `gates: ${track.gates.length}`);
  assert.equal(track.laps, 3, 'the laps property did not survive the import');
  assert.equal(track.grid.length, 8, `grid slots: ${track.grid.length}`);
  // Each gate is a LINE across the road, or a kart drives past it.
  for (const gate of track.gates) {
    assert.ok(gate.tiles.size >= 4, `gate ${gate.index} is only ${gate.tiles.size} tiles wide`);
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
  assert.equal(track.gates.length, 4, `gates after a save: ${track.gates.length}`);
  assert.equal(track.grid.length, 8, `grid slots after a save: ${track.grid.length}`);
  assert.equal(track.laps, 3, 'the lap count did not survive a save');
});

test('the engine puts one kart on each grid slot, parked and facing the first corner', () => {
  const os = world();
  const track = os.raceTrack();
  assert.ok(track);
  assert.equal(os.karts.size, track.grid.length, 'the grid was not filled');
  for (const kart of os.karts.values()) {
    assert.equal(kart.driverId, null, 'a kart started with a driver');
    assert.equal(kart.state, 'idle');
    assert.ok(
      track.grid.some((slot) => Math.hypot(slot.x - kart.x, slot.y - kart.y) < 1),
      'a kart is not on a grid slot',
    );
  }
});

test('an autopilot drives three laps without falling off', () => {
  const os = world();
  const track = os.raceTrack();
  assert.ok(track);
  const kart = [...os.karts.values()][0];
  // A real driver, boarded the real way. Setting `driverId` by hand does not work and the reason
  // is a safety rule rather than an accident: `updateKarts` frees a kart whose driver is not in
  // the zone, so a made-up id empties the seat on the very next tick.
  const driver = os.addPlayer('char_0', 'Autopilot', undefined, 'autopilot');
  const ch = os.characters.get(driver);
  assert.ok(ch);
  ch.x = kart.x;
  ch.y = kart.y;
  assert.equal(os.boardKart(driver), true, 'could not board the kart on the grid');
  // Without a race there is no finish, because there is no lap limit — that is the whole of
  // "drive around as long as you like". So the autopilot starts one, and sits out the lights.
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
  assert.equal(kart.lap, 3, `finished on lap ${kart.lap}`);
  assert.equal(os.raceInfo().entries.get(kart.id)?.place, 1, 'the only finisher did not come first');
  assert.equal(falls, 0, `fell off ${falls} time(s) while following the racing line`);
  // A lap of this oval is about 150 tiles of road; three of them at the speed limit cannot be
  // done in under twenty seconds, and taking three minutes would mean it was crawling.
  const seconds = ticks * dt;
  assert.ok(seconds > 20 && seconds < 170, `three laps took ${seconds.toFixed(1)} s`);
});

test('a driver who never lifts does not get round', () => {
  // The complaint this track was rebuilt for: "ich kann problemlos mit Vollgas fahren". The
  // handling model was never the problem — a nine-tile road round a small infield has no corner
  // tight enough to ask anything of it. Five tiles does, and this is how that is checked: the
  // SAME autopilot, with the throttle pinned, must fail where the one that lifts succeeds.
  const os = world();
  const track = os.raceTrack();
  assert.ok(track);
  const kart = [...os.karts.values()][0];
  const driver = os.addPlayer('char_0', 'Flatout', undefined, 'flatout');
  const ch = os.characters.get(driver);
  assert.ok(ch);
  ch.x = kart.x;
  ch.y = kart.y;
  assert.equal(os.boardKart(driver), true);
  assert.equal(os.startRace(), true);

  const dt = 1 / RACE_TICK_HZ;
  let falls = 0;
  let lastState: Kart['state'] = kart.state;
  for (let i = 0; i < Math.round(45 / dt); i++) {
    if (os.raceInfo().phase !== 'countdown') {
      const target = track.gates[(kart.gate + 1) % track.gates.length];
      let diff = Math.atan2(target.y - kart.y, target.x - kart.x) - kart.heading;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      kart.input = { throttle: 1, steer: diff > 0.05 ? 1 : diff < -0.05 ? -1 : 0 };
    }
    os.update(dt);
    if (kart.state === 'fall' && lastState !== 'fall') falls++;
    lastState = kart.state;
  }
  assert.ok(falls > 0, 'forty-five seconds of full throttle cost nothing at all');
  assert.equal(kart.finished, false, 'a driver who never lifted still finished the race');
});

test('a kart cannot leave the map, barrier or no barrier', () => {
  const os = world();
  const kart = [...os.karts.values()][0];
  kart.driverId = 1;
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
