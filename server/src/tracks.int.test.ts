/**
 * Every committed race track is drivable.
 *
 * Written over the DIRECTORY rather than over a list of names, so a third circuit is covered by
 * existing. That matters more than it sounds: a track can satisfy every unit test — gates in
 * order, a grid, a pit lane — and still be undrivable, because what makes a lap possible is the
 * relation between the corner radius the road allows and the one the handling needs, and nothing
 * about that shows up in geometry. So each one is actually driven.
 *
 * TEST BOUNDARIES:
 *   @real-dependency: the committed .tmj files, loadTiledRegistry, importTmjToLayout, OfficeState
 *       -- Mock? NO. The claim is "these maps work", and every layer of that sentence is one of
 *       these.
 */
import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test, { before } from 'node:test';

import { RACE_TICK_HZ } from '@pixel/shared/office/constants.js';
import { OfficeState } from '@pixel/shared/office/engine/officeState.js';
import { buildDynamicCatalog } from '@pixel/shared/office/layout/furnitureCatalog';
import { racerInput } from '@pixel/shared/office/race/racerDriver.js';
import { raceTrack } from '@pixel/shared/office/race/track.js';
import type { OfficeLayout } from '@pixel/shared/office/types';

import { buildFurnitureCatalogAndSprites } from './assets.js';
import { importTmjToLayout } from './tiled/mapBridge.js';
import { loadTiledRegistry } from './tiled/tiledRegistry.js';

const ROOT = join(import.meta.dirname, '..', '..');
const ZONES = join(ROOT, 'assets', 'tiled', 'zones');
const DT = 1 / RACE_TICK_HZ;

/** Every committed map that is a race track, by zone id. Scratch copies are skipped as always. */
const tracks = new Map<string, OfficeLayout>();

before(async () => {
  buildDynamicCatalog((await buildFurnitureCatalogAndSprites()) as never);
  const registry = loadTiledRegistry(ROOT);
  for (const file of readdirSync(ZONES).filter((f) => f.endsWith('.tmj') && !f.includes('-noimport'))) {
    const tmj = JSON.parse(readFileSync(join(ZONES, file), 'utf8'));
    const { layout } = importTmjToLayout(tmj, registry, () => null);
    if (raceTrack(layout)) tracks.set(file.replace(/\.tmj$/, ''), layout);
  }
});

test('there is more than one circuit', () => {
  // A racing game with one track is a demo of a racing game.
  assert.ok(tracks.size >= 2, `only ${tracks.size} track(s): ${[...tracks.keys()]}`);
});

test('every track is shaped like one', () => {
  for (const [id, layout] of tracks) {
    const track = raceTrack(layout);
    assert.ok(track, `${id} stopped being a track`);
    assert.ok(track.gates.length >= 3, `${id} has only ${track.gates.length} gates`);
    assert.ok(track.grid.length >= 2, `${id} has ${track.grid.length} grid slots`);
    assert.ok(track.laps >= 1, `${id} runs ${track.laps} laps`);
    // A gate is a LINE across the road, or a car drives past it without counting.
    for (const gate of track.gates) {
      assert.ok(gate.tiles.size >= 3, `${id} gate ${gate.index} is ${gate.tiles.size} tiles wide`);
    }
    // A STAGE ends at a line and a circuit does not: that is the whole difference between the two
    // shapes, and it is what `nextPoint` reads to stop sending a finisher back down the course.
    if (track.sprint) assert.ok(track.finish, `${id} is a sprint with no finish line`);
    else assert.equal(track.finish, null, `${id} is a circuit with a finish line`);
  }
});

test('a computer driver gets round every track, and the grid fits', () => {
  for (const [id, layout] of tracks) {
    const os = new OfficeState(layout as never);
    const track = os.raceTrack();
    assert.ok(track);
    assert.equal(os.karts.size, track.grid.length, `${id} did not fill its grid`);
    // Every car starts ON the road, or a race begins with the field in the scenery.
    const inner = os as unknown as { tileMap: number[][] };
    for (const kart of os.karts.values()) {
      const cell = inner.tileMap[Math.floor(kart.y / 16)]?.[Math.floor(kart.x / 16)];
      assert.ok(cell !== undefined && cell !== -1, `${id} has a grid slot off the road`);
    }

    // One driver, alone, at the pace of the quickest of the field.
    const kart = [...os.karts.values()][0];
    const driver = os.addPlayer('char_0', 'Tester', undefined, 'tester');
    const ch = os.characters.get(driver);
    assert.ok(ch);
    ch.x = kart.x;
    ch.y = kart.y;
    assert.equal(os.boardKart(driver), true, `${id}: could not board`);
    const world = {
      tileMap: (os as unknown as { tileMap: number[][] }).tileMap,
      blockedTiles: (os as unknown as { blockedTiles: Set<string> }).blockedTiles,
      walls: (os as unknown as { walls: unknown }).walls,
      track,
    };
    // "Got round" means a lap on a circuit and the far end on a stage — the same question asked
    // of two shapes. A stage is measured by the LAST GATE rather than by the line, because the
    // line only ends a RACE and this drive is practice: nothing here has started one.
    const laps = track.laps;
    const lastGate = track.gates.length - 1;
    const home = (): boolean => (track.sprint ? kart.gate === lastGate : kart.lap >= laps);
    let ticks = 0;
    const cap = Math.round(300 / DT);
    while (!home() && ticks < cap) {
      kart.input = racerInput(kart, world as never, { level: 0.8 });
      os.update(DT);
      ticks++;
    }
    assert.ok(
      home(),
      track.sprint
        ? `${id}: only reached gate ${kart.gate} of ${lastGate} in ${(ticks * DT).toFixed(0)} s`
        : `${id}: only reached lap ${kart.lap} of ${laps} in ${(ticks * DT).toFixed(0)} s`,
    );
    const seconds = ticks * DT;
    assert.ok(seconds > 5, `${id}: finished in ${seconds.toFixed(1)} s — the gates cannot be in order`);
  }
});
