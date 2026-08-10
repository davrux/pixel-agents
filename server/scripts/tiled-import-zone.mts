#!/usr/bin/env -S node --import tsx
/**
 * Import assets/tiled/zones/<zoneId>.tmj back into a saved layout for that
 * zone. See server/src/tiled/mapBridge.ts and
 * docs/design/tiled-editor-integration.md. Writes a NEW (or updates an
 * existing) named layout — never the read-only "Default" — and makes it the
 * zone's active layout (matching LayoutStore.saveAs, the same call the
 * in-game "Save As" uses).
 *
 * Usage (from server/): node --import tsx scripts/tiled-import-zone.mts <zoneId> [layoutName]
 *   layoutName — defaults to "TiledImport"
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PNG } from 'pngjs';

import { appStore } from '../src/appStore.js';
import { loadDefaultLayout } from '../src/assetLoader.js';
import { loadAssetBundle } from '../src/assets.js';
import { LayoutStore } from '../src/layoutStore.js';
import { importTmjToLayout } from '../src/tiled/mapBridge.js';
import { loadTiledRegistry } from '../src/tiled/tiledRegistry.js';
import { buildDynamicCatalog } from '../../shared/src/office/layout/furnitureCatalog.js';
import { serializeLayout, deserializeLayout } from '../../shared/src/office/layout/layoutSerializer.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const ZONES_DIR = path.join(ROOT, 'assets', 'tiled', 'zones');

async function main(): Promise<void> {
  const zoneId = process.argv[2];
  const layoutName = process.argv[3] ?? 'TiledImport';
  if (!zoneId) {
    console.error('Usage: tiled-import-zone.mts <zoneId> [layoutName]');
    process.exit(1);
  }
  if (!LayoutStore.isValidUserName(layoutName)) {
    console.error(`Invalid layout name "${layoutName}".`);
    process.exit(1);
  }

  const tmjPath = path.join(ZONES_DIR, `${zoneId}.tmj`);
  if (!fs.existsSync(tmjPath)) {
    console.error(`No exported map at ${tmjPath} — run tiled-export-zone.mts first.`);
    process.exit(1);
  }
  const tmj = JSON.parse(fs.readFileSync(tmjPath, 'utf-8'));

  const bundle = await loadAssetBundle();
  const furnMsg = bundle.messages.find((m) => (m as { type?: string }).type === 'furnitureAssetsLoaded') as
    | { catalog: never; sprites: never }
    | undefined;
  if (furnMsg) buildDynamicCatalog({ catalog: furnMsg.catalog, sprites: furnMsg.sprites });

  const registry = loadTiledRegistry(ROOT);
  const { layout, images } = importTmjToLayout(tmj, registry, (relPath) => {
    const p = path.join(ZONES_DIR, relPath);
    return fs.existsSync(p) ? fs.readFileSync(p) : null;
  });

  for (const { imageId, label, buffer } of images) {
    const { width, height } = PNG.sync.read(buffer);
    appStore.saveAsset('image', imageId, {
      data: `data:image/png;base64,${buffer.toString('base64')}`,
      width,
      height,
      label,
    });
  }

  // Round-trip through (de)serializeLayout so this matches exactly what a
  // normal in-game save would persist (same shape validation/normalization).
  const normalized = deserializeLayout(serializeLayout(layout));
  if (!normalized) {
    console.error('Imported layout failed to (de)serialize — not saved.');
    process.exit(1);
  }

  const layoutStore = new LayoutStore(loadDefaultLayout(ROOT));
  layoutStore.saveAs(zoneId, layoutName, normalized, Date.now());
  console.log(
    `✓ Saved zone "${zoneId}" layout "${layoutName}" (${normalized.cols}×${normalized.rows}, ${normalized.furniture.length} furniture, ${images.length} image(s)) and made it active.`,
  );
}

void main();
