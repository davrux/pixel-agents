/**
 * Reads the furniture catalog straight from Tiled tileset JSON files
 * (assets/tiled/furniture-*.tsj) — the source of truth this migrated to from
 * the old assets/furniture/<TYPE>/manifest.json tree (see
 * scripts/migrate-furniture-to-tiled.mjs and docs/design.md).
 * No export/import round-trip: the .tsj on disk IS the catalog data.
 *
 * Custom per-tile properties (all optional besides `id`):
 *   id              (string) stable catalog identifier — required
 *   label           (string) display name
 *   canSitOn        (bool)   see FurnitureCatalogEntry.canSitOn
 *   sitFacing       (string) 'N' | 'E' | 'S' | 'W' — see FurnitureCatalogEntry.sitFacing
 *   petCanSitOn     (bool)   see FurnitureCatalogEntry.petCanSitOn
 *   canWalkOver     (bool)   see FurnitureCatalogEntry.canWalkOver
 *   backgroundTiles (int)    see FurnitureCatalogEntry.backgroundTiles
 *   onState         (string) catalog id this becomes when switched on — see
 *                            FurnitureCatalogEntry.onState
 *   actionKind      (string) this type's default Action (see FurnitureCatalogEntry.action)
 *                            — 'meetingRoom' | 'meetingManager' | 'iframe' | 'appliance' |
 *                            'arcade' | 'timeClock' | 'portal' | 'toggle' | 'spawnPoint';
 *                            empty = none
 *   actionVideo     (bool)   only with actionKind 'meetingRoom'
 *   actionUrl       (string) only with actionKind 'iframe' — https:// only
 *   actionPose      (string) only with actionKind 'appliance', e.g. 'coffee'
 *   meetingRoomName (string) only with actionKind 'meetingRoom' — the room's name
 *
 * Every tile carries every one of these, defaults included, rather than only
 * the ones that differ — see server/scripts/sync-furniture-properties.mts, which
 * is what keeps that true. A property a mapper has to remember to ADD is a
 * property they will forget, and an absent `canSitOn` looks exactly like a
 * deliberate "no".
 *
 * Animation is NOT a custom property — a tile's native Tiled `<animation>`
 * (its own frame plus any following ones, each naming a sibling tile's id in
 * the SAME tileset) becomes the frame-0 entry's animationGroup/frame/durationMs,
 * exactly the shape shared/src/office/layout/furnitureCatalog.ts already reads.
 */
import type { FurnitureAsset } from './manifestUtils.js';
import { actionFromProps } from '../../tiled/actionProps.js';
import { furnitureBehaviourFromTile } from '../../tiled/furnitureProps.js';
import { DECAL_TILE_CLASS } from '../../tiled/tiledRegistry.js';

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
  /** Tiled's class for this tile — `FurnitureTile` here. Now load-bearing: it,
   *  not the filename, is what marks a tileset as holding furniture (see
   *  isFurnitureTileset). */
  type?: string;
  /** The tile's own PNG — present in a collection-of-images tileset, absent in
   *  a grid tileset, where the shared sheet + the tile's position say the same
   *  thing (see cropOf). */
  image?: string;
  imagewidth?: number;
  imageheight?: number;
  properties?: TiledProperty[];
  animation?: TiledAnimationFrame[];
}

export interface TiledTilesetJson {
  name?: string;
  tiles: TiledTile[];
  /** Grid-tileset geometry — one shared sheet image, tiles addressed by
   *  position. A collection-of-images tileset has columns 0 and no image. */
  image?: string;
  columns?: number;
  tilewidth?: number;
  tileheight?: number;
}

/** Where in the shared sheet a grid tile's pixels live. Absent for a
 *  collection tile, whose own PNG is the whole answer. */
export interface TileCrop {
  x: number;
  y: number;
  w: number;
  h: number;
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
 *  tileset's own directory) each id needs. Which FILE a tile lives in carries no
 *  meaning at all — assetLoader.ts globs every furniture-*.tsj and each tile
 *  states its own behaviour, so the split is organisational convenience only.
 *
 *  Both tileset shapes come through here: a collection-of-images tileset names
 *  a PNG per tile, a GRID tileset (decal-overworld) names one shared sheet and
 *  each entry then carries a `crop` — the caller slices that region out. What
 *  makes a tile an item is the same either way: its class plus its own `id`
 *  property; a grid cell without a tiles[] entry is not in the catalog. */
export function parseFurnitureTileset(json: TiledTilesetJson): Array<{ asset: FurnitureAsset; imagePath: string; crop?: TileCrop }> {
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

  const out: Array<{ asset: FurnitureAsset; imagePath: string; crop?: TileCrop }> = [];
  for (const tile of json.tiles) {
    const anim = tile.animation;
    if (!anim && frameComponentIds.has(tile.id)) continue;
    const props = propsOf(tile);
    const id = typeof props.id === 'string' ? props.id : undefined;
    if (!id) {
      console.warn(`[tiledFurniture] Skipping tile ${tile.id} in "${json.name}" — missing "id" property`);
      continue;
    }
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
        const src = sourceOf(json, frameTile);
        if (!src) continue;
        out.push({
          asset: buildAsset(src, frameProps, frameId, { groupId: id, frame, durationMs: fr.duration }),
          imagePath: src.imagePath,
          ...(src.crop ? { crop: src.crop } : {}),
        });
      }
      continue;
    }
    const src = sourceOf(json, tile);
    if (!src) {
      console.warn(`[tiledFurniture] Skipping tile ${tile.id} in "${json.name}" — no own image and no grid sheet`);
      continue;
    }
    out.push({ asset: buildAsset(src, props, id, undefined), imagePath: src.imagePath, ...(src.crop ? { crop: src.crop } : {}) });
  }
  return out;
}

/** A tile's pixels: its own PNG (collection tileset) or a region of the shared
 *  sheet (grid tileset — position decomposed against the tileset's columns,
 *  the same way the floor/wall bake is read back). Null only for a tile with
 *  neither, which is a malformed tileset. */
function sourceOf(
  json: TiledTilesetJson,
  tile: TiledTile,
): { imagePath: string; crop?: TileCrop; type?: string; width: number; height: number } | null {
  if (tile.image) return { imagePath: tile.image, type: tile.type, width: tile.imagewidth ?? 0, height: tile.imageheight ?? 0 };
  const columns = json.columns ?? 0;
  if (!json.image || columns <= 0) return null;
  const w = json.tilewidth ?? TILE_SIZE;
  const h = json.tileheight ?? TILE_SIZE;
  return {
    imagePath: json.image,
    crop: { x: (tile.id % columns) * w, y: Math.floor(tile.id / columns) * h, w, h },
    type: tile.type,
    width: w,
    height: h,
  };
}

function buildAsset(
  src: { imagePath: string; type?: string; width: number; height: number },
  props: Record<string, string | number | boolean>,
  id: string,
  anim: { groupId: string; frame: number; durationMs: number } | undefined,
): FurnitureAsset {
  // `||`, not a type check: every tile now carries a `label` property whether
  // or not it says anything (see sync-furniture-properties.mts), so an empty one
  // has to fall back to the id the same way a missing one always did.
  const label = typeof props.label === 'string' && props.label ? props.label : id;
  // A decal shares the catalog with furniture — same sprite table, same
  // transport to the client (furnitureAssetsLoaded), same id lookup — but none
  // of the behaviour: it is a picture on a tile layer, so reading canSitOn or an
  // action off it would invent something the mapper cannot have meant. Nor does
  // it state how it sorts against characters; that is the decal LAYER's business
  // (see tiled/decalProps.ts), which is what lets furniture art be painted as a
  // decal without needing a property furniture tiles do not have.
  const isDecal = src.type === DECAL_TILE_CLASS;
  return {
    id,
    name: label,
    label,
    file: src.imagePath,
    width: src.width,
    height: src.height,
    footprintW: footprintOf(src.width),
    footprintH: footprintOf(src.height),
    ...(isDecal ? { decal: true as const } : furnitureBehaviourFromTile(props)),
    ...(anim ? { animationGroup: `${anim.groupId}__anim`, frame: anim.frame, durationMs: anim.durationMs } : {}),
    ...(() => {
      const action = actionFromProps(props);
      return action ? { action } : {};
    })(),
  };
}

