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
import { CHASES, chases, fleesFrom, PetKind, PetState } from '@pixel/shared/office/types';

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
