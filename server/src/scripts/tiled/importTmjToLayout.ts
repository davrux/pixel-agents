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
 * Known gap: OfficeLayout.tileBlocked has no Tiled representation (see
 * exportLayoutToTmj.ts) — importing never restores it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { LayoutStore } from '../../layoutStore.js';
import { loadAssetBundle } from '../../assets.js';
import { loadTilesetInfo } from './tilesetInfo.js';
import { VOID_GID, floorGid, wallGid } from '@pixel/shared/office/tileGid.js';
import { TILE_SIZE } from '@pixel/shared/office/constants.js';
import type { OfficeLayout, PlacedFurniture, PlacedText, TileAction, Action } from '@pixel/shared/office/types.js';

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
  text?: { text: string; pixelsize?: number; fontfamily?: string };
  properties?: Array<{ name: string; type: string; value: unknown }>;
}

function propsToRecord(obj: TiledObjectIn): Record<string, unknown> {
  const rec: Record<string, unknown> = {};
  for (const p of obj.properties ?? []) rec[p.name] = p.value;
  return rec;
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

export function importTmjToLayout(map: Record<string, unknown>): OfficeLayout {
  const info = loadTilesetInfo(TILED_DIR);
  const cols = map.width as number;
  const rows = map.height as number;
  const layers = map.layers as Array<Record<string, unknown>>;

  const tileLayer = layers.find((l) => l.type === 'tilelayer');
  if (!tileLayer) throw new Error('no tile layer found in map');
  const rawData = tileLayer.data as number[];
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
    const overrides = typeof props.paOverrides === 'string' ? (JSON.parse(props.paOverrides) as Record<string, unknown>) : {};
    const col = Math.round(obj.x / TILE_SIZE);
    const row = Math.round((obj.y - obj.height) / TILE_SIZE);
    furniture.push({ uid, type, col, row, ...overrides } as PlacedFurniture);
  }

  const tileActions: TileAction[] = [];
  for (const obj of objectLayers.get('Actions') ?? []) {
    const kind = obj.class ?? obj.type;
    if (!kind) continue;
    const action = parseAction(kind, propsToRecord(obj));
    if (!action) {
      console.warn(`[tiled:import] action object ${obj.id} (kind "${kind}") is invalid — skipped`);
      continue;
    }
    const col = Math.floor(obj.x / TILE_SIZE);
    const row = Math.floor(obj.y / TILE_SIZE);
    if (col < 0 || row < 0 || col >= cols || row >= rows) continue;
    tileActions.push({ col, row, action });
  }

  const texts: PlacedText[] = [];
  for (const obj of objectLayers.get('Text') ?? []) {
    if (!obj.text?.text) continue;
    const props = propsToRecord(obj);
    const uid = typeof props.uid === 'string' ? props.uid : `t-${Date.now()}-${obj.id}`;
    const col = Math.floor(obj.x / TILE_SIZE);
    const row = Math.floor(obj.y / TILE_SIZE);
    const entry: PlacedText = { uid, col, row, text: obj.text.text.slice(0, MAX_TEXT_LABEL_LEN) };
    if (obj.text.pixelsize) entry.fontSize = obj.text.pixelsize;
    if (obj.text.fontfamily) entry.fontFamily = obj.text.fontfamily;
    if (obj.rotation) entry.angle = ((obj.rotation % 360) + 360) % 360;
    texts.push(entry);
  }

  return { version: 3, cols, rows, tiles, furniture, tileActions, texts };
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
      `${layout.tileActions?.length ?? 0} actions, ${layout.texts?.length ?? 0} texts) — now active`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) void main();
