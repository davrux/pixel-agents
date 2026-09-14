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
import type { OfficeLayout } from '@pixel/shared/office/types';

import { buildFurnitureCatalogAndSprites } from './assets.js';
import { importTmjToLayout } from './tiled/mapBridge.js';
import { loadTiledRegistry } from './tiled/tiledRegistry.js';

const ROOT = join(import.meta.dirname, '..', '..');
const TRACKS = ['raceway', 'speedway', 'hillroad'] as const;
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
}

/** One computer driver of a given skill, alone on a track, driven to the flag. */
function drive(zone: string, level: number): Run {
  const os = new OfficeState(layouts.get(zone) as never);
  const track = os.raceTrack();
  assert.ok(track, `${zone} is not a track`);
  const kart = [...os.karts.values()][0];
  // Alone: a full grid mixes traffic into a measurement about the racing line, which is the same
  // reason raceway.int.test.ts empties the grid for its own run.
  for (const other of [...os.karts.keys()]) if (other !== kart.id) os.karts.delete(other);
  const driver = os.addPlayer('char_0', 'Line', undefined, `line-${zone}-${level}`);
  const ch = os.characters.get(driver);
  assert.ok(ch);
  ch.x = kart.x;
  ch.y = kart.y;
  assert.equal(os.boardKart(driver), true, 'could not board the kart on the grid');
  assert.equal(os.startRace(), true, 'the race would not start');
  const inner = os as unknown as { tileMap: number[][]; blockedTiles: Set<string>; walls: unknown };
  const world = { tileMap: inner.tileMap, blockedTiles: inner.blockedTiles, walls: inner.walls, track } as never;
  let ticks = 0;
  let falls = 0;
  let sum = 0;
  let n = 0;
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
    last = kart.state;
    ticks++;
  }
  return { finished: kart.finished, seconds: ticks * DT, meanSpeed: sum / Math.max(1, n), falls };
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
