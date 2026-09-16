/**
 * Walking over to a kart and getting in — what a double-click on the bodywork asks for.
 *
 * Boarding was already a request the server decides (`boardKart` checks the distance to the
 * CHARACTER), so the only new thing here is the walk in front of it. What that adds is a gap in
 * time, and every claim below is about something that can change during it: the kart can be taken,
 * the walker can change their mind, the walker can already be at the wheel.
 *
 *  1. **Out of reach, you walk; in reach, you are simply in.** A gesture that does nothing because
 *     you were standing too close would be baffling.
 *  2. **The intent is re-checked on arrival.** Somebody else getting in first ends the walk where
 *     it ends and does nothing, which is the honest outcome — not a stolen seat, not a hang.
 *  3. **A new intent cancels the old one.** Six commands cancel a pending walk-to-something, and
 *     `pendingBoard` is carried by the same rule rather than by a seventh copy of it — otherwise a
 *     change of mind puts you in a kart a click later, from across the room.
 *  4. **A driver asking to approach a kart stays where they are.** `boardKart` is a TOGGLE, so the
 *     naive call would get them OUT, which is the opposite of what the gesture means.
 *  5. **The kart you clicked is the kart you get.** Boarding otherwise takes the NEAREST free one,
 *     so somebody standing beside one car who clicks another across the grid gets into the car
 *     they were leaning on. Found in a browser, which is where a gesture aimed at a picture can
 *     first be told apart from one aimed at "a kart".
 *
 * TEST BOUNDARIES:
 *   @real-dependency: OfficeState over the committed raceway -- Mock? NO. The walk is a real path
 *       over a real map, and "a tile beside the kart" only means something on one.
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { before } from 'node:test';

import { KART_BOARD_REACH_TILES, RACE_TICK_HZ, TILE_SIZE } from '@pixel/shared/office/constants.js';
import { OfficeState } from '@pixel/shared/office/engine/officeState.js';
import { buildDynamicCatalog } from '@pixel/shared/office/layout/furnitureCatalog';
import type { OfficeLayout } from '@pixel/shared/office/types';

import { buildFurnitureCatalogAndSprites } from './assets.js';
import { importTmjToLayout } from './tiled/mapBridge.js';
import { loadTiledRegistry } from './tiled/tiledRegistry.js';

const ROOT = join(import.meta.dirname, '..', '..');
let circuit: OfficeLayout;

before(async () => {
  buildDynamicCatalog((await buildFurnitureCatalogAndSprites()) as never);
  const reg = loadTiledRegistry(ROOT);
  circuit = importTmjToLayout(
    JSON.parse(readFileSync(join(ROOT, 'assets', 'tiled', 'zones', 'raceway.tmj'), 'utf8')),
    reg,
    () => null,
  ).layout;
});

const DT = 1 / RACE_TICK_HZ;

/**
 * A walker standing well away from the grid: far enough that boarding must walk, and on a tile the
 * map really CONNECTS to the karts.
 *
 * It gets there by walking rather than by being placed, which is the point: `walkableTiles` holds
 * every standable cell, and on a real map some of them are in another component — the first one on
 * the raceway is (0, 0), from which no kart is reachable at all. So the starting spot is one the
 * pathfinder has already agreed to.
 */
function walker(os: OfficeState, name: string): number {
  const id = os.addPlayer('char_0', name, undefined, name.toLowerCase());
  const ch = os.characters.get(id);
  assert.ok(ch);
  const karts = [...os.karts.values()];
  const grid = karts.find((k) => k.ownerId === id) ?? karts[0];
  ch.tileCol = Math.floor(grid.x / TILE_SIZE);
  ch.tileRow = Math.floor(grid.y / TILE_SIZE);
  ch.x = grid.x;
  ch.y = grid.y;
  const far = os.walkableTiles.find(({ col, row }) => {
    const x = col * TILE_SIZE + TILE_SIZE / 2;
    const y = row * TILE_SIZE + TILE_SIZE / 2;
    if (karts.some((k) => Math.hypot(k.x - x, k.y - y) <= TILE_SIZE * (KART_BOARD_REACH_TILES + 6))) return false;
    return os.walkPlayer(id, col, row);
  });
  assert.ok(far, 'no reachable tile on this map is out of reach of every kart');
  for (let i = 0; i < 5000 && ch.path.length > 0; i++) os.update(DT);
  assert.equal(ch.path.length, 0, 'the walker never reached its starting spot');
  return id;
}

/** Tick until the walker is in a kart, or give up. Returns the ticks it took, or null. */
function runUntilBoarded(os: OfficeState, id: number, ticks = 2000): number | null {
  for (let i = 0; i < ticks; i++) {
    os.update(DT);
    if (os.kartOf(id)) return i;
  }
  return null;
}

test('out of reach walks; in reach is immediate', () => {
  const os = new OfficeState(circuit as never);
  const id = walker(os, 'Walker');
  const ch = os.characters.get(id)!;
  // Their own car, which is the only one they may drive: one is spawned per person.
  const kart = [...os.karts.values()].find((k) => k.ownerId === id)!;

  assert.equal(os.walkPlayerToKart(id, kart.id), true, 'the walk was refused');
  assert.equal(os.kartOf(id), null, 'boarded from across the map without walking');
  assert.ok(ch.path.length > 0, 'no path was set');

  const took = runUntilBoarded(os, id);
  assert.ok(took !== null, 'the walker never arrived');
  assert.equal(os.kartOf(id)?.id, kart.id, 'arrived and got into the wrong kart');

  // …and from beside it, the same call is simply a board.
  const other = os.addPlayer('char_0', 'Near', undefined, 'near');
  const free = [...os.karts.values()].find((k) => k.ownerId === other)!;
  const nearCh = os.characters.get(other)!;
  nearCh.x = free.x;
  nearCh.y = free.y;
  assert.equal(os.walkPlayerToKart(other, free.id), true);
  assert.equal(os.kartOf(other)?.id, free.id, 'standing on the kart did not board it');
});

/**
 * Somebody else's car is not yours, even standing on it.
 *
 * This used to be "the kart you clicked is the kart you get, even standing beside another", which
 * is the same question asked of a world where the grid was full of cars nobody owned. There is one
 * car per person now, so the interesting case is the other way round: the near car belongs to
 * somebody else and the answer has to be no rather than a walk that ends in a refusal.
 */
test('a car that is not yours is refused, even from on top of it', () => {
  const os = new OfficeState(circuit as never);
  const theirs = os.addPlayer('char_0', 'Owner', undefined, 'owner');
  const other = [...os.karts.values()].find((k) => k.ownerId === theirs)!;
  const id = os.addPlayer('char_0', 'Picky', undefined, 'picky');
  const mine = [...os.karts.values()].find((k) => k.ownerId === id)!;
  assert.notEqual(mine.id, other.id, 'two people were given the same car');
  const ch = os.characters.get(id)!;
  ch.tileCol = Math.floor(other.x / TILE_SIZE);
  ch.tileRow = Math.floor(other.y / TILE_SIZE);
  ch.x = other.x;
  ch.y = other.y;

  assert.equal(os.walkPlayerToKart(id, other.id), false, 'somebody else’s car was offered');
  // `boardKart` with no kart named takes the nearest of YOUR OWN, and on a grid the slots are a
  // tile apart — so what this pins is not that it refuses, but that whatever it finds is never
  // somebody else's car.
  os.boardKart(id);
  const got = os.kartOf(id);
  assert.ok(got === null || got.id === mine.id, 'boarded somebody else’s car');
  if (got) assert.equal(os.boardKart(id), true, 'could not get back out');
  // Their own, asked for by name, works.
  assert.equal(os.walkPlayerToKart(id, mine.id), true, 'their own car was refused');
  const took = runUntilBoarded(os, id);
  assert.ok(took !== null, 'the walker never arrived');
  assert.equal(os.kartOf(id)?.id, mine.id, 'ended up somewhere other than their own car');
});

/**
 * A car that stops existing while you walk to it leaves nothing behind.
 *
 * This was "a kart taken while you walk is not taken from its driver", which cannot happen any
 * more — a car is its owner's and nobody else can get in. What CAN happen is the shape underneath
 * it: the thing you are walking to goes away. Their car is removed the moment they are no longer a
 * kart's owner, and the intent on the walker's body has to go with it rather than being carried
 * round for the rest of the session.
 */
test('a car that vanishes while you walk leaves no intent behind', () => {
  const os = new OfficeState(circuit as never);
  const id = walker(os, 'Late');
  const kart = [...os.karts.values()].find((k) => k.ownerId === id)!;
  assert.equal(os.walkPlayerToKart(id, kart.id), true);
  const ch = os.characters.get(id)!;
  assert.equal(ch.pendingBoard, kart.id, 'the intent was not set');

  // …and the car is gone: on a real server this is the owner's own zone switch or disconnect.
  os.karts.delete(kart.id);
  for (let i = 0; i < 2000; i++) os.update(DT);
  assert.equal(os.kartOf(id), null, 'the walker ended up in a car anyway');
  assert.equal(ch.pendingBoard ?? null, null, 'the intent was left on the body');
});

test('a change of mind cancels the intent', () => {
  const os = new OfficeState(circuit as never);
  const id = walker(os, 'Fickle');
  const kart = [...os.karts.values()].find((k) => k.ownerId === id)!;
  const ch = os.characters.get(id)!;
  assert.equal(os.walkPlayerToKart(id, kart.id), true);
  assert.equal(ch.pendingBoard, kart.id);

  // Walk somewhere else instead — the same gesture that cancels a walk-to-monitor.
  assert.equal(os.walkPlayer(id, ch.tileCol, ch.tileRow + 1), true, 'walking away was refused');
  assert.equal(ch.pendingBoard ?? null, null, 'walking away kept the boarding intent');

  for (let i = 0; i < 2000; i++) os.update(DT);
  assert.equal(os.kartOf(id), null, 'a cancelled intent still put the player in a kart');
});

test('asking to approach a kart while driving does not throw you out', () => {
  const os = new OfficeState(circuit as never);
  const id = os.addPlayer('char_0', 'Driver', undefined, 'driver');
  const mine = [...os.karts.values()].find((k) => k.ownerId === id)!;
  const ch = os.characters.get(id)!;
  ch.x = mine.x;
  ch.y = mine.y;
  assert.equal(os.boardKart(id), true);
  const someone = os.addPlayer('char_0', 'Bystander', undefined, 'bystander');
  const theirs = [...os.karts.values()].find((k) => k.ownerId === someone)!;

  assert.equal(os.walkPlayerToKart(id, theirs.id), false, 'a driver was sent walking');
  assert.equal(os.kartOf(id)?.id, mine.id, 'the driver was tipped out of their kart');
});

test('an unknown, occupied or borrowed kart is refused outright', () => {
  const os = new OfficeState(circuit as never);
  const id = walker(os, 'Asker');
  assert.equal(os.walkPlayerToKart(id, 999999), false, 'a kart that does not exist was walked to');

  const kart = [...os.karts.values()].find((k) => k.ownerId === id)!;
  kart.driverId = 12345; // somebody else's
  assert.equal(os.walkPlayerToKart(id, kart.id), false, 'a kart with a driver was walked to');
  kart.driverId = null;
  kart.ownerId = 12345; // …and now it is not theirs at all
  assert.equal(os.walkPlayerToKart(id, kart.id), false, 'somebody else’s car was walked to');
});
