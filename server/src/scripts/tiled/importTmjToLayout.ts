/**
 * Import a Tiled map (.tmj) back into a saved OfficeLayout — the reverse of
 * exportLayoutToTmj.ts. Assumes the map still references the same three
 * canonical tilesets in assets/tiled/ (floor-tileset.tsx, wall-0-tileset.tsx,
 * furniture-tileset.tsx) that export always produces; a .tmj built from
 * scratch in Tiled against those same tilesets works just as well as a
 * round-tripped one.
 *
 * Usage:
 *   pnpm --filter @pixel/server run tiled:import -- <inFile.tmj> <layoutName>
 *   pnpm --filter @pixel/server run tiled:import -- office.tmj Default
 *
 * <layoutName> is saved (and made active) the same way the in-game "Save As"
 * does — this is a trusted local dev/admin tool, not a path a live client
 * ever reaches, so it applies only light validation, not the full
 * SimRoom.ts sanitizers (which are private to that module).
 *
 * ActionArea/BlockedArea are rectangle-only (see TileRect's own doc comment)
 * — a Tiled ellipse or polygon object in the "Actions"/"NonWalkable" layers
 * is rejected with a warning rather than approximated.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { LayoutStore } from '../../layoutStore.js';
import { loadAssetBundle } from '../../assets.js';
import { loadTilesetInfo } from './tilesetInfo.js';
import { VOID_GID, floorGid, wallGid } from '@pixel/shared/office/tileGid.js';
import { TILE_SIZE } from '@pixel/shared/office/constants.js';
import { TEXT_LABEL_DEFAULT_FONT_SIZE, TEXT_LABEL_DEFAULT_FONT_FAMILY } from '@pixel/shared/protocol';
import type { ActionArea, BlockedArea, OfficeLayout, PlacedFurniture, PlacedText, Action, ColorValue, Direction, TileRect } from '@pixel/shared/office/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const ASSETS_DIR = path.join(REPO_ROOT, 'assets');
const TILED_DIR = path.join(ASSETS_DIR, 'tiled');
const ZONE = 'office';
const MAX_TEXT_LABEL_LEN = 200; // generous local-tool cap; see protocol.ts's own for the live server's real one

// Mirror of exportLayoutToTmj.ts's flag — Tiled's native horizontal-flip bit
// stands in for our mirrored ":left" furniture variants.
const FLIPPED_HORIZONTALLY_FLAG = 0x80000000;

interface TiledObjectIn {
  id: number;
  gid?: number;
  name?: string;
  class?: string;
  type?: string; // older Tiled versions used `type` where newer use `class`
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
  ellipse?: boolean;
  polygon?: unknown;
  polyline?: unknown;
  point?: boolean;
  text?: { text: string; pixelsize?: number; fontfamily?: string };
  properties?: Array<{ name: string; type: string; value: unknown }>;
}

function propsToRecord(obj: TiledObjectIn): Record<string, unknown> {
  const rec: Record<string, unknown> = {};
  for (const p of obj.properties ?? []) rec[p.name] = p.value;
  return rec;
}

/** A rectangle-only shape, snapped to the tile grid (see maybeExpand's own
 *  grid-snap precedent in the editor) — null (with a warning) for a
 *  Tiled ellipse/polygon/polyline/point object, or a degenerate/out-of-
 *  bounds rect. */
function rectOf(obj: TiledObjectIn, cols: number, rows: number, label: string): TileRect | null {
  if (obj.ellipse || obj.polygon || obj.polyline || obj.point) {
    console.warn(`[tiled:import] ${label} object ${obj.id} is not a plain rectangle — only rectangles are supported, skipped`);
    return null;
  }
  const col = Math.round(obj.x / TILE_SIZE);
  const row = Math.round(obj.y / TILE_SIZE);
  const w = Math.max(1, Math.round(obj.width / TILE_SIZE));
  const h = Math.max(1, Math.round(obj.height / TILE_SIZE));
  if (col < 0 || row < 0 || col + w > cols || row + h > rows) {
    console.warn(`[tiled:import] ${label} object ${obj.id} is out of bounds — skipped`);
    return null;
  }
  return { col, row, w, h };
}

/** Mirror of exportLayoutToTmj.ts's furnitureOverrideProps — reads the same
 *  real, individually-named/typed custom properties back into overrides,
 *  rather than an opaque JSON blob. */
function parseFurnitureOverrides(obj: TiledObjectIn, props: Record<string, unknown>): Partial<PlacedFurniture> {
  const overrides: Partial<PlacedFurniture> = {};
  if (obj.name) overrides.name = obj.name;
  if (typeof props.colorH === 'number') {
    const color: ColorValue = {
      h: props.colorH,
      s: typeof props.colorS === 'number' ? props.colorS : 0,
      b: typeof props.colorB === 'number' ? props.colorB : 0,
      c: typeof props.colorC === 'number' ? props.colorC : 0,
    };
    if (props.colorColorize === true) color.colorize = true;
    overrides.color = color;
  }
  if (typeof props.facing === 'number') overrides.facing = props.facing as Direction;
  if (typeof props.approachSides === 'string' && props.approachSides.length > 0) {
    overrides.approachSides = props.approachSides.split(',').filter(Boolean) as Array<'N' | 'S' | 'E' | 'W'>;
  }
  if (typeof props.zOffset === 'number' && props.zOffset !== 0) overrides.zOffset = props.zOffset;
  if (typeof props.kind === 'string') {
    const action = parseAction(props.kind, props);
    if (action) overrides.action = action;
  }
  return overrides;
}

function parseAction(kind: string, props: Record<string, unknown>): Action | null {
  switch (kind) {
    case 'meetingRoom':
      return { kind: 'meetingRoom', video: props.video !== false };
    case 'linkManager':
      return { kind: 'linkManager' };
    case 'iframe': {
      const url = typeof props.url === 'string' ? props.url : '';
      return url.startsWith('https://') ? { kind: 'iframe', url } : null;
    }
    case 'appliance':
      return props.pose === 'coffee' ? { kind: 'appliance', pose: 'coffee' } : null;
    case 'arcade':
      return { kind: 'arcade' };
    default:
      return null;
  }
}

/** A fresh id for an area imported without its own `paId` property (e.g. a
 *  hand-drawn Tiled object never exported by us) — falls back to the Tiled
 *  object's own id, already unique within the map. See ActionArea/
 *  BlockedArea's own doc comments on why a stable id matters. */
function areaId(props: Record<string, unknown>, objId: number): string {
  return typeof props.paId === 'string' && props.paId ? props.paId : `a${objId}`;
}

export function importTmjToLayout(map: Record<string, unknown>): OfficeLayout {
  const info = loadTilesetInfo(TILED_DIR);
  const cols = map.width as number;
  const rows = map.height as number;
  const layers = map.layers as Array<Record<string, unknown>>;

  const tileLayers = new Map(layers.filter((l) => l.type === 'tilelayer').map((l) => [l.name as string, l.data as number[]]));
  const rawData = tileLayers.get('Floor & Walls');
  if (!rawData) throw new Error('no "Floor & Walls" tile layer found in map');
  const tiles = rawData.map((gid, i) => {
    if (gid === 0) return VOID_GID;
    if (gid >= info.floor.firstGid && gid < info.floor.firstGid + info.floor.tileCount) {
      const localId = gid - info.floor.firstGid;
      const pattern = Math.floor(localId / 32) + 1;
      const colorIndex = localId % 32;
      return floorGid(pattern, colorIndex);
    }
    if (gid >= info.wall.firstGid && gid < info.wall.firstGid + info.wall.tileCount) {
      const localId = gid - info.wall.firstGid;
      const colorIndex = localId % 32; // the mask half of localId is re-derived from neighbors at render time
      return wallGid(colorIndex);
    }
    console.warn(`[tiled:import] cell ${i} has unrecognized gid ${gid} — importing as void`);
    return VOID_GID;
  });

  const objectLayers = new Map(layers.filter((l) => l.type === 'objectgroup').map((l) => [l.name as string, (l.objects ?? []) as TiledObjectIn[]]));

  const furniture: PlacedFurniture[] = [];
  for (const obj of objectLayers.get('Furniture') ?? []) {
    if (obj.gid === undefined) continue;
    const mirrored = (obj.gid & FLIPPED_HORIZONTALLY_FLAG) !== 0;
    const rawGid = obj.gid & ~FLIPPED_HORIZONTALLY_FLAG & 0x1fffffff; // clear all three Tiled flip flags
    const localId = rawGid - info.furniture.firstGid;
    const baseType = info.furniture.localIdToType.get(localId);
    if (!baseType) {
      console.warn(`[tiled:import] furniture object ${obj.id} references unknown gid ${obj.gid} — skipped`);
      continue;
    }
    const type = mirrored ? `${baseType}:left` : baseType;
    const props = propsToRecord(obj);
    const uid = typeof props.uid === 'string' ? props.uid : `f-${Date.now()}-${obj.id}`;
    const overrides = parseFurnitureOverrides(obj, props);
    const col = Math.round(obj.x / TILE_SIZE);
    const row = Math.round((obj.y - obj.height) / TILE_SIZE);
    furniture.push({ uid, type, col, row, ...overrides } as PlacedFurniture);
  }

  const actionAreas: ActionArea[] = [];
  for (const obj of objectLayers.get('Actions') ?? []) {
    const kind = obj.class ?? obj.type;
    if (!kind) continue;
    const props = propsToRecord(obj);
    const action = parseAction(kind, props);
    if (!action) {
      console.warn(`[tiled:import] action object ${obj.id} (kind "${kind}") is invalid — skipped`);
      continue;
    }
    const rect = rectOf(obj, cols, rows, 'action');
    if (!rect) continue;
    actionAreas.push({ ...rect, id: areaId(props, obj.id), action });
  }

  const blockedAreas: BlockedArea[] = [];
  for (const obj of objectLayers.get('NonWalkable') ?? []) {
    const rect = rectOf(obj, cols, rows, 'blocked');
    if (!rect) continue;
    blockedAreas.push({ ...rect, id: areaId(propsToRecord(obj), obj.id) });
  }

  const texts: PlacedText[] = [];
  for (const obj of objectLayers.get('Text') ?? []) {
    if (!obj.text?.text) continue;
    const props = propsToRecord(obj);
    const uid = typeof props.uid === 'string' ? props.uid : `t-${Date.now()}-${obj.id}`;
    const col = Math.floor(obj.x / TILE_SIZE);
    const row = Math.floor(obj.y / TILE_SIZE);
    const entry: PlacedText = { uid, col, row, text: obj.text.text.slice(0, MAX_TEXT_LABEL_LEN) };
    if (obj.text.pixelsize && obj.text.pixelsize !== TEXT_LABEL_DEFAULT_FONT_SIZE) entry.fontSize = obj.text.pixelsize;
    if (obj.text.fontfamily && obj.text.fontfamily !== TEXT_LABEL_DEFAULT_FONT_FAMILY) entry.fontFamily = obj.text.fontfamily;
    if (obj.rotation) entry.angle = ((obj.rotation % 360) + 360) % 360;
    texts.push(entry);
  }

  return { version: 4, cols, rows, tiles, furniture, actionAreas, blockedAreas, texts };
}

async function main(): Promise<void> {
  const [inFile, layoutName] = process.argv.slice(2);
  if (!inFile || !layoutName) {
    console.error('Usage: tsx importTmjToLayout.ts <inFile.tmj> <layoutName>');
    process.exit(1);
  }
  const map = JSON.parse(fs.readFileSync(inFile, 'utf-8')) as Record<string, unknown>;
  const layout = importTmjToLayout(map);

  const bundle = await loadAssetBundle();
  const store = new LayoutStore((bundle.raw.layout as Record<string, unknown>) ?? null);
  store.saveAs(ZONE, layoutName, layout as unknown as Record<string, unknown>, Date.now());
  console.log(
    `[tiled:import] saved "${layoutName}" in zone "${ZONE}" (${layout.furniture.length} furniture, ` +
      `${layout.actionAreas?.length ?? 0} action areas, ${layout.blockedAreas?.length ?? 0} blocked areas, ` +
      `${layout.texts?.length ?? 0} texts) — now active`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) void main();
