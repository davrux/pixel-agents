/**
 * Reads the furniture catalog straight from Tiled tileset JSON files
 * (assets/tiled/furniture-*.tsj) — the source of truth this migrated to from
 * the old assets/furniture/<TYPE>/manifest.json tree (see
 * scripts/migrate-furniture-to-tiled.mjs and docs/design/tiled-editor-integration.md).
 * No export/import round-trip: the .tsj on disk IS the catalog data.
 *
 * Custom per-tile properties (all optional besides `type`):
 *   type            (string) catalog id — required
 *   label           (string) display name
 *   backgroundTiles (int)    see FurnitureCatalogEntry.backgroundTiles
 *   occupiesSurface (bool)   see FurnitureCatalogEntry.occupiesSurface
 *   mirrorSide      (bool)   produces a virtual ":left" flipped clone
 *   orientation     (string) only 'side' has any effect (triggers the clone above)
 *   stateGroup      (string) shared id linking an on/off pair
 *   state           (string) 'on' | 'off' — needs a matching stateGroup pair
 *   onTrigger       (string) 'autoFacing' | 'click' — what flips the pair
 *   appliance       (string) interaction station kind, e.g. 'coffee'
 *
 * Animation is NOT a custom property — a tile's native Tiled `<animation>`
 * (its own frame plus any following ones, each naming a sibling tile's id in
 * the SAME tileset) becomes the frame-0 entry's animationGroup/frame/durationMs,
 * exactly the shape shared/src/office/layout/furnitureCatalog.ts already reads.
 */
import type { FurnitureAsset } from './manifestUtils.js';

interface TiledProperty {
  name: string;
  type?: string;
  value: string | number | boolean;
}

interface TiledAnimationFrame {
  tileid: number;
  duration: number;
}

interface TiledTile {
  id: number;
  image: string;
  imagewidth: number;
  imageheight: number;
  properties?: TiledProperty[];
  animation?: TiledAnimationFrame[];
}

export interface TiledTilesetJson {
  name?: string;
  tiles: TiledTile[];
}

const TILE_SIZE = 16;

/** Nominal grid size (px) → footprint (tiles), same rounding-and-clamp rule
 *  as the client's own tileset importer (client/src/editor/tilesetImport.ts's
 *  footprintOf) — every current furniture PNG lands on an exact multiple of
 *  TILE_SIZE, but hand-authored art might not, hence the round+clamp. */
function footprintOf(px: number): number {
  return Math.min(16, Math.max(1, Math.round(px / TILE_SIZE)));
}

function propsOf(tile: TiledTile): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const p of tile.properties ?? []) out[p.name] = p.value;
  return out;
}

/** One tileset file's tiles → FurnitureAsset[] + which PNG (relative to the
 *  tileset's own directory) each id needs. `category` comes from the
 *  filename (see FURNITURE_CATEGORY_FILES), not a per-tile property — one
 *  Tiled tileset FILE per category, mirroring the curated category tabs. */
export function parseFurnitureTileset(
  json: TiledTilesetJson,
  category: string,
): Array<{ asset: FurnitureAsset; imagePath: string }> {
  const byId = new Map(json.tiles.map((t) => [t.id, t]));
  // A tile referenced ONLY as a later frame of another tile's <animation> is
  // a component, not a placeable item of its own — the anchor tile's own
  // animation loop below already emits its FurnitureAsset (with the right
  // frame/durationMs/animationGroup); visiting it again at the top level
  // would double it up as a second, non-animated entry (matches the client
  // importer's frameComponentIds, client/src/editor/tilesetImport.ts).
  const frameComponentIds = new Set<number>();
  for (const t of json.tiles) {
    for (const f of t.animation ?? []) frameComponentIds.add(f.tileid);
  }

  const out: Array<{ asset: FurnitureAsset; imagePath: string }> = [];
  for (const tile of json.tiles) {
    const anim = tile.animation;
    if (!anim && frameComponentIds.has(tile.id)) continue;
    const props = propsOf(tile);
    const type = typeof props.type === 'string' ? props.type : undefined;
    if (!type) {
      console.warn(`[tiledFurniture] Skipping tile ${tile.id} in "${json.name}" — missing "type" property`);
      continue;
    }
    const stateGroup = typeof props.stateGroup === 'string' ? props.stateGroup : undefined;
    // Only the frame-0 tile of an animation carries the <animation> block —
    // build one FurnitureAsset per frame (the sibling tiles, resolved by id),
    // each with its own frame/durationMs but ALL sharing one animationGroup
    // id (the anchor's own type — a frame's OWN type would give every frame
    // a distinct group of one, since ids differ per frame).
    if (anim && anim.length > 0) {
      for (let frame = 0; frame < anim.length; frame++) {
        const fr = anim[frame];
        const frameTile = byId.get(fr.tileid);
        if (!frameTile) continue;
        const frameProps = propsOf(frameTile);
        const frameType = typeof frameProps.type === 'string' ? frameProps.type : undefined;
        if (!frameType) continue;
        out.push({
          asset: buildAsset(frameTile, frameProps, frameType, category, stateGroup, { groupId: type, frame, durationMs: fr.duration }),
          imagePath: frameTile.image,
        });
      }
      continue;
    }
    out.push({ asset: buildAsset(tile, props, type, category, stateGroup, undefined), imagePath: tile.image });
  }
  return out;
}

function buildAsset(
  tile: TiledTile,
  props: Record<string, string | number | boolean>,
  type: string,
  category: string,
  stateGroup: string | undefined,
  anim: { groupId: string; frame: number; durationMs: number } | undefined,
): FurnitureAsset {
  const label = typeof props.label === 'string' ? props.label : type;
  return {
    id: type,
    name: label,
    label,
    category,
    file: tile.image,
    width: tile.imagewidth,
    height: tile.imageheight,
    footprintW: footprintOf(tile.imagewidth),
    footprintH: footprintOf(tile.imageheight),
    isDesk: category === 'desks',
    groupId: stateGroup || type,
    canPlaceOnSurfaces: props.occupiesSurface === true,
    backgroundTiles: typeof props.backgroundTiles === 'number' ? props.backgroundTiles : 0,
    ...(typeof props.orientation === 'string' ? { orientation: props.orientation } : {}),
    ...(typeof props.state === 'string' ? { state: props.state } : {}),
    ...(typeof props.onTrigger === 'string' ? { onTrigger: props.onTrigger as 'autoFacing' | 'click' } : {}),
    ...(props.mirrorSide === true ? { mirrorSide: true } : {}),
    ...(anim ? { animationGroup: `${anim.groupId}__anim`, frame: anim.frame, durationMs: anim.durationMs } : {}),
  };
}

/** Category value (FurnitureCatalogEntry.category) ↔ tileset filename slug —
 *  "wall" is filed as furniture-wallmount.tsj so it doesn't collide with the
 *  wall-0.tsj/wall-1.tsj AUTOTILE tilesets (wall TILES, not wall-mounted
 *  FURNITURE) task #156 adds alongside these. */
export const FURNITURE_CATEGORY_FILES: Record<string, string> = {
  desks: 'desks',
  chairs: 'chairs',
  storage: 'storage',
  electronics: 'electronics',
  decor: 'decor',
  wall: 'wallmount',
  kitchens: 'kitchens',
  misc: 'misc',
};
