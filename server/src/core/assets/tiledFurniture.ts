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
  /** Absent on a grid tileset, where the SET owns the one image and this tile's
   *  id is its position in it — see TiledTilesetJson.image. */
  image?: string;
  imagewidth?: number;
  imageheight?: number;
  properties?: TiledProperty[];
  animation?: TiledAnimationFrame[];
}

export interface TiledTilesetJson {
  name?: string;
  tiles: TiledTile[];
  /**
   * Set when this is a **grid** tileset: one image for the whole set, cut into
   * uniform cells, a tile's local id being its position in it (row-major). What
   * Tiled writes for a sheet, as opposed to the "collection of images" every
   * furniture set is, where each tile names its own file.
   *
   * The road set is the reason it exists: hundreds of pieces stay one PNG in git,
   * and Tiled's palette keeps the artist's arrangement, so a junction can be
   * stamped as one block. The loader slices the sheet once (assetLoader.ts).
   */
  image?: string;
  tilewidth?: number;
  tileheight?: number;
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
 *  tileset's own directory) each id needs, plus — for a grid tileset — which CELL
 *  of that single PNG (see TiledTilesetJson.image). Which FILE a tile lives in
 *  carries no meaning at all — assetLoader.ts globs every *.tsj and each tile
 *  states its own behaviour, so the split is organisational convenience only. */
export function parseFurnitureTileset(
  json: TiledTilesetJson,
): Array<{ asset: FurnitureAsset; imagePath: string; sheetCell?: number }> {
  const byId = new Map(json.tiles.map((t) => [t.id, t]));
  /** A grid tileset's tiles have no image of their own: the set has one, and a
   *  tile's id is its position in it. Its size comes from the set too. */
  const sheet = json.image
    ? { image: json.image, tileW: json.tilewidth ?? TILE_SIZE, tileH: json.tileheight ?? TILE_SIZE }
    : null;
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

  const out: Array<{ asset: FurnitureAsset; imagePath: string; sheetCell?: number }> = [];
  for (const tile of json.tiles) {
    const anim = tile.animation;
    if (!anim && frameComponentIds.has(tile.id)) continue;
    const props = propsOf(tile);
    const id = typeof props.id === 'string' ? props.id : undefined;
    if (!id) {
      console.warn(`[tiledFurniture] Skipping tile ${tile.id} in "${json.name}" — missing "id" property`);
      continue;
    }
    // A grid tileset's tile is one cell of the set's own image. No animation
    // handling: an animated sheet tile would be a fine thing to support, and
    // nothing needs it yet, so it stays unsupported rather than half-supported.
    if (sheet) {
      out.push({
        asset: buildAsset(tile, props, id, undefined, { w: sheet.tileW, h: sheet.tileH }),
        imagePath: sheet.image,
        sheetCell: tile.id,
      });
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
        out.push({
          asset: buildAsset(frameTile, frameProps, frameId, { groupId: id, frame, durationMs: fr.duration }),
          imagePath: frameTile.image ?? '',
        });
      }
      continue;
    }
    out.push({ asset: buildAsset(tile, props, id, undefined), imagePath: tile.image ?? '' });
  }
  return out;
}

function buildAsset(
  tile: TiledTile,
  props: Record<string, string | number | boolean>,
  id: string,
  anim: { groupId: string; frame: number; durationMs: number } | undefined,
  /** The size to use when the tile carries none — a grid tileset's cell. */
  sheetSize?: { w: number; h: number },
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
  const isDecal = tile.type === DECAL_TILE_CLASS;
  const width = tile.imagewidth ?? sheetSize?.w ?? TILE_SIZE;
  const height = tile.imageheight ?? sheetSize?.h ?? TILE_SIZE;
  return {
    id,
    name: label,
    label,
    file: tile.image ?? '',
    width,
    height,
    footprintW: footprintOf(width),
    footprintH: footprintOf(height),
    ...(isDecal ? { decal: true as const } : furnitureBehaviourFromTile(props)),
    ...(anim ? { animationGroup: `${anim.groupId}__anim`, frame: anim.frame, durationMs: anim.durationMs } : {}),
    ...(() => {
      const action = actionFromProps(props);
      return action ? { action } : {};
    })(),
  };
}

