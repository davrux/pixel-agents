/**
 * Item boxes, what comes out of them, and the kart a driver chose.
 *
 * Two features that meet in the same place: a race where the cars differ and a race where you can
 * do something about the car in front. What both have in common is that everything is resolved
 * server-side from the world — a client says "now" and nothing else — so these drive the engine
 * rather than the wire.
 *
 * The claims worth pinning are the rules that are cheap to break by accident:
 *
 *  - A box gives you something only if your hands are empty. That one rule is why a box has no
 *    state on the wire, so losing it costs a synced collection, not a detail.
 *  - A shield refuses a shove and the shover still pays. A shield that made a kart immovable would
 *    be a wall with a driver in it.
 *  - Oil is consumed by whoever spins on it, so a corner cannot be made impassable for a race.
 *  - What a car IS is decided when somebody gets into it, from the account — not from the seat.
 *
 * TEST BOUNDARIES:
 *   @real-dependency: the committed circuits through the real importer and OfficeState -- Mock? NO.
 *       Where a box sits and whether the road is under it is a fact about a real map.
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { before } from 'node:test';

import {
  ITEM_OIL_SEC,
  ITEM_SHIELD_SEC,
  ITEM_SPIN_SEC,
  RACE_TICK_HZ,
} from '@pixel/shared/office/constants.js';
import { OfficeState } from '@pixel/shared/office/engine/officeState.js';
import { buildDynamicCatalog } from '@pixel/shared/office/layout/furnitureCatalog';
import { KartItem, KART_ITEMS, drawItem } from '@pixel/shared/office/race/items.js';
import { bumpKarts, createKart, type Kart } from '@pixel/shared/office/race/kart.js';
import { KART_SPECS } from '@pixel/shared/office/race/kartSpec.js';
import { racerUsesItem } from '@pixel/shared/office/race/racerDriver.js';
import { isRough } from '@pixel/shared/office/race/track.js';
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

interface Sim {
  os: OfficeState;
  kart: Kart;
  driver: number;
}

/** One human at the wheel of the lone kart on a track, the lights already out. */
function seated(zone: string, owner = 'items'): Sim {
  const os = new OfficeState(layouts.get(zone) as never);
  assert.ok(os.raceTrack(), `${zone} is not a track`);
  const kart = [...os.karts.values()][0];
  for (const other of [...os.karts.keys()]) if (other !== kart.id) os.karts.delete(other);
  const driver = os.addPlayer('char_0', 'Item', undefined, owner);
  const ch = os.characters.get(driver);
  assert.ok(ch);
  ch.x = kart.x;
  ch.y = kart.y;
  assert.equal(os.boardKart(driver), true, 'could not board the kart on the grid');
  assert.equal(os.startRace(), true, 'the race would not start');
  while (os.raceInfo().phase === 'countdown') os.update(DT);
  return { os, kart, driver };
}

/** Drop the kart onto a cell and run one tick, which is what picking anything up takes. */
function stepOnto(sim: Sim, cell: string): void {
  const [col, row] = cell.split(',').map(Number);
  sim.kart.x = col * TILE_SIZE + TILE_SIZE / 2;
  sim.kart.y = row * TILE_SIZE + TILE_SIZE / 2;
  sim.kart.input = { throttle: 0, steer: 0 };
  sim.os.update(DT);
}

test('a box hands out an item, and only to a driver with empty hands', () => {
  for (const zone of TRACKS) {
    const sim = seated(zone, `box-${zone}`);
    const track = sim.os.raceTrack();
    assert.ok(track);
    const box = [...track.itemBox][0];
    assert.ok(box, `${zone} has no item boxes at all`);
    stepOnto(sim, box);
    assert.notEqual(sim.kart.item, KartItem.None, `${zone}: driving over a box handed out nothing`);
    // …and again with something already in hand: the box does nothing, which is the rule that
    // keeps a box from needing any state of its own.
    sim.kart.item = KartItem.Shield;
    stepOnto(sim, box);
    assert.equal(sim.kart.item, KartItem.Shield, `${zone}: a second box overwrote what was held`);
  }
});

test('every circuit puts its boxes on the road and clear of the grid', () => {
  for (const zone of TRACKS) {
    const os = new OfficeState(layouts.get(zone) as never);
    const track = os.raceTrack();
    assert.ok(track);
    assert.ok(track.itemBox.size >= 3, `${zone} has only ${track.itemBox.size} item boxes`);
    const grid = new Set(
      track.grid.map((g) => `${Math.floor(g.x / TILE_SIZE)},${Math.floor(g.y / TILE_SIZE)}`),
    );
    for (const cell of track.itemBox) {
      const [col, row] = cell.split(',').map(Number);
      assert.equal(isRough(track, col, row), false, `${zone}: a box at ${cell} is off the racing surface`);
      // A box on the grid is a free item for whoever drew that column, which is the opposite of a
      // choice — the same rule the boost pads follow.
      assert.equal(grid.has(cell), false, `${zone}: a box at ${cell} sits on a starting slot`);
    }
  }
});

test('the three items each do what they say, and spending one empties the slot', () => {
  const boost = seated('monza', 'i-boost');
  boost.kart.item = KartItem.Boost;
  assert.equal(boost.os.useKartItem(boost.driver), true);
  assert.ok(boost.kart.boostMs > 0, 'a boost was spent and nothing was boosted');
  assert.equal(boost.kart.item, KartItem.None, 'the slot was not emptied');

  const shield = seated('monza', 'i-shield');
  shield.kart.item = KartItem.Shield;
  assert.equal(shield.os.useKartItem(shield.driver), true);
  assert.ok(
    shield.kart.shieldMs > ITEM_SHIELD_SEC * 900,
    `a shield came up for ${(shield.kart.shieldMs / 1000).toFixed(1)} s`,
  );

  const oil = seated('monza', 'i-oil');
  oil.kart.item = KartItem.Oil;
  assert.equal(oil.os.oilSlicks().length, 0, 'the road started with oil on it');
  assert.equal(oil.os.useKartItem(oil.driver), true);
  assert.equal(oil.os.oilSlicks().length, 1, 'dropping oil left none on the road');
  // BEHIND the car: a driver must not be able to drop one onto their own bonnet.
  const [col, row] = oil.os.oilSlicks()[0].split(',').map(Number);
  const ahead = Math.cos(oil.kart.heading) * (col * TILE_SIZE + TILE_SIZE / 2 - oil.kart.x) +
    Math.sin(oil.kart.heading) * (row * TILE_SIZE + TILE_SIZE / 2 - oil.kart.y);
  assert.ok(ahead < 0, `the oil landed ${ahead.toFixed(0)} px AHEAD of the car`);

  // An empty slot spends nothing, and says so rather than pretending.
  const empty = seated('monza', 'i-empty');
  assert.equal(empty.os.useKartItem(empty.driver), false);
});

test('a shield refuses a shove, and the car that gave it still pays', () => {
  const a = createKart(1, { x: 100, y: 100 }, 0);
  const b = createKart(2, { x: 110, y: 100 }, 0);
  a.driverId = 1;
  b.driverId = 2;
  a.state = b.state = 'drive';
  a.vx = 200;
  b.shieldMs = 3000;
  const beforeA = a.vx;
  assert.equal(bumpKarts(a, b), true, 'two overlapping karts did not touch at all');
  assert.equal(b.vx, 0, 'a shielded kart was shoved');
  assert.ok(a.vx < beforeA, 'the car that rammed a shield kept all its speed');

  // Without the shield the same contact moves it, or the test above proves nothing.
  const c = createKart(3, { x: 100, y: 100 }, 0);
  const d = createKart(4, { x: 110, y: 100 }, 0);
  c.driverId = 3;
  d.driverId = 4;
  c.state = d.state = 'drive';
  c.vx = 200;
  bumpKarts(c, d);
  assert.ok(d.vx > 0, 'an unshielded kart was not shoved either');
});

test('oil spins the next car through it, once, and a shield walks over it', () => {
  const sim = seated('monza', 'i-spin');
  sim.kart.item = KartItem.Oil;
  assert.equal(sim.os.useKartItem(sim.driver), true);
  const cell = sim.os.oilSlicks()[0];
  assert.ok(cell);
  stepOnto(sim, cell);
  assert.ok(sim.kart.spinMs > ITEM_SPIN_SEC * 900, 'driving through oil did not spin the car');
  // Consumed: one slick is one victim, so a corner cannot be closed for the rest of the race.
  assert.equal(sim.os.oilSlicks().length, 0, 'the oil survived the car it caught');

  const safe = seated('monza', 'i-safe');
  safe.kart.item = KartItem.Oil;
  safe.os.useKartItem(safe.driver);
  const at = safe.os.oilSlicks()[0];
  safe.kart.shieldMs = 3000;
  stepOnto(safe, at);
  assert.equal(safe.kart.spinMs, 0, 'a shielded car spun on oil anyway');
  assert.equal(safe.os.oilSlicks().length, 1, 'a shielded car mopped the oil up');
});

test('oil dries, and the clock is the one the constant names', () => {
  const sim = seated('monza', 'i-dry');
  sim.kart.item = KartItem.Oil;
  sim.os.useKartItem(sim.driver);
  // Away from it, or the car picks its own oil up on the next tick.
  sim.kart.x += TILE_SIZE * 8;
  for (let i = 0; i < Math.round((ITEM_OIL_SEC - 1) / DT); i++) sim.os.update(DT);
  assert.equal(sim.os.oilSlicks().length, 1, 'the oil dried early');
  for (let i = 0; i < Math.round(2 / DT); i++) sim.os.update(DT);
  assert.equal(sim.os.oilSlicks().length, 0, 'the oil never dried');
});

test('nothing can be spent while the lights are still red', () => {
  const os = new OfficeState(layouts.get('monza') as never);
  const kart = [...os.karts.values()][0];
  const driver = os.addPlayer('char_0', 'Grid', undefined, 'i-grid');
  const ch = os.characters.get(driver);
  assert.ok(ch);
  ch.x = kart.x;
  ch.y = kart.y;
  assert.equal(os.boardKart(driver), true);
  assert.equal(os.startRace(), true);
  const mine = os.karts.get(kart.id);
  assert.ok(mine);
  mine.item = KartItem.Boost;
  assert.equal(os.raceInfo().phase, 'countdown');
  assert.equal(os.useKartItem(driver), false, 'an item was spent before the lights went out');
  assert.equal(mine.item, KartItem.Boost, 'the slot was emptied anyway');
});

test('what you were holding stays in the car you got out of', () => {
  const sim = seated('monza', 'i-out');
  sim.kart.item = KartItem.Boost;
  sim.kart.shieldMs = 5000;
  assert.equal(sim.os.boardKart(sim.driver), true, 'could not get out');
  assert.equal(sim.kart.item, KartItem.None, 'the item survived the driver leaving');
  assert.equal(sim.kart.shieldMs, 0, 'the shield survived the driver leaving');
});

test('what a car IS is decided when somebody gets in, from their account', () => {
  const os = new OfficeState(layouts.get('monza') as never);
  const gripper = KART_SPECS.find((k) => k.id === 'gripper');
  assert.ok(gripper, 'the spec table has no gripper');
  os.setKartPref('spec-owner', gripper.id);
  const kart = [...os.karts.values()][0];
  const driver = os.addPlayer('char_0', 'Spec', undefined, 'spec-owner');
  const ch = os.characters.get(driver);
  assert.ok(ch);
  ch.x = kart.x;
  ch.y = kart.y;
  assert.equal(os.boardKart(driver), true);
  assert.equal(kart.spec, gripper.id, 'the kart did not take the account’s choice');
  // And it does not stay with the SEAT: the next person gets their own.
  assert.equal(os.boardKart(driver), true, 'could not get out');
  const other = os.addPlayer('char_0', 'Plain', undefined, 'plain-owner');
  const oc = os.characters.get(other);
  assert.ok(oc);
  oc.x = kart.x;
  oc.y = kart.y;
  assert.equal(os.boardKart(other), true);
  assert.equal(kart.spec, 'balanced', 'the kart kept the previous driver’s choice');
});

test('a computer driver spends what it picks up', () => {
  // Without this the field fills its hands at the first box and drives round armed for the rest of
  // the race — measured in a browser before it existed: four pickups in a minute across seven
  // cars, not one of them used, against fourteen uses a minute afterwards.
  const sim = seated('ring', 'i-bot');
  const inner = sim.os as unknown as { tileMap: number[][]; blockedTiles: Set<string>; walls: unknown };
  const world = {
    tileMap: inner.tileMap,
    blockedTiles: inner.blockedTiles,
    walls: inner.walls,
    track: sim.os.raceTrack(),
  } as never;
  // A shield and oil are spent the moment they are held: what they are worth does not depend on
  // where the car is.
  sim.kart.item = KartItem.Shield;
  assert.equal(racerUsesItem(sim.kart, world), true, 'a driver sat on a shield');
  sim.kart.item = KartItem.Oil;
  assert.equal(racerUsesItem(sim.kart, world), true, 'a driver sat on its oil');
  // A boost waits for road to spend it on, and never doubles up on one it is already running.
  sim.kart.item = KartItem.Boost;
  sim.kart.boostMs = 1500;
  assert.equal(racerUsesItem(sim.kart, world), false, 'a driver boosted while already boosting');
  sim.kart.boostMs = 0;
  // Empty hands are empty hands.
  sim.kart.item = KartItem.None;
  assert.equal(racerUsesItem(sim.kart, world), false, 'a driver used an item it did not have');
});

test('the draw covers the whole table and nothing outside it', () => {
  const seen = new Set<KartItem>();
  for (let i = 0; i < 300; i++) seen.add(drawItem(i / 300));
  assert.equal(seen.size, KART_ITEMS.length, `the draw produced ${seen.size} of ${KART_ITEMS.length} items`);
  assert.equal(seen.has(KartItem.None), false, 'a box handed out nothing at all');
  // The ends are the two that a rounding slip loses.
  assert.equal(drawItem(0), KART_ITEMS[0].kind);
  assert.equal(drawItem(0.999999), KART_ITEMS[KART_ITEMS.length - 1].kind);
  assert.equal(drawItem(1), KART_ITEMS[KART_ITEMS.length - 1].kind, 'a roll of exactly 1 fell off the table');
});
