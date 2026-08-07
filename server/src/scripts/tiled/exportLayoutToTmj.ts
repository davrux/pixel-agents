/**
 * Export a saved OfficeLayout to a real Tiled map (.tmj — Tiled's JSON map
 * format) that opens directly in Tiled, referencing the three baked tilesets
 * (floor-tileset.tsx, wall-0-tileset.tsx, furniture-tileset.tsx — run
 * generate:tiled / generate:tiled-furniture first if they're missing).
 *
 * Usage:
 *   pnpm --filter @pixel/server run tiled:export -- <layoutName> [outFile]
 *   pnpm --filter @pixel/server run tiled:export -- Default office.tmj
 *
 * <layoutName> is a name from the office zone's layout list ("Default", or
 * any saved name) — same names shown in the in-game Layouts panel.
 *
 * Known gap: OfficeLayout.tileBlocked (the Block tool's manual walkability
 * override) has no Tiled representation yet — round-tripping through Tiled
 * currently drops it. Everything else (tiles, furniture, tile actions, text
 * labels) round-trips losslessly with importFromTmj.ts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { LayoutStore } from '../../layoutStore.js';
import { loadAssetBundle } from '../../assets.js';
import { loadTilesetInfo } from './tilesetInfo.js';
import { isVoid, isWall, isFloor, floorPatternOf, tileColorIndexOf } from '@pixel/shared/office/tileGid.js';
import { TILE_SIZE } from '@pixel/shared/office/constants.js';
import type { OfficeLayout, PlacedFurniture, PlacedText, TileAction, Action } from '@pixel/shared/office/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const ASSETS_DIR = path.join(REPO_ROOT, 'assets');
const TILED_DIR = path.join(ASSETS_DIR, 'tiled');
const ZONE = 'office';

/** Same N/E/S/W bitmask convention as shared/src/office/wallTiles.ts's
 *  buildWallMask — reimplemented here since that one isn't exported (it
 *  operates on the client's 2D tileMap; this operates on the flat layout
 *  array we already have in hand). */
function wallMaskAt(tiles: number[], cols: number, rows: number, col: number, row: number): number {
  const wallAt = (c: number, r: number): boolean => {
    if (c < 0 || c >= cols || r < 0 || r >= rows) return false;
    return isWall(tiles[r * cols + c]);
  };
  let mask = 0;
  if (wallAt(col, row - 1)) mask |= 1; // N
  if (wallAt(col + 1, row)) mask |= 2; // E
  if (wallAt(col, row + 1)) mask |= 4; // S
  if (wallAt(col - 1, row)) mask |= 8; // W
  return mask;
}

type TiledProperty = { name: string; type: string; value: unknown };
type TiledObject = Record<string, unknown>;

// Tiled's top-bit gid flags (bits/GIDFLIP in the .tmx/.tmj spec) — used here to
// represent our mirrored ":left" furniture variants without baking them as
// separate tileset tiles (identical art, just flipped).
const FLIPPED_HORIZONTALLY_FLAG = 0x80000000;

function strProp(name: string, value: string): TiledProperty {
  return { name, type: 'string', value };
}
function intProp(name: string, value: number): TiledProperty {
  return { name, type: 'int', value };
}
function boolProp(name: string, value: boolean): TiledProperty {
  return { name, type: 'bool', value };
}

/** Furniture overrides Tiled can't natively represent (color tint,
 *  approachSides, zOffset, action, the deprecated facing) are preserved as
 *  opaque JSON in one custom property, so importFromTmj.ts can restore them
 *  exactly even though Tiled itself won't render/edit them meaningfully. */
function furnitureOverrideProps(item: PlacedFurniture): TiledProperty[] {
  const { uid, type: _type, col: _col, row: _row, ...overrides } = item;
  const props = [strProp('uid', uid)];
  const hasOverrides = Object.keys(overrides).length > 0;
  if (hasOverrides) props.push(strProp('paOverrides', JSON.stringify(overrides)));
  return props;
}

function actionProps(action: Action): TiledProperty[] {
  const props: TiledProperty[] = [strProp('kind', action.kind)];
  switch (action.kind) {
    case 'meetingRoom':
      props.push(boolProp('video', action.video));
      break;
    case 'iframe':
      props.push(strProp('url', action.url));
      break;
    case 'appliance':
      props.push(strProp('pose', action.pose));
      break;
    // 'linkManager' and 'arcade' carry no extra fields.
  }
  return props;
}

export function exportLayoutToTmj(layout: OfficeLayout): TiledObject {
  const info = loadTilesetInfo(TILED_DIR);
  const { cols, rows, tiles } = layout;

  // ── Tile layer: floor + wall, one real Tiled gid per cell ──
  const data: number[] = new Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      const gid = tiles[idx];
      if (isVoid(gid)) {
        data[idx] = 0;
      } else if (isFloor(gid)) {
        const pattern = floorPatternOf(gid);
        const colorIndex = tileColorIndexOf(gid) ?? 0;
        const localId = (pattern - 1) * 32 + colorIndex;
        if (localId >= info.floor.tileCount) {
          console.warn(`[tiled:export] (${c},${r}) floor pattern ${pattern} has no baked tile — exporting as empty`);
          data[idx] = 0;
        } else {
          data[idx] = info.floor.firstGid + localId;
        }
      } else if (isWall(gid)) {
        const colorIndex = tileColorIndexOf(gid) ?? 0;
        const mask = wallMaskAt(tiles, cols, rows, c, r);
        const localId = mask * 32 + colorIndex;
        data[idx] = info.wall.firstGid + localId;
      } else {
        data[idx] = 0;
      }
    }
  }

  // ── Furniture: one Tile Object per item, anchored bottom-left (Tiled's
  //    convention for tile objects — unlike plain rectangles below). ──
  let nextObjectId = 1;
  const furnitureObjects: TiledObject[] = [];
  for (const item of layout.furniture) {
    const mirrored = item.type.endsWith(':left');
    const baseType = mirrored ? item.type.slice(0, -':left'.length) : item.type;
    const localId = info.furniture.typeToLocalId.get(baseType);
    if (localId === undefined) {
      console.warn(`[tiled:export] furniture type "${item.type}" (uid ${item.uid}) has no baked tile — skipped`);
      continue;
    }
    // Footprint isn't stored on the placed item — it lives in the catalog,
    // which the furniture tileset's own tile size already encodes. Read it
    // back off the tileset-declared width/height instead of re-deriving it.
    const size = info.furniture.sizeByType.get(baseType) ?? { width: TILE_SIZE, height: TILE_SIZE };
    const gid = info.furniture.firstGid + localId;
    furnitureObjects.push({
      id: nextObjectId++,
      gid: mirrored ? (gid | FLIPPED_HORIZONTALLY_FLAG) >>> 0 : gid,
      name: item.name ?? '',
      // Tile objects anchor at the bottom-left of their image in Tiled.
      x: item.col * TILE_SIZE,
      y: item.row * TILE_SIZE + size.height,
      width: size.width,
      height: size.height,
      rotation: 0,
      visible: true,
      properties: furnitureOverrideProps(item),
    });
  }

  // ── Tile actions: plain rectangle objects (top-left anchored), one per
  //    tile, class = action kind, fields as properties. ──
  const actionObjects: TiledObject[] = (layout.tileActions ?? []).map((t: TileAction) => ({
    id: nextObjectId++,
    name: '',
    class: t.action.kind,
    x: t.col * TILE_SIZE,
    y: t.row * TILE_SIZE,
    width: TILE_SIZE,
    height: TILE_SIZE,
    rotation: 0,
    visible: true,
    properties: actionProps(t.action),
  }));

  // ── Text labels: Tiled's native text object type. ──
  const textObjects: TiledObject[] = (layout.texts ?? []).map((pt: PlacedText) => ({
    id: nextObjectId++,
    name: '',
    x: pt.col * TILE_SIZE,
    y: pt.row * TILE_SIZE,
    width: TILE_SIZE,
    height: TILE_SIZE,
    rotation: pt.angle ?? 0,
    visible: true,
    text: {
      text: pt.text,
      pixelsize: pt.fontSize ?? 8,
      fontfamily: pt.fontFamily ?? "'FS Pixel Sans', monospace",
      halign: 'center',
      valign: 'bottom',
      wrap: false,
      color: '#ffffff',
    },
    properties: [strProp('uid', pt.uid)],
  }));

  const map: TiledObject = {
    type: 'map',
    version: '1.10',
    tiledversion: '1.11.0',
    orientation: 'orthogonal',
    renderorder: 'right-down',
    width: cols,
    height: rows,
    tilewidth: TILE_SIZE,
    tileheight: TILE_SIZE,
    infinite: false,
    nextlayerid: 5,
    nextobjectid: nextObjectId,
    tilesets: [
      { firstgid: info.floor.firstGid, source: info.floor.source },
      { firstgid: info.wall.firstGid, source: info.wall.source },
      { firstgid: info.furniture.firstGid, source: info.furniture.source },
    ],
    layers: [
      {
        id: 1,
        name: 'Floor & Walls',
        type: 'tilelayer',
        x: 0,
        y: 0,
        width: cols,
        height: rows,
        visible: true,
        opacity: 1,
        data,
      },
      {
        id: 2,
        name: 'Furniture',
        type: 'objectgroup',
        x: 0,
        y: 0,
        visible: true,
        opacity: 1,
        draworder: 'topdown',
        objects: furnitureObjects,
      },
      {
        id: 3,
        name: 'Actions',
        type: 'objectgroup',
        x: 0,
        y: 0,
        visible: true,
        opacity: 1,
        draworder: 'topdown',
        objects: actionObjects,
      },
      {
        id: 4,
        name: 'Text',
        type: 'objectgroup',
        x: 0,
        y: 0,
        visible: true,
        opacity: 1,
        draworder: 'topdown',
        objects: textObjects,
      },
    ],
  };
  return map;
}

function row_unused(r: number): number {
  return r;
}

async function main(): Promise<void> {
  const [layoutName, outArg] = process.argv.slice(2);
  if (!layoutName) {
    console.error('Usage: tsx exportLayoutToTmj.ts <layoutName> [outFile.tmj]');
    process.exit(1);
  }

  const bundle = await loadAssetBundle();
  const store = new LayoutStore((bundle.raw.layout as Record<string, unknown>) ?? null);
  const raw = store.resolve(ZONE, layoutName);
  if (!raw) {
    console.error(`[tiled:export] no layout named "${layoutName}" in zone "${ZONE}"`);
    process.exit(1);
  }
  if (raw.version !== 3) {
    console.error(`[tiled:export] layout "${layoutName}" is schema version ${raw.version as number}, expected 3 — resave it in the editor first.`);
    process.exit(1);
  }

  const map = exportLayoutToTmj(raw as unknown as OfficeLayout);

  const outFile = outArg ?? path.join(TILED_DIR, `${layoutName}.tmj`);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(map, null, 2));
  console.log(`[tiled:export] wrote ${outFile}`);
}

if (import.meta.url === `file://${process.argv[1]}`) void main();
