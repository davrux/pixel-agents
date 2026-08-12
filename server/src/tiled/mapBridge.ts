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
import type {
  Action,
  ApplianceKind,
  OfficeLayout,
  PlacedFurniture,
  PlacedImage,
  PlacedText,
} from '@pixel/shared/office/types.js';
import { TileType } from '@pixel/shared/office/types.js';
import { TILE_SIZE } from '@pixel/shared/office/constants.js';
import { getCatalogEntry } from '@pixel/shared/office/layout/furnitureCatalog.js';

import { findGid, gidAt, resolveFromTmjTilesets, type TiledRegistry } from './tiledRegistry.js';
import { FLOOR_SET_FILES, TILED_SHEET_COLUMNS, WALL_SET_FILES } from '@pixel/shared/office/tiledSheetLayout.js';

type TiledProp = { name: string; type: string; value: string | number | boolean; propertytype?: string };
type PropBag = Record<string, string | number | boolean>;

export interface TmjImageAsset {
  id: string;
  data: string; // data:image/png;base64,...
  width: number;
  height: number;
}

export interface TmjExportResult {
  tmj: Record<string, unknown>;
  /** Image files the caller should write alongside the .tmj (path is
   *  relative to the .tmj's own directory, matching each Image Object's
   *  `image` field). */
  imageFiles: Array<{ relPath: string; buffer: Buffer }>;
}

function prop(name: string, value: string | number | boolean, propertyType?: string): TiledProp {
  const type = typeof value === 'boolean' ? 'bool' : typeof value === 'number' ? 'int' : 'string';
  return propertyType ? { name, type, value, propertytype: propertyType } : { name, type, value };
}

/** Always emits all four action-related properties (kind/video/url/pose),
 *  even when empty/inapplicable for this action's kind — so opening the
 *  .tmj in Tiled shows every settable field up front instead of only
 *  whichever ones happened to be set on the item being exported (there's no
 *  other way to discover "oh, I can set actionUrl here" from the file).
 *  `actionKind`/`actionPose` carry `propertytype` so Tiled shows them as
 *  dropdowns (see Pixels.tiled-project's ActionKind/ApplianceKind enums) —
 *  Tiled reads this per-property, independent of the object's own class. */
function actionProps(action: Action | null, prefix = 'action'): TiledProp[] {
  return [
    prop(`${prefix}Kind`, action?.kind ?? '', 'ActionKind'),
    prop(`${prefix}Video`, action?.kind === 'meetingRoom' ? action.video : false),
    prop(`${prefix}Url`, action?.kind === 'iframe' ? action.url : ''),
    prop(`${prefix}Pose`, action?.kind === 'appliance' ? action.pose : '', 'ApplianceKind'),
  ];
}

function actionFromProps(props: PropBag, prefix = 'action'): Action | null {
  const kind = props[`${prefix}Kind`];
  if (typeof kind !== 'string') return null;
  switch (kind) {
    case 'meetingRoom':
      return { kind, video: props[`${prefix}Video`] === true };
    case 'linkManager':
    case 'arcade':
    case 'toggle':
      return { kind };
    case 'iframe':
      return { kind, url: typeof props[`${prefix}Url`] === 'string' ? (props[`${prefix}Url`] as string) : '' };
    case 'appliance':
      return { kind, pose: (typeof props[`${prefix}Pose`] === 'string' ? props[`${prefix}Pose`] : 'coffee') as ApplianceKind };
    default:
      return null;
  }
}

/** Deep-equal for Action — used to group tileActions into same-value blocks
 *  for export (see the Actions export block below). `kind` alone isn't
 *  enough: two 'meetingRoom' tiles with different `video` are NOT the same
 *  action and must not merge into one exported shape. */
function actionsEqual(a: Action | null, b: Action | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'meetingRoom':
      return b.kind === 'meetingRoom' && a.video === b.video;
    case 'iframe':
      return b.kind === 'iframe' && a.url === b.url;
    case 'appliance':
      return b.kind === 'appliance' && a.pose === b.pose;
    default:
      return true; // linkManager/arcade/toggle carry no other fields
  }
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

/** Tiled's own GID horizontal-flip bit (top bit of the 32-bit GID field) —
 *  plain addition/subtraction, not a bitwise op: these GIDs are always far
 *  below 2^31, and JS's bitwise operators coerce to signed Int32 first,
 *  which would turn 0x80000000 negative. */
const TILED_FLIP_H = 0x80000000;

/** `flippedHorizontally` (see PlacedFurniture) maps directly onto Tiled's own
 *  GID flip bit — purely cosmetic, so Tiled's canvas shows a real mirrored
 *  sprite instead of drawing the unflipped one. `id` (see the export/import
 *  properties block) already carries the true identity independent of this;
 *  the GID here is only ever consulted for *display*. */
function findFurnitureGid(registry: TiledRegistry, id: string, flippedHorizontally: boolean): number | null {
  const direct = findFurnitureGidExact(registry, id);
  if (direct === null) return null;
  return flippedHorizontally ? direct + TILED_FLIP_H : direct;
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

export function exportLayoutToTmj(
  layout: OfficeLayout,
  registry: TiledRegistry,
  imageAssets: Map<string, TmjImageAsset>,
  zoneId: string,
): TmjExportResult {
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
    const gid = findFurnitureGid(registry, item.id, !!item.flippedHorizontally);
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
  const textObjects = (layout.texts ?? []).map((t, idx) => ({
    id: idx + 1,
    name: '',
    type: '',
    x: t.col * TILE_SIZE,
    y: t.row * TILE_SIZE,
    width: 8 * TILE_SIZE,
    height: 2 * TILE_SIZE,
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

  // ── Images: native Tiled image objects, PNG extracted alongside the .tmj ──
  const imageFiles: TmjExportResult['imageFiles'] = [];
  const imageObjects = (layout.images ?? []).flatMap((im, idx) => {
    const asset = imageAssets.get(im.imageId);
    if (!asset) return []; // deleted since this layout was saved — matches the live renderer's own skip
    const relPath = `images/${im.imageId}.png`;
    const base64 = asset.data.replace(/^data:image\/\w+;base64,/, '');
    imageFiles.push({ relPath, buffer: Buffer.from(base64, 'base64') });
    return [
      {
        id: idx + 1,
        name: '',
        type: 'Image',
        x: im.col * TILE_SIZE,
        y: im.row * TILE_SIZE,
        width: im.footprintW * TILE_SIZE,
        height: im.footprintH * TILE_SIZE,
        rotation: 0,
        visible: true,
        image: relPath,
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

  return { tmj, imageFiles };
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
  const furnitureObjects = allObjects.filter((o) => o.type === 'FurnitureObject');
  const actionObjects = allObjects.filter((o) => o.type === 'ActionArea');
  const textObjects = allObjects.filter((o) => o.text !== undefined);
  const imageObjects = allObjects.filter((o) => typeof o.image === 'string');

  const tiles: number[] = [];
  const tileColors: OfficeLayout['tileColors'] = [];
  const tileFloorSet: number[] = [];
  const tileWallSet: number[] = [];
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
      tileColors.push(rowAndSwatchFromLocalId(resolved.localId).swatchIndex);
      tileFloorSet.push(0);
      // Which set this came from — unlike the floor/wall/void classification
      // above, this one legitimately IS about the file, since "which set"
      // has no other identity (see setIndexFromFile).
      tileWallSet.push(setIndexFromFile(WALL_SET_FILES, resolved.tileset.file));
    } else if (resolved?.class === 'FloorTile') {
      const { row, swatchIndex } = rowAndSwatchFromLocalId(resolved.localId);
      tiles.push(row + 1);
      tileColors.push(swatchIndex);
      tileFloorSet.push(setIndexFromFile(FLOOR_SET_FILES, resolved.tileset.file));
      tileWallSet.push(0);
    } else {
      tiles.push(TileType.VOID);
      tileColors.push(null);
      tileFloorSet.push(0);
      tileWallSet.push(0);
    }
    tileBlocked.push(!!collision[i] && collision[i] !== 0);
  }

  const furniture: PlacedFurniture[] = furnitureObjects.map((obj, idx) => {
    const props: PropBag = Object.fromEntries(((obj.properties as TiledProp[]) ?? []).map((p) => [p.name, p.value]));
    // Identity is a flat property read — always present (see the matching
    // export-side comment), independent of the GID entirely. The GID's own
    // flip bit is read back separately, purely for `flippedHorizontally`
    // (see PlacedFurniture) — the two are unrelated concerns.
    const id = typeof props.id === 'string' ? props.id : '';
    const rawGid = Number(obj.gid) || 0;
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
    if (rawGid >= TILED_FLIP_H) item.flippedHorizontally = true;
    if (typeof props.name === 'string' && props.name) item.name = props.name;
    if (typeof props.approachSides === 'string' && props.approachSides) {
      item.approachSides = props.approachSides.split(',').filter((s): s is 'N' | 'S' | 'E' | 'W' => ['N', 'S', 'E', 'W'].includes(s));
    }
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
    const t: PlacedText = {
      uid: generateUid(),
      col: Math.round(Number(obj.x) / TILE_SIZE),
      row: Math.round(Number(obj.y) / TILE_SIZE),
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
    const imageId = typeof props.imageId === 'string' ? props.imageId : null;
    const relPath = typeof obj.image === 'string' ? obj.image : null;
    if (!imageId || !relPath) continue;
    const buffer = readImageFile(relPath);
    if (buffer) importedImages.push({ imageId, label: imageId, buffer });
    images.push({
      uid: generateUid(),
      col: Math.round(Number(obj.x) / TILE_SIZE),
      row: Math.round(Number(obj.y) / TILE_SIZE),
      footprintW: Math.max(1, Math.round(Number(obj.width) / TILE_SIZE)),
      footprintH: Math.max(1, Math.round(Number(obj.height) / TILE_SIZE)),
      imageId,
    });
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
    tileBlocked,
    tileActions,
    texts,
    images,
  };
  return { layout, images: importedImages, mapName };
}
