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
import { loadDefaultLayout } from '../assetLoader.js';
import { LayoutStore } from '../layoutStore.js';
import { ZoneStore } from '../zoneStore.js';
import { controlBus, ZONE_LAYOUT_CHANGED_EVENT } from '../controlBus.js';
import { sanitizeLayoutTexts, sanitizeLayoutImages, sanitizeLayoutActions } from '../layoutSanitize.js';
import { importTmjToLayout } from './mapBridge.js';
import { loadTiledRegistry, type TiledRegistry } from './tiledRegistry.js';
import { serializeLayout, deserializeLayout } from '@pixel/shared/office/layout/layoutSerializer.js';

/** Directory this .tmj lives in ends up being `assets/tiled/zones` in every
 *  real deployment (this file lives at server/src/tiled/, three levels below
 *  the repo root) — overridable the same way assets.ts's ASSETS_ROOT is, for
 *  a custom deployment layout. */
const ASSETS_ROOT = process.env.PIXEL_STREAM_ASSETS_DIR?.trim() || path.resolve(import.meta.dirname, '..', '..', '..');

/** The layout name every Tiled-import path (both CLI scripts and
 *  watchZoneFiles below) saves under by default — one name so a mapper's
 *  repeated saves keep landing on the same layout instead of piling up a
 *  new one per import. */
export const DEFAULT_TILED_IMPORT_LAYOUT_NAME = 'TiledImport';

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

/** The zone id a .tmj resolves to: its own `mapName` (falling back to the
 *  filename), lowercased. Every zone id in this system is already lowercase
 *  ("office", "plaza", ...) and ZoneStore.create's slugify always lowercases
 *  whatever label it's given — but a zone LOOKUP (`ZoneStore.has`) is a
 *  plain, case-SENSITIVE string match. Skipping this normalization means a
 *  mapName of "Office" or "UPONU" would fail to match the real "office"/
 *  "uponu" zone and silently create a near-duplicate ("uponu-2", ...)
 *  instead of updating the one that already exists — exactly the mismatch
 *  this closes. */
export function resolveZoneId(tmjPath: string, filename: string): string {
  return (readMapName(tmjPath) ?? path.basename(filename, '.tmj')).toLowerCase();
}

/** Import one zones/<file>.tmj into a saved layout for `zoneId`, making it
 *  that zone's active layout (matches LayoutStore.saveAs, the same call the
 *  in-game "Save As" uses). Placed images resolve against assets/tiled
 *  itself, never zone-relative — either the referenced tile's own `image`
 *  path (any file a mapper added directly via Tiled's Tileset editor), or
 *  the png/images/<id>.png convention bake-images-tiled.mts writes, as a
 *  fallback for a bare (non-tile) Image object (see mapBridge.ts). A
 *  'spawnPoint' tile action (see Action) sets the zone's own arrival point
 *  the same way the in-game "Arrival point" click flow does — the FIRST one
 *  found wins if a mapper accidentally places more than one. */
export async function importZoneTmjFile(
  tmjPath: string,
  registry: TiledRegistry,
  zoneId: string,
  layoutName: string,
  layoutStore: LayoutStore,
  zones: ZoneStore,
): Promise<ZoneImportResult> {
  const tmj = JSON.parse(fs.readFileSync(tmjPath, 'utf-8'));
  const tiledDir = path.join(ASSETS_ROOT, 'assets', 'tiled');
  const { layout, images } = importTmjToLayout(tmj, registry, (relPath) => {
    const p = path.join(tiledDir, relPath);
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
  // Create the zone (if it doesn't exist yet) BEFORE the spawnPoint handling
  // below — ZoneStore.edit (used to set arrive) is a no-op against a zone
  // that doesn't exist yet, which a first-ever import of a new zone would
  // otherwise silently hit.
  ensureZoneExists(zones, zoneId, normalized.cols, normalized.rows);
  // Same content checks as the live save/save-as path (SimRoom.ts) — a
  // hand-edited .tmj is no more trusted than a patched client, so texts/
  // images/actions get the same caps and https://-only enforcement before
  // ever reaching the DB.
  const sanitized = sanitizeLayoutImages(sanitizeLayoutActions(sanitizeLayoutTexts(normalized as unknown as Record<string, unknown>)));
  layoutStore.saveAs(zoneId, layoutName, sanitized, Date.now());

  const tileActions = sanitized.tileActions as Array<{ kind: string } | null> | undefined;
  const cols = sanitized.cols as number;
  const spawnIdx = tileActions?.findIndex((a) => a?.kind === 'spawnPoint') ?? -1;
  if (spawnIdx >= 0) {
    zones.edit(zoneId, { arrive: { col: spawnIdx % cols, row: Math.floor(spawnIdx / cols) } });
  }

  return {
    cols: normalized.cols,
    rows: normalized.rows,
    furnitureCount: normalized.furniture.length,
    imageCount: images.length,
  };
}

/** Create a zone matching `zoneId` if none exists yet, sized from the map
 *  that was just imported for it — so importing a .tmj for a not-yet-known
 *  zone (whether by hand via the CLI scripts or picked up by
 *  watchZoneFiles) is enough on its own; no separate "create zone" step
 *  needed first. A no-op if the zone already exists (the overwhelmingly
 *  common case once a zone's been imported once). Logs instead of throwing
 *  if `zoneId` has characters ZoneStore.create's slugify would change
 *  (spaces, punctuation, non-ASCII, ...) — the layout is saved and harmless
 *  either way, just not reachable under this exact id until a zone matching
 *  it is created some other way. */
export function ensureZoneExists(zones: ZoneStore, zoneId: string, cols: number, rows: number): void {
  if (zones.has(zoneId)) return;
  const createdId = zones.create(zoneId, cols, rows, Date.now());
  if (createdId !== zoneId) {
    console.warn(`[tiled-import] "${zoneId}" isn't usable as a zone id as-is (got "${createdId}" back) — layout imported, but no zone was created for it.`);
  }
}

const ZONE_TMJ_RE = /\.tmj$/;

/** "Save in Tiled → live", no server restart or manual CLI run: watches
 *  assets/tiled/zones for .tmj changes and imports each one straight into
 *  its own zone's saved layout, the same way tiled-import-all-zones.mts
 *  does by hand — see importZoneTmjFile. The target zone is created (sized
 *  from the imported map itself) the first time its mapName/filename shows
 *  up; every already-open room for that zone reloads live via
 *  ZONE_LAYOUT_CHANGED_EVENT, the same way a loadLayout message would.
 *  Mirrors assets.ts's watchFurnitureTilesets — call once at boot; harmless
 *  to leave running in any deployment, since a stable server never touches
 *  assets/tiled. See docs/design/tiled-editor-integration.md. */
export function watchZoneFiles(): void {
  const zonesDir = path.join(ASSETS_ROOT, 'assets', 'tiled', 'zones');
  if (!fs.existsSync(zonesDir)) return;

  const layoutStore = new LayoutStore(loadDefaultLayout(ASSETS_ROOT));
  const zones = new ZoneStore();
  const pending = new Map<string, NodeJS.Timeout>();

  const importOne = async (file: string): Promise<void> => {
    pending.delete(file);
    const tmjPath = path.join(zonesDir, file);
    if (!fs.existsSync(tmjPath)) return; // deleted before its debounce fired
    const zoneId = resolveZoneId(tmjPath, file);
    try {
      // Reloaded fresh per import (not cached at boot) so a furniture
      // tileset added/changed since server start still resolves correctly —
      // matches watchFurnitureTilesets rebuilding the furniture catalog on
      // every save rather than once.
      const registry = loadTiledRegistry(ASSETS_ROOT);
      const result = await importZoneTmjFile(tmjPath, registry, zoneId, DEFAULT_TILED_IMPORT_LAYOUT_NAME, layoutStore, zones);
      controlBus.emit(ZONE_LAYOUT_CHANGED_EVENT, zoneId);
      console.log(`[tiled-watch] ${file} → zone "${zoneId}" (${result.cols}×${result.rows}, ${result.furnitureCount} furniture, ${result.imageCount} image(s))`);
    } catch (err) {
      console.warn(`[tiled-watch] ${file} import failed:`, err instanceof Error ? err.message : err);
    }
  };

  // Debounced PER FILE: editors commonly emit several fs events per save,
  // and saving one zone must not delay or get coalesced with another's.
  fs.watch(zonesDir, (_event, filename) => {
    if (!filename || !ZONE_TMJ_RE.test(filename)) return;
    const existing = pending.get(filename);
    if (existing) clearTimeout(existing);
    pending.set(
      filename,
      setTimeout(() => void importOne(filename), 300),
    );
  });
  console.log(`[tiled-watch] watching ${zonesDir} for zone .tmj changes`);
}
