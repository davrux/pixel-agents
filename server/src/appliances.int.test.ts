/**
 * Each side uses its own appliance, and only if the map has one.
 *
 * An agent goes to a coffee machine; a pet goes to a water bowl; neither touches the other's, and
 * where the map has none of its kind, it simply never goes. That is the whole rule, and it replaced
 * a lookup that filtered by NOTHING: both `findFreeStation` (agents) and the `'drink'` branch of
 * `findFreePetTarget` (pets) walked every entry in `points` — which holds seats as well as
 * appliance stand tiles. So an agent on a coffee break could march to a free desk chair and stand
 * on it, and a "drinking" pet could claim the coffee machine, blocking an agent out of it for four
 * to nine seconds with nothing on screen to explain why. Neither had a test, and neither looks
 * broken from the outside — the animal stands somewhere, which is what animals do.
 *
 * The fix is one condition, `point.appliance === kind`, and it does two jobs: it picks the right
 * kind, and it excludes seats by construction, because a seat carries no appliance at all. These
 * tests are written against that: what the POINTS say, since that is what both lookups read.
 *
 * TEST BOUNDARIES:
 *   @real-dependency: OfficeState + the real furniture catalog -- Mock? NO. Whether a placement
 *       yields an appliance stand point is a fact about the catalog entry and `effectiveAction`; a
 *       stub would test my assumption about them. The water bowl is an ACTION OVERRIDE on an
 *       ordinary placement rather than new art, which is also how a mapper would prototype one.
 */
import { strict as assert } from 'node:assert';
import test, { before } from 'node:test';

import { buildDynamicCatalog, getCatalogEntry } from '@pixel/shared/office/layout/furnitureCatalog';
import { OfficeState } from '@pixel/shared/office/engine/officeState.js';
import { createPet, type PetAffordances } from '@pixel/shared/office/engine/pets.js';
import { APPLIANCES, APPLIANCES_FOR, PetKind, TILE_SIZE } from '@pixel/shared/office/types';

import { buildFurnitureCatalogAndSprites } from './assets.js';

before(async () => {
  buildDynamicCatalog((await buildFurnitureCatalogAndSprites()) as never);
});

/** One placement of `id`, with an optional Action override (how a bowl exists without new art). */
function place(id: string, col: number, row: number, action?: unknown): Record<string, unknown> {
  const entry = getCatalogEntry(id);
  assert.ok(entry, `${id} is not in the catalog`);
  return {
    uid: `${id}-${col}-${row}`,
    id,
    col,
    row,
    x: col * TILE_SIZE,
    y: row * TILE_SIZE,
    width: entry.width,
    height: entry.height,
    ...(action ? { action } : {}),
  };
}

/**
 * A walkable map with `furniture` on it.
 *
 * `walls` is a WallEdges pair, not `[]`. The other engine tests get away with an array because
 * they never place an appliance, and an appliance is what reaches `computeApproachTiles` →
 * `wallOnNorthEdge`, which guards `!walls` but then reads `walls.horizontal` — truthy and wrong
 * throws where absent would have been fine.
 */
const world = (furniture: Array<Record<string, unknown>>, cols = 16, rows = 16) =>
  new OfficeState({
    cols,
    rows,
    tiles: new Array(cols * rows).fill(1),
    walls: { horizontal: [], vertical: [] },
    furniture,
  } as never);

/** Appliance kinds among the points, counted. Seats contribute `none`. */
function kinds(os: OfficeState): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of os.points.values()) {
    const k = p.appliance ?? `none(${p.posture})`;
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

test('a coffee machine yields coffee stand points, and a seat yields none', () => {
  const os = world([place('COFFEE_MACHINE', 4, 4), place('SOFA_BACK', 8, 8)]);
  const k = kinds(os);
  assert.ok((k.coffee ?? 0) > 0, `no coffee stand point was built: ${JSON.stringify(k)}`);
  assert.equal(k.pet_feed ?? 0, 0, 'a coffee machine must not offer feeding');
  // The seats are still there and still carry no appliance — which is exactly what keeps a
  // coffee break off them now that the lookup asks for a kind.
  for (const p of os.points.values()) {
    if (p.posture === 'sit') assert.equal(p.appliance, undefined, 'a seat must never carry an appliance kind');
  }
});

test('an appliance declared as a bowl yields pet_feed points and no coffee', () => {
  // What a bowl is, mechanically: any placement whose own Action says `appliance` with pose
  // `water`. The furniture art can follow later; the semantics do not depend on it.
  const os = world([place('SOFA_BACK', 4, 4, { kind: 'appliance', pose: 'pet_feed' })]);
  const k = kinds(os);
  assert.ok((k.pet_feed ?? 0) > 0, `no bowl stand point was built: ${JSON.stringify(k)}`);
  assert.equal(k.coffee ?? 0, 0, 'a bowl must not offer coffee');
});

test('a pet may drink only when a bowl exists, never because a coffee machine does', () => {
  // The decisive one, and the observable is the affordance the pet's brain is handed.
  const affordancesFor = (furniture: Array<Record<string, unknown>>): PetAffordances => {
    const os = world(furniture);
    os.pets.set(1, createPet(1, PetKind.DOG, 0, { col: 2, row: 2 }));
    let seen: PetAffordances | null = null;
    os.setPetDecider((_pet, aff) => {
      seen = aff;
      return 'wander';
    });
    // Enough ticks for the pet to leave SPAWN and reach an idle decision.
    for (let i = 0; i < 200 && seen === null; i++) os.update(1 / 20);
    assert.ok(seen, 'the pet never asked its brain for a decision');
    return seen;
  };

  assert.equal(
    affordancesFor([place('COFFEE_MACHINE', 6, 6)]).canDrink,
    false,
    'a pet was offered the coffee machine — that is the behaviour this rule exists to stop',
  );
  assert.equal(affordancesFor([place('SOFA_BACK', 6, 6)]).canDrink, false, 'a seat is not a drink target');
  assert.equal(
    affordancesFor([place('SOFA_BACK', 6, 6, { kind: 'appliance', pose: 'pet_feed' })]).canDrink,
    true,
    'a bowl is placed and the pet still cannot use it',
  );
  assert.equal(affordancesFor([]).canDrink, false, 'no appliance at all, no visit');
  // A fountain is the one both sides may use, so a pet takes it as readily as a bowl.
  assert.equal(
    affordancesFor([place('SOFA_BACK', 6, 6, { kind: 'appliance', pose: 'drink' })]).canDrink,
    true,
    'a fountain is open to pets as well',
  );
});

test('the usage matrix is the one thing that decides who may go where', () => {
  // Spelled out, because the whole point of the three kinds is that this table is not implicit.
  // A bowl is named for whom it feeds rather than for the action: drinking is not a pet thing —
  // anyone can use a fountain — and a bowl is the only one of the three that is species-specific.
  assert.deepEqual(APPLIANCES_FOR.character, ['coffee', 'drink'], 'a character never eats from a bowl');
  assert.deepEqual(APPLIANCES_FOR.pet, ['drink', 'pet_feed'], 'a pet never uses the coffee machine');
  // And what you DO there comes from the appliance, not from who you are.
  assert.equal(APPLIANCES.coffee.pose, 'coffee');
  assert.equal(APPLIANCES.drink.pose, 'drink');
  assert.equal(APPLIANCES.pet_feed.pose, 'feed');
});
