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

import { findGid, type TiledRegistry } from './tiledRegistry.js';
import { FLOOR_CATEGORY, WALL_CATEGORY } from './categories.js';

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
): TmjExportResult {
  const { cols, rows, tiles } = layout;

  // ── Ground layer: floor/wall GIDs, GID 0 = VOID ──────────────────
  const ground: number[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const t = tiles[r * cols + c];
      const color = layout.tileColors?.[r * cols + c] ?? null;
      if (t === TileType.VOID) {
        ground.push(0);
      } else if (t === TileType.WALL) {
        const mask = wallBitmask(layout, c, r);
        const gid =
          findGid(
            registry,
            'wall-0.tsj',
            (p) => p.bitmask === mask && (color ? p.hue === color.h && p.sat === color.s : !('hue' in p)),
          ) ?? findGid(registry, 'wall-0.tsj', (p) => p.bitmask === mask && !('hue' in p));
        ground.push(gid ?? 0);
      } else {
        const gid =
          findGid(
            registry,
            'floor.tsj',
            (p) => p.pattern === t && (color ? p.hue === color.h && p.sat === color.s : !('hue' in p)),
          ) ?? findGid(registry, 'floor.tsj', (p) => p.pattern === t && !('hue' in p));
        ground.push(gid ?? 0);
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

  // ── Actions: one Point object per non-null tileActions entry ─────
  const actionObjects: Array<Record<string, unknown>> = [];
  (layout.tileActions ?? []).forEach((action, i) => {
    if (!action) return;
    const col = i % cols;
    const row = Math.floor(i / cols);
    actionObjects.push({
      id: 0, // renumbered below
      name: '',
      type: 'ActionPoint',
      point: true,
      // Position IS the data — col/row are derived from x/y on import
      // (Math.floor), never stored as their own properties: Tiled doesn't
      // update custom properties when an object is dragged, so a stored
      // col/row would silently go stale the moment you move the point.
      x: col * TILE_SIZE + TILE_SIZE / 2,
      y: row * TILE_SIZE + TILE_SIZE / 2,
      width: 0,
      height: 0,
      rotation: 0,
      properties: actionProps(action),
    });
  });
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
        type: '',
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
    version: '1.10',
    nextlayerid: 6,
    nextobjectid: furnitureObjects.length + actionObjects.length + textObjects.length + imageObjects.length + 1,
    tilesets: tilesetRefs,
    layers: [
      { id: 1, name: 'Ground', type: 'tilelayer', width: cols, height: rows, x: 0, y: 0, opacity: 1, visible: true, data: ground },
      { id: 2, name: 'Collision', type: 'tilelayer', width: cols, height: rows, x: 0, y: 0, opacity: 0.5, visible: true, data: collision },
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

function colorFromProps(props: PropBag): { h: number; s: number; b: number; c: number; colorize: true } | null {
  if (typeof props.hue !== 'number' || typeof props.sat !== 'number') return null;
  return { h: props.hue, s: props.sat, b: 0, c: 0, colorize: true };
}

export interface TmjImportResult {
  layout: OfficeLayout;
  /** imageId → PNG buffer for images the caller should persist as new/updated
   *  image assets before saving the layout (matches saveAsset's 'image' type). */
  images: Array<{ imageId: string; label: string; buffer: Buffer }>;
}

export function importTmjToLayout(
  tmj: Record<string, unknown>,
  registry: TiledRegistry,
  readImageFile: (relPath: string) => Buffer | null,
): TmjImportResult {
  const cols = Number(tmj.width);
  const rows = Number(tmj.height);
  const layers = (tmj.layers as Array<Record<string, unknown>>) ?? [];
  const byName = (name: string) => layers.find((l) => l.name === name);

  const ground = (byName('Ground')?.data as number[]) ?? [];
  const collision = (byName('Collision')?.data as number[]) ?? [];

  const tiles: number[] = [];
  const tileColors: OfficeLayout['tileColors'] = [];
  const tileBlocked: boolean[] = [];
  for (let i = 0; i < cols * rows; i++) {
    const gid = ground[i] ?? 0;
    const resolved = registry.resolve(gid);
    // Classify by `category`, not by which file a tile lives in or which
    // other properties happen to be present — a mapper reorganizing tileset
    // files must not silently break this (see docs/design/tiled-editor-integration.md).
    if (resolved?.props.category === WALL_CATEGORY) {
      tiles.push(TileType.WALL);
      tileColors.push(colorFromProps(resolved.props));
    } else if (resolved?.props.category === FLOOR_CATEGORY && typeof resolved.props.pattern === 'number') {
      tiles.push(resolved.props.pattern);
      tileColors.push(colorFromProps(resolved.props));
    } else {
      tiles.push(TileType.VOID);
      tileColors.push(null);
    }
    tileBlocked.push(!!collision[i] && collision[i] !== 0);
  }

  const furnitureLayer = byName('Furniture');
  const furniture: PlacedFurniture[] = (
    (furnitureLayer?.objects as Array<Record<string, unknown>>) ?? []
  ).map((obj, idx) => {
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

  const actionsLayer = byName('Actions');
  const tileActions: Array<Action | null> = new Array(cols * rows).fill(null);
  for (const obj of (actionsLayer?.objects as Array<Record<string, unknown>>) ?? []) {
    const props: PropBag = Object.fromEntries(((obj.properties as TiledProp[]) ?? []).map((p) => [p.name, p.value]));
    // Position IS the data — see the matching export-side comment; never
    // read a stored col/row property (Tiled wouldn't have kept it in sync
    // with a dragged object anyway).
    const col = Math.floor(Number(obj.x) / TILE_SIZE);
    const row = Math.floor(Number(obj.y) / TILE_SIZE);
    const action = actionFromProps(props);
    if (action && col >= 0 && col < cols && row >= 0 && row < rows) tileActions[row * cols + col] = action;
  }

  const textLayer = byName('Text');
  const texts: PlacedText[] = ((textLayer?.objects as Array<Record<string, unknown>>) ?? []).map((obj) => {
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

  const imagesLayer = byName('Images');
  const images: PlacedImage[] = [];
  const importedImages: TmjImportResult['images'] = [];
  for (const obj of (imagesLayer?.objects as Array<Record<string, unknown>>) ?? []) {
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
    tileBlocked,
    tileActions,
    texts,
    images,
  };
  return { layout, images: importedImages };
}
