/**
 * Reads the furniture catalog straight from Tiled tileset JSON files
 * (assets/tiled/furniture-*.tsj) — the source of truth this migrated to from
 * the old assets/furniture/<TYPE>/manifest.json tree (see
 * scripts/migrate-furniture-to-tiled.mjs and docs/design/tiled-editor-integration.md).
 * No export/import round-trip: the .tsj on disk IS the catalog data.
 *
 * Custom per-tile properties (all optional besides `id`):
 *   id              (string) stable catalog identifier — required
 *   label           (string) display name
 *   category        (string) browsing label — see FURNITURE_CATEGORIES; a
 *                             pure per-tile property, NOT tied to which
 *                             tileset file the tile lives in (a file may mix
 *                             categories — see docs/design/tiled-editor-integration.md's
 *                             revised category section)
 *   backgroundTiles (int)    see FurnitureCatalogEntry.backgroundTiles
 *   occupiesSurface (bool)   see FurnitureCatalogEntry.occupiesSurface
 *   orientation     (string) 'front' | 'back' | 'side' — which facing this art
 *                            shows; also namespaces an on/off state pair's key
 *                            alongside stateGroup, so e.g. a front and a side
 *                            view of the "same" stateful item don't collide
 *   stateGroup      (string) shared id linking an on/off pair
 *   state           (string) 'on' | 'off' — needs a matching stateGroup pair
 *   onTrigger       (string) 'autoFacing' | 'click' — what flips the pair
 *   actionKind      (string) this type's default Action (see FurnitureCatalogEntry.action)
 *                            — 'meetingRoom' | 'meetingManager' | 'iframe' | 'appliance' |
 *                            'arcade' | 'portal' | 'toggle'; empty = no default action
 *   actionVideo     (bool)   only with actionKind 'meetingRoom'
 *   actionUrl       (string) only with actionKind 'iframe' — https:// only
 *   actionPose      (string) only with actionKind 'appliance', e.g. 'coffee'
 *
 * Animation is NOT a custom property — a tile's native Tiled `<animation>`
 * (its own frame plus any following ones, each naming a sibling tile's id in
 * the SAME tileset) becomes the frame-0 entry's animationGroup/frame/durationMs,
 * exactly the shape shared/src/office/layout/furnitureCatalog.ts already reads.
 */
import type { FurnitureAsset } from './manifestUtils.js';
import { FURNITURE_CATEGORIES as CATEGORY_LABELS } from '@pixel/shared/office/layout/furnitureCatalog.js';
import { actionFromProps } from '../../tiled/actionProps.js';

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
 *  tileset's own directory) each id needs. `category` is read per-tile (see
 *  FURNITURE_CATEGORIES) — a tileset file can freely mix categories, it's
 *  purely a browsing label now, not a placement constraint or a file split. */
export function parseFurnitureTileset(json: TiledTilesetJson): Array<{ asset: FurnitureAsset; imagePath: string }> {
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
    // Server-generated furniture (portals, conference monitor, arcade
    // cabinet, meeting-room kiosk, wall logos — see
    // server/scripts/bake-generated-furniture.mts) is baked into these same
    // tilesets purely so the Tiled MAP bridge can give it a real sprite
    // instead of a blank placeholder; it must NOT also become a runtime
    // catalog entry here, or it would duplicate (and shadow the real
    // action/portal/appliance flags of) the entry assets.ts's own
    // `generated` array already injects.
    if (props.generated === true) continue;
    const id = typeof props.id === 'string' ? props.id : undefined;
    if (!id) {
      console.warn(`[tiledFurniture] Skipping tile ${tile.id} in "${json.name}" — missing "id" property`);
      continue;
    }
    const category = categoryOf(props, json.name, id);
    const stateGroup = typeof props.stateGroup === 'string' ? props.stateGroup : undefined;
    // Only the frame-0 tile of an animation carries the <animation> block —
    // build one FurnitureAsset per frame (the sibling tiles, resolved by
    // Tiled's own tile id), each with its own frame/durationMs but ALL
    // sharing one animationGroup id (the anchor's own id — a frame's OWN id
    // would give every frame a distinct group of one, since ids differ per
    // frame).
    if (anim && anim.length > 0) {
      for (let frame = 0; frame < anim.length; frame++) {
        const fr = anim[frame];
        const frameTile = byId.get(fr.tileid);
        if (!frameTile) continue;
        const frameProps = propsOf(frameTile);
        const frameId = typeof frameProps.id === 'string' ? frameProps.id : undefined;
        if (!frameId) continue;
        // A frame tile doesn't necessarily carry its own `category` — fall
        // back to the anchor tile's, which every frame logically shares.
        const frameCategory = typeof frameProps.category === 'string' ? frameProps.category : category;
        out.push({
          asset: buildAsset(frameTile, frameProps, frameId, frameCategory, stateGroup, { groupId: id, frame, durationMs: fr.duration }),
          imagePath: frameTile.image,
        });
      }
      continue;
    }
    out.push({ asset: buildAsset(tile, props, id, category, stateGroup, undefined), imagePath: tile.image });
  }
  return out;
}

const VALID_CATEGORIES = new Set(CATEGORY_LABELS.map((c) => c.id));

function categoryOf(props: Record<string, string | number | boolean>, tilesetName: string | undefined, id: string): string {
  if (typeof props.category === 'string' && VALID_CATEGORIES.has(props.category as never)) {
    return props.category;
  }
  console.warn(`[tiledFurniture] "${id}" in "${tilesetName}" has no valid "category" property — defaulting to "misc"`);
  return 'misc';
}

function buildAsset(
  tile: TiledTile,
  props: Record<string, string | number | boolean>,
  id: string,
  category: string,
  stateGroup: string | undefined,
  anim: { groupId: string; frame: number; durationMs: number } | undefined,
): FurnitureAsset {
  const label = typeof props.label === 'string' ? props.label : id;
  return {
    id,
    name: label,
    label,
    category,
    file: tile.image,
    width: tile.imagewidth,
    height: tile.imageheight,
    footprintW: footprintOf(tile.imagewidth),
    footprintH: footprintOf(tile.imageheight),
    isDesk: category === 'desks',
    groupId: stateGroup || id,
    canPlaceOnSurfaces: props.occupiesSurface === true,
    backgroundTiles: typeof props.backgroundTiles === 'number' ? props.backgroundTiles : 0,
    ...(typeof props.orientation === 'string' ? { orientation: props.orientation } : {}),
    ...(typeof props.state === 'string' ? { state: props.state } : {}),
    ...(typeof props.onTrigger === 'string' ? { onTrigger: props.onTrigger as 'autoFacing' | 'click' } : {}),
    ...(anim ? { animationGroup: `${anim.groupId}__anim`, frame: anim.frame, durationMs: anim.durationMs } : {}),
    ...(() => {
      const action = actionFromProps(props);
      return action ? { action } : {};
    })(),
  };
}

