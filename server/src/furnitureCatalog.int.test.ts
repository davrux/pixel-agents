/**
 * Every behaviour a furniture TILE states must survive into the runtime catalog.
 *
 * This exists because one of them did not. `canWalkOver` was added to the tiles,
 * the sync script, the collision computation and the renderer — but not to
 * `buildDynamicCatalog`'s field-by-field mapping, and the asset type it maps from
 * was missing the field too, so nothing failed to compile. The symptom reached a
 * mapper rather than a test: a rug dragged in from the Tilesets panel showed
 * `canWalkOver: true` (Tiled displays the tile's own properties) and still blocked
 * movement, because only a placement that spelled the override out was read.
 * Toggling the checkbox off and on "fixed" the rug by writing exactly that.
 *
 * So this asserts the *contract* rather than that one property: whatever
 * `furnitureBehaviourFromTile` can read off a tile has to be visible through
 * `getCatalogEntry`. A new property added to FURNITURE_TILE_PROPS and forgotten
 * in the mapping fails here.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';

import { buildDynamicCatalog, getCatalogEntry } from '@pixel/shared/office/layout/furnitureCatalog';

import { buildFurnitureCatalogAndSprites } from './assets.js';
import { furnitureBehaviourFromTile } from './tiled/furnitureProps.js';

/** The behaviour keys a tile can state, from the one function that reads them. */
const BEHAVIOUR_KEYS = Object.keys(
  furnitureBehaviourFromTile({
    canSitOn: true,
    sitFacing: 'N',
    petCanSitOn: true,
    canWalkOver: true,
    backgroundTiles: 1,
    onState: 'SOMETHING_ON',
  }),
) as Array<'canSitOn' | 'sitFacing' | 'petCanSitOn' | 'canWalkOver' | 'backgroundTiles' | 'onState'>;

test('every behaviour a tile states survives into the runtime catalog', async () => {
  const built = await buildFurnitureCatalogAndSprites();
  assert.ok(built.loaded, 'furniture tilesets did not load');
  assert.ok(buildDynamicCatalog(built as never), 'catalog was not built');

  const assets = built.catalog as Array<Record<string, unknown> & { id: string }>;
  assert.ok(assets.length > 100, `expected a real catalog, got ${assets.length} assets`);

  // Sanity: the reader must actually produce each key somewhere in the real
  // tilesets, or this test would pass by having nothing to check.
  for (const key of BEHAVIOUR_KEYS) {
    const stated = assets.filter((a) => a[key] !== undefined);
    assert.ok(stated.length > 0, `no tile in the tilesets states ${key} — nothing to verify`);

    const lost = stated.filter((a) => {
      const entry = getCatalogEntry(a.id) as Record<string, unknown> | undefined;
      return !entry || entry[key] !== a[key];
    });
    assert.equal(
      lost.length,
      0,
      `${key} is dropped between the tileset reader and the catalog for ${lost.length}/${stated.length} tiles ` +
        `(e.g. ${lost[0]?.id}) — add it to buildDynamicCatalog's mapping and to LoadedAssetData`,
    );
  }
});

test('a rug is walkable from its tile alone, with no per-placement override', async () => {
  const built = await buildFurnitureCatalogAndSprites();
  buildDynamicCatalog(built as never);
  const { resolveCanWalkOver } = await import('@pixel/shared/office/layout/furnitureCatalog');

  const rugs = (built.catalog as Array<Record<string, unknown> & { id: string }>).filter(
    (a) => a.canWalkOver === true,
  );
  assert.ok(rugs.length > 0, 'no tile states canWalkOver — the fixture is gone');
  for (const rug of rugs) {
    const entry = getCatalogEntry(rug.id);
    // An empty placement: exactly what dragging a tile out of the Tilesets panel
    // produces — a gid and nothing else.
    const placement = { uid: 'x', id: rug.id, col: 0, row: 0 };
    assert.equal(resolveCanWalkOver(placement, entry), true, `${rug.id} does not resolve walkable`);
  }
});
