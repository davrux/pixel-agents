/**
 * What a race is set to before it starts — and that the server, not the panel, decides.
 *
 * Four things used to be the map's alone: the lap count, a grid filled to the last slot with
 * computer drivers, a fixed countdown, and a difficulty you could only pass to `/race`. They are
 * settings now, which means they are values arriving from a client — so what is pinned here is
 * mostly the clamping (§ Security: the panel's own bounds are UX, `setRaceSetup` is the gate).
 *
 * TEST BOUNDARIES:
 *   @real-dependency: OfficeState over the two committed circuits -- Mock? NO. The bot count is
 *       bounded by the real grid, which is a fact about the maps.
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { before } from 'node:test';

import {
  RACE_COUNTDOWN_CHOICES,
  RACE_DEFAULT_BOTS,
  RACE_DEFAULT_COUNTDOWN_SEC,
  RACE_MAX_LAPS,
  RACE_MIN_LAPS,
  RACE_TICK_HZ,
} from '@pixel/shared/office/constants.js';
import { OfficeState } from '@pixel/shared/office/engine/officeState.js';
import { buildDynamicCatalog } from '@pixel/shared/office/layout/furnitureCatalog';
import { RACE_GREEN_MS } from '@pixel/shared/office/race/raceState.js';
import type { OfficeLayout } from '@pixel/shared/office/types';

import { buildFurnitureCatalogAndSprites } from './assets.js';
import { importTmjToLayout } from './tiled/mapBridge.js';
import { loadTiledRegistry } from './tiled/tiledRegistry.js';

const ROOT = join(import.meta.dirname, '..', '..');
let circuit: OfficeLayout;
/** A DIFFERENT track, for the test that pushes one map over another. */
let second: OfficeLayout;

before(async () => {
  buildDynamicCatalog((await buildFurnitureCatalogAndSprites()) as never);
  const reg = loadTiledRegistry(ROOT);
  const read = (zone: string): OfficeLayout =>
    importTmjToLayout(JSON.parse(readFileSync(join(ROOT, 'assets', 'tiled', 'zones', `${zone}.tmj`), 'utf8')), reg, () => null)
      .layout;
  circuit = read('raceway');
  second = read('monza');
});

const DT = 1 / RACE_TICK_HZ;

/** A zone with one person sitting in a kart — the state the panel is used from. */
function seated(layout: OfficeLayout): { os: OfficeState; driver: number } {
  const os = new OfficeState(layout as never);
  const driver = os.addPlayer('char_0', 'Setter', undefined, 'setter');
  const ch = os.characters.get(driver);
  // Their own car: a kart is spawned for whoever is on the track and belongs to them.
  const kart = [...os.karts.values()].find((k) => k.ownerId === driver)!;
  assert.ok(ch);
  ch.x = kart.x;
  ch.y = kart.y;
  assert.equal(os.boardKart(driver), true);
  return { os, driver };
}

test('the map is the default, not the rule', () => {
  const os = new OfficeState(circuit as never);
  const track = os.raceTrack();
  assert.ok(track);
  const setup = os.raceSetup();
  assert.equal(setup.laps, track.laps, 'the lap count did not start at what the mapper drew');
  // NOT a full grid, and that is the point of the number: a map's grid says how many cars it can
  // hold, which is not how many a race wants. Eleven opponents is a queue — asked for as "nicht
  // mehr als 6 Autos" — and the panel still goes to the grid's full size for anybody who wants it.
  assert.equal(setup.bots, Math.min(RACE_DEFAULT_BOTS, track.grid.length - 1));
  assert.ok(track.grid.length - 1 > RACE_DEFAULT_BOTS, 'this map is too small for the cap to mean anything');
  assert.equal(setup.countdownSec, RACE_DEFAULT_COUNTDOWN_SEC);
  assert.equal(setup.difficulty, 'medium');
});

test('every number is clamped where it arrives, not where it is shown', () => {
  const os = new OfficeState(circuit as never);
  const slots = os.raceTrack()!.grid.length;
  assert.equal(os.setRaceSetup({ laps: 0 }).laps, RACE_MIN_LAPS, 'zero laps was accepted');
  assert.equal(os.setRaceSetup({ laps: 9999 }).laps, RACE_MAX_LAPS, 'a race of nine thousand laps');
  assert.equal(os.setRaceSetup({ laps: 4.7 }).laps, 4, 'a fractional lap count');
  assert.equal(os.setRaceSetup({ laps: NaN }).laps, RACE_MIN_LAPS, 'NaN laps');
  assert.equal(os.setRaceSetup({ bots: -3 }).bots, 0, 'a negative number of drivers');
  assert.equal(os.setRaceSetup({ bots: 500 }).bots, slots, 'more computer drivers than the grid holds');
  // A countdown is a CHOICE, so an unknown one is refused outright rather than clamped into the
  // nearest — 7 is not "nearly 5", it is not one of the lengths this game offers.
  assert.equal(os.setRaceSetup({ countdownSec: 7 }).countdownSec, RACE_DEFAULT_COUNTDOWN_SEC);
  for (const c of RACE_COUNTDOWN_CHOICES) assert.equal(os.setRaceSetup({ countdownSec: c }).countdownSec, c);
  assert.equal(os.setRaceSetup({ difficulty: 'impossible' as never }).difficulty, 'medium');
  assert.equal(os.setRaceSetup({ difficulty: 'hard' }).difficulty, 'hard');
});

test('a patch changes one field and leaves the others alone', () => {
  // Two people at the same panel nudge different things; restating all four would mean whoever
  // clicked last undid the other.
  const os = new OfficeState(circuit as never);
  os.setRaceSetup({ laps: 7, difficulty: 'hard' });
  const after = os.setRaceSetup({ bots: 2 });
  assert.equal(after.laps, 7);
  assert.equal(after.difficulty, 'hard');
  assert.equal(after.bots, 2);
});

test('the settings are what the race actually runs', () => {
  const { os } = seated(circuit);
  os.setRaceSetup({ laps: 6, bots: 3, countdownSec: 10 });
  assert.equal(os.startRace(), true);
  const race = os.raceInfo();
  assert.equal(race.laps, 6, "the race ran the map’s laps instead of the setting");
  // One human plus exactly three computer drivers — not a full grid.
  assert.equal(race.entries.size, 4, 'the grid was filled past what was asked for');
  assert.equal(race.timerMs, 10 * 1000 + RACE_GREEN_MS, 'the lights ignored the setting');
});

test('nought computer drivers is a race, and it is just you', () => {
  const { os } = seated(circuit);
  os.setRaceSetup({ bots: 0 });
  assert.equal(os.startRace(), true);
  assert.equal(os.raceInfo().entries.size, 1);
  // …and the field really is empty, rather than filled and then hidden.
  assert.equal([...os.karts.values()].filter((k) => k.driverId !== null).length, 1);
});

// The stage that used to be checked here was `hillroad`, and the race keeps only closed circuits
// now. That a sprint ignores the lap setting is pinned in raceSetup.int.test.ts, over a layout
// built for it — no map needed, since the claim is about a track that HAS a finish line and not
// about any particular one.

test('a race already under way cannot be reconfigured underneath itself', () => {
  const { os } = seated(circuit);
  os.setRaceSetup({ laps: 4 });
  assert.equal(os.startRace(), true);
  for (let i = 0; i < 30; i++) os.update(DT);
  const ignored = os.setRaceSetup({ laps: 20, bots: 0 });
  assert.equal(ignored.laps, 4, 'the lap count changed during a countdown');
  assert.equal(os.raceInfo().laps, 4);
});

test('a fresh track brings its own defaults, and drops the last one’s', () => {
  // Pushing a map is how a zone becomes a different track; settings for the old one are settings
  // for a lap count and a grid that no longer exist.
  const os = new OfficeState(circuit as never);
  os.setRaceSetup({ laps: 11, bots: 1, countdownSec: 3, difficulty: 'hard' });
  os.rebuildFromLayout(second as never);
  const setup = os.raceSetup();
  assert.equal(setup.laps, os.raceTrack()!.laps);
  assert.equal(setup.bots, Math.min(RACE_DEFAULT_BOTS, os.raceTrack()!.grid.length - 1));
  assert.equal(setup.countdownSec, RACE_DEFAULT_COUNTDOWN_SEC);
  assert.equal(setup.difficulty, 'medium');
});

test('only the field is on the grid: one car per driver, and none left over', () => {
  // "Wenn das Rennen startet, sollten alle überflüssigen Autos verschwunden sein." A grid with
  // nine parked empty cars on it is not a starting grid, and once the field sets off they are
  // obstacles in the middle of the road that nobody is ever going to move.
  //
  // It was answered twice. First by REMOVING the spare cars when a race starts, which is what the
  // assertions below still check; then — reported as "Autos für Computer-Driver müssen vor dem
  // Start nicht angezeigt werden" — by never parking them in the first place: a car exists for a
  // person on the track, and a computer driver's is made when the race makes the driver.
  const { os } = seated(circuit);
  assert.equal(os.karts.size, 1, `one person on the track left ${os.karts.size} cars parked`);
  os.setRaceSetup({ bots: 2 });
  assert.equal(os.startRace(), true);
  assert.equal(os.karts.size, 3, `one human and two computer drivers left ${os.karts.size} cars out`);
  for (const kart of os.karts.values()) {
    assert.notEqual(kart.driverId, null, 'an empty car stayed on the grid');
  }

  // …and afterwards the track holds the people who are on it and nothing else: the computer
  // drivers go, and so do their cars.
  os.abandonRace();
  for (let i = 0; i < 5; i++) os.update(DT);
  assert.equal(os.raceInfo().phase, 'idle');
  assert.equal(os.karts.size, 1, `the track kept ${os.karts.size} cars for one person`);
  // Exactly one car per occupied slot, not two stacked on the one that was driven.
  for (const slot of os.raceTrack()!.grid) {
    const here = [...os.karts.values()].filter((k) => Math.hypot(k.x - slot.x, k.y - slot.y) < 16);
    assert.ok(here.length <= 1, 'a grid slot ended up with more than one car on it');
  }
});
