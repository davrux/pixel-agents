/**
 * A kart drives, slides, falls, laps and shoves — the whole movement model, headless.
 *
 * This is the file the racing feature stands or falls on, and it exists before any art or any
 * client code for exactly that reason: if the model is wrong, pretty karts are wasted work. What
 * it pins is the six claims the model makes, each of which is a way a racer goes wrong:
 *
 *  1. **A kart goes where it points and tops out.** Thrust along the heading, drag against it.
 *  2. **A wall is slid along, not stopped at.** The blocked AXIS is lost and the other survives,
 *     which is the difference between a racer and a maze.
 *  3. **Leaving the ground is allowed and punished.** Everywhere else in this engine `canStep`
 *     refuses to leave the ground; a kart must be able to, because driving off a bridge is the
 *     point. It falls, waits, and comes back at the last gate FACING THE NEXT — which is what
 *     makes respawning need no extra authoring.
 *  4. **Only the next gate counts.** Cutting the infield and driving backwards earn nothing, and
 *     the finish line only scores when the whole ring has been walked.
 *  5. **A bump is a trade with a direction.** The shove lands on the velocity VECTOR, so a kart
 *     hit from the side leaves the road — the feature this is all for. A scalar speed along the
 *     heading cannot express that, which is why the model carries a vector.
 *  6. **It is deterministic.** Same inputs, same world, same numbers — the engine's whole
 *     contract (invariant 3) and the thing that lets this test exist at all.
 *
 * TEST BOUNDARIES:
 *   @real-dependency: the real tile map, real wall edges, the real track reader -- Mock? NO. Every
 *       claim here is about what geometry does to a body; a stub would test my belief about the
 *       geometry. The track is hand-built rather than loaded from a .tmj because a ring road with
 *       four gates is the smallest thing that can express a lap, and no such map exists yet.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';

import { KART_FALL_SEC, KART_MAX_SPEED_PX_PER_SEC } from '@pixel/shared/office/constants.js';
import { bumpKarts, createKart, facingFromHeading, updateKart, type Kart, type KartWorld } from '@pixel/shared/office/race/kart.js';
import { gateAt, headingFrom, raceProgress, raceTrack, type RaceTrack, wrapAngle } from '@pixel/shared/office/race/track.js';
import { TILE_SIZE, TileType, type Action, type OfficeLayout } from '@pixel/shared/office/types';

const COLS = 24;
const ROWS = 16;

/**
 * A ring road with four gates, anticlockwise: bottom straight (the finish), right, top, left.
 *
 * Two kinds of edge, deliberately, because they are two different rules and the first version of
 * this fixture had only one — it surrounded the road with VOID and then every test that meant to
 * scrape a wall fell off the world instead:
 *
 *  - **The INFIELD is VOID.** Only ground makes a cell drivable, so a pit needs no new concept —
 *    which is also what makes a bridge over one free.
 *  - **The OUTER boundary is BLOCKED** (a barrier, as a real track has). A blocked tile stops a
 *    kart; open air drops it.
 */
function ovalLayout(): OfficeLayout {
  const tiles = new Array(COLS * ROWS).fill(TileType.VOID);
  const onRing = (col: number, row: number): boolean => {
    const inOuter = col >= 2 && col <= 21 && row >= 2 && row <= 13;
    const inInfield = col >= 5 && col <= 18 && row >= 5 && row <= 10;
    return inOuter && !inInfield;
  };
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) if (onRing(col, row)) tiles[row * COLS + col] = 1;
  }
  const tileActions: Array<Action | null> = new Array(COLS * ROWS).fill(null);
  const gate = (col: number, row: number, index: number): void => {
    tileActions[row * COLS + col] = { kind: 'raceGate', gate: index };
  };
  for (let row = 11; row <= 13; row++) gate(12, row, 0); // finish, across the bottom straight
  for (let col = 19; col <= 21; col++) gate(col, 8, 1); // right
  for (let row = 2; row <= 4; row++) gate(12, row, 2); // top
  for (let col = 2; col <= 4; col++) gate(col, 8, 3); // left
  tileActions[12 * COLS + 10] = { kind: 'raceStart', slot: 0 };
  tileActions[12 * COLS + 9] = { kind: 'raceStart', slot: 1 };
  return { version: 3, cols: COLS, rows: ROWS, tiles, tileActions, laps: 2 } as unknown as OfficeLayout;
}

function world(): { world: KartWorld; track: RaceTrack; layout: OfficeLayout } {
  const layout = ovalLayout();
  const track = raceTrack(layout);
  assert.ok(track, 'the hand-built oval is not recognised as a track');
  const tileMap: number[][] = [];
  for (let row = 0; row < ROWS; row++) {
    tileMap.push((layout.tiles as number[]).slice(row * COLS, (row + 1) * COLS));
  }
  // The barrier: one ring of blocked tiles just outside the road. Ground underneath (so it is a
  // wall and not a pit) and blocked, which is what stops a kart.
  const blockedTiles = new Set<string>();
  for (let row = 1; row <= 14; row++) {
    for (let col = 1; col <= 22; col++) {
      const outside = col === 1 || col === 22 || row === 1 || row === 14;
      if (!outside) continue;
      blockedTiles.add(`${col},${row}`);
      tileMap[row][col] = 1;
    }
  }
  return { world: { tileMap, blockedTiles, track }, track, layout };
}

/** Pixel centre of a tile. */
const at = (col: number, row: number): { x: number; y: number } => ({
  x: col * TILE_SIZE + TILE_SIZE / 2,
  y: row * TILE_SIZE + TILE_SIZE / 2,
});

const DT = 1 / 60;
function drive(kart: Kart, w: KartWorld, seconds: number, input: Partial<Kart['input']> = {}): { laps: number; falls: number } {
  kart.input = { throttle: 0, steer: 0, ...input } as Kart['input'];
  let laps = 0;
  let falls = 0;
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    const out = updateKart(kart, DT, w);
    if (out.lapped) laps++;
    if (out.fell) falls++;
  }
  return { laps, falls };
}

test('the oval is read as a track: four gates in lap order, two grid slots, its lap count', () => {
  const { track } = world();
  assert.equal(track.gates.length, 4);
  assert.deepEqual(
    track.gates.map((g) => g.index),
    [0, 1, 2, 3],
    'gates are not re-indexed into lap order',
  );
  assert.equal(track.grid.length, 2);
  assert.equal(track.laps, 2, 'the map property was ignored');
  // A gate is a LINE: several tiles, one of which is enough to cross it.
  assert.equal(track.gates[0].tiles.size, 3);
  assert.ok(gateAt(track, 12, 12), 'the finish line is not where it was painted');
  assert.equal(gateAt(track, 12, 8), null, 'the infield carries a gate');
});

test('a map with no gates is not a track, however much road it has', () => {
  const { layout } = world();
  const bare = { ...layout, tileActions: new Array(COLS * ROWS).fill(null) } as unknown as OfficeLayout;
  assert.equal(raceTrack(bare), null);
  // One gate is not a ring either — a lap needs somewhere to go and come back from.
  const one = { ...layout, tileActions: new Array(COLS * ROWS).fill(null) } as unknown as OfficeLayout;
  (one.tileActions as Array<Action | null>)[12 * COLS + 12] = { kind: 'raceGate', gate: 0 };
  (one.tileActions as Array<Action | null>)[12 * COLS + 10] = { kind: 'raceStart', slot: 0 };
  assert.equal(raceTrack(one), null);
});

test('a kart goes where it points, and tops out', () => {
  const { world: w } = world();
  const kart = createKart(1, at(8, 12), 0); // facing east along the bottom straight
  kart.driverId = 42;
  const startX = kart.x;
  drive(kart, w, 1.5, { throttle: 1 });
  assert.ok(kart.x > startX + 40, `barely moved: ${kart.x - startX} px in 1.5 s`);
  assert.ok(Math.abs(kart.y - at(8, 12).y) < 0.001, 'drifted sideways with no steering input');
  const speed = Math.hypot(kart.vx, kart.vy);
  assert.ok(speed <= KART_MAX_SPEED_PX_PER_SEC + 0.001, `over the speed limit: ${speed}`);
  assert.ok(speed > KART_MAX_SPEED_PX_PER_SEC * 0.75, `never got going: ${speed}`);

  // Letting go slows it without stopping it dead.
  const coasting = Math.hypot(kart.vx, kart.vy);
  drive(kart, w, 0.3, { throttle: 0 });
  const after = Math.hypot(kart.vx, kart.vy);
  assert.ok(after < coasting * 0.8 && after > 0, `coasting is wrong: ${coasting} -> ${after}`);
});

test('a wall is slid along, not stopped at', () => {
  const { world: w } = world();
  // Bottom straight, driving east but aimed into the outer BARRIER at row 14 — so the y
  // component is refused and x survives. Against a pit this would be a fall, which is the other
  // test; against a wall it has to be a scrape.
  const kart = createKart(1, at(8, 13), 0.5); // ~29° south of east
  kart.driverId = 42;
  const start = { x: kart.x, y: kart.y };
  drive(kart, w, 1.2, { throttle: 1 });
  assert.equal(kart.state, 'drive', 'scraping a wall should not be a fall');
  assert.ok(kart.x > start.x + 25, `did not slide along the wall: ${kart.x - start.x} px`);
  assert.ok(kart.y < 14 * TILE_SIZE, 'ended up inside the barrier');
});

test('driving off the road is a fall, and the respawn faces the next gate', () => {
  const { world: w, track } = world();
  // Placed ON the finish line and aimed north, straight at the infield pit two tiles away. Not
  // driven there from a distance: at 110 px/s a blind drive leaves the straight altogether, which
  // is how the first version of this test measured the wrong fall.
  const kart = createKart(1, { x: track.gates[0].x, y: track.gates[0].y }, -Math.PI / 2);
  kart.driverId = 42;
  kart.gate = 0;
  const out = drive(kart, w, 0.8, { throttle: 1 });
  assert.equal(out.falls, 1, 'the kart stayed on a road that is not there');
  assert.equal(kart.state, 'fall');

  // It comes back at the gate it last passed, pointing at the next one.
  drive(kart, w, KART_FALL_SEC + 0.2, { throttle: 0 });
  assert.notEqual(kart.state, 'fall', 'never came back');
  assert.ok(Math.hypot(kart.x - track.gates[0].x, kart.y - track.gates[0].y) < 1, 'respawned somewhere else');
  assert.ok(Math.abs(kart.heading - headingFrom(track, track.gates[0])) < 0.001, 'respawned facing the wrong way');
  assert.equal(Math.hypot(kart.vx, kart.vy), 0, 'kept its speed through the fall');
});

test('only the next gate counts: cutting and reversing earn nothing', () => {
  const { world: w, track } = world();
  const kart = createKart(1, at(12, 12), 0);
  kart.driverId = 42;
  kart.gate = 0;

  // Teleported onto gate 2 (the top straight) without passing gate 1 — which is what cutting
  // across the infield would achieve if gates did not have an order.
  kart.x = track.gates[2].x;
  kart.y = track.gates[2].y;
  updateKart(kart, DT, w);
  assert.equal(kart.gate, 0, 'a gate out of order counted');
  assert.equal(kart.lap, 0);

  // Back onto the finish line from gate 0 — a lap must need the whole ring, not a line crossed
  // twice.
  kart.x = track.gates[0].x;
  kart.y = track.gates[0].y;
  updateKart(kart, DT, w);
  assert.equal(kart.lap, 0, 'crossing the finish line without a lap scored one');

  // The ring, in order, does score.
  for (const index of [1, 2, 3, 0]) {
    kart.x = track.gates[index].x;
    kart.y = track.gates[index].y;
    updateKart(kart, DT, w);
  }
  assert.equal(kart.gate, 0);
  assert.equal(kart.lap, 1, 'a full lap in order did not count');
  assert.equal(kart.finished, false, 'finished after one of two laps');

  for (const index of [1, 2, 3, 0]) {
    kart.x = track.gates[index].x;
    kart.y = track.gates[index].y;
    updateKart(kart, DT, w);
  }
  assert.equal(kart.lap, 2);
  assert.equal(kart.finished, true, 'the last lap did not finish the race');
});

test('standings come from the gate and the distance to the next, not the line to the finish', () => {
  const { track } = world();
  const justStarted = raceProgress(track, 0, 0, track.gates[0].x, track.gates[0].y);
  const aboutToLap = raceProgress(track, 0, 3, track.gates[3].x, track.gates[3].y);
  assert.ok(aboutToLap > justStarted, 'a kart three gates in ranks behind one on the line');
  const nextLap = raceProgress(track, 1, 0, track.gates[0].x, track.gates[0].y);
  assert.ok(nextLap > aboutToLap, 'a lap counts for less than the gates within it');
});

test('a bump is a trade, and a shove from the side puts a kart off the road', () => {
  const { world: w } = world();
  // Head to head along the bottom straight: one at speed, one parked.
  const runner = createKart(1, at(8, 12), 0);
  runner.driverId = 42;
  drive(runner, w, 1.5, { throttle: 1 });
  const parked = createKart(2, { x: runner.x + 17, y: runner.y }, 0);
  const before = Math.hypot(runner.vx, runner.vy);

  assert.equal(bumpKarts(runner, parked), true, 'two karts a pixel apart did not touch');
  assert.ok(Math.hypot(parked.vx, parked.vy) > 20, 'the parked kart was not shoved');
  assert.ok(Math.hypot(runner.vx, runner.vy) < before, 'ramming cost the rammer nothing');
  assert.ok(parked.vx > 0, 'shoved the wrong way down the straight');

  // From the SIDE, towards the pit: the victim is on the INNER lane (row 11) with the infield
  // right above it, and the rammer comes up from the outer lane heading north. This is the bridge
  // case, and it is the reason velocity is a vector — a scalar speed along the heading could not
  // carry a sideways shove at all.
  const victim = createKart(3, at(8, 11), 0);
  victim.driverId = 7;
  const rammer = createKart(4, at(8, 13), -Math.PI / 2); // heading north, two tiles below
  rammer.driverId = 8;
  drive(rammer, w, 0.45, { throttle: 1 });
  // Placed at the contact point with the speed it built up, rather than waiting for the tick that
  // happens to overlap them.
  rammer.x = victim.x;
  rammer.y = victim.y + 17;
  assert.ok(rammer.vy < -20, `the rammer is not moving north: vy=${rammer.vy}`);
  bumpKarts(rammer, victim);
  assert.ok(victim.vy < -15, `not pushed north: vy=${victim.vy}`);
  const fell = drive(victim, w, 0.8, { throttle: 0 });
  assert.equal(fell.falls, 1, 'a kart shoved towards the pit stayed on the map');
});

test('the same inputs give the same numbers', () => {
  const run = (): Kart => {
    const { world: w } = world();
    const kart = createKart(1, at(8, 12), 0);
    kart.driverId = 42;
    drive(kart, w, 1.0, { throttle: 1, steer: 1 });
    drive(kart, w, 1.0, { throttle: 1, steer: -1 });
    return kart;
  };
  const a = run();
  const b = run();
  assert.deepEqual(
    { x: a.x, y: a.y, heading: a.heading, vx: a.vx, vy: a.vy, gate: a.gate, lap: a.lap },
    { x: b.x, y: b.y, heading: b.heading, vx: b.vx, vy: b.vy, gate: b.gate, lap: b.lap },
  );
});

test('a heading stays inside one turn, however long the kart circles', () => {
  const { world: w } = world();
  const kart = createKart(1, at(8, 12), 0);
  kart.driverId = 42;
  // Twelve seconds of holding one lock is about six full turns at KART_STEER_RAD_PER_SEC.
  drive(kart, w, 12, { throttle: 1, steer: 1 });
  assert.ok(kart.heading >= 0 && kart.heading < Math.PI * 2, `heading ran away: ${kart.heading}`);
  // Why it matters, stated as the thing that breaks: the wire carries the heading as hundredths
  // of a radian in a uint16, so an unwrapped angle arrives pointing somewhere else entirely.
  const onWire = Math.round(kart.heading * 100);
  assert.ok(onWire >= 0 && onWire <= 65535, `a uint16 cannot carry ${onWire}`);
  // The other direction, and the one atan2 hands out: a gate that points north-west.
  assert.equal(wrapAngle(-Math.PI / 2).toFixed(4), ((3 * Math.PI) / 2).toFixed(4));
  assert.equal(wrapAngle(0), 0);
});

test('a driver faces the way the kart points, in the four a body has art for', () => {
  const deg = (d: number) => facingFromHeading((d * Math.PI) / 180);
  // Sixteen headings for the kart, four for the driver: the asymmetry is the point, since a
  // character's art is four three-quarter views and a kart's is a picture per angle.
  assert.equal(deg(0), 2, 'east is RIGHT');
  assert.equal(deg(90), 0, 'south is DOWN');
  assert.equal(deg(180), 1, 'west is LEFT');
  assert.equal(deg(270), 3, 'north is UP');
  // Quadrants, not nearest-axis: a diagonal goes to the HORIZONTAL facing, because a driver seen
  // from the side reads as driving where one seen head-on reads as parked.
  assert.equal(deg(30), 2, 'east-south-east still faces right');
  assert.equal(deg(150), 1, 'west-south-west still faces left');
  assert.equal(deg(-30), 2, 'a negative heading is wrapped first');
  // Every heading answers, and only with a facing that exists.
  for (let d = 0; d < 720; d += 3) assert.ok([0, 1, 2, 3].includes(deg(d)), `heading ${d} gave nothing`);
});
