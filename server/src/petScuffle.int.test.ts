/**
 * A chase can end: the hunter corners its quarry and both vanish into one comic cloud.
 *
 * Before this, a chase had no ending at all. `navigateReaction` computed ONE path to the tile the
 * quarry stood on at that instant, the hunter walked it to the end, found nobody, and idled for up
 * to eight seconds before deciding again — the engine's own comment said "on arrival the pet just
 * returns to idle and may react again". So a dog could never catch a cat, and the only reason that
 * looked fine is that a dog trotting about looks like a dog trotting about.
 *
 * Two decisions shape what is tested here, and both were deliberate:
 *
 *  • **Geometry catches, not speed.** There is one walking speed for every pet and it stays that
 *    way, so a hunter closes distance only when its quarry runs out of room. The hunter re-aims
 *    every PET_REACTION_REPATH_SEC — and the quarry re-picks its escape on the SAME cadence,
 *    because reacting twice as often IS a speed advantage wearing a different hat.
 *  • **A cloud is a pair, and the server says who is in it.** Both animals hold
 *    `PetState.SCUFFLE` and point at each other through `scufflePartnerId`, which is synced: the
 *    client draws ONE picture between them and must not guess the pairing from adjacency, since
 *    three animals in a row would make that guess draw two clouds on one spot.
 *
 * TEST BOUNDARIES:
 *   @real-dependency: OfficeState over a hand-built layout -- Mock? NO. Every claim here is about
 *       what the engine does with two animals on a floor, and the engine is the thing under test.
 *       The pets are placed and pinned past their fade-in, because `createPet` gives each one a
 *       RANDOM first pause and a test that waits for it measures patience (see petChase's note).
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  PET_AFTERMATH_DURATION_SEC,
  PET_CATCH_RADIUS_TILES,
  PET_HUNTER_WIN_CHANCE,
  PET_SCUFFLE_COOLDOWN_SEC,
  PET_SCUFFLE_DURATION_SEC,
} from '@pixel/shared/office/constants.js';
import { OfficeState } from '@pixel/shared/office/engine/officeState.js';
import { beginPetDespawn, createPet, petPose } from '@pixel/shared/office/engine/pets.js';
import { PetKind, PetState, type Pet } from '@pixel/shared/office/types';
import { PetSync } from '@pixel/shared/schema';

/** An open floor with no furniture: a chase needs nothing else, and walls would add a variable. */
function world(cols = 24, rows = 12): OfficeState {
  return new OfficeState({
    cols,
    rows,
    tiles: new Array(cols * rows).fill(1),
    walls: { horizontal: [], vertical: [] },
    furniture: [],
  } as never);
}

/** A pet already past its fade-in and its random first pause, at a tile. */
function place(os: OfficeState, id: number, kind: PetKind, col: number, row: number): Pet {
  const pet = createPet(id, kind, 0, { col, row });
  pet.state = PetState.IDLE;
  pet.effect = null;
  pet.wanderTimer = 0;
  os.pets.set(id, pet);
  return pet;
}

/**
 * The pet's state, read WITHOUT narrowing.
 *
 * `assert.equal` in node:assert/strict carries an assertion signature, so asserting a state once
 * narrows the field to that literal for the rest of the function — and every later comparison then
 * looks impossible to the compiler even though the value changes on the next tick.
 */
const stateOf = (pet: Pet): string => pet.state;

const tick = (os: OfficeState, seconds: number, step = 1 / 20): void => {
  for (let i = 0; i < Math.round(seconds / step); i++) os.update(step);
};

test('a hunter that reaches its quarry puts both of them in one cloud', () => {
  const os = world();
  const dog = place(os, 1, PetKind.DOG, 4, 4);
  const cat = place(os, 2, PetKind.CAT, 5, 4); // already adjacent: this is about the catch, not the pursuit
  os.setPetDecider((pet) => (pet.kind === PetKind.DOG ? 'chase' : 'wander'));

  tick(os, 1);

  assert.equal(dog.state, PetState.SCUFFLE, 'the dog reached the cat and nothing happened');
  assert.equal(cat.state, PetState.SCUFFLE, 'the cat is not in the cloud its hunter is in');
  assert.equal(dog.scufflePartnerId, cat.id, 'the dog names no partner');
  assert.equal(cat.scufflePartnerId, dog.id, 'the pair is not symmetric — the client would draw a cloud off one end');
  // They stop where they are: a cloud that slides across the floor reads as a bug.
  assert.deepEqual(dog.path, []);
  assert.deepEqual(cat.path, []);
  // And the pose behind the cloud is the standing one, so a client whose cloud art failed to load
  // shows two animals rather than nothing.
  assert.equal(petPose(dog), 'idle');
});

test('a hunter merely walking past its quarry starts nothing', () => {
  // The narrow condition, and the reason the world is not wall-to-wall clouds: what earns a scuffle
  // is having PURSUED. A dog wandering across a tile beside a sitting cat has not.
  const os = world();
  const dog = place(os, 1, PetKind.DOG, 4, 4);
  const cat = place(os, 2, PetKind.CAT, 5, 4);
  os.setPetDecider(() => 'wander');

  tick(os, 3);

  assert.notEqual(dog.state, PetState.SCUFFLE, 'a wandering dog started a brawl');
  assert.notEqual(cat.state, PetState.SCUFFLE);
  assert.equal(dog.scufflePartnerId, null);
});

test('the cloud ends by itself, and the hunter may not immediately start again', () => {
  const os = world();
  const dog = place(os, 1, PetKind.DOG, 4, 4);
  const cat = place(os, 2, PetKind.CAT, 5, 4);
  os.setPetDecider((pet) => (pet.kind === PetKind.DOG ? 'chase' : 'wander'));

  tick(os, 1);
  assert.equal(dog.state, PetState.SCUFFLE, 'no cloud to end');

  tick(os, PET_SCUFFLE_DURATION_SEC + 0.5);
  assert.notEqual(dog.state, PetState.SCUFFLE, 'the cloud never cleared');
  assert.notEqual(cat.state, PetState.SCUFFLE);
  assert.equal(dog.scufflePartnerId, null, 'a partner id outlived the cloud');
  assert.equal(cat.scufflePartnerId, null);

  // The cooldown is what stops the two falling into an endless loop of clouds on one tile. It holds
  // the HUNTER back only — the quarry may run at once, and that asymmetry is how it gets away.
  assert.ok(dog.chaseCooldown > 0, 'the dog may chase again immediately');
  assert.ok(cat.chaseCooldown > 0, 'both sides pause equally; only chasing is gated by it');
  assert.ok(dog.chaseCooldown <= PET_SCUFFLE_COOLDOWN_SEC);
});

test('a pet on cooldown is not offered a chase at all', () => {
  // The other half of the gate: the affordance the brain is handed. A hunter whose cooldown is
  // running must not even be ASKED to chase, or every decider has to remember the rule.
  const os = world();
  const dog = place(os, 1, PetKind.DOG, 4, 4);
  const cat = place(os, 2, PetKind.CAT, 6, 4);
  let offered: boolean | null = null;
  os.setPetDecider((pet, aff) => {
    if (pet.id === dog.id) offered ??= aff.canChase;
    return 'wander';
  });

  // Both pinned where they were placed, two tiles apart: a wandering pet walks off and then only
  // decides again after a pause of up to eight seconds, so without this the second half of the test
  // measures how far the dog wandered rather than what it was offered.
  const held = (seconds: number): void => {
    for (let i = 0; i < Math.round(seconds * 20); i++) {
      os.update(1 / 20);
      for (const [p, col] of [
        [dog, 4],
        [cat, 6],
      ] as const) {
        p.tileCol = col;
        p.tileRow = 4;
        p.state = PetState.IDLE;
        p.wanderTimer = 0;
        p.path = [];
      }
    }
  };

  dog.chaseCooldown = 5;
  held(1);
  assert.equal(offered, false, 'a dog still cooling down was offered the chase');

  dog.chaseCooldown = 0;
  offered = null;
  held(1);
  assert.equal(offered, true, 'and with the cooldown spent it is offered again');
});

test('a cloud never has one animal in it', () => {
  // The failure this guards is invisible on screen: the renderer needs BOTH ends to place a cloud,
  // so a pet left pointing at a partner that despawned would stand there drawn by nobody until its
  // lifespan ran out.
  const os = world();
  const dog = place(os, 1, PetKind.DOG, 4, 4);
  const cat = place(os, 2, PetKind.CAT, 5, 4);
  os.setPetDecider((pet) => (pet.kind === PetKind.DOG ? 'chase' : 'wander'));
  tick(os, 1);
  assert.equal(dog.state, PetState.SCUFFLE);

  // The cat leaves the world mid-scuffle (its lifespan ends, an admin removes it, a zone reloads).
  beginPetDespawn(cat, { releaseClaim: () => {} });
  tick(os, 0.2);

  assert.notEqual(dog.state, PetState.SCUFFLE, 'the dog is still in a cloud with a pet that left');
  assert.equal(dog.scufflePartnerId, null, 'a partner id points at a despawning pet');
});

test('a third animal does not join a pair', () => {
  // A scuffle is a PAIR — there is one partner id and nothing to point a third at. A second dog
  // finding an occupied cat has to wait, which is also the honest reading of the picture.
  const os = world();
  const dogA = place(os, 1, PetKind.DOG, 4, 4);
  const cat = place(os, 2, PetKind.CAT, 5, 4);
  const dogB = place(os, 3, PetKind.DOG, 5, 5);
  os.setPetDecider((pet) => (pet.kind === PetKind.DOG ? 'chase' : 'wander'));

  tick(os, 1);

  const inCloud = [dogA, cat, dogB].filter((p) => p.state === PetState.SCUFFLE);
  assert.equal(inCloud.length, 2, `expected exactly two animals in a cloud, got ${inCloud.length}`);
  assert.ok(inCloud.includes(cat), 'the cat is the quarry — it must be one of the two');
  // Whichever dog got there first, the pair points at itself and nobody else.
  const [a, b] = inCloud;
  assert.equal(a.scufflePartnerId, b.id);
  assert.equal(b.scufflePartnerId, a.id);
  assert.equal(dogB.state === PetState.SCUFFLE ? dogA.scufflePartnerId : dogB.scufflePartnerId, null);
});

test('the cloud has a winner, once for the pair, and the loser walks away', () => {
  // Nobody used to win: both animals left the cloud and got the cooldown. Now the outcome is
  // rolled ONCE when the cloud starts (PET_HUNTER_WIN_CHANCE, hunter-favoured) and stored on both
  // sides, so the two can never both believe they won — each ticks its own timer, and a roll per
  // pet at the end would produce exactly that.
  const os = world();
  const dog = place(os, 1, PetKind.DOG, 4, 4);
  const cat = place(os, 2, PetKind.CAT, 5, 4);
  os.setPetDecider((pet) => (pet.kind === PetKind.DOG ? 'chase' : 'wander'));

  tick(os, 1);
  assert.equal(dog.state, PetState.SCUFFLE, 'no cloud to win');
  assert.notEqual(dog.scuffleWon, cat.scuffleWon, 'both sides think the same thing about who won');

  // The cloud clears into the beat that shows it: one gloats, one cowers.
  tick(os, PET_SCUFFLE_DURATION_SEC + 0.2);
  const winner = dog.scuffleWon ? dog : cat;
  const loser = dog.scuffleWon ? cat : dog;
  assert.equal(winner.state, PetState.WIN);
  assert.equal(loser.state, PetState.LOSE);
  // Drawn from art that exists — and the pose must match what the state advances frames with.
  assert.equal(petPose(winner), 'talk');
  assert.equal(petPose(loser), 'sit');
  // The partner id is kept THROUGH the beat: the retreat below runs away from whoever won, which
  // is not the same question as "what does my species flee".
  assert.equal(loser.scufflePartnerId, winner.id);

  // Measured against WHERE THE FIGHT WAS, not against the winner: the winner is loose again the
  // moment the beat ends, its own chase is on cooldown so it wanders, pets do not block each other
  // — and it can wander straight onto the loser's tile. Asserting the gap between two moving
  // animals made this test fail about one run in three with "1 → 0", which said nothing about the
  // retreat and everything about the winner's random walk.
  const scene = { col: winner.tileCol, row: winner.tileRow };
  const distance = (): number =>
    Math.max(Math.abs(loser.tileCol - scene.col), Math.abs(loser.tileRow - scene.row));
  const before = distance();
  tick(os, PET_AFTERMATH_DURATION_SEC + 0.2);
  assert.equal(winner.state === PetState.WIN, false, 'the beat never ended');
  assert.equal(loser.state, PetState.WANDER, 'the loser did not walk away');
  assert.ok(loser.path.length > 0, 'it is walking, but to nowhere');
  assert.equal(loser.scufflePartnerId, null, 'a partner id outlived the pair');
  assert.ok(loser.chaseCooldown > 0 && winner.chaseCooldown > 0, 'both sides pause before chasing again');

  // The claim is the DIRECTION: away from whoever won. Deliberately not asserted as "no reaction"
  // — this pair is a dog and a cat, so one tick later the walking interrupt sees the cat's own
  // species hunter standing right there and turns the retreat into a proper flight. That is better
  // than the one-shot path, and it is why the assertion is about distance rather than about which
  // mechanism moved it.
  tick(os, 2);
  assert.ok(distance() > before, `the loser stayed put or came closer (${before} → ${distance()})`);
});

test('a loser retreats even when its species flees nothing of the sort', () => {
  // The case `fleeFrom` exists for, and the one the 'flee' reaction cannot serve: a cat that lost
  // to a BIRD. `fleesFrom('cat')` is ['dog'] — no bird is anywhere in it — so a species-driven
  // flight would find nobody and the loser would simply stand there beside the animal that just
  // beat it. Losing is about who beat you.
  const os = world();
  const cat = place(os, 1, PetKind.CAT, 6, 6);
  const bird = place(os, 2, PetKind.BIRD, 7, 6);
  os.setPetDecider((pet) => (pet.kind === PetKind.CAT ? 'chase' : 'wander'));
  tick(os, 1);
  assert.equal(cat.state, PetState.SCUFFLE, 'the cat never caught the bird');

  // Force the outcome rather than rolling for it: this test is about the retreat, and the odds are
  // pinned elsewhere. Both sides are set, exactly as beginScuffle does it.
  cat.scuffleWon = false;
  bird.scuffleWon = true;

  // Again against the SPOT, not the victor — see the note in the test above.
  const scene = { col: bird.tileCol, row: bird.tileRow };
  const distance = (): number => Math.max(Math.abs(cat.tileCol - scene.col), Math.abs(cat.tileRow - scene.row));
  const before = distance();
  tick(os, PET_SCUFFLE_DURATION_SEC + PET_AFTERMATH_DURATION_SEC + 2.2);
  assert.ok(distance() > before, `the beaten cat did not back off from the bird (${before} → ${distance()})`);
});

test('the hunter usually wins, and sometimes does not', () => {
  // A statistical claim, because a die is not an assertion: 400 clouds, and the observed rate has
  // to sit around PET_HUNTER_WIN_CHANCE rather than at 0, 1 or a half. What this pins is the thing
  // that was asked for — the winner must not always be the same animal.
  let hunterWins = 0;
  const ROUNDS = 400;
  for (let i = 0; i < ROUNDS; i++) {
    const os = world();
    const dog = place(os, 1, PetKind.DOG, 4, 4);
    const cat = place(os, 2, PetKind.CAT, 5, 4);
    os.setPetDecider((pet) => (pet.kind === PetKind.DOG ? 'chase' : 'wander'));
    tick(os, 1);
    assert.equal(dog.state, PetState.SCUFFLE, `round ${i}: no cloud`);
    if (dog.scuffleWon) hunterWins++;
    assert.notEqual(dog.scuffleWon, cat.scuffleWon, `round ${i}: both won`);
  }
  const rate = hunterWins / ROUNDS;
  // A wide band on purpose: this must fail when somebody makes the outcome certain or even, and
  // never because 400 coin flips landed unevenly. At p=0.6 the standard error is 2.4 points, so
  // ±10 is four sigma.
  assert.ok(
    rate > 0.5 && rate < 0.7,
    `the hunter won ${(rate * 100).toFixed(1)} % of ${ROUNDS} clouds; expected around ${PET_HUNTER_WIN_CHANCE * 100} %`,
  );
  assert.ok(hunterWins < ROUNDS, 'the hunter won every single one — the quarry can never win');
  assert.ok(hunterWins > 0, 'the hunter never won one');
});

test('an animal that just fought is off limits, to everybody, for the cooldown', () => {
  // The bug this closes, measured on a world with two dogs and one cat: 101 clouds in three
  // minutes, the partners alternating. The 12-second cooldown gated CHASING, and a cat hunts no
  // dogs — so the cat had no protection at all, and whenever one dog was cooling down the other was
  // free. The cooldown is an immunity for both roles now.
  const os = world();
  const dogA = place(os, 1, PetKind.DOG, 4, 4);
  const cat = place(os, 2, PetKind.CAT, 5, 4);
  const dogB = place(os, 3, PetKind.DOG, 6, 4);
  os.setPetDecider((pet) => (pet.kind === PetKind.DOG ? 'chase' : 'wander'));

  tick(os, 1);
  const first = [dogA, dogB].find((d) => d.state === PetState.SCUFFLE);
  assert.ok(first, 'neither dog caught the cat');
  const other = first === dogA ? dogB : dogA;
  assert.notEqual(other.state, PetState.SCUFFLE, 'both dogs got into the same cloud');

  // Through the cloud, the beat, and well past both — but not past the cooldown.
  tick(os, PET_SCUFFLE_DURATION_SEC + PET_AFTERMATH_DURATION_SEC + 3);
  assert.ok(cat.chaseCooldown > 0, 'the cat came out of the fight unprotected');
  assert.equal(cat.state === PetState.SCUFFLE, false, 'the other dog grabbed the cat straight away');

  // And it stays that way: the second dog is standing right there and keeps trying.
  tick(os, 20);
  assert.equal(cat.state === PetState.SCUFFLE, false, `the cat was caught again after ${20}s of immunity`);
  assert.ok(cat.chaseCooldown > 0, 'the immunity ran out far too early');

  // The protection is not just a refused catch: a protected quarry is invisible to the hunter's
  // INTENT, so no dog runs after a cat it cannot possibly catch.
  let offered: boolean | null = null;
  os.setPetDecider((pet, aff) => {
    if (pet.id === other.id) offered ??= aff.canChase;
    return 'wander';
  });
  // The dog is held ready to decide: left to itself it walks a wander path for seconds at a time
  // and is simply never asked, which leaves `offered` at null and says nothing either way.
  for (let i = 0; i < 60; i++) {
    os.update(1 / 20);
    other.state = PetState.IDLE;
    other.wanderTimer = 0;
    other.path = [];
    other.tileCol = cat.tileCol + 1;
    other.tileRow = cat.tileRow;
  }
  assert.equal(offered, false, 'a dog was offered a chase against a cat under immunity');
});

test('nobody grabs an animal during the beat', () => {
  // The other half of "fights that go on forever": the catch check skipped a quarry in `SCUFFLE`,
  // but during the 1.2-second beat the state is WIN or LOSE — so a second hunter could take the
  // loser while its badge was still up, and on the screen that looks exactly like somebody joining
  // the fight. It showed up in the numbers as clouds every 1-2 seconds against a cloud-plus-beat of
  // 2.7.
  const os = world();
  const dogA = place(os, 1, PetKind.DOG, 4, 4);
  const cat = place(os, 2, PetKind.CAT, 5, 4);
  const dogB = place(os, 3, PetKind.DOG, 5, 5);
  os.setPetDecider((pet) => (pet.kind === PetKind.DOG ? 'chase' : 'wander'));

  tick(os, 1);
  assert.equal(cat.state, PetState.SCUFFLE, 'no cloud to protect');
  const partner = cat.scufflePartnerId;

  // Into the beat, and watch it for its whole length: nobody's partner may change, and no third
  // animal may enter a cloud.
  tick(os, PET_SCUFFLE_DURATION_SEC + 0.2);
  assert.ok(stateOf(cat) === PetState.WIN || stateOf(cat) === PetState.LOSE, 'the beat never started');
  for (let i = 0; i < 20; i++) {
    tick(os, 0.05);
    if (stateOf(cat) !== PetState.WIN && stateOf(cat) !== PetState.LOSE) break;
    assert.equal(cat.scufflePartnerId, partner, 'the pair changed partners mid-beat');
    assert.notEqual(stateOf(dogB), PetState.SCUFFLE, 'a third animal started a cloud during the beat');
    assert.notEqual(stateOf(dogB), PetState.WIN);
    assert.notEqual(stateOf(dogB), PetState.LOSE);
  }
  assert.ok(dogA.chaseCooldown >= 0);
});

test('a fleeing animal does not double back', () => {
  // The "both of them running up and down" report. Every re-aim used to recompute the best escape
  // from scratch twice a second, and in a confined space the best answer alternates as the hunter
  // moves: measured in an 8x8 room, 21 reversals out of 21 samples, every single run. The heading
  // is remembered AND its exact opposite is refused, which makes the ping-pong impossible rather
  // than unlikely.
  const os = world();
  const cat = place(os, 1, PetKind.CAT, 8, 6);
  place(os, 2, PetKind.DOG, 9, 6); // east of the cat, so "away" is west …
  cat.fleeHeading = { dc: 1, dr: 0 }; // … but the cat is already running EAST
  os.setPetDecider((pet) => (pet.kind === PetKind.CAT ? 'flee' : 'sit'));

  tick(os, 0.1);
  assert.ok(cat.path.length > 0, 'the cat did not move at all');
  const firstStep = cat.path[0];
  assert.notEqual(
    `${firstStep.col},${firstStep.row}`,
    `${cat.tileCol - 1},${cat.tileRow}`,
    'the cat turned round on the spot, straight back through the direction it came from',
  );
  // It went somewhere, and somewhere is not backwards: north, south, or on east past the dog is
  // all fine — what is forbidden is the reversal.
  assert.ok(
    firstStep.row !== cat.tileRow || firstStep.col > cat.tileCol,
    `expected a sideways or forward step, got ${firstStep.col},${firstStep.row} from ${cat.tileCol},${cat.tileRow}`,
  );
});

test('the synced partner id can hold a pet id', () => {
  // The regression this file exists to keep: `scufflePartnerId` shipped as `uint16` and the live
  // world caught it within a minute. Pet ids start at 1 000 000, so a cat with id 1000007 reached
  // the client as 16967 — 1000007 mod 65536 — and since the renderer verifies that both ends name
  // each other, it drew no cloud at all. Nothing threw, nothing logged, and every test in this file
  // passed, because a test places pets with ids 1, 2 and 3.
  //
  // Asserted against the id space the ENGINE hands out, read from its own source, so raising
  // `nextPetId` past a field's capacity fails here instead of on somebody's screen.
  const CAPACITY: Record<string, number> = {
    uint8: 0xff,
    int8: 0x7f,
    uint16: 0xffff,
    int16: 0x7fff,
    uint32: 0xffffffff,
    int32: 0x7fffffff,
    number: Number.MAX_SAFE_INTEGER,
  };
  const meta = (PetSync as never as Record<symbol, unknown>)[Symbol.metadata] as Record<string, { name?: string; type?: unknown }>;
  assert.ok(meta, 'PetSync carries no schema metadata — did @colyseus/schema change how it stores types?');
  const declared = Object.fromEntries(
    Object.entries(meta)
      .filter(([, d]) => d && typeof d === 'object' && 'type' in d)
      .map(([k, d]) => [String(d.name ?? k), String(d.type)]),
  );

  const engineSrc = readFileSync(
    join(import.meta.dirname, '..', '..', 'shared', 'src', 'office', 'engine', 'officeState.ts'),
    'utf8',
  );
  const firstId = Number(/nextPetId\s*=\s*([0-9_]+)/.exec(engineSrc)?.[1]?.replace(/_/g, ''));
  assert.ok(Number.isFinite(firstId) && firstId > 0, 'could not read nextPetId out of the engine');

  const type = declared.scufflePartnerId;
  assert.ok(type, 'scufflePartnerId is not a synced field any more');
  assert.ok(
    CAPACITY[type] > firstId,
    `scufflePartnerId is ${type} (max ${CAPACITY[type]}) but pet ids start at ${firstId}: a partner ` +
      `id would arrive truncated, both ends would stop naming each other, and no cloud would be drawn`,
  );
});

test('the catch radius counts diagonals, and only reaches one tile', () => {
  // Chebyshev, deliberately: two pets corner to corner look adjacent, and a cloud between them
  // reads right. Two tiles apart it must NOT fire, or the cloud appears with a gap in the middle.
  assert.equal(PET_CATCH_RADIUS_TILES, 1);

  const caught = (dc: number, dr: number): boolean => {
    const os = world();
    const dog = place(os, 1, PetKind.DOG, 6, 6);
    const cat = place(os, 2, PetKind.CAT, 6 + dc, 6 + dr);
    os.setPetDecider((pet) => (pet.kind === PetKind.DOG ? 'chase' : 'sit'));
    // BOTH pinned, so the distance is the only variable. Pinning only the hunter made this test
    // fail about one run in five, and for two opposite reasons: a pet walks 2.5 tiles per second,
    // so in one second the quarry can leave a radius it started inside (a catch that should happen
    // does not) or wander into one it started outside (a catch that should not happen does). Its
    // 'sit' decision falls through to a random wander here, because the map has no furniture.
    for (let i = 0; i < 20; i++) {
      os.update(1 / 20);
      for (const [pet, col, row] of [
        [dog, 6, 6],
        [cat, 6 + dc, 6 + dr],
      ] as const) {
        pet.tileCol = col;
        pet.tileRow = row;
      }
    }
    return dog.state === PetState.SCUFFLE;
  };

  assert.equal(caught(1, 0), true, 'orthogonally adjacent is a catch');
  assert.equal(caught(1, 1), true, 'and so is corner to corner');
  assert.equal(caught(2, 0), false, 'two tiles apart is not — the cloud would have a gap in it');
});
