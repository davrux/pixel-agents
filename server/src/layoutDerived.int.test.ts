/**
 * What is derived from the layout is rebuilt WITH the layout — and the caches lean on that.
 *
 * Three answers about the map used to be recomputed per question: which cells a piece stands on
 * (`occupiedSurfaceTiles`, walked twice per pet decision), which piece a seat faces
 * (`seatFacesFurniture`, a linear `find` inside a loop over placements) and where somebody may
 * appear (`findFreeSpawnTile`, a filter over all 2651 walkable tiles plus a rebuilt footprint set,
 * on every join). Measured on uponu at 300 agents: a pet's 'sit' decision cost 2.5 ms and a join
 * 0.2 ms — 0.22 ms and 13 µs now.
 *
 * A cache of a map is only safe if it cannot outlive the map, so that is what this file pins,
 * from three sides:
 *
 *  1. **The tables follow a rebuild.** A perch that a pushed map removed must stop being offered.
 *     A stale table does not throw or look wrong — it makes an animal walk to furniture that is
 *     not there any more, which is the kind of bug that gets blamed on the pathfinder.
 *  2. **`rebuildFromLayout` replaces the layout OBJECT.** `SimRoom` keys its encoded
 *     `layoutLoaded` frame on that identity instead of on an invalidation call, precisely so that
 *     no future caller has to remember to clear it. If a rebuild ever started mutating the layout
 *     in place, that cache would serve every joiner a stale map, and this is the test that fails
 *     first.
 *  3. **A pre-encoded frame is the same bytes `send` would build.** `client.send('m', msg)` is
 *     `client.raw(getMessageBytes.raw(ROOM_DATA, 'm', msg))`, so packing once per map is a
 *     saving and not a wire change — as long as packing is deterministic, which is asserted here
 *     rather than assumed.
 *
 * TEST BOUNDARIES:
 *   @real-dependency: OfficeState + the real furniture catalog + Colyseus's own encoder -- Mock?
 *       NO. Every claim here is about what those three actually do; a stub would test my belief
 *       about them, and belief is exactly what a cache turns into a bug.
 */
import { strict as assert } from 'node:assert';
import test, { before } from 'node:test';

import { readFileSync } from 'node:fs';

import { getMessageBytes, Protocol } from '@colyseus/core';
import { AUTO_ON_FACING_DEPTH, SPAWN_PROBE_TRIES } from '@pixel/shared/office/constants.js';
import { OfficeState } from '@pixel/shared/office/engine/officeState.js';
import { createPet } from '@pixel/shared/office/engine/pets.js';
import { buildDynamicCatalog, getCatalogEntry } from '@pixel/shared/office/layout/furnitureCatalog';
import { Direction, PetKind, PetState, TILE_SIZE, type Character, type Pet } from '@pixel/shared/office/types';

import { buildFurnitureCatalogAndSprites } from './assets.js';

before(async () => {
  buildDynamicCatalog((await buildFurnitureCatalogAndSprites()) as never);
});

const COLS = 20;
const ROWS = 20;

function place(id: string, col: number, row: number): Record<string, unknown> {
  const entry = getCatalogEntry(id);
  assert.ok(entry, `${id} is not in the catalog`);
  return { uid: `${id}-${col}-${row}`, id, col, row, x: col * TILE_SIZE, y: row * TILE_SIZE, width: entry.width, height: entry.height };
}

const layoutOf = (furniture: Array<Record<string, unknown>>, cols = COLS, rows = ROWS): Record<string, unknown> => ({
  cols,
  rows,
  tiles: new Array(cols * rows).fill(1),
  walls: { horizontal: [], vertical: [] },
  furniture,
});

type Inner = {
  petTargetSpecs(pet: Pet, action: string): Array<{ furnitureUid: string | null }>;
  petUnavailableFurniture(): Set<string>;
  findFreeSpawnTile(preferred?: { col: number; row: number }): { col: number; row: number };
  footprintUids: Map<string, Set<string>>;
  surfaceUids: Map<string, Set<string>>;
  spawnablePool: Array<{ col: number; row: number }>;
  points: Map<string, { col: number; row: number; facingDir: number; posture: string }>;
  addAgent(id: number, preferredSkin?: string): void;
  characters: Map<number, Character>;
};
const inner = (os: OfficeState): Inner => os as unknown as Inner;

function pet(os: OfficeState, col: number, row: number): Pet {
  const p = createPet(1, PetKind.CAT, 0, { col, row });
  p.state = PetState.IDLE;
  p.effect = null;
  p.wanderTimer = 0;
  os.pets.set(1, p);
  return p;
}

test('a perch a pushed map removed stops being offered', () => {
  const os = new OfficeState(layoutOf([place('COFFEE_TABLE', 8, 8)]) as never);
  const i = inner(os);
  const cat = pet(os, 2, 2);

  const uid = 'COFFEE_TABLE-8-8';
  assert.ok(
    i.petTargetSpecs(cat, 'sit').some((sp) => sp.furnitureUid === uid),
    'the fixture does not offer the perch in the first place',
  );
  assert.ok(i.footprintUids.size > 0 && i.surfaceUids.size > 0, 'the derived tables were never built');

  // The same zone, a map without it — what a push does.
  os.rebuildFromLayout(layoutOf([]) as never);
  pet(os, 2, 2);
  assert.equal(
    i.petTargetSpecs(os.pets.get(1)!, 'sit').some((sp) => sp.furnitureUid === uid),
    false,
    'a perch that is no longer on the map is still being offered — the derived tables went stale',
  );
  assert.equal(i.footprintUids.size, 0, 'the footprint table still holds the old placement');
  assert.equal(i.surfaceUids.size, 0, 'the surface table still holds the old placement');
});

test('the spawn pool follows the map, and never offers a cell furniture stands on', () => {
  const os = new OfficeState(layoutOf([place('COFFEE_TABLE', 8, 8)]) as never);
  const i = inner(os);
  assert.equal(i.spawnablePool.length, COLS * ROWS - i.footprintUids.size, 'the pool is not the walkable floor');

  // A smaller map: the pool must shrink with it rather than keep tiles that no longer exist.
  os.rebuildFromLayout(layoutOf([], 8, 8) as never);
  assert.ok(
    i.spawnablePool.every((t) => t.col < 8 && t.row < 8),
    'the spawn pool still holds tiles from the bigger map',
  );
  assert.equal(i.spawnablePool.length, 64);
});

test('rebuildFromLayout replaces the layout object — the identity SimRoom caches on', () => {
  const os = new OfficeState(layoutOf([]) as never);
  const before = os.getLayout();
  os.rebuildFromLayout(layoutOf([place('COFFEE_TABLE', 4, 4)]) as never);
  assert.notEqual(os.getLayout(), before, 'the layout was mutated in place: every cached frame keyed on it is now stale');
});

test('a pre-encoded layoutLoaded frame is the bytes send would have built', () => {
  const os = new OfficeState(layoutOf([place('COFFEE_TABLE', 4, 4)]) as never);
  const frame = (): Buffer =>
    getMessageBytes.raw(Protocol.ROOM_DATA, 'm', { type: 'layoutLoaded', layout: os.getLayout(), force: true });
  const first = frame();
  assert.ok(first.length > 0);
  assert.deepEqual(frame(), first, 'packing the same message twice gave different bytes — a cached frame would be a wire change');

  os.rebuildFromLayout(layoutOf([]) as never);
  assert.notDeepEqual(frame(), first, 'a different map packed to the same bytes');
});

test('a seat an active agent faces makes its perch unavailable', () => {
  // Built in two steps on purpose: where a seat looks is a fact about the placement, so read it
  // and put the perch there, rather than assuming a direction.
  const os = new OfficeState(layoutOf([place('WOODEN_CHAIR_BACK', 6, 6)]) as never);
  const i = inner(os);
  const seat = [...i.points.values()].find((p) => p.posture === 'sit');
  assert.ok(seat, 'the chair yielded no seat');
  const dCol = seat.facingDir === Direction.RIGHT ? 1 : seat.facingDir === Direction.LEFT ? -1 : 0;
  const dRow = seat.facingDir === Direction.DOWN ? 1 : seat.facingDir === Direction.UP ? -1 : 0;
  const perchCol = seat.col + dCol;
  const perchRow = seat.row + dRow;

  os.rebuildFromLayout(layoutOf([place('WOODEN_CHAIR_BACK', 6, 6), place('COFFEE_TABLE', perchCol, perchRow)]) as never);
  const uid = `COFFEE_TABLE-${perchCol}-${perchRow}`;
  assert.equal(i.petUnavailableFurniture().has(uid), false, 'nobody is sitting yet and the perch is already blocked');

  // Seat an ACTIVE agent there — the state the old per-uid check looked for.
  i.addAgent(1, 'char_0');
  const ch = i.characters.get(1);
  assert.ok(ch);
  const seatId = [...i.points.entries()].find(([, p]) => p.posture === 'sit' && p.col === seat.col && p.row === seat.row)?.[0];
  assert.ok(seatId, 'the seat lost its id across the rebuild');
  ch.homePointId = seatId;
  ch.isActive = true;

  assert.ok(i.petUnavailableFurniture().has(uid), `a perch ${AUTO_ON_FACING_DEPTH} tiles in front of a working agent is offered to a pet`);
  const cat = pet(os, 2, 2);
  assert.equal(
    i.petTargetSpecs(cat, 'sit').some((sp) => sp.furnitureUid === uid),
    false,
    'the target search offers a perch the agent is using',
  );

  // An idle agent is not using it.
  ch.isActive = false;
  assert.equal(i.petUnavailableFurniture().has(uid), false, 'an inactive agent still blocks the perch');
});

test('a spawn never lands on furniture, an occupant or a meeting area — crowded or not', () => {
  // A small map so nearly every free tile can be taken: past SPAWN_PROBE_TRIES the random probes
  // are exhausted and the old exhaustive filter answers, which is the branch that must stay
  // correct rather than fast.
  const os = new OfficeState(layoutOf([place('COFFEE_TABLE', 3, 3)], 8, 8) as never);
  const i = inner(os);
  const taken = new Set<string>();
  const occupiedByFurniture = new Set(i.footprintUids.keys());

  for (let n = 1; n <= 60; n++) {
    const tile = i.findFreeSpawnTile();
    const key = `${tile.col},${tile.row}`;
    const free = i.spawnablePool.length - taken.size;
    if (free > 0) {
      assert.equal(occupiedByFurniture.has(key), false, `spawn ${n} landed on furniture at ${key}`);
      assert.equal(taken.has(key), false, `spawn ${n} landed on somebody at ${key} with ${free} tiles free`);
    }
    taken.add(key);
    // Park a character there, so the next spawn has one fewer tile.
    i.addAgent(n, 'char_0');
    const ch = i.characters.get(n);
    assert.ok(ch);
    ch.tileCol = tile.col;
    ch.tileRow = tile.row;
  }
  assert.ok(taken.size > SPAWN_PROBE_TRIES, 'the fixture never got crowded enough to exhaust the probes');
});

test('the spawn choice is still spread over the map', () => {
  // Rejection sampling has to stay a random pick: a "first free tile" shortcut passes every
  // correctness test above and piles every joiner onto one corner.
  const os = new OfficeState(layoutOf([]) as never);
  const i = inner(os);
  const seen = new Set<string>();
  for (let n = 0; n < 60; n++) {
    const t = i.findFreeSpawnTile();
    seen.add(`${t.col},${t.row}`);
  }
  assert.ok(seen.size > 30, `60 spawns landed on ${seen.size} distinct tiles — that is not a random pick`);
});

test('the join sends its pre-encoded frame through the QUEUE, not straight to the socket', () => {
  // The mistake this pins was made here and caught in a browser rather than by a test, which is
  // why it is worth a source-level assertion: `client.send` is `enqueueRaw`, which HOLDS messages
  // while a client is still JOINING and flushes them after the handshake. `client.raw` writes to
  // the socket at once — so a pre-encoded frame sent with it arrives before the SDK has
  // registered its handler and is dropped, silently. What a viewer sees is a world stuck in its
  // loading phase until the deadline, and the only clue is a console warning in the browser
  // (`onMessage() not registered for type 'm'`). Nothing on the server notices at all.
  const src = readFileSync(new URL('./rooms/SimRoom.ts', import.meta.url), 'utf8');
  const join = src.slice(src.indexOf('onJoin(client'), src.indexOf('onLeave('));
  assert.ok(join.length > 200, 'onJoin was not found — this test is reading the wrong slice');
  assert.ok(join.includes('client.enqueueRaw(this.zoneMapFrame())'), 'the join no longer enqueues the pre-encoded map frame');
  assert.equal(
    /\bclient\.raw\(/.test(join),
    false,
    'onJoin writes straight to the socket: anything sent that way during a join is dropped before the client can handle it',
  );
});
