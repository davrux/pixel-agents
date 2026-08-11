/**
 * GID bookkeeping across every assets/tiled/*.tsj tileset — the map bridge
 * (mapBridge.ts) needs one global, stable numbering to write/read Tiled
 * tile GIDs, exactly like Tiled itself computes when you add tilesets to a
 * map (each tileset occupies a contiguous [firstgid, firstgid+tilecount)
 * range, walked in the order the tilesets were added).
 *
 * Fixed, deterministic order: every FLOOR_SET_FILES entry, then every
 * WALL_SET_FILES entry, then collision, then every furniture-*.tsj
 * alphabetically — stable across repeated exports as long as no tileset is
 * added/removed/reordered on disk.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { FLOOR_SET_FILES, WALL_SET_FILES } from '@pixel/shared/office/tiledSheetLayout.js';

type TiledProp = { name: string; type?: string; value: string | number | boolean };
interface TiledTileJson {
  id: number;
  type?: string;
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
  /** Resolve a global GID (0 = empty) to its tileset + local tile class/properties. */
  resolve(gid: number): { tileset: RegistryTileset; localId: number; class?: string; props: Record<string, string | number | boolean> } | null;
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
    const tiles: RegistryTile[] = [];
    for (let id = 0; id < json.tilecount; id++) {
      const t = byId.get(id);
      tiles.push({ class: t?.type, props: t ? propsOf(t) : {} });
    }
    tilesets.push({ file, name: json.name, firstgid: nextGid, tileCount: json.tilecount, tiles });
    nextGid += json.tilecount;
  }

  function resolve(gid: number) {
    if (gid <= 0) return null;
    for (const ts of tilesets) {
      if (gid >= ts.firstgid && gid < ts.firstgid + ts.tileCount) {
        const localId = gid - ts.firstgid;
        const tile = ts.tiles[localId];
        return { tileset: ts, localId, class: tile.class, props: tile.props };
      }
    }
    return null;
  }

  return { tilesets, resolve, bySource: (file) => tilesets.find((t) => t.file === file) };
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
