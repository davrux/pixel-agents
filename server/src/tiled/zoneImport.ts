/**
 * Shared logic behind server/scripts/tiled-import-zone.mts (one zone) and
 * tiled-import-all-zones.mts (every zones/*.tmj file) — factored out so
 * neither script duplicates the actual (read → import → save) sequence, and
 * so the batch script can do the expensive one-time setup (asset bundle,
 * registry, LayoutStore) once instead of per file.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PNG } from 'pngjs';

import { appStore } from '../appStore.js';
import { LayoutStore } from '../layoutStore.js';
import { sanitizeLayoutTexts, sanitizeLayoutImages, sanitizeLayoutActions } from '../layoutSanitize.js';
import { importTmjToLayout } from './mapBridge.js';
import { type TiledRegistry } from './tiledRegistry.js';
import { serializeLayout, deserializeLayout } from '@pixel/shared/office/layout/layoutSerializer.js';

export interface ZoneImportResult {
  cols: number;
  rows: number;
  furnitureCount: number;
  imageCount: number;
}

/** Read a .tmj's own `mapName` Map property (see Pixels.tiled-project's Map
 *  class) — the zone this map belongs to, independent of its filename.
 *  Null if absent (predates this property, or hand-created without it). */
export function readMapName(tmjPath: string): string | null {
  const tmj = JSON.parse(fs.readFileSync(tmjPath, 'utf-8')) as { properties?: Array<{ name: string; value: unknown }> };
  const found = (tmj.properties ?? []).find((p) => p.name === 'mapName');
  return typeof found?.value === 'string' && found.value ? found.value : null;
}

/** Import one zones/<file>.tmj into a saved layout for `zoneId`, making it
 *  that zone's active layout (matches LayoutStore.saveAs, the same call the
 *  in-game "Save As" uses). `zonesDir` resolves the map's own relative image
 *  paths (`images/<id>.png`, siblings of the .tmj). */
export async function importZoneTmjFile(
  tmjPath: string,
  zonesDir: string,
  registry: TiledRegistry,
  zoneId: string,
  layoutName: string,
  layoutStore: LayoutStore,
): Promise<ZoneImportResult> {
  const tmj = JSON.parse(fs.readFileSync(tmjPath, 'utf-8'));
  const { layout, images } = importTmjToLayout(tmj, registry, (relPath) => {
    const p = path.join(zonesDir, relPath);
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
    throw new Error(`Imported layout from ${tmjPath} failed to (de)serialize`);
  }
  // Same content checks as the live save/save-as path (SimRoom.ts) — a
  // hand-edited .tmj is no more trusted than a patched client, so texts/
  // images/actions get the same caps and https://-only enforcement before
  // ever reaching the DB.
  const sanitized = sanitizeLayoutImages(sanitizeLayoutActions(sanitizeLayoutTexts(normalized as unknown as Record<string, unknown>)));
  layoutStore.saveAs(zoneId, layoutName, sanitized, Date.now());
  return {
    cols: normalized.cols,
    rows: normalized.rows,
    furnitureCount: normalized.furniture.length,
    imageCount: images.length,
  };
}
