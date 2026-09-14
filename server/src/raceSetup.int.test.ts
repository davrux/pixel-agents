/**
 * How a track says what it is: which way it goes, and whether it is laps at all.
 *
 * Both were implicit and neither should be. The direction of a lap lived in the NUMBERING of the
 * gates — gate 0 to gate 1 — which is invisible to whoever is placing them in Tiled and impossible
 * to check by looking at the map; and "a race" meant "three times round", which is one shape out of
 * several. A beacon states the first, and a finish line gives the second.
 *
 * TEST BOUNDARIES:
 *   @real-dependency: raceTrack over hand-built layouts -- Mock? NO. It IS the thing under test,
 *       and the layouts are small enough to write out.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';

import { nextGate, nextPoint, raceTrack } from '@pixel/shared/office/race/track.js';
import type { Action, OfficeLayout } from '@pixel/shared/office/types';

const COLS = 20;
const ROWS = 20;

/** A layout with the given actions, and ground everywhere so nothing else gets in the way. */
function layoutWith(actions: Array<{ col: number; row: number; action: Action }>, laps = 3): OfficeLayout {
  const tileActions: Array<Action | null> = new Array(COLS * ROWS).fill(null);
  for (const a of actions) tileActions[a.row * COLS + a.col] = a.action;
  return {
    version: 3,
    cols: COLS,
    rows: ROWS,
    // 0 is a ground cell (VOID is -1): what makes a cell drivable is that ground is there, and
    // the tile id only says which picture.
    tiles: new Array(COLS * ROWS).fill(0),
    furniture: [],
    tileActions,
    laps,
  } as unknown as OfficeLayout;
}

/** Four gates round a square, plus one grid slot. `dir` goes on the slot when given. */
function ring(dir?: number): Array<{ col: number; row: number; action: Action }> {
  return [
    { col: 10, row: 16, action: { kind: 'raceGate', gate: 0 } },
    { col: 16, row: 10, action: { kind: 'raceGate', gate: 1 } },
    { col: 10, row: 3, action: { kind: 'raceGate', gate: 2 } },
    { col: 3, row: 10, action: { kind: 'raceGate', gate: 3 } },
    { col: 8, row: 16, action: { kind: 'raceStart', slot: 0, dir: dir ?? -1 } },
  ];
}

const deg = (rad: number): number => Math.round((rad * 180) / Math.PI) % 360;

test('with no beacon, the gates say which way it goes', () => {
  // Every map drawn before beacons existed means this by saying nothing.
  const track = raceTrack(layoutWith(ring()));
  assert.ok(track);
  // Gate 0 is at the bottom, gate 1 to its upper right — so the lap sets off that way.
  const expected = Math.round((Math.atan2(10 - 16, 16 - 10) * 180) / Math.PI);
  assert.equal(deg(track.startHeading), ((expected % 360) + 360) % 360);
});

test('a beacon overrides it, and north is a perfectly good direction', () => {
  // The question this answers, asked in as many words: "könnte ja auch sein, dass die Rennstrecke
  // Richtung Norden startet".
  for (const [degrees, name] of [
    [0, 'east'],
    [90, 'south'],
    [180, 'west'],
    [270, 'north'],
  ] as const) {
    const track = raceTrack(layoutWith(ring(degrees)));
    assert.ok(track, `${name} did not build`);
    assert.equal(deg(track.startHeading), degrees, `a beacon pointing ${name} was ignored`);
  }
});

test('a beacon is honoured even when it disagrees with the gates', () => {
  // Deliberately: the beacon is the statement, the gate order is the fallback. A map that says
  // one thing and means another is a map to fix, not a rule to average.
  const track = raceTrack(layoutWith(ring(270)));
  assert.ok(track);
  assert.equal(deg(track.startHeading), 270);
});

test('a finish line makes it a sprint, and its absence makes it laps', () => {
  const circuit = raceTrack(layoutWith(ring(0)));
  assert.ok(circuit);
  assert.equal(circuit.sprint, false);
  assert.equal(circuit.laps, 3);

  const sprint = raceTrack(layoutWith([...ring(0), { col: 12, row: 3, action: { kind: 'raceFinish' } }]));
  assert.ok(sprint);
  assert.equal(sprint.sprint, true, 'a finish line did not make it point-to-point');
  // The lap count is still read — a sprint simply does not use it, and dropping it here would
  // lose it for a map that later removes its finish line.
  assert.equal(sprint.laps, 3);
});

test('a map with one gate is not a track, beacon or no beacon', () => {
  // The rule that keeps every other zone out of the racing code: two gates and a grid slot, or it
  // is a room with some markers in it.
  const one = raceTrack(
    layoutWith([
      { col: 10, row: 16, action: { kind: 'raceGate', gate: 0 } },
      { col: 8, row: 16, action: { kind: 'raceStart', slot: 0, dir: 0 } },
    ]),
  );
  assert.equal(one, null);
});

test('a stage aims at its LINE after the last gate, not back at the first', () => {
  // The gates are a ring and `nextGate` wraps — which is exactly right for a lap and exactly wrong
  // for the last gate of a point-to-point. Measured before this existed: three finishers turned
  // round at the far end and drove the whole stage back into the cars still racing, and one of
  // them crossed gate 0 on the way, which the lap path then scored as finishing the race.
  const track = raceTrack(
    layoutWith([...ring(0), { col: 4, row: 10, action: { kind: 'raceFinish' } }]),
  );
  assert.ok(track);
  assert.ok(track.sprint);
  assert.ok(track.finish, 'a sprint with no finish point');
  const last = track.gates.length - 1;
  assert.deepEqual(nextPoint(track, last), track.finish, 'the final leg does not aim at the line');
  // Every other leg is unchanged, and a circuit is unchanged everywhere — the wrap is still what
  // a lap is made of.
  for (let g = 0; g < last; g++) {
    assert.deepEqual(nextPoint(track, g), nextGate(track, g), `leg ${g} stopped following the gates`);
  }
  const circuit = raceTrack(layoutWith(ring(0)));
  assert.ok(circuit);
  assert.equal(circuit.finish, null, 'a circuit invented a finish point');
  for (let g = 0; g < circuit.gates.length; g++) {
    assert.deepEqual(nextPoint(circuit, g), nextGate(circuit, g), 'a circuit stopped wrapping');
  }
});
