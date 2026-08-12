/**
 * OfficeLayout ↔ Tiled .tmj bridge (task #157, see
 * docs/design/tiled-editor-integration.md). OfficeLayout stays the runtime
 * schema forever — .tmj is a pure edit-time export/import round-trip, not a
 * second source of truth. Written fresh; does not reuse the rejected
 * office/tiled-schema branch's scripts.
 *
 * Known, disclosed simplifications (not yet verified against a live Tiled
 * instance — same caveat as task #156's Wang sets):
 * - Tile Object Y anchor is assumed to be the tile's BOTTOM edge (Tiled's
 *   documented convention) — see tileObjectY/rowFromTileObjectY, the one
 *   place this assumption lives.
 * - Furniture types with no Tiled tileset representation (the server-
 *   generated portal/conference/arcade/meetingRoom/logo catalog entries —
 *   drawn in code, never baked into a .tsj) export as a plain (non-tile)
 *   rectangle Object carrying just a `type` property — round-trips exactly,
 *   just isn't visually a real sprite inside Tiled's own canvas.
 */
import type { Action, OfficeLayout, PlacedFurniture, PlacedImage, PlacedText } from '@pixel/shared/office/types.js';
import { TileType } from '@pixel/shared/office/types.js';
import { TILE_SIZE } from '@pixel/shared/office/constants.js';
import { getCatalogEntry } from '@pixel/shared/office/layout/furnitureCatalog.js';

import { findGid, gidAt, resolveFromTmjTilesets, type TiledRegistry } from './tiledRegistry.js';
import { prop, actionProps, actionFromProps, actionsEqual, type TiledProp, type PropBag } from './actionProps.js';
import { FLOOR_SET_FILES, TILED_SHEET_COLUMNS, WALL_SET_FILES } from '@pixel/shared/office/tiledSheetLayout.js';

export interface TmjExportResult {
  tmj: Record<string, unknown>;
}

/** N=1,E=2,S=4,W=8 — same convention as shared/src/office/wallTiles.ts's
 *  buildWallMask, reimplemented against OfficeLayout's flat tiles[] instead
 *  of a 2D tileMap (only used to pick a human-friendly Wang-matching GID on
 *  export; imports never read this value back — the live renderer always
 *  recomputes the correct piece from neighbors regardless of which exact
 *  bitmask GID a wall cell references). */
function wallBitmask(layout: OfficeLayout, col: number, row: number): number {
  const { cols, rows, tiles } = layout;
  const at = (c: number, r: number) => tiles[r * cols + c];
  let mask = 0;
  if (row > 0 && at(col, row - 1) === TileType.WALL) mask |= 1;
  if (col < cols - 1 && at(col + 1, row) === TileType.WALL) mask |= 2;
  if (row < rows - 1 && at(col, row + 1) === TileType.WALL) mask |= 4;
  if (col > 0 && at(col - 1, row) === TileType.WALL) mask |= 8;
  return mask;
}

/** Tiled's own GID flip bits (top two bits of the 32-bit GID field) — plain
 *  addition/subtraction, not a bitwise op: these GIDs are always far below
 *  2^31, and JS's bitwise operators coerce to signed Int32 first, which
 *  would turn 0x80000000/0x40000000 negative. Only H/V are used (see
 *  PlacedFurniture/PlacedImage's flippedHorizontally/flippedVertically) —
 *  Tiled's third bit (diagonal flip, 0x20000000) has no corresponding
 *  concept here and is never set or read. */
const TILED_FLIP_H = 0x80000000;
const TILED_FLIP_V = 0x40000000;

/** `flippedHorizontally`/`flippedVertically` (see PlacedFurniture) map
 *  directly onto Tiled's own GID flip bits — purely cosmetic, so Tiled's
 *  canvas shows the real (mirrored) sprite instead of drawing the unflipped
 *  one. `id` (see the export/import properties block) already carries the
 *  true identity independent of this; the GID here is only ever consulted
 *  for *display*. */
function findFurnitureGid(registry: TiledRegistry, id: string, flippedHorizontally: boolean, flippedVertically: boolean): number | null {
  const direct = findFurnitureGidExact(registry, id);
  if (direct === null) return null;
  return direct + (flippedHorizontally ? TILED_FLIP_H : 0) + (flippedVertically ? TILED_FLIP_V : 0);
}

function findFurnitureGidExact(registry: TiledRegistry, id: string): number | null {
  for (const ts of registry.tilesets) {
    if (!ts.file.startsWith('furniture-')) continue;
    const localId = ts.tiles.findIndex((t) => t.props.id === id);
    if (localId >= 0) return ts.firstgid + localId;
  }
  return null;
}

/** Tiled's documented Tile Object convention: (x,y) is the BOTTOM-LEFT
 *  corner of the tile's image, not top-left like every other object type. */
function tileObjectY(row: number, footprintH: number): number {
  return (row + footprintH) * TILE_SIZE;
}
function rowFromTileObjectY(y: number, footprintH: number): number {
  return Math.round(y / TILE_SIZE) - footprintH;
}

export function exportLayoutToTmj(layout: OfficeLayout, registry: TiledRegistry, zoneId: string): TmjExportResult {
  const { cols, rows, tiles } = layout;

  // ── Ground layer: floor/wall GIDs, GID 0 = VOID ──────────────────
  // GID is computed directly from position — no property search needed.
  // Column 0 = Natural, column 1+i = PALETTE_64[i] (see tiledSheetLayout.ts);
  // row = pattern-1 (floor) or bitmask (wall) — exactly how
  // bake-floor-wall-tiled.mts lays the sheet out.
  const ground: number[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const t = tiles[r * cols + c];
      const swatchIdx = layout.tileColors?.[r * cols + c] ?? null;
      const col = swatchIdx === null ? 0 : swatchIdx + 1;
      if (t === TileType.VOID) {
        ground.push(0);
      } else if (t === TileType.WALL) {
        const mask = wallBitmask(layout, c, r);
        const wallSet = WALL_SET_FILES[layout.tileWallSet?.[r * cols + c] ?? 0] ?? WALL_SET_FILES[0];
        ground.push(gidAt(registry, `${wallSet}.tsj`, mask * TILED_SHEET_COLUMNS + col) ?? 0);
      } else {
        const floorSet = FLOOR_SET_FILES[layout.tileFloorSet?.[r * cols + c] ?? 0] ?? FLOOR_SET_FILES[0];
        ground.push(gidAt(registry, `${floorSet}.tsj`, (t - 1) * TILED_SHEET_COLUMNS + col) ?? 0);
      }
    }
  }

  // ── Collision layer: tileBlocked, parameterless marker tile ──────
  const collisionGid = findGid(registry, 'collision.tsj', () => true) ?? 0;
  const collision: number[] = [];
  for (let i = 0; i < cols * rows; i++) collision.push(layout.tileBlocked?.[i] ? collisionGid : 0);

  // ── Furniture: tile objects (or a plain rect fallback), list order = stacking ──
  const orderedFurniture = [...layout.furniture]
    .map((f, i) => ({ f, i }))
    .sort((a, b) => (a.f.zOffset ?? 0) - (b.f.zOffset ?? 0) || a.i - b.i)
    .map(({ f }) => f);

  const furnitureObjects = orderedFurniture.map((item, idx) => {
    const entry = getCatalogEntry(item.id);
    const fw = entry?.footprintW ?? 1;
    const fh = entry?.footprintH ?? 1;
    const gid = findFurnitureGid(registry, item.id, !!item.flippedHorizontally, !!item.flippedVertically);
    // Every field always present (even empty/0/false) — see actionProps's
    // own note; the same "discoverable, not just whatever was set" reasoning
    // applies to approachSides/name here. No `uid` (regenerated fresh on
    // every import, see importTmjToLayout) and no `zOffset` (stacking comes
    // purely from this object's position in the list — see orderedFurniture
    // above and its import-side counterpart) — both dropped per
    // docs/design/tiled-editor-integration.md. `id` IS always written, even
    // when a GID is also set (yes, Tiled then shows the same value twice —
    // once inherited from the tile, once as this explicit property) — the
    // GID's only job is picking the right sprite + flip state to *display*;
    // making identity depend on resolving it back through the registry was
    // needless indirection when the object can just say what it is directly.
    // Import reads `id` as a flat property lookup, full stop.
    const properties: TiledProp[] = [
      prop('id', item.id),
      prop('name', item.name ?? ''),
      prop('approachSides', item.approachSides && item.approachSides.length ? item.approachSides.join(',') : '', 'ApproachSide'),
      prop('approachThrough', !!item.approachThrough),
      ...actionProps(item.action ?? null),
    ];

    const base = {
      id: idx + 1,
      name: item.name ?? '',
      type: 'FurnitureObject',
      visible: true,
      x: item.col * TILE_SIZE,
      width: fw * TILE_SIZE,
      height: fh * TILE_SIZE,
      rotation: 0,
      properties,
    };
    if (gid !== null) {
      return { ...base, gid, y: tileObjectY(item.row, fh) };
    }
    // No Tiled tileset backs this id (server-generated furniture) — a
    // plain rectangle placeholder, top-left anchored like every other
    // non-tile object; round-trips via the `id` property either way.
    return { ...base, y: item.row * TILE_SIZE };
  });

  // ── Actions: one Rectangle per maximal solid same-action block, else one
  // Point per tile — a mapper filling a big area (e.g. a meeting room) gets
  // one clean shape instead of one dot per tile; an irregular/hand-painted
  // shape still round-trips exactly via individual points, exactly like
  // every ActionArea did before rectangle support existed. "Solid" means the
  // 4-connected same-action component's cell count equals its own bounding
  // box's area — i.e. there's no gap or different action anywhere inside
  // that box. Position IS the data either way — col/row (or the covered
  // range) are derived from x/y/width/height on import, never stored as
  // their own properties: Tiled doesn't update custom properties when an
  // object is dragged or resized, so a stored col/row would silently go
  // stale the moment someone moves or resizes the shape.
  const actionObjects: Array<Record<string, unknown>> = [];
  {
    const tileActions = layout.tileActions ?? [];
    const total = cols * rows;
    const visited = new Uint8Array(total);
    const stack: number[] = [];
    for (let start = 0; start < total; start++) {
      const startAction = tileActions[start];
      if (visited[start] || !startAction) continue;
      const component: number[] = [start];
      visited[start] = 1;
      stack.push(start);
      let minCol = start % cols;
      let maxCol = minCol;
      let minRow = Math.floor(start / cols);
      let maxRow = minRow;
      while (stack.length > 0) {
        const idx = stack.pop()!;
        const c = idx % cols;
        const r = Math.floor(idx / cols);
        const neighbors = [
          r > 0 ? idx - cols : -1,
          r < rows - 1 ? idx + cols : -1,
          c > 0 ? idx - 1 : -1,
          c < cols - 1 ? idx + 1 : -1,
        ];
        for (const n of neighbors) {
          if (n >= 0 && !visited[n] && actionsEqual(tileActions[n] ?? null, startAction)) {
            visited[n] = 1;
            component.push(n);
            stack.push(n);
            const nc = n % cols;
            const nr = Math.floor(n / cols);
            if (nc < minCol) minCol = nc;
            if (nc > maxCol) maxCol = nc;
            if (nr < minRow) minRow = nr;
            if (nr > maxRow) maxRow = nr;
          }
        }
      }
      const boxCols = maxCol - minCol + 1;
      const boxRows = maxRow - minRow + 1;
      // A lone tile (1x1) stays a Point — a tiny rectangle sitting exactly on
      // the tile's own edges is harder to spot/grab in Tiled than a dot, and
      // single-tile actions (a portal, an appliance) are the common case.
      if ((boxCols > 1 || boxRows > 1) && component.length === boxCols * boxRows) {
        actionObjects.push({
          id: 0, // renumbered below
          name: '',
          type: 'ActionArea',
          x: minCol * TILE_SIZE,
          y: minRow * TILE_SIZE,
          width: boxCols * TILE_SIZE,
          height: boxRows * TILE_SIZE,
          rotation: 0,
          properties: actionProps(startAction),
        });
      } else {
        for (const idx of component) {
          const c = idx % cols;
          const r = Math.floor(idx / cols);
          actionObjects.push({
            id: 0, // renumbered below
            name: '',
            type: 'ActionArea',
            point: true,
            x: c * TILE_SIZE + TILE_SIZE / 2,
            y: r * TILE_SIZE + TILE_SIZE / 2,
            width: 0,
            height: 0,
            rotation: 0,
            properties: actionProps(startAction),
          });
        }
      }
    }
  }
  actionObjects.forEach((o, i) => (o.id = i + 1));

  // ── Text: native Tiled text objects ───────────────────────────────
  // Our own anchor is free (bottom-center of the label, see PlacedText) while
  // Tiled anchors a text object at its box's top-left — convert by centering
  // a fixed-size box under the anchor point (approximate, same as before this
  // became free-positioned: Tiled's own left/top text alignment inside that
  // box was never pixel-exact with the renderer's centered layout either).
  const TEXT_BOX_W = 8 * TILE_SIZE;
  const TEXT_BOX_H = 2 * TILE_SIZE;
  const textObjects = (layout.texts ?? []).map((t, idx) => ({
    id: idx + 1,
    name: '',
    type: '',
    x: t.x - TEXT_BOX_W / 2,
    y: t.y - TEXT_BOX_H,
    width: TEXT_BOX_W,
    height: TEXT_BOX_H,
    rotation: t.angle ?? 0,
    visible: true,
    text: {
      text: t.text,
      ...(t.fontFamily ? { fontfamily: t.fontFamily } : {}),
      ...(t.fontSize ? { pixelsize: t.fontSize } : {}),
      wrap: true,
    },
    properties: [],
  }));

  // ── Images: real GID-backed tile objects from images.tsj (see
  // bake-images-tiled.mts) — Tiled's object format has no "standalone image
  // file" field (only gid or text), so this is the only shape Tiled itself
  // can actually create (via Insert Tile against that tileset); a bare
  // object with a custom `image` property was never a real Tiled mechanism.
  // Same bottom-edge Y anchor as any other GID-backed tile object (see
  // tileObjectY) — Tiled anchors tile objects at their bottom-left corner,
  // not top-left like every other shape. An image whose id isn't in
  // images.tsj (not yet baked since it was uploaded) is skipped, matching
  // the live renderer's own skip for a deleted image.
  const imageObjects = (layout.images ?? []).flatMap((im, idx) => {
    const baseGid = findGid(registry, 'images.tsj', (props) => props.imageId === im.imageId);
    if (baseGid === null) return [];
    const gid = baseGid + (im.flippedHorizontally ? TILED_FLIP_H : 0) + (im.flippedVertically ? TILED_FLIP_V : 0);
    return [
      {
        id: idx + 1,
        name: '',
        type: 'Image',
        gid,
        x: im.col * TILE_SIZE,
        y: tileObjectY(im.row, im.footprintH),
        width: im.footprintW * TILE_SIZE,
        height: im.footprintH * TILE_SIZE,
        rotation: 0,
        visible: true,
        properties: [prop('imageId', im.imageId)],
      },
    ];
  });

  const tilesetRefs = registry.tilesets.map((ts) => ({ firstgid: ts.firstgid, source: `../${ts.file}` }));

  const tmj: Record<string, unknown> = {
    compressionlevel: -1,
    width: cols,
    height: rows,
    tilewidth: TILE_SIZE,
    tileheight: TILE_SIZE,
    infinite: false,
    orientation: 'orthogonal',
    renderorder: 'right-down',
    tiledversion: '1.11.0',
    type: 'map',
    class: 'Map',
    version: '1.10',
    nextlayerid: 6,
    nextobjectid: furnitureObjects.length + actionObjects.length + textObjects.length + imageObjects.length + 1,
    // The Pixel Agents zone this map belongs to — read back on import
    // instead of trusting the .tmj's own filename (same class-not-container
    // principle as everywhere else in this bridge; see
    // docs/design/tiled-custom-properties-reference.md's Map class).
    properties: [prop('mapName', zoneId)],
    tilesets: tilesetRefs,
    layers: [
      { id: 1, name: 'Ground', class: 'GroundLayer', type: 'tilelayer', width: cols, height: rows, x: 0, y: 0, opacity: 1, visible: true, data: ground },
      { id: 2, name: 'Collision', class: 'CollisionLayer', type: 'tilelayer', width: cols, height: rows, x: 0, y: 0, opacity: 0.5, visible: true, data: collision },
      { id: 3, name: 'Furniture', type: 'objectgroup', draworder: 'index', opacity: 1, visible: true, x: 0, y: 0, objects: furnitureObjects },
      { id: 4, name: 'Actions', type: 'objectgroup', draworder: 'index', opacity: 1, visible: true, x: 0, y: 0, objects: actionObjects },
      { id: 5, name: 'Text', type: 'objectgroup', draworder: 'index', opacity: 1, visible: true, x: 0, y: 0, objects: textObjects },
      { id: 6, name: 'Images', type: 'objectgroup', draworder: 'index', opacity: 1, visible: true, x: 0, y: 0, objects: imageObjects },
    ],
  };

  return { tmj };
}

/** Every imported item gets a fresh identity — `uid` is purely internal
 *  engine plumbing (station claims, on/off toggle state, editor selection;
 *  see officeState.ts/LayoutEditor.ts), never something a Tiled edit needs
 *  to preserve across a round-trip. Not exported as a property at all. */
function generateUid(): string {
  return `imported_${Math.random().toString(36).slice(2, 10)}`;
}

/** Derive (row, swatch index) from a resolved tile's position within its
 *  tileset — the import-side counterpart to the export's gidAt() arithmetic.
 *  Column 0 = Natural (null), column 1+i = PALETTE_64[i]; row = pattern-1
 *  (floor) or bitmask (wall). Positional, not property-based: floor.tsj/
 *  wall-*.tsj are entirely machine-generated (bake-floor-wall-tiled.mts), so
 *  their tile order is exactly as reliable as a stored property would be,
 *  with nothing to keep in sync. */
function rowAndSwatchFromLocalId(localId: number): { row: number; swatchIndex: number | null } {
  const row = Math.floor(localId / TILED_SHEET_COLUMNS);
  const col = localId % TILED_SHEET_COLUMNS;
  return { row, swatchIndex: col === 0 ? null : col - 1 };
}

/** Which set (0, 1, 2, …) a FloorTile/WallTile GID resolved to, from its
 *  tileset's own filename (e.g. "wall-1-warm.tsj" + WALL_SET_FILES → 3).
 *  Unrecognized files (shouldn't happen — every FloorTile/WallTile lives in
 *  one of these by construction) fall back to 0. */
function setIndexFromFile(files: string[], file: string): number {
  const idx = files.indexOf(file.replace(/\.tsj$/, ''));
  return idx >= 0 ? idx : 0;
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

  // Classified by the layer's own `class` (GroundLayer/CollisionLayer — see
  // Pixels.tiled-project), not by name — same reasoning as the object
  // classification below: a mapper renaming these tile layers must not
  // silently empty out the whole map. Tiled writes a layer's custom class
  // under `class` specifically (not `type`, which every layer already uses
  // structurally for tilelayer/objectgroup/imagelayer/group).
  const ground = (layers.find((l) => l.class === 'GroundLayer')?.data as number[]) ?? [];
  const collision = (layers.find((l) => l.class === 'CollisionLayer')?.data as number[]) ?? [];

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
  const tileColors: OfficeLayout['tileColors'] = [];
  const tileFloorSet: number[] = [];
  const tileWallSet: number[] = [];
  const tileWallMask: OfficeLayout['tileWallMask'] = [];
  const tileBlocked: boolean[] = [];
  for (let i = 0; i < cols * rows; i++) {
    const gid = ground[i] ?? 0;
    const resolved = resolveGid(gid);
    // Classify by Tiled's own `class` (FloorTile/WallTile — see
    // Pixels.tiled-project), not by which file a tile lives in — a mapper
    // reorganizing tileset files must not silently break this (see
    // docs/design/tiled-editor-integration.md).
    if (resolved?.class === 'WallTile') {
      tiles.push(TileType.WALL);
      const { row, swatchIndex } = rowAndSwatchFromLocalId(resolved.localId);
      tileColors.push(swatchIndex);
      tileFloorSet.push(0);
      // Which set this came from — unlike the floor/wall/void classification
      // above, this one legitimately IS about the file, since "which set"
      // has no other identity (see setIndexFromFile).
      tileWallSet.push(setIndexFromFile(WALL_SET_FILES, resolved.tileset.file));
      // The exact autotile piece the mapper placed (see OfficeLayout.
      // tileWallMask) — rendered verbatim, not re-derived from adjacency.
      tileWallMask.push(row);
    } else if (resolved?.class === 'FloorTile') {
      const { row, swatchIndex } = rowAndSwatchFromLocalId(resolved.localId);
      tiles.push(row + 1);
      tileColors.push(swatchIndex);
      tileFloorSet.push(setIndexFromFile(FLOOR_SET_FILES, resolved.tileset.file));
      tileWallSet.push(0);
      tileWallMask.push(null);
    } else {
      tiles.push(TileType.VOID);
      tileColors.push(null);
      tileFloorSet.push(0);
      tileWallSet.push(0);
      tileWallMask.push(null);
    }
    tileBlocked.push(!!collision[i] && collision[i] !== 0);
  }

  const furniture: PlacedFurniture[] = furnitureObjects.map((obj, idx) => {
    const props: PropBag = Object.fromEntries(((obj.properties as TiledProp[]) ?? []).map((p) => [p.name, p.value]));
    // Identity is normally a flat property read (always present — see the
    // matching export-side comment), independent of the GID entirely. But a
    // sprite dragged straight from the Tilesets panel (see
    // isFurnitureTileObject above) carries no properties at all, so fall
    // back to the `id` already baked onto the FurnitureTile itself — the
    // GID still says exactly what this is, just indirectly instead of
    // redundantly. The GID's flip bits are read back separately, purely for
    // `flippedHorizontally`/`flippedVertically` — an unrelated concern either way.
    const rawGid = Number(obj.gid) || 0;
    const resolvedTile = rawGid > 0 ? resolveGid(baseGid(rawGid)) : null;
    const id = typeof props.id === 'string' && props.id ? props.id : typeof resolvedTile?.props.id === 'string' ? resolvedTile.props.id : '';
    const entry = getCatalogEntry(id);
    const fh = entry?.footprintH ?? 1;
    const hasGid = rawGid > 0;
    const col = Math.round(Number(obj.x) / TILE_SIZE);
    const row = hasGid ? rowFromTileObjectY(Number(obj.y), fh) : Math.round(Number(obj.y) / TILE_SIZE);
    // zOffset comes purely from this object's position in Tiled's own
    // Furniture object list (drag to reorder there) — no stored property,
    // per docs/design/tiled-editor-integration.md.
    const item: PlacedFurniture = {
      uid: generateUid(),
      id,
      col,
      row,
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
    if (typeof props.name === 'string' && props.name) item.name = props.name;
    if (typeof props.approachSides === 'string' && props.approachSides) {
      item.approachSides = props.approachSides.split(',').filter((s): s is 'N' | 'S' | 'E' | 'W' => ['N', 'S', 'E', 'W'].includes(s));
    }
    if (props.approachThrough === true) item.approachThrough = true;
    const action = actionFromProps(props);
    if (action) item.action = action;
    return item;
  });

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
    const imageId = typeof props.imageId === 'string' && props.imageId ? props.imageId : typeof resolvedTile?.props.imageId === 'string' ? resolvedTile.props.imageId : null;
    if (!imageId) continue;
    const footprintH = Math.max(1, Math.round(Number(obj.height) / TILE_SIZE));
    // Prefer the tile's own declared `image` path — a mapper can add a tile
    // straight in Tiled's Tileset editor (Edit Tileset → Add Tiles) pointing
    // at whatever file they picked, entirely bypassing bake-images-tiled.mts
    // and its png/images/<imageId>.png convention; that convention is only a
    // fallback for the cases with no such tile at all (a bare `type: 'Image'`
    // object with no gid). readImageFile resolves both against assets/tiled
    // itself, never zone-relative (see zoneImport.ts).
    const buffer = readImageFile(resolvedTile?.image ?? `png/images/${imageId}.png`);
    if (buffer) importedImages.push({ imageId, label: imageId, buffer });
    const image: PlacedImage = {
      uid: generateUid(),
      col: Math.round(Number(obj.x) / TILE_SIZE),
      // Same bottom-edge Y anchor as any other GID-backed tile object — see
      // the matching export-side tileObjectY call.
      row: rowFromTileObjectY(Number(obj.y), footprintH),
      footprintW: Math.max(1, Math.round(Number(obj.width) / TILE_SIZE)),
      footprintH,
      imageId,
    };
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
    version: 1,
    cols,
    rows,
    tiles: tiles as OfficeLayout['tiles'],
    furniture,
    tileColors,
    tileFloorSet,
    tileWallSet,
    tileWallMask,
    tileBlocked,
    tileActions,
    texts,
    images,
  };
  return { layout, images: importedImages, mapName };
}
