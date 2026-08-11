#!/usr/bin/env -S node --import tsx
/**
 * Import every assets/tiled/zones/*.tmj file at once — for when new zones
 * were added straight in Tiled rather than exported via
 * tiled-export-zone.mts. This is NOT automatic on server start; run it by
 * hand after adding/editing zone files.
 *
 * Each file's target zone is its own `mapName` Map property (Tiled: View →
 * Custom Types Editor → Map, or the Properties panel with nothing selected)
 * — not its filename — so renaming a .tmj or copy-pasting one as a starting
 * point for a new zone doesn't silently import it under the wrong zone.
 * Falls back to the filename (without extension) if `mapName` is unset,
 * e.g. for files predating that property.
 *
 * Usage (from server/): node --import tsx scripts/tiled-import-all-zones.mts [layoutName]
 *   layoutName — defaults to "TiledImport", same as tiled-import-zone.mts
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { loadDefaultLayout } from '../src/assetLoader.js';
import { loadAssetBundle } from '../src/assets.js';
import { LayoutStore } from '../src/layoutStore.js';
import { loadTiledRegistry } from '../src/tiled/tiledRegistry.js';
import { importZoneTmjFile, readMapName } from '../src/tiled/zoneImport.js';
import { buildDynamicCatalog } from '../../shared/src/office/layout/furnitureCatalog.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const ZONES_DIR = path.join(ROOT, 'assets', 'tiled', 'zones');

async function main(): Promise<void> {
  const layoutName = process.argv[2] ?? 'TiledImport';
  if (!LayoutStore.isValidUserName(layoutName)) {
    console.error(`Invalid layout name "${layoutName}".`);
    process.exit(1);
  }

  const files = fs.existsSync(ZONES_DIR) ? fs.readdirSync(ZONES_DIR).filter((f) => f.endsWith('.tmj')).sort() : [];
  if (files.length === 0) {
    console.error(`No .tmj files found in ${ZONES_DIR}.`);
    process.exit(1);
  }

  const bundle = await loadAssetBundle();
  const furnMsg = bundle.messages.find((m) => (m as { type?: string }).type === 'furnitureAssetsLoaded') as
    | { catalog: never; sprites: never }
    | undefined;
  if (furnMsg) buildDynamicCatalog({ catalog: furnMsg.catalog, sprites: furnMsg.sprites });

  const registry = loadTiledRegistry(ROOT);
  const layoutStore = new LayoutStore(loadDefaultLayout(ROOT));

  let ok = 0;
  let failed = 0;
  for (const file of files) {
    const tmjPath = path.join(ZONES_DIR, file);
    const zoneId = readMapName(tmjPath) ?? path.basename(file, '.tmj');
    try {
      const result = await importZoneTmjFile(tmjPath, ZONES_DIR, registry, zoneId, layoutName, layoutStore);
      console.log(
        `✓ ${file} → zone "${zoneId}" layout "${layoutName}" (${result.cols}×${result.rows}, ${result.furnitureCount} furniture, ${result.imageCount} image(s))`,
      );
      ok++;
    } catch (err) {
      console.error(`✗ ${file} → zone "${zoneId}": ${(err as Error).message}`);
      failed++;
    }
  }
  console.log(`\n${ok} imported, ${failed} failed, out of ${files.length} file(s).`);
  if (failed > 0) process.exit(1);
}

void main();
