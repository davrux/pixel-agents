#!/usr/bin/env -S node --import tsx
/**
 * Export one zone's active layout to assets/tiled/zones/<zoneId>.tmj, ready
 * to open in Tiled. See server/src/tiled/mapBridge.ts and
 * docs/design/tiled-editor-integration.md.
 *
 * Usage (from server/): node --import tsx scripts/tiled-export-zone.mts <zoneId> [layoutName]
 *   zoneId      — e.g. "office" (default zone id, see DEFAULT_ZONE_ID)
 *   layoutName  — a saved layout name, or omit for the zone's current active one
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { appStore } from '../src/appStore.js';
import { loadDefaultLayout } from '../src/assetLoader.js';
import { loadAssetBundle } from '../src/assets.js';
import { LayoutStore, DEFAULT_LAYOUT_NAME } from '../src/layoutStore.js';
import { exportLayoutToTmj, type TmjImageAsset } from '../src/tiled/mapBridge.js';
import { loadTiledRegistry } from '../src/tiled/tiledRegistry.js';
import { buildDynamicCatalog } from '../../shared/src/office/layout/furnitureCatalog.js';
import { deserializeLayout } from '../../shared/src/office/layout/layoutSerializer.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const ZONES_DIR = path.join(ROOT, 'assets', 'tiled', 'zones');

async function main(): Promise<void> {
  const zoneId = process.argv[2];
  const layoutName = process.argv[3];
  if (!zoneId) {
    console.error('Usage: tiled-export-zone.mts <zoneId> [layoutName]');
    process.exit(1);
  }

  const bundle = await loadAssetBundle();
  const furnMsg = bundle.messages.find((m) => (m as { type?: string }).type === 'furnitureAssetsLoaded') as
    | { catalog: never; sprites: never }
    | undefined;
  if (furnMsg) buildDynamicCatalog({ catalog: furnMsg.catalog, sprites: furnMsg.sprites });

  const layoutStore = new LayoutStore(loadDefaultLayout(ROOT));
  const name = layoutName ?? layoutStore.getActiveName(zoneId);
  const raw = layoutStore.resolve(zoneId, name);
  if (!raw) {
    console.error(`No layout "${name}" found for zone "${zoneId}".`);
    process.exit(1);
  }
  const layout = deserializeLayout(JSON.stringify(raw));
  if (!layout) {
    console.error(`Layout "${name}" for zone "${zoneId}" failed to parse.`);
    process.exit(1);
  }

  const imageRows = appStore.listAssets('image') as Array<{ name: string; data: TmjImageAsset }>;
  const imageAssets = new Map<string, TmjImageAsset>(imageRows.map((r) => [r.name, { ...r.data, id: r.name }]));

  const registry = loadTiledRegistry(ROOT);
  const { tmj, imageFiles } = exportLayoutToTmj(layout, registry, imageAssets, zoneId);

  fs.mkdirSync(ZONES_DIR, { recursive: true });
  const outPath = path.join(ZONES_DIR, `${zoneId}.tmj`);
  fs.writeFileSync(outPath, JSON.stringify(tmj, null, 2) + '\n');
  for (const { relPath, buffer } of imageFiles) {
    const dest = path.join(ZONES_DIR, relPath);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buffer);
  }
  console.log(
    `✓ ${outPath} (${layout.cols}×${layout.rows}, ${layout.furniture.length} furniture, ${imageFiles.length} image(s)) — layout "${name}"${name === DEFAULT_LAYOUT_NAME ? ' (read-only default)' : ''}`,
  );
}

void main();
