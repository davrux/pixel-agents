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
  PET_CATCH_RADIUS_TILES,
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
