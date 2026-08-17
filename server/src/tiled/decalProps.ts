/**
 * The decal properties, defined once — the decal counterpart of
 * furnitureProps.ts next door.
 *
 * A **decal** is map art and nothing else: a tile painted on a `DecalLayer`
 * (see mapBridge.ts) that draws and is never anything more. It has no synced
 * object, no occupancy, no action, no on/off state, and it does not block — a
 * decal that should stop movement is painted into the `CollisionLayer` as well.
 * That is the whole point: a map may paint thousands of ground patches without
 * growing thousands of FurnitureSync objects, because a decal rides along in the
 * layout (one `layoutLoaded`) rather than in the synced schema.
 *
 * ── Why a decal TILE says almost nothing ──
 *
 * There is exactly one thing to decide about a decal beyond which picture it is:
 * whether it lies flat (characters walk over it) or stands (a character behind it
 * is hidden). That decision does NOT live here, on the tile — it lives on the
 * **layer**, as the `occludes` property of the `DecalLayer` class:
 *
 *   a layer with occludes = false → everything painted on it lies flat
 *   a layer with occludes = true  → everything painted on it stands
 *
 * Deliberately so. Whether a given picture is background or an obstacle is a
 * property of the PLACE, not of the art: the same tree is scenery on a far
 * hillside and an obstacle beside the path. Tying it to the tile would force one
 * answer for the whole map, and a tile-layer cell has nowhere to carry an
 * override. Putting it on the layer gives a per-placement answer that is visible
 * in the Layers panel — you move a cell between layers to change its mind —
 * and a map may carry as many decal layers as it likes (see mapBridge.ts, which
 * reads all of them).
 *
 * This is why the list below has no behaviour in it at all, and why furniture art
 * painted on a decal layer works exactly as well as art from decal.tsj: nothing
 * is read off the tile that a FurnitureTile could not also answer.
 */

/** The layer property that decides how everything on that layer sorts — see the
 *  header, and DecalLayer in Pixels.tiled-project. Absent/false = lies flat. */
export const DECAL_LAYER_OCCLUDES = 'occludes';

/**
 * Every property a DecalTile carries, with its default. Written onto every decal
 * tile, defaults included, for the same reason furniture tiles carry their full
 * set: a property a mapper has to remember to add is a property they will forget.
 */
export const DECAL_TILE_PROPS: ReadonlyArray<{
  name: string;
  default: string | number | boolean;
  propertyType?: string;
}> = [{ name: 'label', default: '' }];
