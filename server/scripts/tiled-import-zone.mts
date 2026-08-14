#!/usr/bin/env -S node --import tsx
/**
 * Import assets/tiled/zones/<zoneId>.tmj and make it that zone's map. See
 * server/src/tiled/mapBridge.ts and docs/design/tiled-editor-integration.md.
 * A zone has exactly one map, so this replaces whatever was there — the same
 * write a push performs (see src/tiled/zonePushApi.ts), just locally.
 *
 * Usage (from server/): node --import tsx scripts/tiled-import-zone.mts <zoneId>
 *
 * For importing every zones/*.tmj file at once, see tiled-import-all-zones.mts.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { loadAssetBundle } from '../src/assets.js';
import { ZoneMapStore } from '../src/zoneMapStore.js';
import { ZoneStore } from '../src/zoneStore.js';
import { loadTiledRegistry } from '../src/tiled/tiledRegistry.js';
import { importZoneTmjFile, isNoImportMap, NO_IMPORT_SUFFIX } from '../src/tiled/zoneImport.js';
import { buildDynamicCatalog } from '../../shared/src/office/layout/furnitureCatalog.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const ZONES_DIR = path.join(ROOT, 'assets', 'tiled', 'zones');

async function main(): Promise<void> {
  const zoneId = process.argv[2];
  if (!zoneId) {
    console.error('Usage: tiled-import-zone.mts <zoneId>');
    process.exit(1);
  }
  const tmjPath = path.join(ZONES_DIR, `${zoneId}.tmj`);
  if (isNoImportMap(tmjPath)) {
    console.error(`${path.basename(tmjPath)} carries the ${NO_IMPORT_SUFFIX} suffix — scratch maps are never imported. Copy it to a name without that suffix first.`);
    process.exit(1);
  }
  if (!fs.existsSync(tmjPath)) {
    console.error(`No map at ${tmjPath} — author the zone in Tiled and save it there first.`);
    process.exit(1);
  }

  const bundle = await loadAssetBundle();
  const furnMsg = bundle.messages.find((m) => (m as { type?: string }).type === 'furnitureAssetsLoaded') as
    | { catalog: never; sprites: never }
    | undefined;
  if (furnMsg) buildDynamicCatalog({ catalog: furnMsg.catalog, sprites: furnMsg.sprites });

  const registry = loadTiledRegistry(ROOT);
  const mapStore = new ZoneMapStore();
  const zones = new ZoneStore();

  const result = await importZoneTmjFile(tmjPath, registry, zoneId, mapStore, zones);
  console.log(
    `✓ Zone "${zoneId}": ${result.cols}×${result.rows}, ${result.furnitureCount} furniture, ${result.imageCount} image(s).`,
  );
}

void main();
