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
 *
 * For importing every zones/*.tmj file at once, see tiled-import-all-zones.mts.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { loadDefaultLayout } from '../src/assetLoader.js';
import { loadAssetBundle } from '../src/assets.js';
import { LayoutStore } from '../src/layoutStore.js';
import { ZoneStore } from '../src/zoneStore.js';
import { loadTiledRegistry } from '../src/tiled/tiledRegistry.js';
import { importZoneTmjFile, isNoImportMap, NO_IMPORT_SUFFIX, DEFAULT_TILED_IMPORT_LAYOUT_NAME } from '../src/tiled/zoneImport.js';
import { buildDynamicCatalog } from '../../shared/src/office/layout/furnitureCatalog.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const ZONES_DIR = path.join(ROOT, 'assets', 'tiled', 'zones');

async function main(): Promise<void> {
  const zoneId = process.argv[2];
  const layoutName = process.argv[3] ?? DEFAULT_TILED_IMPORT_LAYOUT_NAME;
  if (!zoneId) {
    console.error('Usage: tiled-import-zone.mts <zoneId> [layoutName]');
    process.exit(1);
  }
  if (!LayoutStore.isValidUserName(layoutName)) {
    console.error(`Invalid layout name "${layoutName}".`);
    process.exit(1);
  }

  const tmjPath = path.join(ZONES_DIR, `${zoneId}.tmj`);
  if (isNoImportMap(tmjPath)) {
    console.error(`${path.basename(tmjPath)} carries the ${NO_IMPORT_SUFFIX} suffix — scratch maps are never imported. Copy it to a name without that suffix first.`);
    process.exit(1);
  }
  if (!fs.existsSync(tmjPath)) {
    console.error(`No exported map at ${tmjPath} — run tiled-export-zone.mts first.`);
    process.exit(1);
  }

  const bundle = await loadAssetBundle();
  const furnMsg = bundle.messages.find((m) => (m as { type?: string }).type === 'furnitureAssetsLoaded') as
    | { catalog: never; sprites: never }
    | undefined;
  if (furnMsg) buildDynamicCatalog({ catalog: furnMsg.catalog, sprites: furnMsg.sprites });

  const registry = loadTiledRegistry(ROOT);
  const layoutStore = new LayoutStore(loadDefaultLayout(ROOT));
  const zones = new ZoneStore();

  const result = await importZoneTmjFile(tmjPath, registry, zoneId, layoutName, layoutStore, zones);
  console.log(
    `✓ Saved zone "${zoneId}" layout "${layoutName}" (${result.cols}×${result.rows}, ${result.furnitureCount} furniture, ${result.imageCount} image(s)) and made it active.`,
  );
}

void main();
