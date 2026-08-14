/**
 * GID bookkeeping across every assets/tiled/*.tsj tileset — the map bridge
 * (mapBridge.ts) needs one global, stable numbering to write/read Tiled
 * tile GIDs, exactly like Tiled itself computes when you add tilesets to a
 * map (each tileset occupies a contiguous [firstgid, firstgid+tilecount)
 * range, walked in the order the tilesets were added).
 *
 * Fixed, deterministic order: every FLOOR_SET_FILES entry, then every
 * WALL_SET_FILES entry, then collision, then images (see
 * bake-images-tiled.mts), then every furniture-*.tsj alphabetically —
 * stable across repeated exports as long as no tileset is added/removed/
 * reordered on disk.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { FLOOR_SET_FILES, WALL_SET_FILES } from '@pixel/shared/office/tiledSheetLayout.js';

type TiledProp = { name: string; type?: string; value: string | number | boolean };
interface TiledTileJson {
  id: number;
  type?: string;
  image?: string;
  properties?: TiledProp[];
}
interface TiledTilesetJson {
  name: string;
  tilecount: number;
  tiles?: TiledTileJson[];
}

export interface RegistryTile {
  /** Tiled's class assignment for this tile (e.g. "FloorTile", "WallTile") —
   *  see Pixels.tiled-project's propertyTypes. Undefined for an unclassed
   *  tile (e.g. collision.tsj's parameterless marker). */
  class?: string;
  props: Record<string, string | number | boolean>;
  /** This tile's own `image` path (relative to assets/tiled/), for a
   *  "Collection of Images" tile (see images.tsj/ImageTile) — e.g. a tile a
   *  mapper added directly in Tiled's Tileset editor, pointing at whatever
   *  file they picked, not necessarily one baked by bake-images-tiled.mts.
   *  Undefined for tiles from a single-image (grid) tileset, where the path
   *  lives on the tileset itself instead. */
  image?: string;
}

export interface RegistryTileset {
  file: string; // e.g. "floor.tsj"
  name: string;
  firstgid: number;
  tileCount: number;
  tiles: RegistryTile[]; // index = local tile id
}

export interface TiledRegistry {
  tilesets: RegistryTileset[];
  /** Find the tileset matching `file` (e.g. "floor.tsj"), if loaded. */
  bySource(file: string): RegistryTileset | undefined;
}

function propsOf(tile: TiledTileJson): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const p of tile.properties ?? []) out[p.name] = p.value;
  return out;
}

export function loadTiledRegistry(assetsRoot: string): TiledRegistry {
  const tiledDir = path.join(assetsRoot, 'assets', 'tiled');
  const fixedOrder = [
    ...FLOOR_SET_FILES.map((f) => `${f}.tsj`),
    ...WALL_SET_FILES.map((f) => `${f}.tsj`),
    'collision.tsj',
    'images.tsj',
  ];
  const furnitureFiles = fs
    .readdirSync(tiledDir)
    .filter((f) => /^furniture-.*\.tsj$/.test(f))
    .sort();
  const files = [...fixedOrder.filter((f) => fs.existsSync(path.join(tiledDir, f))), ...furnitureFiles];

  const tilesets: RegistryTileset[] = [];
  let nextGid = 1; // GID 0 is reserved for "empty" — never assigned to a tile.
  for (const file of files) {
    const json = JSON.parse(fs.readFileSync(path.join(tiledDir, file), 'utf-8')) as TiledTilesetJson;
    const byId = new Map((json.tiles ?? []).map((t) => [t.id, t]));
    // Indexed by the tile's OWN id, and sized to reach the highest one — not
    // just to `tilecount`. Deleting a tile from the middle of an image
    // collection in Tiled drops the count but does NOT renumber what is left,
    // so the last tile's id then sits past the count; walking only to the count
    // would leave it unresolvable, and a placement using it would vanish on the
    // next import. The gap the deletion left stays an empty slot, which is
    // exactly right — nothing should resolve there.
    const maxId = json.tiles?.length ? Math.max(...json.tiles.map((t) => t.id)) : -1;
    const slots = Math.max(json.tilecount, maxId + 1);
    const tiles: RegistryTile[] = [];
    for (let id = 0; id < slots; id++) {
      const t = byId.get(id);
      tiles.push({ class: t?.type, props: t ? propsOf(t) : {}, image: t?.image });
    }
    tilesets.push({ file, name: json.name, firstgid: nextGid, tileCount: slots, tiles });
    nextGid += slots;
  }

  return { tilesets, bySource: (file) => tilesets.find((t) => t.file === file) };
}

/** Global GID for a tile matching `predicate` within tileset `file`, or null
 *  if the tileset isn't loaded or no tile matches. */
export function findGid(
  registry: TiledRegistry,
  file: string,
  predicate: (props: Record<string, string | number | boolean>) => boolean,
): number | null {
  const ts = registry.bySource(file);
  if (!ts) return null;
  const localId = ts.tiles.findIndex((t) => predicate(t.props));
  return localId < 0 ? null : ts.firstgid + localId;
}

/** Global GID for a known local tile id within tileset `file` — the
 *  positional counterpart to findGid, for tilesets (floor/wall) whose tile
 *  order is a fixed, code-generated grid rather than something to search by
 *  property. Null if the tileset isn't loaded or localId is out of range. */
export function gidAt(registry: TiledRegistry, file: string, localId: number): number | null {
  const ts = registry.bySource(file);
  if (!ts || localId < 0 || localId >= ts.tileCount) return null;
  return ts.firstgid + localId;
}

/** Build a GID resolver for one specific .tmj being imported, using THAT
 *  file's own `tilesets` array (each entry's real `firstgid`/`source`,
 *  exactly as Tiled last wrote them) instead of `TiledRegistry.resolve`'s
 *  own recomputed-from-disk-order firstgid ranges. Those only agree with the
 *  imported file's actual ranges as long as no one has ever added, removed,
 *  or reordered a tileset reference via Tiled's own Tileset panel — which a
 *  human editing a .tmj directly in Tiled (the whole point of this bridge)
 *  is free to do at any time, with Tiled updating `firstgid`s to match but
 *  our own registry having no way to know. Per-file tile class/props are
 *  still read from `registry` (order-independent — keyed by filename), only
 *  the GID→file/localId mapping itself comes from the .tmj. */
export function resolveFromTmjTilesets(
  registry: TiledRegistry,
  tmjTilesets: Array<{ firstgid: number; source: string }>,
): (gid: number) => { tileset: RegistryTileset; localId: number; class?: string; props: Record<string, string | number | boolean>; image?: string } | null {
  const entries = tmjTilesets
    .map((t) => {
      const ts = registry.bySource(path.basename(String(t.source)));
      return ts ? { firstgid: Number(t.firstgid), tileset: ts } : null;
    })
    .filter((e): e is { firstgid: number; tileset: RegistryTileset } => e !== null);

  return (gid: number) => {
    if (gid <= 0) return null;
    for (const { firstgid, tileset } of entries) {
      if (gid >= firstgid && gid < firstgid + tileset.tileCount) {
        const localId = gid - firstgid;
        const tile = tileset.tiles[localId];
        return { tileset, localId, class: tile?.class, props: tile?.props ?? {}, image: tile?.image };
      }
    }
    return null;
  };
}
