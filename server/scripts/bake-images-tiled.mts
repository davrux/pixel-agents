#!/usr/bin/env -S node --import tsx
/**
 * Bake every uploaded image asset (appStore's 'image' type — the in-game
 * Assets editor's uploads) into a real Tiled tileset: assets/tiled/images.tsj,
 * a "collection of images" tileset (no shared grid — each tile is its own
 * independently-sized PNG, see the JSON tileset format's per-tile `image`/
 * `imagewidth`/`imageheight` fields), plus the PNG files themselves under
 * assets/tiled/png/src/images/.
 *
 * Without this, there is no way to place an image in Tiled at all: Tiled's
 * object format has no field for "a standalone image file" independent of a
 * tileset (verified against the official JSON Map Format reference — an
 * Object has `gid` or `text`, nothing else image-related). A GID-backed tile
 * object from a real "collection of images" tileset, placed via Insert Tile
 * (T), is the only way Tiled itself can create one.
 *
 * Run by hand (from server/) whenever the image library changes:
 *   node --import tsx scripts/bake-images-tiled.mts
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { appStore } from '../src/appStore.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const TILED_DIR = path.join(ROOT, 'assets', 'tiled');
const PNG_DIR = path.join(TILED_DIR, 'png', 'src', 'images');

interface ImageAssetData {
  data: string; // data:image/png;base64,...
  width: number;
  height: number;
  label?: string;
}

fs.mkdirSync(PNG_DIR, { recursive: true });

const images = appStore.listAssets('image') as Array<{ name: string; data: ImageAssetData }>;
images.sort((a, b) => a.name.localeCompare(b.name)); // stable tile order across re-bakes

const tiles = images.map((img, id) => {
  const base64 = img.data.data.replace(/^data:image\/\w+;base64,/, '');
  fs.writeFileSync(path.join(PNG_DIR, `${img.name}.png`), Buffer.from(base64, 'base64'));
  return {
    id,
    // Assigns this tile to Pixels.tiled-project's ImageTile class — a plain
    // grid tile (FloorTile/WallTile) is classified by file+position alone,
    // but a collection-of-images tileset has no grid to derive anything
    // from, so identity has to be an explicit property like FurnitureTile's
    // `id` (see docs/design.md).
    type: 'ImageTile',
    image: `png/src/images/${img.name}.png`,
    imagewidth: img.data.width,
    imageheight: img.data.height,
    properties: [{ name: 'imageId', type: 'string', value: img.name }],
  };
});

const tsj = {
  columns: 0, // 0 = collection of images, not a shared grid (see json format reference)
  margin: 0,
  name: 'images',
  spacing: 0,
  tilecount: tiles.length,
  tiledversion: '1.11.0',
  // "Maximum width/height of tiles in this set" — Tiled uses these only for
  // its own UI layout hints; each tile still carries its own real size.
  tilewidth: tiles.reduce((m, t) => Math.max(m, t.imagewidth), 1),
  tileheight: tiles.reduce((m, t) => Math.max(m, t.imageheight), 1),
  tiles,
  type: 'tileset',
  version: '1.10',
};

fs.writeFileSync(path.join(TILED_DIR, 'images.tsj'), JSON.stringify(tsj, null, 2) + '\n');
console.log(`✓ images.tsj + png/src/images/*.png (${tiles.length} image${tiles.length === 1 ? '' : 's'})`);
