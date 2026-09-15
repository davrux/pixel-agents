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
  KART_RADIUS_PX,
  KART_RESPAWN_REACH_TILES,
  RACE_TICK_HZ,
} from '@pixel/shared/office/constants.js';
import { OfficeState } from '@pixel/shared/office/engine/officeState.js';
import { buildDynamicCatalog } from '@pixel/shared/office/layout/furnitureCatalog';
import type { Kart } from '@pixel/shared/office/race/kart.js';
import { isRough, raceTrack } from '@pixel/shared/office/race/track.js';
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
  // Alone on the track: what is under test is the MAP — whether this circuit can be driven — and
  // a grid full of opponents would mix their bumping into the answer. Racing them has its own
  // test (race.int.test.ts).
  for (const other of [...os.karts.keys()]) if (other !== kart.id) os.karts.delete(other);
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
    const kart = [...os.karts.values()][0];
    const driver = os.characters.size > 1 ? null : os.addPlayer('char_0', 'Victim', undefined, 'victim');
    if (driver !== null) {
      const ch = os.characters.get(driver)!;
      ch.x = kart.x;
      ch.y = kart.y;
      os.boardKart(driver);
    }
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
  const kart = [...os.karts.values()][0];
  const driver = os.addPlayer('char_0', 'Faller', undefined, 'faller');
  const ch = os.characters.get(driver)!;
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
  assert.ok(spawnTiles.length > 0, 'the map places no spawn points');

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
