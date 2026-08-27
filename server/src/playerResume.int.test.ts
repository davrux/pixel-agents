/**
 * A reload must not move anybody.
 *
 * The world reconnects by reloading the page (OfficeScene.handleDisconnect), so a
 * server restart runs every player through onLeave/onJoin — or, when the restart
 * was not graceful, through onJoin alone. What came back was a *placement*:
 * `findFreeSpawnTile` refuses furniture tiles and meeting areas, which is right
 * for choosing a tile on somebody's behalf and wrong for coming back to the chair
 * you were sitting in, so a seated player reappeared at a random tile, standing.
 *
 * These pin down the two halves of the fix: what `playerSpot` considers worth
 * remembering, and that `resumePlayer` puts it back — including the claim, since a
 * pose that is not backed by an occupied InteractionPoint is exactly the
 * double-occupancy hole the one-occupancy model exists to close (AGENTS.md § 4).
 *
 * The last test takes the other half of the round trip — the store — because a
 * spot that does not read back is indistinguishable from no spot at all, and that
 * is the silent failure mode: everybody quietly spawns at random again.
 *
 * TEST BOUNDARIES:
 *   @real-dependency: OfficeState -- Mock? NO. It IS the engine under test; this
 *       drives it headlessly, which is what AGENTS.md asks of an engine change.
 *   @real-dependency: furnitureCatalog -- Mock? NO. Built from a two-item
 *       synthetic catalog rather than the deployment's tilesets, so a seat and an
 *       appliance are guaranteed present regardless of what art is installed.
 *   @real-dependency: appStore + SQLite -- Mock? NO. The validation it does on
 *       read is the thing under test. A throwaway PIXEL_STREAM_DATA_DIR keeps it
 *       away from a developer's own world, which is why appStore is imported
 *       dynamically: db.ts resolves that path at module load.
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { OfficeState } from '@pixel/shared/office/engine/index.js';
import { getCharacterPose } from '@pixel/shared/office/engine/characters.js';
import { buildDynamicCatalog } from '@pixel/shared/office/layout/furnitureCatalog.js';
import { emptyZoneMap } from '@pixel/shared/office/layout/layoutSerializer.js';
import { CharacterPose, CharacterState, Direction } from '@pixel/shared/office/types.js';

const CHAIR = { col: 3, row: 3 };
const MACHINE = { col: 6, row: 6 };

/** A room with one chair and one coffee machine, and the catalog that gives them
 *  their behaviour (a seat, and an appliance with stand tiles around it). */
function world(): OfficeState {
  buildDynamicCatalog({
    catalog: [
      { id: 'chair', label: 'Chair', footprintW: 1, footprintH: 1, width: 16, height: 16, canSitOn: true, sitFacing: Direction.UP },
      { id: 'machine', label: 'Coffee machine', footprintW: 1, footprintH: 1, width: 16, height: 16, action: { kind: 'appliance' } },
    ],
  } as never);
  return new OfficeState({
    ...emptyZoneMap(12, 12),
    furniture: [
      { uid: 'chair-1', id: 'chair', ...CHAIR },
      { uid: 'machine-1', id: 'machine', ...MACHINE },
    ],
  });
}

/** Run the sim until `done()`, or fail — walking there is the only way to reach
 *  an appliance's stand tile, and that takes ticks. */
function runUntil(os: OfficeState, done: () => boolean, what: string): void {
  for (let i = 0; i < 400 && !done(); i++) os.update(0.05);
  assert.ok(done(), `never ${what} within 20 s of simulation`);
}

test('a seated player comes back to the same chair, still sitting', () => {
  const os = world();
  const before = os.addPlayer('char_0', 'Ann');
  assert.ok(os.sitPlayerAt(before, CHAIR.col, CHAIR.row), 'could not sit on the fixture chair');
  runUntil(os, () => os.getCharacter(before)?.state === CharacterState.SIT, 'sat down');

  const spot = os.playerSpot(before);
  assert.ok(spot, 'a player has a spot');
  assert.equal(spot.pointId, 'chair-1', 'the chair it claimed is what identifies the spot');

  // What a reload does: the avatar is gone, then a fresh one joins.
  os.removePlayer(before);
  const after = os.addPlayer('char_0', 'Ann');
  os.resumePlayer(after, spot);

  const ch = os.getCharacter(after);
  assert.ok(ch);
  assert.deepEqual({ col: ch.tileCol, row: ch.tileRow }, CHAIR, 'resumed somewhere other than the chair');
  assert.equal(ch.state, CharacterState.SIT);
  assert.equal(ch.atPointId, 'chair-1');
  // The claim, not just the pose: an unoccupied point is one an agent may be sent to.
  assert.equal(os.points.get('chair-1')?.occupantId, after, 'the seat is not claimed by the resumed player');

  // And it holds: the resume writes state the very next tick could undo.
  for (let i = 0; i < 20; i++) os.update(0.05);
  assert.equal(ch.state, CharacterState.SIT, 'stood up again on the next tick');
  assert.equal(ch.atPointId, 'chair-1');
});

test('a player at the coffee machine comes back holding the cup', () => {
  const os = world();
  const before = os.addPlayer('char_0', 'Bo');
  assert.ok(os.useAppliance(before, MACHINE.col, MACHINE.row), 'no appliance at the fixture machine');
  runUntil(os, () => os.getCharacter(before)?.atPointId !== null, 'reached the machine');

  const spot = os.playerSpot(before);
  assert.ok(spot, 'a player has a spot');
  assert.ok(spot.pointId?.startsWith('station:machine-1:'), `expected a station point, got ${spot.pointId}`);

  os.removePlayer(before);
  const after = os.addPlayer('char_0', 'Bo');
  os.resumePlayer(after, spot);

  const ch = os.getCharacter(after);
  assert.ok(ch);
  assert.equal(ch.atPointId, spot.pointId);
  assert.equal(getCharacterPose(ch), CharacterPose.COFFEE, 'the ☕ pose is what the player sees restored');
  // Held indefinitely, exactly as a click-started pose is (an NPC's break is the
  // timed one) — a resumed cup must not vanish a second later.
  assert.equal(ch.atPointTimer, 0);
  for (let i = 0; i < 40; i++) os.update(0.05);
  assert.equal(getCharacterPose(ch), CharacterPose.COFFEE, 'the pose timed out — players hold it until they move');
});

test('a spot on open floor resumes exactly, facing the same way', () => {
  const os = world();
  const before = os.addPlayer('char_0', 'Cy');
  assert.ok(os.walkPlayer(before, 8, 2));
  runUntil(os, () => os.getCharacter(before)?.path.length === 0, 'finished walking');
  const walked = os.getCharacter(before);
  assert.ok(walked);
  const spot = os.playerSpot(before);
  assert.ok(spot);
  assert.equal(spot.pointId, undefined, 'open floor is not a point');

  os.removePlayer(before);
  const after = os.addPlayer('char_0', 'Cy');
  os.resumePlayer(after, spot);

  const ch = os.getCharacter(after);
  assert.ok(ch);
  assert.deepEqual({ col: ch.tileCol, row: ch.tileRow }, { col: spot.col, row: spot.row });
  assert.equal(ch.dir, spot.dir);
  assert.equal(ch.x, spot.col * 16 + 8, 'pixel position has to follow the tile, or it interpolates from nowhere');
});

test('the sit toggle resumes as sitting, with no chair claimed', () => {
  const os = world();
  const before = os.addPlayer('char_0', 'Di');
  assert.ok(os.setPlayerSit(before, true));
  const spot = os.playerSpot(before);
  assert.ok(spot);
  assert.equal(spot.sit, true);
  assert.equal(spot.pointId, undefined);

  os.removePlayer(before);
  const after = os.addPlayer('char_0', 'Di');
  os.resumePlayer(after, spot);
  const ch = os.getCharacter(after);
  assert.equal(ch?.state, CharacterState.SIT);
  assert.equal(ch?.atPointId, null);
});

test('a chair somebody else took stays theirs — the resume just stands', () => {
  const os = world();
  const first = os.addPlayer('char_0', 'Ann');
  os.sitPlayerAt(first, CHAIR.col, CHAIR.row);
  runUntil(os, () => os.getCharacter(first)?.state === CharacterState.SIT, 'sat down');
  const spot = os.playerSpot(first);
  assert.ok(spot);

  // Ann is still sitting there when Bo reconnects with a spot naming her chair
  // (she took it while he was away). First come, first served — same rule as
  // claimPoint, which is what keeps agents and players from sharing a tile.
  const other = os.addPlayer('char_1', 'Bo');
  os.resumePlayer(other, spot);

  const bo = os.getCharacter(other);
  assert.ok(bo);
  assert.equal(bo.atPointId, null, 'the resume stole an occupied seat');
  assert.equal(bo.state, CharacterState.IDLE);
  assert.equal(os.points.get('chair-1')?.occupantId, first, 'the sitting player lost her seat');
  assert.notDeepEqual({ col: bo.tileCol, row: bo.tileRow }, CHAIR, 'stood on the chair tile anyway');
});

test('a spot survives the store, and a hand-edited row is read field by field', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'pixel-player-spot-test-'));
  process.env.PIXEL_STREAM_DATA_DIR = dataDir;
  try {
    const { appStore } = await import('./appStore.js');
    const { userStore } = await import('./userStore.js');
    const { db } = await import('./db.js');
    // Real accounts: a spot lives in `player_pos`, which references `users` (see
    // schema/tables.ts). A position for an account that does not exist is a row the schema
    // refuses — and those were exactly the rows nothing used to delete.
    for (const id of ['ann', 'ed']) userStore.createUser(id, 'password-123', {});

    const spot = { col: 4, row: 7, dir: Direction.LEFT, pointId: 'chair-1', sit: true, afk: true };
    appStore.setPlayerSpot('ann', 'uponu', spot);
    assert.deepEqual(appStore.getPlayerSpot('ann', 'uponu'), spot);
    assert.equal(appStore.getPlayerSpot('ann', 'foyer'), null, 'a spot belongs to one zone');
    assert.equal(appStore.getPlayerSpot('bo', 'uponu'), null, 'a spot belongs to one user');

    // A write for an account that is gone is dropped, not thrown: this runs on the tick, five
    // seconds apart, and an account can be deleted while its player is still standing there.
    appStore.setPlayerSpot('nobody', 'uponu', spot);
    assert.equal(appStore.getPlayerSpot('nobody', 'uponu'), null);

    // Junk in a field is dropped field by field, never the whole spot: the tile is the part
    // worth having. SQLite stores what it is given, so a restored or hand-edited database can
    // hold a direction outside 0..3 and a point id of any length — the guards are for that, not
    // for this store, which only ever writes a real Direction. The long id matters because it is
    // looked up in the points map: an unbounded string off disk has no business going there.
    db.prepare(
      `INSERT INTO player_pos(user_id, zone, col, row, dir, point_id, sit, afk, updated_at)
         VALUES('ed', 'uponu', 1, 1, 99, ?, 0, 0, 0)`,
    ).run('x'.repeat(200));
    assert.deepEqual(appStore.getPlayerSpot('ed', 'uponu'), { col: 1, row: 1, dir: Direction.DOWN });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
