/**
 * Who hunts whom is one table, and fleeing is that table read backwards.
 *
 * It used to be four words in two engine methods: `pet.kind === DOG` beside
 * `nearestLivingPetOfKind(pet, CAT)` for chasing, and the mirror image for fleeing, plus the same
 * two species named a third and fourth time in the editor's labels. Two things followed. A duck had
 * no relation at all — not as a decision, but because `DUCK` appears in none of those lines. And
 * the two halves were independent data, so the world could be configured into a state that does not
 * exist: a dog that hunts a cat which has not noticed.
 *
 * `CHASES` states the relation once and `fleesFrom` derives the other half, which is what these
 * tests are about:
 *
 *  1. The table says what it says, and the derivation is the inverse MINUS what hunts back — so a
 *     mutual pairing leaves nobody fleeing. That is not a curiosity: it is how a confrontation
 *     becomes expressible at all, and where a scuffle would go.
 *  2. The engine reads only the table. Nothing in the affordances names a species, so a duck's
 *     empty relation and a dog's cat come out of the same code path.
 *  3. A pet saved before the rename keeps its settings. `chaseCats`/`fleeDogs`/`drink` are read as
 *     `chase`/`flee`/`feedDrink`, because the alternative is every configured animal silently
 *     reverting to all-on.
 *
 * TEST BOUNDARIES:
 *   @real-dependency: OfficeState over a hand-built layout -- Mock? NO. The claim in (2) is about
 *       what the engine does with the table, and a stub of the engine would test my belief about
 *       it. No furniture is placed: chase and flee need nothing but two animals and a floor.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';

import { OfficeState } from '@pixel/shared/office/engine/officeState.js';
import { createPet, type PetAffordances } from '@pixel/shared/office/engine/pets.js';
import { resolvePetConfig } from '@pixel/shared/office/sprites/characterSpec.js';
import { CHASES, chases, fleesFrom, PetKind, PetState, type Pet } from '@pixel/shared/office/types';

test('the table states the relation and nothing states the reverse', () => {
  assert.deepEqual(CHASES[PetKind.DOG], ['cat'], 'a dog hunts cats');
  assert.deepEqual(CHASES[PetKind.CAT], [], 'a cat hunts nothing yet — a bird is a species this world lacks');
  assert.deepEqual(CHASES[PetKind.DUCK], [], 'nothing hunts as a duck');

  // Derived, not stored. These four are the whole of today's shoo-cat behaviour, and none of them
  // is written down anywhere.
  assert.deepEqual(fleesFrom(PetKind.CAT), ['dog'], 'a cat runs from dogs because dogs hunt cats');
  assert.deepEqual(fleesFrom(PetKind.DOG), [], 'nothing hunts a dog, so a dog runs from nothing');
  assert.deepEqual(fleesFrom(PetKind.DUCK), [], 'a duck is hunted by nobody');

  assert.equal(chases(PetKind.DOG, PetKind.CAT), true);
  assert.equal(chases(PetKind.CAT, PetKind.DOG), false, 'the relation is one-directional unless stated twice');
  assert.equal(chases(PetKind.DOG, PetKind.DOG), false, 'nothing hunts its own kind');
});

test('a mutual pairing leaves nobody fleeing', () => {
  // The case the derivation exists for. Written against a hypothetical table rather than the live
  // one, because it is a property of the rule and must hold before anyone edits CHASES.
  const mutual = { dog: ['cat'], cat: ['dog'], duck: [] } as unknown as typeof CHASES;
  assert.deepEqual(fleesFrom(PetKind.CAT, mutual), [], 'a cat that hunts back does not flee');
  assert.deepEqual(fleesFrom(PetKind.DOG, mutual), [], 'and neither does the dog');
  // Both still hunt, so the two walk toward each other instead of one shoving the other into a
  // corner forever. That meeting is the thing a scuffle animation would resolve.
  assert.equal(chases(PetKind.DOG, PetKind.CAT, mutual) && chases(PetKind.CAT, PetKind.DOG, mutual), true);

  // A one-sided addition still produces a fleeing side, so the subtraction is not just "always []".
  const withBirds = { dog: ['cat'], cat: ['duck'], duck: [] } as unknown as typeof CHASES;
  assert.deepEqual(fleesFrom(PetKind.DUCK, withBirds), ['cat'], 'a new pairing needs one word, on one side');
});

test('the table is well formed: no kind hunts itself and every quarry exists', () => {
  // Cheap, and it is the check that catches a typo in a table whose whole purpose is to be edited.
  const known = new Set<string>(Object.values(PetKind));
  for (const [hunter, quarry] of Object.entries(CHASES)) {
    assert.ok(known.has(hunter), `CHASES has a row for '${hunter}', which is not a PetKind`);
    assert.equal(new Set(quarry).size, quarry.length, `${hunter} names a quarry twice`);
    for (const q of quarry) {
      assert.ok(known.has(q), `${hunter} hunts '${q}', which is not a PetKind`);
      assert.notEqual(q, hunter, `${hunter} hunts its own kind`);
    }
  }
  for (const kind of Object.values(PetKind)) {
    assert.ok(CHASES[kind] !== undefined, `${kind} has no row — an absent row and an empty one must not differ`);
  }
});

test('the engine resolves chase and flee from the table alone', () => {
  // Two pets, one tile apart, and the affordances each one's brain is handed. Nothing in
  // computePetAffordances names a species any more, so this is the same code path for all three
  // kinds — which is what makes the duck's answer evidence rather than a coincidence.
  const seen = (kinds: Array<[number, PetKind]>, apart = 1): Map<number, PetAffordances> => {
    const cols = 32;
    const os = new OfficeState({
      cols,
      rows: 8,
      tiles: new Array(cols * 8).fill(1),
      walls: { horizontal: [], vertical: [] },
      furniture: [],
    } as never);
    kinds.forEach(([id, kind], i) => {
      const pet = createPet(id, kind, 0, { col: 2 + i * apart, row: 4 });
      // Past the fade-in, and with the random wander pause spent. Both matter, and the second one
      // is why this test was flaky at first: `nearestLivingPetOfKinds` skips a pet still in SPAWN,
      // and `createPet` gives each animal a RANDOM first pause — so whoever happened to decide
      // first saw the other one as not there yet, and the assertion failed about half the time.
      // Pinning both means the two decide on the same tick, with each other visible.
      pet.state = PetState.IDLE;
      pet.effect = null;
      pet.wanderTimer = 0;
      os.pets.set(id, pet);
    });
    const out = new Map<number, PetAffordances>();
    os.setPetDecider((pet, aff) => {
      if (!out.has(pet.id)) out.set(pet.id, aff);
      return 'wander'; // whatever it does next is not the claim; the affordance it was handed is
    });
    for (let i = 0; i < 200 && out.size < kinds.length; i++) os.update(1 / 20);
    assert.equal(out.size, kinds.length, 'not every pet asked its brain for a decision');
    return out;
  };

  const dogCat = seen([
    [1, PetKind.DOG],
    [2, PetKind.CAT],
  ]);
  assert.equal(dogCat.get(1)!.canChase, true, 'a dog beside a cat is not offered the chase');
  assert.equal(dogCat.get(1)!.threatened, false, 'nothing hunts a dog');
  assert.equal(dogCat.get(2)!.threatened, true, 'a cat beside a dog does not know it is prey');
  assert.equal(dogCat.get(2)!.canChase, false, 'a cat hunts nothing today');

  // A duck is the case the hardcoded version could not express: it is neither, and it is neither
  // for the same reason the dog IS — an empty row in the table.
  const duckPair = seen([
    [1, PetKind.DUCK],
    [2, PetKind.DOG],
  ]);
  assert.equal(duckPair.get(1)!.canChase, false, 'a duck hunts nothing');
  assert.equal(duckPair.get(1)!.threatened, false, 'and a dog does not hunt ducks, so it is not prey either');
  assert.equal(duckPair.get(2)!.canChase, false, 'a dog beside a duck has nothing to chase');

  // And distance still matters — the relation says WHO, the radius says whether. 28 tiles apart,
  // against PET_SHOO_RADIUS_TILES = 5.
  const far = seen(
    [
      [1, PetKind.DOG],
      [2, PetKind.CAT],
    ],
    28,
  );
  assert.equal(far.get(1)!.canChase, false, 'a dog across the map is offered a chase it cannot see');
  assert.equal(far.get(2)!.threatened, false, 'and the cat there has nothing to fear');
});

test('a walking pet notices what it passes, and a sitting one is left in peace', () => {
  // The complaint this answers: Emma and a cat walked straight past each other. A pet used to look
  // for a quarry only at its own decision points, and those are PET_WANDER_PAUSE_MIN..MAX apart
  // (1.5-8 s, and a sit is 8-25 s) — at 2.5 tiles per second the other animal is out of the
  // five-tile radius long before the next look. So a WALKING pet now checks on the same cadence it
  // re-aims with, and both roles get it: whoever notices sooner closes distance sooner, and only
  // geometry is meant to decide a chase.
  const world = (): OfficeState => {
    const cols = 40;
    return new OfficeState({
      cols,
      rows: 8,
      tiles: new Array(cols * 8).fill(1),
      walls: { horizontal: [], vertical: [] },
      furniture: [],
    } as never);
  };
  const start = (os: OfficeState, id: number, kind: PetKind, col: number, row: number): Pet => {
    const pet = createPet(id, kind, 0, { col, row });
    pet.state = PetState.IDLE;
    pet.effect = null;
    pet.wanderTimer = 999; // stand still unless this test says otherwise
    os.pets.set(id, pet);
    return pet;
  };
  /**
   * Put a pet on a walk along its row, without going through a decision.
   *
   * Deliberately not "let it decide to wander": that picks a RANDOM target, and a roll that lands
   * on the pet's own tile leaves it idling for up to eight seconds — which made the first version
   * of this test fail about one run in three for a reason that had nothing to do with the claim.
   * The claim is about a pet that IS walking.
   */
  const sendWalking = (pet: Pet, toCol: number): void => {
    pet.state = PetState.WANDER;
    pet.path = [];
    for (let c = pet.tileCol + Math.sign(toCol - pet.tileCol); ; c += Math.sign(toCol - pet.tileCol)) {
      pet.path.push({ col: c, row: pet.tileRow });
      if (c === toCol) break;
    }
    pet.moveProgress = 0;
  };

  // A dog told to WANDER — so the decision point itself never offers a chase; the interrupt is the
  // only thing that can start one.
  const os = world();
  const dog = start(os, 1, PetKind.DOG, 4, 4);
  start(os, 2, PetKind.CAT, 7, 4); // held still: this is about the dog noticing
  os.setPetDecider(() => 'wander');
  sendWalking(dog, 30); // off across the map, straight past the cat
  for (let i = 0; i < 40 && dog.reaction === null; i++) os.update(1 / 20);

  assert.equal(dog.reaction, 'chase', 'a dog walking three tiles from a cat never looked up');
  assert.ok(dog.path.length > 0, 'it noticed the cat but has no path to it');

  // The mirror, and the reason it is not optional: if only the hunter noticed mid-walk, the hunter
  // would effectively be faster, which is the one thing this design refuses.
  const os2 = world();
  const cat2 = start(os2, 1, PetKind.CAT, 20, 4);
  const dog2 = start(os2, 2, PetKind.DOG, 23, 4);
  os2.setPetDecider(() => 'wander');
  sendWalking(cat2, 2);
  for (let i = 0; i < 40 && cat2.reaction === null; i++) os2.update(1 / 20);
  assert.equal(cat2.reaction, 'flee', 'a cat walking past a dog did not bolt');
  assert.equal(dog2.reaction, null, 'the pinned dog should not have moved at all here');

  // And the exception that was asked for by name: a SITTING animal keeps sitting. A dog that shoots
  // out of a nap because a cat passed three tiles away is a different world.
  const os3 = world();
  const napping = start(os3, 1, PetKind.DOG, 4, 4);
  napping.state = PetState.SIT;
  napping.sitTimer = 60;
  start(os3, 2, PetKind.CAT, 6, 4);
  os3.setPetDecider(() => 'wander');
  for (let i = 0; i < 60; i++) os3.update(1 / 20);
  assert.equal(napping.state, PetState.SIT, 'the napping dog got up');
  assert.equal(napping.reaction, null, 'a sitting pet must not take up a chase');
});

test('a pet saved before the rename keeps its switches', () => {
  // The read path that makes the rename free. Nothing writes the old names any more, so this is the
  // only thing standing between a stored animal and a silent reset to all-on.
  const legacy = resolvePetConfig({
    active: true,
    minSec: 60,
    maxSec: 180,
    maxConcurrent: 1,
    behaviors: { rest: false, chaseCats: false, fleeDogs: false, drink: false, talk: false },
  });
  assert.deepEqual(legacy.behaviors, { rest: false, chase: false, flee: false, feedDrink: false, talk: false });

  // The current names win where both are present, and a missing switch is still on by default.
  const both = resolvePetConfig({ behaviors: { chase: true, chaseCats: false, drink: false } });
  assert.equal(both.behaviors.chase, true, 'the current name decides');
  assert.equal(both.behaviors.feedDrink, false, 'and the old one is still honoured where it is alone');
  assert.equal(both.behaviors.talk, true, 'an absent switch defaults on, as it always did');

  // The switch is a permission, not the relation: it cannot make a duck hunt.
  assert.equal(resolvePetConfig({}).behaviors.chase, true);
  assert.deepEqual(CHASES[PetKind.DUCK], [], 'an all-on duck still hunts nothing');
});
