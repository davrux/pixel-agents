/**
 * GID bookkeeping across every assets/tiled/*.tsj tileset — the map bridge
 * (mapBridge.ts) needs one global, stable numbering to write/read Tiled
 * tile GIDs, exactly like Tiled itself computes when you add tilesets to a
 * map (each tileset occupies a contiguous [firstgid, firstgid+tilecount)
 * range, walked in the order the tilesets were added).
 *
 * Deterministic order: every .tsj in the directory, alphabetically. Stable
 * across repeated exports as long as no tileset is added or removed. (A map's
 * own tilesets array is what an IMPORT trusts; see resolveFromTmjTilesets.)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';


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
  tilewidth?: number;
  tileheight?: number;
  columns?: number;
  spacing?: number;
  /** Present on a grid tileset (one sheet for the whole set), absent on a
   *  collection of images. */
  image?: string;
  tiles?: TiledTileJson[];
}

export interface RegistryTile {
  /** Tiled's class assignment for this tile (e.g. "WallTile", "DecalTile") —
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
  /** The tileset's own grid width in tiles (Tiled's `columns`) — 0 for a
   *  collection-of-images set. For the baked floor/wall grids this is what a
   *  localId is decomposed against (row = pattern/bitmask, column = swatch);
   *  it is per set because sets differ: a palette-baked sheet has 65 columns
   *  (Natural + 64 swatches), a natural-only one (floor-overworld) has 1. */
  columns: number;
  /** Transparent px baked between cells (Tiled's `spacing`). Read for the same
   *  reason as `columns`: the client draws a cell as a frame of the sheet and has
   *  to know where the cell actually starts, and taking that from a constant is
   *  what lets a re-baked sheet and its reader disagree. See FLOOR_TILE_SPACING /
   *  WALL_TILE_SPACING for why the gap exists at all. */
  spacing: number;
  /** One tile's size in px. Read because a GROUND cell is exactly one map cell:
   *  a sheet with bigger tiles cannot be ground without overflowing its
   *  neighbours, and the import refuses it with a message (see groundFits). */
  tileWidth: number;
  tileHeight: number;
  /** A grid tileset's own image, relative to assets/tiled — '' for a
   *  collection-of-images set, which has one image per tile instead. Carried
   *  through so nothing has to guess where a sheet's PNG lives (sets.json passes
   *  it to the client for exactly that reason). */
  image: string;
  tiles: RegistryTile[]; // index = local tile id
}

/** The Tiled class every furniture tile carries (see Pixels.tiled-project).
 *  THE discriminator for "is this a furniture tileset" — not the filename. A
 *  tileset used to have to be called `furniture-*.tsj`, which made a naming
 *  convention load-bearing in four separate places while the class already said
 *  the same thing, exactly the duplication that a `category` property on floor
 *  and wall tiles was removed for. */
export const FURNITURE_TILE_CLASS = 'FurnitureTile';
/** Map art painted on a DecalLayer and nothing more — no synced object, no
 *  behaviour (see tiled/decalProps.ts). Same discriminator rule as the three
 *  above: the tiles say it, the filename never does. */
export const DECAL_TILE_CLASS = 'DecalTile';

/** Does this tileset hold furniture? Asked of the file's own tiles, so a
 *  tileset may be named anything — as may a floor or wall one, now that a layout
 *  names the sets it uses instead of storing a position in a hardcoded list. */
export function isFurnitureTileset(json: { tiles?: Array<{ type?: string }> }): boolean {
  return tilesetHolds(json, FURNITURE_TILE_CLASS);
}

/** Does this tileset hold decals? */
export function isDecalTileset(json: { tiles?: Array<{ type?: string }> }): boolean {
  return tilesetHolds(json, DECAL_TILE_CLASS);
}

/** Does this tileset hold tiles of `cls`? The one question that decides what a
 *  tileset IS — asked of its tiles, never of its filename. */
export function tilesetHolds(json: { tiles?: Array<{ type?: string }> }, cls: string): boolean {
  return (json.tiles ?? []).some((t) => t.type === cls);
}

/** The floor / wall sets on disk, by NAME (the tileset filename without .tsj),
 *  alphabetically. Discovered from the tiles' own class, so nothing enumerates
 *  filenames: adding, renaming or removing a tileset needs no code change. A
 *  layout stores these names (OfficeLayout.floorSets / wallSets), so the order
 *  here is only a stable presentation order, never an identity. */
/**
 * Every GRID tileset (one sheet for the whole set), with its name, grid geometry
 * and image path — what the client needs to register each sheet as a texture and
 * draw cells out of it.
 *
 * All of them, not just the baked floor/wall sets: a map's ground may name any
 * grid tileset (see OfficeLayout.tiles), so restricting this list would restore
 * exactly the limit that made painting imported art on the GroundLayer produce a
 * hole. The cell size travels with each sheet, which is what a wall set's taller
 * cells need — read off the tileset, never guessed from a filename.
 */
export function gridSheets(registry: TiledRegistry): Array<{
  name: string;
  columns: number;
  spacing: number;
  img: string;
  tileWidth: number;
  tileHeight: number;
}> {
  return registry.tilesets
    .filter((ts) => ts.image !== '' && ts.columns > 0)
    .map((ts) => ({
      name: ts.file.replace(/\.tsj$/, ''),
      columns: ts.columns,
      spacing: ts.spacing,
      img: ts.image,
      // The cell size — the only thing that ever differed between a floor sheet and
      // a wall sheet. It used to travel as a `kind` derived from the
      // FloorTile/WallTile classes; a measurement the tileset already states belongs
      // in the tileset, so both classes are gone and this is read instead.
      tileWidth: ts.tileWidth,
      tileHeight: ts.tileHeight,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
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
  // Alphabetical, no fixed head: with nothing storing a position any more (see
  // gridSheets), the only requirement is that repeated runs agree — which
  // matters because an EXPORT writes these firstgids into a map, and the map's
  // own copy is what a later import trusts (resolveFromTmjTilesets).
  const files = fs
    .readdirSync(tiledDir)
    .filter((f) => f.endsWith('.tsj'))
    .sort();

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
    tilesets.push({
      file,
      name: json.name,
      firstgid: nextGid,
      tileCount: slots,
      columns: json.columns ?? 0,
      spacing: json.spacing ?? 0,
      image: json.image ?? '',
      tileWidth: json.tilewidth ?? 0,
      tileHeight: json.tileheight ?? 0,
      tiles,
    });
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
 *  the GID→file/localId mapping itself comes from the .tmj.
 *
 *  The map's table decides where each tileset ENDS as well, not just where it
 *  starts — see the cap in the loop, which is what makes appending art to a
 *  tileset harmless for maps that were saved before it. */
export function resolveFromTmjTilesets(
  registry: TiledRegistry,
  tmjTilesets: Array<{ firstgid: number; source: string }>,
): (gid: number) => { tileset: RegistryTileset; localId: number; class?: string; props: Record<string, string | number | boolean>; image?: string } | null {
  // Sorted by firstgid, because the NEXT entry's start is where this one ends —
  // see the cap below. Tiled writes them in ascending order; sorting a copy means
  // we do not depend on that.
  const raw = [...tmjTilesets]
    .map((t) => ({ firstgid: Number(t.firstgid), source: path.basename(String(t.source)) }))
    .filter((t) => Number.isFinite(t.firstgid) && t.firstgid > 0)
    .sort((a, b) => a.firstgid - b.firstgid);

  interface Entry {
    firstgid: number;
    tileset: RegistryTileset;
    /** Where the NEXT tileset starts in this map, if there is one. */
    nextFirstgid: number | undefined;
  }
  const entries = raw
    .map((t, i): Entry | null => {
      const ts = registry.bySource(t.source);
      // The cap comes from the RAW table, including entries whose tileset this
      // build does not have: an unknown tileset still owns its slice of the number
      // space in THIS map, and letting its predecessor spill into it would resolve
      // its cells to the wrong art rather than to nothing.
      return ts ? { firstgid: t.firstgid, tileset: ts, nextFirstgid: raw[i + 1]?.firstgid } : null;
    })
    .filter((e): e is Entry => e !== null);

  return (gid: number) => {
    if (gid <= 0) return null;
    for (const { firstgid, tileset, nextFirstgid } of entries) {
      // Where this tileset ENDS is the map's answer, not the file's.
      //
      // The file says "I have N tiles"; the map says "the next set starts here".
      // They agree in a freshly saved map, and disagree exactly when the map is
      // older than the tileset — someone appended art since. Taking the file's
      // answer then lets the grown tileset swallow the first cells of the next one:
      // a decal painted in an older map came back as a fountain frame, silently,
      // because tile 6 of furniture-misc now sits where decal's tile 0 used to.
      //
      // The smaller of the two is right in both directions. Capped by the map, an
      // old map keeps resolving to what its author painted (the new tiles are
      // simply out of its reach until it is saved in Tiled again). Capped by the
      // file, a map NEWER than the tilesets resolves its unknown cells to nothing
      // — a visible hole, rather than confident nonsense.
      const end = Math.min(firstgid + tileset.tileCount, nextFirstgid ?? Number.MAX_SAFE_INTEGER);
      if (gid >= firstgid && gid < end) {
        const localId = gid - firstgid;
        const tile = tileset.tiles[localId];
        return { tileset, localId, class: tile?.class, props: tile?.props ?? {}, image: tile?.image };
      }
    }
    return null;
  };
}
