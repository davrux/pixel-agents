/**
 * Pawns and controllers: every pawn is driven by something, and only a human-driven one takes
 * commands.
 *
 * The split is Unreal's and the reason is ours: the pawn is the body (transform, pose, which sheet
 * it draws from) and the controller decides where it goes. It replaced a boolean `isPlayer`, which
 * could express two drivers and nothing more — the third (pets) had to be a separate collection,
 * and a fourth had nowhere to go at all.
 *
 * Three properties, and each one is a bug that a boolean allowed:
 *
 *  1. **Nobody is unclaimed.** `ControllerKind.NONE` is the schema's zero, so a pawn created
 *     without an explicit controller reads as unclaimed. That is deliberate — deny by default —
 *     and the update loop holds such a pawn still rather than running the agent FSM on it. What
 *     must never happen is a pawn REACHING that state through a normal spawn.
 *  2. **A command is a property of the controller, not a habit.** The ten `…Player` methods used
 *     to open with their own `if (!ch.isPlayer) return`; ten copies of one rule is where the
 *     eleventh forgets, and then a `playerMove` moves an agent. They go through `humanPawn` now,
 *     so this asserts the outcome: an agent's id is refused by every one of them.
 *  3. **A pet is driven too.** Its controller is synced like everyone else's, so a client can ask
 *     one question of any pawn instead of inferring the answer from which collection it arrived in.
 *
 * TEST BOUNDARIES:
 *   @real-dependency: OfficeState over a real layout -- Mock? NO. The claim is about what the
 *       engine does with a pawn, and the engine is the thing under test. A hand-built layout keeps
 *       it deterministic.
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { ControllerKind, Direction } from '@pixel/shared/office/types';
import { OfficeState } from '@pixel/shared/office/engine/officeState.js';
import { CharacterSync, PetSync } from '@pixel/shared/schema';

/** An empty walkable map — enough for spawning and walking. */
const emptyMap = (cols = 12, rows = 12) => ({
  cols,
  rows,
  tiles: new Array(cols * rows).fill(1),
  walls: [],
  furniture: [] as Array<Record<string, unknown>>,
});

const fresh = (): OfficeState => new OfficeState(emptyMap() as never);

test('a spawned pawn always names its controller', () => {
  const os = fresh();
  const playerId = os.addPlayer(undefined, 'Ann');
  os.addAgent(7, undefined, undefined, true, 'owner');

  const player = os.getCharacter(playerId);
  const agent = os.getCharacter(7);
  assert.ok(player && agent);
  assert.equal(player.controller, ControllerKind.HUMAN, 'a viewer avatar is human-driven');
  assert.equal(agent.controller, ControllerKind.AGENT, 'an agent mirrors an external process');

  // The property that matters: nothing reaches NONE by spawning. NONE exists so that a pawn
  // somebody forgot to claim is inert instead of privileged, not as a state the world produces.
  for (const ch of os.characters.values()) {
    assert.notEqual(ch.controller, ControllerKind.NONE, `pawn ${ch.id} was spawned unclaimed`);
  }
});

test('every player command refuses a pawn a human does not drive', () => {
  const os = fresh();
  os.addAgent(7, undefined, undefined, true, 'owner');
  const agentId = 7;

  // One line per command, because the guard used to be one copy per command. `resumePlayer` and
  // `removePlayer` return void, so they are checked by their absence of effect below.
  assert.equal(os.walkPlayer(agentId, 4, 4), false, 'walkPlayer moved an agent');
  assert.equal(os.warpPlayer(agentId, 4, 4), false, 'warpPlayer teleported an agent');
  assert.equal(os.sitPlayerAt(agentId, 4, 4), false);
  assert.equal(os.setPlayerDir(agentId, Direction.LEFT), false);
  assert.equal(os.setPlayerSit(agentId, true), false);
  // `null`, not `false`: this one answers with the new afk value, so "not applicable" and "afk is
  // off" must not be the same answer. A caller that treated them alike would report an agent as
  // present-and-not-away.
  assert.equal(os.setPlayerAfk(agentId, true), null);
  assert.equal(os.walkPlayerToAction(agentId, 4, 4), false);
  assert.equal(os.playerSpot(agentId), null, 'an agent has no player spot to persist');

  // And the same calls on a real human pawn are accepted, so the guard is not simply "always no".
  const playerId = os.addPlayer(undefined, 'Ann');
  assert.equal(os.setPlayerDir(playerId, Direction.LEFT), true);
  // `heldDir`, not `dir`: this is a held key, and the facing follows on the next tick. Asserting
  // `dir` here would have been asserting the tick, not the command.
  assert.equal(os.getCharacter(playerId)?.heldDir, Direction.LEFT);
  assert.ok(os.playerSpot(playerId), 'a human pawn has a spot');
});

test('an unclaimed pawn stands still instead of being driven by the agent FSM', () => {
  const os = fresh();
  os.addAgent(7, undefined, undefined, true, 'owner');
  const ch = os.getCharacter(7);
  assert.ok(ch);
  // Force the state the zero value describes. The engine must not decide that "no controller"
  // means "the default one" — an unclaimed pawn wandering off for coffee is the failure this
  // guards, and it is exactly what a boolean `isPlayer` would have done (false → agent).
  ch.controller = ControllerKind.NONE;
  const before = { col: ch.tileCol, row: ch.tileRow, state: ch.state };

  const warn = console.warn;
  const said: string[] = [];
  console.warn = (...a: unknown[]) => void said.push(a.map(String).join(' '));
  try {
    for (let i = 0; i < 40; i++) os.update(1 / 20);
  } finally {
    console.warn = warn;
  }

  assert.deepEqual({ col: ch.tileCol, row: ch.tileRow, state: ch.state }, before, 'an unclaimed pawn moved');
  assert.equal(said.length, 1, `expected exactly one warning over 40 ticks, got ${said.length}`);
  assert.match(said[0], /no controller drives it/);
});

test('the controller lives on the pawn base, so every pawn kind has one', () => {
  // Asserted on the schema rather than by spawning a pet: a pet's spawn interval is 60-180 s of
  // simulated time, and a test that ticks that far measures patience, not behaviour.
  //
  // Both kinds extending PawnSync is the whole reason a fourth controller costs nothing: the field
  // is already on every pawn that exists. And the default is NONE on both, which is the deny value
  // — a pawn only becomes drivable when something claims it.
  assert.equal(new CharacterSync().controller, ControllerKind.NONE);
  assert.equal(new PetSync().controller, ControllerKind.NONE);
  assert.equal(ControllerKind.NONE, 0, 'the zero value must be the one that grants nothing');
});

test('every ControllerKind has code that drives it', () => {
  // The rule that makes a fourth controller cheap AND safe: adding a value to the enum is not
  // enough — something has to drive it, or a pawn it claims stands still with one warning and it
  // takes a week to notice.
  //
  // Two places count, because a controller lands in one of two shapes today:
  //   • `officeState.update`'s dispatch, for a controller that drives a CHARACTER pawn (HUMAN,
  //     AGENT). That block names its kinds explicitly.
  //   • `SimRoom`'s sync, for a controller whose pawns are their own kind and their own loop.
  //     PET is this shape: a pet is pet-driven by BEING in `os.pets`, so the engine never asks —
  //     the kind is stated where the pawn is synced. Worth knowing before adding a fourth: if it
  //     drives characters it belongs in the dispatch, if it brings its own pawn kind it does not.
  //
  // The enum is enumerated rather than listed here, so this cannot pass by being out of date.
  const read = (...parts: string[]): string => readFileSync(join(import.meta.dirname, '..', '..', ...parts), 'utf8');
  const engine = read('shared', 'src', 'office', 'engine', 'officeState.ts');
  const room = read('server', 'src', 'rooms', 'SimRoom.ts');

  assert.ok(engine.includes('── Controller dispatch'), 'the dispatch block is gone — did update() get rewritten?');

  for (const name of Object.keys(ControllerKind)) {
    if (name === 'NONE') continue; // by definition nobody drives it; the dispatch holds it still
    const token = `ControllerKind.${name}`;
    assert.ok(
      engine.includes(token) || room.includes(token),
      `ControllerKind.${name} exists but neither officeState.update() nor SimRoom's sync ever ` +
        `names it. Nothing drives a pawn it claims: add its case to the dispatch (a character ` +
        `pawn) or set it where its own pawn kind is synced (its own body).`,
    );
  }
});
