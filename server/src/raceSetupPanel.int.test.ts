/**
 * What a race is set to before it starts — and that the server, not the panel, decides.
 *
 * Four things used to be the map's alone: the lap count, a grid filled to the last slot with
 * computer drivers, a fixed countdown, and a difficulty you could only pass to `/race`. They are
 * settings now, which means they are values arriving from a client — so what is pinned here is
 * mostly the clamping (§ Security: the panel's own bounds are UX, `setRaceSetup` is the gate).
 *
 * TEST BOUNDARIES:
 *   @real-dependency: OfficeState over the committed raceway and hillroad -- Mock? NO. The bot
 *       count is bounded by the real grid and the lap setting is ignored on a real stage; both
 *       claims are about the maps.
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { before } from 'node:test';

import {
  RACE_COUNTDOWN_CHOICES,
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
let stage: OfficeLayout;

before(async () => {
  buildDynamicCatalog((await buildFurnitureCatalogAndSprites()) as never);
  const reg = loadTiledRegistry(ROOT);
  const read = (zone: string): OfficeLayout =>
    importTmjToLayout(JSON.parse(readFileSync(join(ROOT, 'assets', 'tiled', 'zones', `${zone}.tmj`), 'utf8')), reg, () => null)
      .layout;
  circuit = read('raceway');
  stage = read('hillroad');
});

const DT = 1 / RACE_TICK_HZ;

/** A zone with one person sitting in a kart — the state the panel is used from. */
function seated(layout: OfficeLayout): { os: OfficeState; driver: number } {
  const os = new OfficeState(layout as never);
  const kart = [...os.karts.values()][0];
  const driver = os.addPlayer('char_0', 'Setter', undefined, 'setter');
  const ch = os.characters.get(driver);
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
  // A full grid, which is what starting a race did before anybody could say otherwise: everybody
  // else's seat taken by a computer driver.
  assert.equal(setup.bots, track.grid.length - 1);
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

test('a stage ignores the lap setting, because it has no laps to run', () => {
  const { os } = seated(stage);
  assert.equal(os.raceTrack()?.sprint, true);
  os.setRaceSetup({ laps: 9 });
  assert.equal(os.startRace(), true);
  assert.equal(os.raceInfo().laps, 1, 'a stage was made to run nine of itself');
});

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
  os.rebuildFromLayout(stage as never);
  const setup = os.raceSetup();
  assert.equal(setup.laps, os.raceTrack()!.laps);
  assert.equal(setup.bots, os.raceTrack()!.grid.length - 1);
  assert.equal(setup.countdownSec, RACE_DEFAULT_COUNTDOWN_SEC);
  assert.equal(setup.difficulty, 'medium');
});
