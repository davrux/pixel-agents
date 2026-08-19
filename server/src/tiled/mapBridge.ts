/**
 * Tiled .tmj → OfficeLayout importer (see docs/design.md).
 * One-way by design: Tiled is where a zone is authored, OfficeLayout is what the
 * engine runs, and nothing ever travels back. There used to be an exporter here
 * (OfficeLayout → .tmj) so a layout edited in-game could be re-opened in Tiled;
 * both halves of that loop are gone — the in-game world editor was removed and
 * maps are only ever pushed (see scripts/push-zones.mts), so a second writer of
 * .tmj would just be a way to overwrite the mapper's own file.
 *
 * Consequence worth knowing: nothing in a .tmj needs to be *producible* by us,
 * only readable. Where the old round-trip forced a lossless representation, the
 * importer is free to derive (zOffset from object list order, uid freshly per
 * import) and to ignore what our renderer cannot show (rotation, diagonal flip).
 */
import type { Action, OfficeLayout, PlacedDecal, PlacedFurniture, PlacedImage, PlacedText } from '@pixel/shared/office/types.js';
import { TileType } from '@pixel/shared/office/types.js';
import { TILE_SIZE } from '@pixel/shared/office/constants.js';
import { getCatalogEntry } from '@pixel/shared/office/layout/furnitureCatalog.js';

import { DECAL_LAYER_OCCLUDES } from './decalProps.js';
import { DECAL_TILE_CLASS, resolveFromTmjTilesets, type TiledRegistry, type RegistryTileset } from './tiledRegistry.js';
import { actionFromProps, type TiledProp, type PropBag } from './actionProps.js';
import { furnitureBehaviourFromObject } from './furnitureProps.js';
import { TILED_SHEET_COLUMNS, WALL_BITMASK_COUNT } from '@pixel/shared/office/tiledSheetLayout.js';
import { emptyWallEdges, hIndex, latticeIndex, vIndex } from '@pixel/shared/office/wallEdges.js';

/** Tiled's own GID flip bits (top two bits of the 32-bit GID field) — plain
 *  addition/subtraction, not a bitwise op: these GIDs are always far below
 *  2^31, and JS's bitwise operators coerce to signed Int32 first, which
 *  would turn 0x80000000/0x40000000 negative. Only H/V are used (see
 *  PlacedFurniture/PlacedImage's flippedHorizontally/flippedVertically) —
 *  Tiled's third bit (diagonal flip, 0x20000000) has no corresponding
 *  concept here and is never set or read. */
const TILED_FLIP_H = 0x80000000;
const TILED_FLIP_V = 0x40000000;
/** Tiled's third flip bit. We render nothing rotated, but a gid carrying it still
 *  has to RESOLVE — see baseGid. */
const TILED_FLIP_D = 0x20000000;

/** Tile properties that mean "this item does something", checked when a tile is
 *  painted onto a decal layer — where doing something is exactly what it stops
 *  being able to do. Walkability and backgroundTiles are deliberately not here:
 *  a decal is walkable and occupies nothing anyway, so neither is lost. */
const DECLARED_BEHAVIOUR = ['canSitOn', 'petCanSitOn', 'onState', 'actionKind'];

/** Tiled's documented Tile Object convention: (x,y) is the BOTTOM-LEFT
 *  corner of the tile's image, not top-left like every other object type. */
function rowFromTileObjectY(y: number, heightPx: number): number {
  // Tiled anchors a tile object at its BOTTOM left, so the row is where its top edge
  // lands. Measured from the object's own height: taking it from the catalog's
  // footprint put a placement Tiled shows at 16px a whole cell too high, because the
  // art behind it is 32px tall (see PlacedFurniture.width).
  return Math.round((y - heightPx) / TILE_SIZE);
}

/** Every imported item gets a fresh identity — `uid` is purely internal engine
 *  plumbing (station claims, on/off toggle state; see officeState.ts), so it is
 *  generated per import and never read from the map. */
function generateUid(): string {
  return `imported_${Math.random().toString(36).slice(2, 10)}`;
}

/** Tiled's text `color` is `#rrggbb` or `#aarrggbb` (alpha FIRST) per the
 *  JSON map format spec; a PlacedText.color is always opaque `#rrggbb` (see
 *  its own doc comment — no alpha channel modeled), so this just strips
 *  Tiled's leading alpha pair when present. Returns null for anything that
 *  isn't a well-formed hex color at all. */
function tiledColorToRgbHex(color: string): string | null {
  const hex = color.startsWith('#') ? color.slice(1) : color;
  if (/^[0-9a-fA-F]{6}$/.test(hex)) return `#${hex}`;
  if (/^[0-9a-fA-F]{8}$/.test(hex)) return `#${hex.slice(2)}`;
  return null;
}

/** Derive (row, swatch index) from a resolved tile's position within its
 *  tileset, undoing the sheet layout bake-floor-wall-tiled.mts writes out.
 *  Column 0 = Natural (null), column 1+i = the set's palette[i]; row =
 *  pattern-1 (floor) or bitmask (wall). Positional, not property-based:
 *  floor.tsj/wall-*.tsj are entirely machine-generated
 *  (bake-floor-wall-tiled.mts), so their tile order is exactly as reliable as
 *  a stored property would be, with nothing to keep in sync. The column count
 *  is the tileset's OWN (RegistryTileset.columns): sets differ — 65 for a
 *  palette bake, 1 for a natural-only set like floor-overworld. The fallback
 *  cannot trigger for a tile resolved out of a baked grid (those always carry
 *  columns ≥ 1); it only keeps the math finite if a tile from a
 *  collection-of-images set (columns 0) is ever painted on a wall layer. */
function rowAndSwatchFromLocalId(localId: number, tilesetColumns: number): { row: number; swatchIndex: number | null } {
  const columns = tilesetColumns > 0 ? tilesetColumns : TILED_SHEET_COLUMNS;
  const row = Math.floor(localId / columns);
  const col = localId % columns;
  return { row, swatchIndex: col === 0 ? null : col - 1 };
}

/** This tileset's position in the layout table being built, appending it if this
 *  is the first tile from it. That is how a map ends up naming its own sets (see
 *  OfficeLayout.floorSets): the table is whatever the map actually uses, in the
 *  order first encountered, rather than a slice of a global list. */
/** Warn once per distinct message — an import walks thousands of cells and a
 *  mistake is usually made once and repeated everywhere. */
function warnOnce(seen: Set<string>, message: string): void {
  if (seen.has(message)) return;
  seen.add(message);
  console.warn(`[tiled] ${message}`);
}

/**
 * May this tileset's tiles be ground?
 *
 * A ground cell is drawn into exactly one map cell, so a sheet with bigger tiles
 * would overflow into its neighbours — the one restriction the old FloorTile test
 * happened to imply, and the only one worth keeping. Refused with a message rather
 * than drawn wrongly.
 */
function groundFits(tileset: RegistryTileset, seen: Set<string>): boolean {
  // 0 means the tileset did not say; taking that as "fits" keeps a hand-written
  // tileset working rather than refusing every cell of it.
  const w = tileset.tileWidth || TILE_SIZE;
  const h = tileset.tileHeight || TILE_SIZE;
  if (w === TILE_SIZE && h === TILE_SIZE) return true;
  warnOnce(seen, `ground tile from "${tileset.file}": tiles are ${w}×${h}, but a ground cell is ${TILE_SIZE}×${TILE_SIZE} — paint it on a DecalLayer instead`);
  return false;
}

function setIndexInto(table: string[], file: string): number {
  const name = file.replace(/\.tsj$/, '');
  const idx = table.indexOf(name);
  if (idx >= 0) return idx;
  table.push(name);
  return table.length - 1;
}

/** `png/src/images/foo.png` → `foo`. Sanitised to the same shape an authored
 *  imageId has, since it becomes an asset key. */
function imageIdFromPath(image: string | undefined): string {
  if (!image) return '';
  const base = image.split('/').pop() ?? '';
  return base.replace(/\.[a-zA-Z0-9]+$/, '').replace(/[^A-Za-z0-9._-]/g, '_');
}

export interface TmjImportResult {
  layout: OfficeLayout;
  /** imageId → PNG buffer for images the caller should persist as new/updated
   *  image assets before saving the layout (matches saveAsset's 'image' type). */
  images: Array<{ imageId: string; label: string; buffer: Buffer }>;
  /** The map's own `mapName` property (see Pixels.tiled-project's Map
   *  class), or null if absent — e.g. a .tmj predating this property, or a
   *  hand-created map that never set it. Callers decide the fallback
   *  (tiled-import-all-zones.mts falls back to the filename). */
  mapName: string | null;
}

export function importTmjToLayout(
  tmj: Record<string, unknown>,
  registry: TiledRegistry,
  readImageFile: (relPath: string) => Buffer | null,
): TmjImportResult {
  const cols = Number(tmj.width);
  const rows = Number(tmj.height);
  const layers = (tmj.layers as Array<Record<string, unknown>>) ?? [];
  const mapProps: PropBag = Object.fromEntries(((tmj.properties as TiledProp[]) ?? []).map((p) => [p.name, p.value]));
  const mapName = typeof mapProps.mapName === 'string' && mapProps.mapName ? mapProps.mapName : null;

  // Resolve GIDs against THIS map's own tileset firstgid/source list, not
  // registry.resolve's disk-order assumption — see resolveFromTmjTilesets.
  const resolveGid = resolveFromTmjTilesets(registry, (tmj.tilesets as Array<{ firstgid: number; source: string }>) ?? []);

  // Classified by the layer's own `class` (GroundLayer/WallLatticeLayer/
  // CollisionLayer — see Pixels.tiled-project), not by name — same reasoning
  // as the object classification below: a mapper renaming these tile layers
  // must not silently empty out the whole map. Tiled writes a layer's custom
  // class under `class` specifically (not `type`, which every layer already
  // uses structurally for tilelayer/objectgroup/imagelayer/group).
  const ground = (layers.find((l) => l.class === 'GroundLayer')?.data as number[]) ?? [];
  const collision = (layers.find((l) => l.class === 'CollisionLayer')?.data as number[]) ?? [];
  // Walls are edges, painted on their own half-offset lattice layer (see
  // OfficeLayout.walls). Which layer a tile is on is the whole statement — a
  // a wall.
  const wallLatticeLayer = (layers.find((l) => l.class === 'WallLatticeLayer')?.data as number[]) ?? [];
  // North-wall face surface, cell-aligned on its own layer (see WallEdges.faces).
  const wallFaceLayer = (layers.find((l) => l.class === 'WallFaceLayer')?.data as number[]) ?? [];

  // Objects are classified by their own nature — a native Tiled field
  // (`text`/`image`, always present on Tiled's own Text/Image object types
  // regardless of any custom class) or a custom `type` class
  // (FurnitureObject/ActionArea, see Pixels.tiled-project) — never by which
  // named layer they happen to live in. Same robustness-to-reorganization
  // principle as the Ground layer's per-tile class below: export still
  // groups these into named layers (Furniture/Actions/Text/Images) purely
  // for a tidy Layers panel, but a mapper renaming/merging/splitting those
  // layers can't silently break the import.
  const allObjects = layers
    .filter((l) => l.type === 'objectgroup')
    .flatMap((l) => (l.objects as Array<Record<string, unknown>>) ?? []);
  // A tile object's GID always resolves back to a real FurnitureTile
  // (baked with its own `id`) via the registry, independent of whatever
  // class Tiled happens to have on the OBJECT itself — which matters
  // because dragging a furniture sprite straight from the Tilesets panel
  // onto the map (the natural, expected way to place furniture by hand in
  // Tiled) creates an object with a `gid` but NO class and NO properties at
  // all; only our own exporter's objects reliably carry `type:
  // 'FurnitureObject'`. Falling back to the tile's own class here means a
  // hand-placed sprite is still recognized as furniture instead of being
  // silently dropped — verified against a real hand-authored map where over
  // half the placed furniture had exactly this shape.
  const baseGid = (gid: unknown): number => {
    let raw = Number(gid) || 0;
    if (raw >= TILED_FLIP_H) raw -= TILED_FLIP_H;
    if (raw >= TILED_FLIP_V) raw -= TILED_FLIP_V;
    if (raw >= TILED_FLIP_D) raw -= TILED_FLIP_D;
    return raw;
  };
  const isFurnitureTileObject = (o: Record<string, unknown>): boolean => {
    const gid = baseGid(o.gid);
    return gid > 0 && resolveGid(gid)?.class === 'FurnitureTile';
  };
  // Same reasoning as isFurnitureTileObject: an image, being a real GID-
  // backed tile object from images.tsj now (see bake-images-tiled.mts), is
  // recognized by its tile's ImageTile class — not by a custom `type` on the
  // object, which a plain "Insert Tile" placement never sets either.
  const isImageTileObject = (o: Record<string, unknown>): boolean => {
    const gid = baseGid(o.gid);
    return gid > 0 && resolveGid(gid)?.class === 'ImageTile';
  };
  // Tiled's own `text` field is set structurally only by a genuine native
  // Text object (Insert Text) — never by a custom `type`/property, unlike
  // every other classification below. It wins outright over a stale/leftover
  // `type: 'Image'` (etc.) that a copy-pasted-then-retyped object can end up
  // dragging along from whatever it was copied from — confirmed against a
  // live map where two objects copy-pasted from an Image and then edited
  // into plain text labels still carried the old `type: 'Image'` + `imageId`
  // property, silently double-importing as a broken image AND a text label.
  const isTextObject = (o: Record<string, unknown>): boolean => o.text !== undefined;
  const furnitureObjects = allObjects.filter((o) => !isTextObject(o) && (o.type === 'FurnitureObject' || isFurnitureTileObject(o)));
  const actionObjects = allObjects.filter((o) => !isTextObject(o) && o.type === 'ActionArea');
  const textObjects = allObjects.filter(isTextObject);
  const imageObjects = allObjects.filter((o) => !isTextObject(o) && (o.type === 'Image' || isImageTileObject(o)));

  const tiles: number[] = [];
  const tileFloorSet: number[] = [];
  const tileBlocked: boolean[] = [];
  // Filled as tiles are met, so the layout ends up naming exactly the sets it
  // uses — see setIndexInto.
  const floorSets: string[] = [];
  const wallSets: string[] = [];
  /** Ground tiles a map paints that cannot be ground — reported once each. */
  const groundWarnings = new Set<string>();
  for (let i = 0; i < cols * rows; i++) {
    // Through baseGid like every other gid read: a flipped tile is still that
    // tile. Without this a mirrored floor tile resolved to nothing and the cell
    // silently became VOID — the same trap that swallowed painted wall pieces.
    const groundResolved = resolveGid(baseGid(ground[i]));
    // ANY grid tileset can be ground: the cell keeps the tile's own local id and
    // the set it came from, which is exactly what Tiled paints with. There used to
    // be a `class === 'FloorTile'` test here, and it was the reason a piece of an
    // imported art sheet painted on the GroundLayer silently became a hole — the
    // ground you could walk on was restricted to the baked palette sets, for no
    // reason the model needed. What a tile IS still decides everything else (a
    // WallTile belongs on the lattice layer, a decal on a DecalLayer); ground is
    // the one case where the LAYER is the whole statement.
    if (groundResolved && groundResolved.tileset.columns > 0 && groundFits(groundResolved.tileset, groundWarnings)) {
      tiles.push(groundResolved.localId);
      // Which set this came from — "which set" has no identity other than the
      // file (see setIndexInto).
      tileFloorSet.push(setIndexInto(floorSets, groundResolved.tileset.file));
    } else {
      if (groundResolved && groundResolved.tileset.columns === 0) {
        warnOnce(groundWarnings, `ground tile from "${groundResolved.tileset.file}": a collection-of-images tileset cannot be ground (it has no grid) — paint it on a DecalLayer instead`);
      }
      tiles.push(TileType.VOID);
      tileFloorSet.push(0);
    }
    tileBlocked.push(!!collision[i] && collision[i] !== 0);
  }

  /**
   * Rebuild the edge sets from the painted lattice tiles. A piece's own bitmask
   * IS the statement about which of the four edges at that point are wall, so a
   * painted tile sets those edges — union across lattice points, so two
   * neighbours that disagree about their shared edge both get their way rather
   * than one silently winning.
   *
   * Pieces past the bitmask range are the north-wall FACES: decorative wall
   * surface, not barriers, so they set no edges and are kept verbatim as a
   * latticePiece override. The barrier for a faced wall is the edge run the
   * mapper paints along its base.
   */
  const wallEdges = ((): NonNullable<OfficeLayout['walls']> => {
    const walls = emptyWallEdges(cols, rows);
    const latticeSet: number[] = new Array((cols + 1) * (rows + 1)).fill(0);
    const latticeColor: Array<number | null> = new Array((cols + 1) * (rows + 1)).fill(null);
    const latticePiece: Array<number | null> = new Array((cols + 1) * (rows + 1)).fill(null);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        // baseGid: a mapper mirroring a wall piece (Tiled's X/Y/Z while painting)
        // sets a flip bit, and the raw gid then matches no tileset range at all —
        // so the piece was dropped and that stretch of wall simply did not appear,
        // while the editor showed it perfectly. Costly to diagnose from a
        // screenshot; cheap to prevent here.
        const resolved = resolveGid(baseGid(wallLatticeLayer[r * cols + c]));
        // The LAYER is the statement, exactly as for ground: whatever is painted on
        // the lattice layer is a wall piece. This tested `class === 'WallTile'`
        // until that class was removed, and the test then silently dropped every
        // wall in the map — 262 edges gone, and only a re-import plus a count
        // caught it. A grid is still required: a piece is a ROW of a sheet.
        if (!resolved || resolved.tileset.columns <= 0) continue;
        const { row: piece, swatchIndex } = rowAndSwatchFromLocalId(resolved.localId, resolved.tileset.columns);
        const li = latticeIndex(cols, c, r);
        latticeSet[li] = setIndexInto(wallSets, resolved.tileset.file);
        latticeColor[li] = swatchIndex;
        // EVERY painted piece is recorded, not just the faces. The bitmask ones
        // used to be thrown away and re-derived from the edge set at render
        // time, and the derivation overshoots: an "east+west" piece asserts an
        // edge on BOTH sides, so the union of a painted run reaches one edge
        // past each end, and a stub appeared there that Tiled does not draw —
        // visible as a doorway looking narrower in game than in the editor.
        // Keeping the piece makes the lattice layer mean what it shows.
        latticePiece[li] = piece;
        if (piece >= WALL_BITMASK_COUNT) continue; // a face asserts no edges
        if (piece & 1 && r > 0) walls.vertical[vIndex(cols, c, r - 1)] = true; // N
        if (piece & 2) walls.horizontal[hIndex(cols, c, r)] = true; // E
        if (piece & 4 && r < rows) walls.vertical[vIndex(cols, c, r)] = true; // S
        if (piece & 8 && c > 0) walls.horizontal[hIndex(cols, c - 1, r)] = true; // W
      }
    }

    // Faces are read per cell off their own un-offset layer.
    const facePiece: Array<number | null> = new Array(cols * rows).fill(null);
    const faceSet: number[] = new Array(cols * rows).fill(0);
    const faceColor: Array<number | null> = new Array(cols * rows).fill(null);
    let anyFace = false;
    for (let i = 0; i < cols * rows; i++) {
      const resolved = resolveGid(baseGid(wallFaceLayer[i]));
      if (!resolved || resolved.tileset.columns <= 0) continue; // the layer says it is a face
      const { row: piece, swatchIndex } = rowAndSwatchFromLocalId(resolved.localId, resolved.tileset.columns);
      facePiece[i] = piece;
      faceSet[i] = setIndexInto(wallSets, resolved.tileset.file);
      faceColor[i] = swatchIndex;
      anyFace = true;
    }
    return {
      ...walls,
      latticeSet,
      latticeColor,
      latticePiece,
      ...(anyFace ? { faces: { piece: facePiece, set: faceSet, color: faceColor } } : {}),
    };
  })();

  const furniture: PlacedFurniture[] = furnitureObjects.map((obj, idx) => {
    const props: PropBag = Object.fromEntries(((obj.properties as TiledProp[]) ?? []).map((p) => [p.name, p.value]));
    // Identity comes from the GID — i.e. from the tile whose sprite you can
    // see — and an `id` property is read only when there is no GID at all (the
    // rectangle placeholder; see the matching export-side comment for why it
    // is no longer written otherwise). This ordering matters: with the property
    // winning, a hand-edited `id` repointed the placement while the canvas went
    // on showing the old sprite. The GID's flip bits are read back separately,
    // purely for `flippedHorizontally`/`flippedVertically` — an unrelated
    // concern either way.
    const rawGid = Number(obj.gid) || 0;
    const resolvedTile = rawGid > 0 ? resolveGid(baseGid(rawGid)) : null;
    const tileId = typeof resolvedTile?.props.id === 'string' ? resolvedTile.props.id : '';
    const id = tileId || (typeof props.id === 'string' ? props.id : '');
    if (tileId && typeof props.id === 'string' && props.id && props.id !== tileId) {
      console.warn(`[tiled] furniture object at ${obj.x},${obj.y} carries id "${props.id}" but its tile is "${tileId}" — the tile wins; delete the stale property`);
    }
    const entry = getCatalogEntry(id);
    const hasGid = rawGid > 0;
    // The size Tiled shows. Stored only when it differs from the art, so an ordinary
    // placement stays as small on the wire as it always was.
    const objW = Math.round(Number(obj.width) || 0);
    const objH = Math.round(Number(obj.height) || 0);
    const sized = entry !== undefined && objW > 0 && objH > 0 && (objW !== entry.width || objH !== entry.height);
    const drawnH = sized ? objH : (entry?.height ?? TILE_SIZE);
    const col = Math.round(Number(obj.x) / TILE_SIZE);
    const row = hasGid ? rowFromTileObjectY(Number(obj.y), drawnH) : Math.round(Number(obj.y) / TILE_SIZE);
    if (sized) {
      console.log(`[tiled] ${id} at ${col},${row} is placed at ${objW}×${objH}, its art is ${entry.width}×${entry.height} — drawn and occupying cells at the placed size`);
    }
    // zOffset comes purely from this object's position in Tiled's own
    // Furniture object list (drag to reorder there) — no stored property,
    // per docs/design.md.
    const item: PlacedFurniture = {
      uid: generateUid(),
      id,
      col,
      row,
      ...(sized ? { width: objW, height: objH } : {}),
      zOffset: idx,
    };
    {
      let flipBits = rawGid;
      if (flipBits >= TILED_FLIP_H) {
        item.flippedHorizontally = true;
        flipBits -= TILED_FLIP_H;
      }
      if (flipBits >= TILED_FLIP_V) item.flippedVertically = true;
    }
    // The native Tiled object Name, not a custom property.
    if (typeof obj.name === 'string' && obj.name) item.name = obj.name;
    // Likewise opacity: Tiled writes it on every object itself, so there is no
    // property to declare and a mapper just uses the Properties panel's own
    // field. Only a real reduction is stored — 1 is the absence of an override.
    const objOpacity = Number(obj.opacity);
    if (Number.isFinite(objOpacity) && objOpacity >= 0 && objOpacity < 1) item.opacity = objOpacity;
    if (typeof props.approachSides === 'string' && props.approachSides) {
      item.approachSides = props.approachSides.split(',').filter((s): s is 'N' | 'S' | 'E' | 'W' => ['N', 'S', 'E', 'W'].includes(s));
    }
    if (props.approachThrough === true) item.approachThrough = true;
    const action = actionFromProps(props);
    if (action) item.action = action;
    // Read from this OBJECT's own properties only, never the tile's — the tile's
    // values are the catalog default that these would override, and copying them
    // down onto the placement would freeze them there.
    Object.assign(item, furnitureBehaviourFromObject(props));
    return item;
  });

  /**
   * Painted map art — every DecalLayer of the map, cell by cell (see PlacedDecal).
   *
   * `filter`, not `find`: a tile-layer cell holds ONE tile, so stacking a flower
   * onto a grass patch needs a second layer, which is ordinary practice in Tiled.
   * Layers are read in the order the map lists them and the result keeps that
   * order, which is the stacking order for flat decals (see DECAL_DEPTH).
   *
   * Each layer's own `occludes` property decides how everything painted on it
   * sorts, and is copied onto every cell here — the layer does not survive the
   * import, and the same art on a flat and a standing layer has to be able to
   * disagree. Read off the LAYER and never off the tile, so that whether a thing
   * is background or an obstacle stays a decision about the place rather than
   * about the picture (see tiled/decalProps.ts).
   *
   * Position: Tiled anchors an oversized tile at its cell's BOTTOM edge, growing
   * upwards, while PlacedDecal/PlacedFurniture store the top-left cell — so the
   * sprite's own height converts one into the other. Getting this wrong would
   * make a map render differently in the game than it looks in the editor, which
   * is the one thing the whole Tiled path exists to prevent.
   */
  const decals: PlacedDecal[] = [];
  for (const layer of layers.filter((l) => l.class === 'DecalLayer')) {
    const data = layer.data as number[] | undefined;
    if (!Array.isArray(data)) continue; // an empty or non-tile layer carrying the class
    const layerProps: PropBag = Object.fromEntries(
      ((layer.properties as TiledProp[]) ?? []).map((p) => [p.name, p.value]),
    );
    const occludes = layerProps[DECAL_LAYER_OCCLUDES] === true;
    for (let i = 0; i < Math.min(data.length, cols * rows); i++) {
      const rawGid = Number(data[i]) || 0;
      if (rawGid === 0) continue;
      const resolved = resolveGid(baseGid(rawGid));
      const id = typeof resolved?.props.id === 'string' ? resolved.props.id : '';
      if (!id) continue;
      if (resolved?.class !== DECAL_TILE_CLASS) {
        // Painting furniture art onto a decal layer is allowed — that IS how a
        // purely decorative item stops being a synced object — but anything the
        // tile declared about behaviour is gone, and silently losing a sittable
        // chair or a working portal would be baffling. Loud, not fatal.
        const declares = DECLARED_BEHAVIOUR.filter((k) => {
          const v = resolved?.props[k];
          return v === true || (typeof v === 'string' && v !== '') || (typeof v === 'number' && v !== 0);
        });
        if (declares.length > 0) {
          console.warn(
            `[tiled] "${id}" is painted on decal layer "${String(layer.name ?? '')}" but declares ${declares.join(', ')} — ` +
              'a decal is art only: no behaviour, no collision (paint the CollisionLayer for that). ' +
              'Place it as a Furniture object if you want the behaviour.',
          );
        }
      }
      const entry = getCatalogEntry(id);
      // From the art's real height, NOT footprintH: that one is clamped to 16
      // tiles (footprintOf), and Tiled anchors by the image's actual height, so a
      // taller decal would land in the wrong row. The rounding is safe because a
      // sliced item is always padded to whole tiles (see scripts/lib/sheetSlice.mts).
      const spriteRows = entry ? Math.max(1, Math.round(entry.height / TILE_SIZE)) : 1;
      const decal: PlacedDecal = {
        id,
        col: i % cols,
        row: Math.floor(i / cols) - (spriteRows - 1),
        ...(occludes ? { occludes: true } : {}),
      };
      let flipBits = rawGid;
      if (flipBits >= TILED_FLIP_H) {
        decal.flippedHorizontally = true;
        flipBits -= TILED_FLIP_H;
      }
      if (flipBits >= TILED_FLIP_V) decal.flippedVertically = true;
      decals.push(decal);
    }
  }

  const tileActions: Array<Action | null> = new Array(cols * rows).fill(null);
  for (const obj of actionObjects) {
    const props: PropBag = Object.fromEntries(((obj.properties as TiledProp[]) ?? []).map((p) => [p.name, p.value]));
    const action = actionFromProps(props);
    if (!action) continue;
    // Position IS the data — see the matching export-side comment; never
    // read a stored col/row property (Tiled wouldn't have kept it in sync
    // with a dragged or resized object anyway). Works for either shape: a
    // Point's x/y is its tile's CENTER (see export), so floor() lands on
    // the same tile either way; a Rectangle's x/y is its top-left corner,
    // and its width/height (rounded to whole tiles, minimum one) give the
    // covered range — every tile in that range gets this action. Objects
    // are applied in Tiled's own list order, so a later, more specific
    // shape overriding part of an earlier, larger one wins — same
    // last-write-wins precedent as furniture zOffset-by-list-position.
    const col0 = Math.floor(Number(obj.x) / TILE_SIZE);
    const row0 = Math.floor(Number(obj.y) / TILE_SIZE);
    const wTiles = obj.point === true ? 1 : Math.max(1, Math.round(Number(obj.width) / TILE_SIZE));
    const hTiles = obj.point === true ? 1 : Math.max(1, Math.round(Number(obj.height) / TILE_SIZE));
    for (let row = row0; row < row0 + hTiles; row++) {
      for (let col = col0; col < col0 + wTiles; col++) {
        if (col >= 0 && col < cols && row >= 0 && row < rows) tileActions[row * cols + col] = action;
      }
    }
  }

  const texts: PlacedText[] = textObjects.map((obj) => {
    const textData = (obj.text as Record<string, unknown>) ?? {};
    // Reverse of the export box-centering above — use the object's own
    // width/height (a user may have resized the text box in Tiled) rather
    // than assuming the fixed default size.
    const boxW = Number(obj.width) || 8 * TILE_SIZE;
    const boxH = Number(obj.height) || 2 * TILE_SIZE;
    const t: PlacedText = {
      uid: generateUid(),
      x: Number(obj.x) + boxW / 2,
      y: Number(obj.y) + boxH,
      text: typeof textData.text === 'string' ? textData.text : '',
    };
    if (typeof textData.fontfamily === 'string') t.fontFamily = textData.fontfamily;
    if (typeof textData.pixelsize === 'number') t.fontSize = textData.pixelsize;
    if (typeof textData.color === 'string') {
      const rgb = tiledColorToRgbHex(textData.color);
      if (rgb) t.color = rgb;
    }
    if (typeof obj.rotation === 'number' && obj.rotation) t.angle = ((obj.rotation as number) % 360 + 360) % 360;
    return t;
  });

  const images: PlacedImage[] = [];
  const importedImages: TmjImportResult['images'] = [];
  for (const obj of imageObjects) {
    const props: PropBag = Object.fromEntries(((obj.properties as TiledProp[]) ?? []).map((p) => [p.name, p.value]));
    const rawGid = Number(obj.gid) || 0;
    const resolvedTile = rawGid > 0 ? resolveGid(baseGid(rawGid)) : null;
    // Same "own property wins, tile's baked one is the fallback" precedent
    // as furniture's `id` — a plain Insert Tile placement carries no
    // properties of its own at all, only the tile's.
    // Third fallback, and the one a mapper actually hits: the tile's own file
    // name. Adding a tile in Tiled's Tileset editor that points at a PNG is the
    // natural way to place a picture, and Tiled writes no custom property for
    // it — so requiring `imageId` silently dropped exactly that placement. The
    // file name is a perfectly good id, and it is what bake-images-tiled.mts
    // names its own tiles after anyway.
    const imageId =
      (typeof props.imageId === 'string' && props.imageId ? props.imageId : '') ||
      (typeof resolvedTile?.props.imageId === 'string' ? resolvedTile.props.imageId : '') ||
      imageIdFromPath(resolvedTile?.image);
    if (!imageId) continue;
    const height = Number(obj.height) || TILE_SIZE;
    // Prefer the tile's own declared `image` path — a mapper can add a tile
    // straight in Tiled's Tileset editor (Edit Tileset → Add Tiles) pointing
    // at whatever file they picked, entirely bypassing bake-images-tiled.mts
    // and its png/src/images/<imageId>.png convention; that convention is only a
    // fallback for the cases with no such tile at all (a bare `type: 'Image'`
    // object with no gid). readImageFile resolves both against assets/tiled
    // itself, never zone-relative (see zoneImport.ts).
    const buffer = readImageFile(resolvedTile?.image ?? `png/src/images/${imageId}.png`);
    if (buffer) importedImages.push({ imageId, label: imageId, buffer });
    const image: PlacedImage = {
      uid: generateUid(),
      x: Number(obj.x) || 0,
      // Same bottom-edge Y anchor as any other GID-backed tile object — see
      // the matching export-side conversion. No rounding: the exact pixel
      // box Tiled shows is exactly what's stored.
      y: (Number(obj.y) || 0) - height,
      width: Number(obj.width) || TILE_SIZE,
      height,
      imageId,
    };
    const imgOpacity = Number(obj.opacity);
    if (Number.isFinite(imgOpacity) && imgOpacity >= 0 && imgOpacity < 1) image.opacity = imgOpacity;
    // Decode both flip bits independently — strip H first so a lingering H
    // bit can't be mistaken for V (H > V, so any H-flipped gid is already
    // >= TILED_FLIP_V on its own).
    let flipBits = rawGid;
    if (flipBits >= TILED_FLIP_H) {
      image.flippedHorizontally = true;
      flipBits -= TILED_FLIP_H;
    }
    if (flipBits >= TILED_FLIP_V) image.flippedVertically = true;
    images.push(image);
  }

  const layout: OfficeLayout = {
    version: 2,
    cols,
    rows,
    tiles,
    furniture,
    tileFloorSet,
    floorSets,
    wallSets,
    walls: wallEdges,
    tileBlocked,
    tileActions,
    texts,
    images,
    // Left out entirely when the map paints none, so a layout only carries what
    // its map actually has (same as the optional fields above).
    ...(decals.length > 0 ? { decals } : {}),
  };
  return { layout, images: importedImages, mapName };
}
