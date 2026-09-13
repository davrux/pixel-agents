/**
 * A race is an episode inside a track, not a mode of the zone.
 *
 * That distinction is the thing under test and it was asked for in those words: without a race
 * running you drive around as long as you like, and the lap limit only exists once somebody has
 * started one. So the two halves are checked separately — the state machine on its own (no world,
 * no karts, no map) and then the engine driving it over the real committed circuit.
 *
 * TEST BOUNDARIES:
 *   @real-dependency: the committed .tmj, importTmjToLayout, OfficeState -- Mock? NO. "A lap
 *       counts" is a claim about gates on a real map meeting a real state machine.
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { before } from 'node:test';

import {
  RACE_COUNTDOWN_MS,
  RACE_GRACE_MS,
  RACE_MAX_MS,
  RACE_RESULTS_MS,
  RACE_TICK_HZ,
} from '@pixel/shared/office/constants.js';
import { OfficeState } from '@pixel/shared/office/engine/officeState.js';
import { buildDynamicCatalog } from '@pixel/shared/office/layout/furnitureCatalog';
import {
  FINAL_LAP_AT,
  RACE_PHASES,
  completeLap,
  createRace,
  lights,
  markFinalLap,
  racing,
  standings,
  startRace,
  stopRace,
  takeNotices,
  tickRace,
} from '@pixel/shared/office/race/raceState.js';
import { goingBackwards, raceProgress, raceTrack } from '@pixel/shared/office/race/track.js';
import { ControllerKind, type OfficeLayout } from '@pixel/shared/office/types';

import { buildFurnitureCatalogAndSprites } from './assets.js';
import { importTmjToLayout } from './tiled/mapBridge.js';
import { loadTiledRegistry } from './tiled/tiledRegistry.js';

const ROOT = join(import.meta.dirname, '..', '..');
let layout: OfficeLayout;
let stageLayout: OfficeLayout;

before(async () => {
  buildDynamicCatalog((await buildFurnitureCatalogAndSprites()) as never);
  const registry = loadTiledRegistry(ROOT);
  const read = (zone: string): OfficeLayout =>
    importTmjToLayout(JSON.parse(readFileSync(join(ROOT, 'assets', 'tiled', 'zones', `${zone}.tmj`), 'utf8')), registry, () => null)
      .layout;
  layout = read('raceway');
  stageLayout = read('hillroad');
});

const world = (): OfficeState => new OfficeState(layout as never);
const stage = (): OfficeState => new OfficeState(stageLayout as never);
const DT = 1 / RACE_TICK_HZ;

// ── the machine, with no world at all ────────────────────────────────────────

test('the phase order on the wire is append-only', () => {
  // The index IS `RaceSync.phase`, so a reorder shows an older client a countdown when a race has
  // finished. Spelled out rather than asserted against itself, so an edit has to change this too.
  assert.deepEqual([...RACE_PHASES], ['idle', 'countdown', 'racing', 'done']);
});

test('lights count down and the last one is green', () => {
  const race = createRace();
  const track = raceTrack(layout);
  assert.ok(track);
  assert.equal(lights(race).lit, 0, 'lamps are lit with no race running');
  startRace(race, track, [{ kartId: 1, human: true }]);
  const seen: string[] = [];
  for (let t = 0; t < RACE_COUNTDOWN_MS; t += 100) {
    const l = lights(race);
    seen.push(`${l.lit}${l.go ? 'g' : ''}`);
    tickRace(race, 100);
  }
  // Three lamps, one per second, and then green — never backwards.
  assert.equal(seen[0], '1', `first frame showed ${seen[0]}`);
  assert.ok(seen.includes('2') && seen.includes('3'), `never reached three lamps: ${[...new Set(seen)]}`);
  assert.ok(seen.includes('3g'), 'the light never went green');
  const lit = seen.map((s) => Number(s[0]));
  for (let i = 1; i < lit.length; i++) assert.ok(lit[i] >= lit[i - 1], `lamps went out again at ${i}`);
});

test('a race refuses to start twice, or with nobody in it', () => {
  const race = createRace();
  const track = raceTrack(layout);
  assert.ok(track);
  assert.equal(startRace(race, track, []), false, 'started a race with no drivers');
  assert.equal(startRace(race, track, [{ kartId: 1, human: true }, { kartId: 2, human: true }]), true);
  assert.equal(startRace(race, track, [{ kartId: 3, human: true }]), false, 'started a second race on top of the first');
  assert.equal(race.entries.size, 2, 'the refused start changed the field');
});

test('laps are timed from the LIGHTS, and the best one is kept', () => {
  const race = createRace();
  const track = raceTrack(layout);
  assert.ok(track);
  startRace(race, track, [{ kartId: 1, human: true }]);
  // Whoever typed /race should not carry the countdown in their time.
  while (race.phase === 'countdown') tickRace(race, 100);
  assert.equal(race.phase, 'racing');
  assert.equal(race.timerMs, 0, 'the clock started before the lights went out');
  tickRace(race, 30_000);
  completeLap(race, 1, 1);
  assert.equal(race.entries.get(1)!.lastLapMs, 30_000);
  assert.equal(race.entries.get(1)!.bestLapMs, 30_000);
  tickRace(race, 25_000);
  completeLap(race, 1, 2);
  assert.equal(race.entries.get(1)!.lastLapMs, 25_000, 'the second lap was timed from the start');
  assert.equal(race.entries.get(1)!.bestLapMs, 25_000, 'a faster lap did not become the best');
  tickRace(race, 40_000);
  assert.equal(completeLap(race, 1, 3), true, 'the last lap did not finish the race');
  assert.equal(race.entries.get(1)!.bestLapMs, 25_000, 'a slower lap replaced the best');
  assert.equal(race.entries.get(1)!.place, 1);
  assert.equal(race.entries.get(1)!.finishedMs, 95_000);
});

test('places are handed out in finishing order, and the rest are sorted live', () => {
  const race = createRace();
  const track = raceTrack(layout);
  assert.ok(track);
  startRace(race, track, [{ kartId: 1, human: true }, { kartId: 2, human: true }, { kartId: 3, human: true }]);
  while (race.phase === 'countdown') tickRace(race, 100);
  tickRace(race, 10_000);
  completeLap(race, 2, 3); // kart 2 wins
  assert.equal(race.entries.get(2)!.place, 1);
  // The others are ordered by how far round they are, behind whoever has finished.
  standings(race, (id) => (id === 3 ? 5.5 : 2.1));
  assert.equal(race.entries.get(3)!.place, 2);
  assert.equal(race.entries.get(1)!.place, 3);
  // And a finisher keeps the place it earned rather than being re-sorted by where it coasted to.
  standings(race, (id) => (id === 2 ? 0 : 9));
  assert.equal(race.entries.get(2)!.place, 1, 'a finisher lost its place to a live sort');
});

test('a race ends when everyone is home, and again when the clock runs out', () => {
  const track = raceTrack(layout);
  assert.ok(track);
  const home = createRace();
  startRace(home, track, [{ kartId: 1, human: true }]);
  while (home.phase === 'countdown') tickRace(home, 100);
  completeLap(home, 1, home.laps);
  assert.equal(tickRace(home, 16).ended, true, 'the last finisher did not end the race');
  assert.equal(home.phase, 'done');
  // The results stay up, and then the track is free again — not stuck on the board.
  tickRace(home, RACE_RESULTS_MS + 1);
  assert.equal(home.phase, 'idle');
  assert.equal(home.entries.size, 0, 'the field outlived the race');

  // One driver who parks in the pit must not hold the zone forever.
  const stalled = createRace();
  startRace(stalled, track, [{ kartId: 1, human: true }, { kartId: 2, human: true }]);
  while (stalled.phase === 'countdown') tickRace(stalled, 100);
  tickRace(stalled, RACE_MAX_MS);
  assert.equal(stalled.phase, 'done', 'a race nobody finished never ended');
});

// ── the engine, over the real circuit ────────────────────────────────────────

test('with no race running a kart laps for ever and finishes nothing', () => {
  const os = world();
  const kart = [...os.karts.values()][0];
  const driver = os.addPlayer('char_0', 'Cruiser', undefined, 'cruiser');
  const ch = os.characters.get(driver);
  assert.ok(ch);
  ch.x = kart.x;
  ch.y = kart.y;
  assert.equal(os.boardKart(driver), true);
  assert.equal(os.raceInfo().phase, 'idle');

  const track = os.raceTrack();
  assert.ok(track);
  // Carried from gate to gate rather than driven: what is under test is what a LAP means with no
  // race running, and a driving autopilot would only add its own ability to the assertion.
  for (let lap = 0; lap < 5; lap++) {
    for (const gate of track.gates) {
      kart.x = gate.x;
      kart.y = gate.y;
      kart.vx = 0;
      kart.vy = 0;
      kart.input = { throttle: 0, steer: 0 };
      os.update(DT);
    }
  }
  // It has been round more times than the race would allow, and none of that ended anything.
  // Four, not five: the kart starts ON gate 0, and the next gate it is looking for is 1 — so the
  // first crossing of the line is the one that opens the lap rather than closing one.
  assert.equal(kart.lap, 4, `five circuits gave ${kart.lap} laps`);
  assert.ok(kart.lap > track.laps, `the lap limit still bit at lap ${kart.lap}`);
  assert.equal(kart.finished, false, 'a kart finished a race nobody started');
  assert.equal(os.raceInfo().phase, 'idle');
  assert.equal(racing(os.raceInfo(), kart.id), false);
});

test('starting a race gathers every driven kart onto the grid and holds it there', () => {
  const os = world();
  const track = os.raceTrack();
  assert.ok(track);
  const karts = [...os.karts.values()];
  const ids: number[] = [];
  for (let i = 0; i < 3; i++) {
    const driver = os.addPlayer('char_0', `Racer${i}`, undefined, `racer${i}`);
    const ch = os.characters.get(driver)!;
    ch.x = karts[i].x;
    ch.y = karts[i].y;
    assert.equal(os.boardKart(driver), true);
    ids.push(driver);
  }
  // One kart is driven away from the grid first: starting a race must gather it back.
  karts[0].x = track.gates[2].x;
  karts[0].y = track.gates[2].y;
  karts[0].lap = 7;

  assert.equal(os.startRace(), true);
  assert.equal(os.raceInfo().phase, 'countdown');
  // Three humans, and the rest of the grid filled with computer drivers — a race with nobody in
  // it is not a race.
  assert.equal(os.raceInfo().entries.size, track.grid.length, 'the grid was not filled out');
  for (const kart of karts.slice(0, 3)) {
    assert.equal(kart.lap, 0, 'a kart brought its old lap count into the race');
    assert.ok(
      track.grid.some((slot) => Math.hypot(slot.x - kart.x, slot.y - kart.y) < 1),
      'a kart was not gathered onto the grid',
    );
  }
  // Held: the throttle is not connected until the lights go out.
  for (const kart of karts.slice(0, 3)) kart.input = { throttle: 1, steer: 0 };
  const before = { x: karts[0].x, y: karts[0].y };
  for (let i = 0; i < Math.round((RACE_COUNTDOWN_MS / 1000 - 0.2) / DT); i++) os.update(DT);
  assert.equal(os.raceInfo().phase, 'countdown', 'the countdown ended early');
  assert.equal(karts[0].x, before.x, 'a kart moved before the lights');
  assert.equal(karts[0].y, before.y, 'a kart moved before the lights');
  // …and released the moment they do.
  for (let i = 0; i < Math.round(0.6 / DT); i++) os.update(DT);
  assert.equal(os.raceInfo().phase, 'racing');
  assert.ok(Math.hypot(karts[0].x - before.x, karts[0].y - before.y) > 4, 'the lights went out and nobody moved');
});

test('calling a race off hands the track straight back', () => {
  const os = world();
  const kart = [...os.karts.values()][0];
  const driver = os.addPlayer('char_0', 'Quitter', undefined, 'quitter');
  const ch = os.characters.get(driver)!;
  ch.x = kart.x;
  ch.y = kart.y;
  os.boardKart(driver);
  assert.equal(os.startRace(), true);
  kart.finished = true;
  os.abandonRace();
  assert.equal(os.raceInfo().phase, 'idle');
  assert.equal(kart.finished, false, 'an abandoned race left a kart marked as finished');
  // And another can start at once — the refusal is about a RUNNING race, not a cooldown.
  assert.equal(os.startRace(), true);
});

test('a race is refused where there is no track', () => {
  const plain = new OfficeState({ ...layout, tileActions: [] } as never);
  assert.equal(plain.raceTrack(), null);
  assert.equal(plain.startRace(), false);
  assert.equal(plain.raceInfo().phase, 'idle');
});

test('replacing the map ends a race that was running on the old one', () => {
  const os = world();
  const kart = [...os.karts.values()][0];
  const driver = os.addPlayer('char_0', 'Pusher', undefined, 'pusher');
  const ch = os.characters.get(driver)!;
  ch.x = kart.x;
  ch.y = kart.y;
  os.boardKart(driver);
  assert.equal(os.startRace(), true);
  // A push replaces the track under the field, and its gates are not the ones they were racing
  // through. Ending it is the only honest answer.
  os.rebuildFromLayout({ ...layout } as never);
  assert.equal(os.raceInfo().phase, 'idle');
  assert.equal(os.raceInfo().entries.size, 0);
});

test('stopRace is safe from any phase', () => {
  const race = createRace();
  stopRace(race);
  assert.equal(race.phase, 'idle');
  const track = raceTrack(layout);
  assert.ok(track);
  startRace(race, track, [{ kartId: 1, human: true }]);
  stopRace(race);
  assert.equal(race.phase, 'idle');
  assert.equal(race.finished, 0);
});

test('the grid is filled with computer drivers, and they leave with the race', () => {
  const os = world();
  const track = os.raceTrack();
  assert.ok(track);
  const kart = [...os.karts.values()][0];
  const driver = os.addPlayer('char_0', 'Human', undefined, 'human');
  const ch = os.characters.get(driver)!;
  ch.x = kart.x;
  ch.y = kart.y;
  assert.equal(os.boardKart(driver), true);
  const before = os.characters.size;

  assert.equal(os.startRace(), true);
  const field = [...os.karts.values()].filter((k) => k.driverId !== null);
  assert.equal(field.length, track.grid.length, 'the grid is not full');
  assert.equal(os.characters.size, before + track.grid.length - 1, 'the opponents were not spawned');
  for (const k of field) {
    const who = os.characters.get(k.driverId!)!;
    assert.ok(who, 'a kart has a driver that does not exist');
    if (k.driverId === driver) continue;
    assert.equal(who.controller, ControllerKind.RACER, 'an opponent is not driven by a racer');
    assert.ok((who.racerSkill ?? 0) > 0, 'an opponent has no skill at all');
  }
  // Skills differ, or the grid is a train rather than a field.
  const skills = new Set(field.map((k) => os.characters.get(k.driverId!)!.racerSkill).filter((v) => v !== undefined));
  assert.ok(skills.size > 1, 'every opponent is exactly as quick as the others');

  os.abandonRace();
  assert.equal(os.characters.size, before, 'the opponents outlived the race');
  assert.equal(
    [...os.karts.values()].filter((k) => k.driverId !== null).length,
    1,
    'an abandoned race left computer drivers in their karts',
  );
});

test('a computer driver gets round the circuit on its own', () => {
  // The autopilot the track's test drives is the racer's brain now, so this is the claim that
  // matters: an opponent is somebody to race, not a kart that parks in the first corner.
  const os = world();
  const track = os.raceTrack();
  assert.ok(track);
  const kart = [...os.karts.values()][0];
  const driver = os.addPlayer('char_0', 'Human', undefined, 'human');
  const ch = os.characters.get(driver)!;
  ch.x = kart.x;
  ch.y = kart.y;
  os.boardKart(driver);
  assert.equal(os.startRace(), true);

  // The human sits still; everybody else drives themselves.
  const bots = [...os.karts.values()].filter((k) => k.driverId !== null && k.driverId !== driver);
  assert.ok(bots.length >= 4, `only ${bots.length} opponents`);
  // Read while the race is still ON: once it is over the board goes up and then the entries are
  // cleared, and a test that reads afterwards is reading an empty race.
  const places: number[] = [];
  let home: typeof bots = [];
  while (os.raceInfo().phase === 'countdown') os.update(DT); // the lights first
  for (let i = 0; i < Math.round(200 / DT); i++) {
    kart.input = { throttle: 0, steer: 0 };
    os.update(DT);
    if (os.raceInfo().phase !== 'racing' || bots.every((b) => b.finished)) {
      home = bots.filter((b) => b.finished);
      for (const b of home) places.push(os.raceInfo().entries.get(b.id)?.place ?? 0);
      break;
    }
  }
  assert.ok(home.length >= Math.ceil(bots.length / 2), `only ${home.length} of ${bots.length} opponents finished`);
  // …and the places they earned are a ranking, not all the same number.
  assert.equal(new Set(places).size, places.length, `two opponents share a place: ${places}`);
  assert.ok(Math.min(...places) === 1, 'nobody came first');
});

test('a driver who leaves mid-race retires, so the race can still end', () => {
  // Measured after a client disconnected during a race: the field circulated until the six-minute
  // timeout, because `tickRace` waits for everyone to be home and a kart nobody is in never
  // crosses a line. The computer drivers stayed on track for all of it — which is how a "ghost"
  // is reported.
  const os = world();
  const kart = [...os.karts.values()][0];
  const driver = os.addPlayer('char_0', 'Leaver', undefined, 'leaver');
  const ch = os.characters.get(driver)!;
  ch.x = kart.x;
  ch.y = kart.y;
  os.boardKart(driver);
  assert.equal(os.startRace(), true);
  const field = os.raceInfo().entries.size;
  assert.ok(field > 1);

  while (os.raceInfo().phase === 'countdown') os.update(DT);
  os.removePlayer(driver);
  os.update(DT);
  assert.equal(os.raceInfo().entries.has(kart.id), false, 'the empty kart is still in the race');
  assert.equal(os.raceInfo().entries.size, field - 1);
  assert.equal(kart.driverId, null, 'the kart was not handed back');

  // And the race finishes on the opponents alone, in well under the timeout.
  let ticks = 0;
  const cap = Math.round(180 / DT);
  while (os.raceInfo().phase === 'racing' && ticks < cap) {
    os.update(DT);
    ticks++;
  }
  assert.ok(ticks < cap, 'the race never ended after its only human left');
  // …and then the track is empty again rather than full of parked opponents.
  while (os.raceInfo().phase !== 'idle') os.update(DT);
  assert.equal(
    [...os.characters.values()].filter((c) => c.controller === ControllerKind.RACER).length,
    0,
    'the computer drivers outlived the race',
  );
});

test('the flag comes out for the LEADER, and stays out', () => {
  const race = createRace();
  const track = raceTrack(layout);
  assert.ok(track);
  startRace(race, track, [{ kartId: 1, human: true }]);
  while (race.phase === 'countdown') tickRace(race, 100);
  // Not on the first lap, however far round it anybody is.
  markFinalLap(race, 0, 0.99);
  assert.equal(race.finalLap, false, 'the flag came out on lap one of three');
  // Not at the start of the last lap either — it is a moment, not a phase.
  markFinalLap(race, race.laps - 1, 0.2);
  assert.equal(race.finalLap, false);
  markFinalLap(race, race.laps - 1, FINAL_LAP_AT);
  assert.equal(race.finalLap, true, 'the flag never came out');
  assert.ok(takeNotices(race).some((n) => n.kind === 'finalLap'), 'the flag was not announced');
  // Latched: a leader shoved backwards must not put it away again, or the banner blinks.
  markFinalLap(race, 0, 0);
  assert.equal(race.finalLap, true, 'the flag went away again');
});

test('on a stage the flag waits for the line, not for the start', () => {
  // A one-lap CIRCUIT flies the flag from the green, because the only lap is the final one. A
  // stage is one "lap" of the gate ring and means the opposite — measured live before this
  // existed, the chequered banner was up sixteen seconds into a fifty-second run, and it said
  // FINAL LAP on a road that does not loop.
  const race = createRace();
  const track = raceTrack(stageLayout);
  assert.ok(track);
  assert.equal(track.sprint, true);
  startRace(race, track, [{ kartId: 1, human: true }]);
  while (race.phase === 'countdown') tickRace(race, 100);
  assert.equal(race.laps, 1, 'a stage is one run');
  markFinalLap(race, 0, 0.2);
  assert.equal(race.finalLap, false, 'the flag came out a fifth of the way down the stage');
  markFinalLap(race, 0, FINAL_LAP_AT);
  assert.equal(race.finalLap, true, 'the flag never came out on the stage');

  // …and the one-lap circuit keeps its old answer, which is the case this exception is carved out
  // of rather than replacing.
  const oneLap = createRace();
  const circuit = raceTrack({ ...layout, laps: 1 } as never);
  assert.ok(circuit);
  assert.equal(circuit.sprint, false);
  startRace(oneLap, circuit, [{ kartId: 1, human: true }]);
  while (oneLap.phase === 'countdown') tickRace(oneLap, 100);
  markFinalLap(oneLap, 0, 0);
  assert.equal(oneLap.finalLap, true, 'a one-lap circuit stopped flying the flag from the green');
});

test('a record is measured against what STOOD, and announced once', () => {
  const race = createRace();
  const track = raceTrack(layout);
  assert.ok(track);
  startRace(race, track, [{ kartId: 1, human: true }], { lapMs: 30_000, raceMs: 100_000 });
  while (race.phase === 'countdown') tickRace(race, 100);
  tickRace(race, 31_000);
  completeLap(race, 1, 1); // slower than the record
  assert.equal(takeNotices(race).filter((n) => n.kind === 'lapRecord').length, 0, 'a slow lap set a record');
  tickRace(race, 25_000);
  completeLap(race, 1, 2); // faster
  assert.equal(takeNotices(race).filter((n) => n.kind === 'lapRecord').length, 1, 'a fast lap set no record');
  tickRace(race, 26_000);
  completeLap(race, 1, 3); // slower than the one just set — no second announcement
  const last = takeNotices(race);
  assert.equal(last.filter((n) => n.kind === 'lapRecord').length, 0, 'a slower lap announced a record');
  assert.ok(last.some((n) => n.kind === 'won'), 'the winner was not announced');
  assert.ok(last.some((n) => n.kind === 'raceRecord'), 'a race under the record set none');
});

test('the race ends when the PEOPLE are home, not the last computer driver', () => {
  const race = createRace();
  const track = raceTrack(layout);
  assert.ok(track);
  startRace(race, track, [
    { kartId: 1, human: true },
    { kartId: 2, human: false },
    { kartId: 3, human: false },
  ]);
  while (race.phase === 'countdown') tickRace(race, 100);
  tickRace(race, 60_000);
  completeLap(race, 1, race.laps);
  assert.equal(tickRace(race, 16).ended, true, 'the only person finished and the race ran on');
  assert.equal(race.phase, 'done');

  // With nobody human in it every entry has to be home, or it would end the instant it started.
  const demo = createRace();
  startRace(demo, track, [{ kartId: 9, human: false }]);
  while (demo.phase === 'countdown') tickRace(demo, 100);
  assert.equal(tickRace(demo, 16).ended, false, 'a grid of computer drivers ended at once');
  completeLap(demo, 9, demo.laps);
  assert.equal(tickRace(demo, 16).ended, true);
});

test('driving backwards is warned about, and being shoved round is not', () => {
  const track = raceTrack(layout);
  assert.ok(track);
  const gate = track.gates[0];
  const next = track.gates[1];
  const toNext = Math.atan2(next.y - gate.y, next.x - gate.x);
  const fast = 150;
  // Straight at the next gate: fine.
  assert.equal(
    goingBackwards(track, 0, gate.x, gate.y, Math.cos(toNext) * fast, Math.sin(toNext) * fast),
    false,
    'driving towards the next gate counted as the wrong way',
  );
  // Straight away from it: the wrong way.
  assert.equal(
    goingBackwards(track, 0, gate.x, gate.y, -Math.cos(toNext) * fast, -Math.sin(toNext) * fast),
    true,
    'driving away from the next gate was not the wrong way',
  );
  // A track BENDS, so "not straight at it" must not be enough.
  const across = toNext + Math.PI / 2;
  assert.equal(
    goingBackwards(track, 0, gate.x, gate.y, Math.cos(across) * fast, Math.sin(across) * fast),
    false,
    'a corner counted as the wrong way',
  );
  // Barely moving: the question is meaningless and is not asked, or a nudged car flaps the warning.
  assert.equal(goingBackwards(track, 0, gate.x, gate.y, -Math.cos(toNext) * 8, -Math.sin(toNext) * 8), false);
});

test('a running order is by progress, and progress is monotone within a leg', () => {
  const track = raceTrack(layout);
  assert.ok(track);
  // Sitting ON the gate you just passed is the least progress of that leg; nearing the next is
  // the most; and neither can escape the leg it belongs to.
  const at0 = raceProgress(track, 0, 0, track.gates[0].x, track.gates[0].y);
  const near1 = raceProgress(track, 0, 0, track.gates[1].x, track.gates[1].y);
  assert.ok(near1 > at0, 'closing on the next gate did not count as progress');
  assert.ok(near1 <= at0 + 1.0001, `one leg is worth more than one gate: ${near1 - at0}`);
  // Miles off the track, past the gate: still inside the leg, never behind where it started.
  const wild = raceProgress(track, 0, 0, track.gates[1].x + 2000, track.gates[1].y + 2000);
  assert.ok(wild >= at0 && wild <= at0 + 1.0001, `progress escaped its leg: ${wild}`);
  // A later lap always outranks an earlier one.
  assert.ok(raceProgress(track, 1, 0, track.gates[0].x, track.gates[0].y) > near1);
});

test('the winner starts a clock: nobody waits for a driver who has given up', () => {
  const race = createRace();
  const track = raceTrack(layout);
  assert.ok(track);
  startRace(race, track, [
    { kartId: 1, human: true },
    { kartId: 2, human: true },
  ]);
  while (race.phase === 'countdown') tickRace(race, 100);
  tickRace(race, 60_000);
  completeLap(race, 1, race.laps); // kart 1 wins; kart 2 is in the pit and not coming
  assert.equal(race.phase, 'racing', 'the race ended while somebody was still out there');
  tickRace(race, RACE_GRACE_MS - 1000);
  assert.equal(race.phase, 'racing', 'the grace period was not honoured');
  tickRace(race, 2000);
  assert.equal(race.phase, 'done', 'the race ran on past the grace period');
  // The one who never finished has no TIME — a result board says "still out there" rather than
  // inventing one. (Its running place comes from `standings`, which the engine calls; this test
  // drives the machine directly and never does.)
  assert.equal(race.entries.get(2)!.finishedMs, null);
  assert.equal(race.entries.get(1)!.place, 1);
});

// ── a stage, where the line is the only way home ─────────────────────────────

/**
 * The centre of one TILE the gate covers — not the gate's own centre.
 *
 * A gate's `x`/`y` is the average of its tiles, and on a stage a gate crosses the road at an angle,
 * so that average can land on a tile the gate does not occupy. Carrying a kart there passes
 * nothing, which reads in a failure as "the gates were not walked in order".
 */
function onGate(gate: { tiles: ReadonlySet<string> }): { x: number; y: number } {
  const [col, row] = [...gate.tiles][0].split(',').map(Number);
  return { x: col * 16 + 8, y: row * 16 + 8 };
}

/** Put the kart on a point and let one tick see it there. Carried rather than driven: what is
 *  under test is what the ENGINE counts, and an autopilot would add its own ability to that. */
function carryTo(os: OfficeState, kart: { x: number; y: number; vx: number; vy: number; input: unknown }, p: { x: number; y: number }): void {
  kart.x = p.x;
  kart.y = p.y;
  kart.vx = 0;
  kart.vy = 0;
  kart.input = { throttle: 0, steer: 0 };
  os.update(1 / RACE_TICK_HZ);
}

test('a stage is won at the line, and only after every gate', () => {
  const os = stage();
  const track = os.raceTrack();
  assert.ok(track);
  assert.equal(track.sprint, true, 'hillroad stopped being a stage');
  assert.ok(track.finish);
  const kart = [...os.karts.values()][0];
  const driver = os.addPlayer('char_0', 'Rally', undefined, 'rally');
  const ch = os.characters.get(driver);
  assert.ok(ch);
  ch.x = kart.x;
  ch.y = kart.y;
  assert.equal(os.boardKart(driver), true);
  assert.equal(os.startRace(), true);
  while (os.raceInfo().phase === 'countdown') os.update(1 / RACE_TICK_HZ);

  // Straight across the landscape to the line, passing nothing. This is the whole reason the gate
  // check exists: the finish used to be judged from the TILE alone, so a stage was won by ignoring
  // the course — which no circuit could ever allow, because a lap is guarded by the gate ring.
  carryTo(os, kart, track.finish);
  assert.equal(kart.finished, false, 'a stage was won by driving straight to the line');
  assert.equal(os.raceInfo().finished, 0);

  // Now the course, gate by gate, and then the line.
  for (const gate of track.gates) carryTo(os, kart, onGate(gate));
  assert.equal(kart.gate, track.gates.length - 1, 'the gates were not walked in order');
  assert.equal(kart.finished, false, 'the last gate ended the race by itself');
  carryTo(os, kart, track.finish);
  assert.equal(kart.finished, true, 'crossing the line after every gate did not finish the stage');
  assert.equal(os.raceInfo().finished, 1);
});

test('crossing the start line again never finishes a stage', () => {
  const os = stage();
  const track = os.raceTrack();
  assert.ok(track);
  const kart = [...os.karts.values()][0];
  const driver = os.addPlayer('char_0', 'Wanderer', undefined, 'wanderer');
  const ch = os.characters.get(driver);
  assert.ok(ch);
  ch.x = kart.x;
  ch.y = kart.y;
  assert.equal(os.boardKart(driver), true);
  assert.equal(os.startRace(), true);
  while (os.raceInfo().phase === 'countdown') os.update(1 / RACE_TICK_HZ);

  // Round the gates and back over gate 0 — which is what the wrapping gate ring used to send
  // finishers off to do. `race.laps` is 1 on a stage, so the LAP path scored that as the last lap
  // and classified them as home sixty tiles from the line.
  for (const gate of track.gates) carryTo(os, kart, onGate(gate));
  carryTo(os, kart, onGate(track.gates[0]));
  assert.equal(kart.lap, 1, 'the lap counter stopped counting — the carry did not cross the line');
  assert.equal(kart.finished, false, 'a stage was finished by recrossing the START line');
  assert.equal(os.raceInfo().finished, 0);
});
