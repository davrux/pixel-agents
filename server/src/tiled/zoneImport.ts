/**
 * Shared logic behind server/scripts/tiled-import-zone.mts (one zone) and
 * tiled-import-all-zones.mts (every zones/*.tmj file) — factored out so
 * neither script duplicates the actual (read → import → save) sequence, and
 * so the batch script can do the expensive one-time setup (asset bundle,
 * registry, ZoneMapStore) once instead of per file.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { appStore } from '../appStore.js';
import { ZoneMapStore } from '../zoneMapStore.js';
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

/** The layout name every Tiled-import path (the CLI scripts and the push
 *  endpoint) saves under by default — one name so a mapper's repeated saves
 *  keep landing on the same layout instead of piling up a new one per import. */

/** Filename suffix marking a zones/*.tmj as a scratch copy that must never be
 *  imported: `uponu-noimport.tmj` is a place to try things out while the real
 *  `uponu.tmj` stays untouched. */
export const NO_IMPORT_SUFFIX = '-noimport';

/**
 * Is this a scratch map that must not be imported?
 *
 * Keyed on the FILENAME, deliberately not on the map's own `mapName` — a
 * scratch copy is normally made by duplicating a real map, so it arrives
 * carrying that map's mapName, and resolveZoneId would happily point it at the
 * live zone. That is exactly the accident this prevents: without the check,
 * saving a copy called `uponu-noimport.tmj` imports straight over `uponu`.
 */
export function isNoImportMap(filename: string): boolean {
  return path.basename(filename, '.tmj').toLowerCase().endsWith(NO_IMPORT_SUFFIX);
}

export interface ZoneImportResult {
  cols: number;
  rows: number;
  furnitureCount: number;
  imageCount: number;
  /** Placements whose tile could not be resolved. Non-zero means this map was
   *  authored against different tilesets than the importing server has — the
   *  gids point somewhere else, and those items are simply gone. Reported
   *  rather than thrown so a mostly-fine map still lands, but it is the first
   *  thing to look at when a pushed zone comes out wrong. */
  unresolvedCount: number;
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
 *  ("uponu", ...) and ZoneStore.create's slugify always lowercases
 *  whatever label it's given — but a zone LOOKUP (`ZoneStore.has`) is a
 *  plain, case-SENSITIVE string match. Skipping this normalization means a
 *  mapName of "UPONU" would fail to match the real
 *  "uponu" zone and silently create a near-duplicate ("uponu-2", ...)
 *  instead of updating the one that already exists — exactly the mismatch
 *  this closes. */
export function resolveZoneId(tmjPath: string, filename: string): string {
  return (readMapName(tmjPath) ?? path.basename(filename, '.tmj')).toLowerCase();
}

/** Import one zones/<file>.tmj and make it `zoneId`'s map — a zone has exactly
 *  one, so this replaces whatever was there. Placed images resolve against assets/tiled
 *  itself, never zone-relative — either the referenced tile's own `image`
 *  path (any file a mapper added directly via Tiled's Tileset editor), or
 *  the png/src/images/<id>.png convention bake-images-tiled.mts writes, as a
 *  fallback for a bare (non-tile) Image object (see mapBridge.ts). A
 *  'spawnPoint' tile action (see Action) sets the zone's own arrival point
 *  the same way the in-game "Arrival point" click flow does — the FIRST one
 *  found wins if a mapper accidentally places more than one. */
export async function importZoneTmjFile(
  tmjPath: string,
  registry: TiledRegistry,
  zoneId: string,
  mapStore: ZoneMapStore,
  zones: ZoneStore,
): Promise<ZoneImportResult> {
  // Enforced here, in the one place every import path funnels through, so no
  // caller can forget it (see isNoImportMap for why the filename decides).
  if (isNoImportMap(tmjPath)) {
    throw new Error(`${path.basename(tmjPath)} carries the ${NO_IMPORT_SUFFIX} suffix and is never imported`);
  }
  const tmj = JSON.parse(fs.readFileSync(tmjPath, 'utf-8'));
  return importZoneTmj(tmj, registry, zoneId, mapStore, zones);
}

/**
 * Import an already-parsed .tmj. Split out from importZoneTmjFile so a map can
 * also arrive over the wire (see zonePushApi.ts) rather than only off this
 * machine's disk — a deploy server imports from its own `assets/tiled/zones`
 * only to fill a zone that has no map at all (see seedBundledZones.ts), so a
 * mapper's *edits* reach it no other way.
 *
 * `extraFiles` is how a pushed map carries the images it references: the
 * importer resolves a relative path to bytes, and on a server that never saw
 * the file, disk cannot answer. Falls back to disk for anything not supplied,
 * which is what makes the local CLI path work unchanged.
 */
export async function importZoneTmj(
  tmj: Record<string, unknown>,
  registry: TiledRegistry,
  zoneId: string,
  mapStore: ZoneMapStore,
  zones: ZoneStore,
  extraFiles?: Map<string, Buffer>,
): Promise<ZoneImportResult> {
  const tiledDir = path.join(ASSETS_ROOT, 'assets', 'tiled');
  const { layout, images } = importTmjToLayout(tmj, registry, (relPath) => {
    const supplied = extraFiles?.get(relPath);
    if (supplied) return supplied;
    const p = path.join(tiledDir, relPath);
    return fs.existsSync(p) ? fs.readFileSync(p) : null;
  });

  // A pushed map may bring pictures the server does not have yet. They belong on DISK,
  // next to the tilesets — the layout points at the file and the client fetches it like
  // any other sheet. Nothing goes into the database: an image row used to be base64 that
  // travelled to every client on every join, a copy of a file that is already in git.
  for (const { imageId, src, buffer } of images) {
    const target = path.join(tiledDir, src);
    if (fs.existsSync(target)) continue;
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, buffer);
      console.log(`[zone-import] wrote ${src} (${buffer.length} bytes) — image ${imageId} came with the push`);
    } catch (err) {
      console.warn(`[zone-import] could not write ${src}: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Round-trip through (de)serializeLayout so this matches exactly what a
  // normal in-game save would persist (same shape validation/normalization).
  const normalized = deserializeLayout(serializeLayout(layout));
  if (!normalized) {
    throw new Error(`Imported layout for zone "${zoneId}" failed to (de)serialize`);
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
  mapStore.put(zoneId, sanitized, Date.now());

  // Where players arrive: a 'spawnPoint' action anywhere in the map, first one
  // found. Both carriers count — an ActionArea (a bare marker on the Actions
  // layer) and a furniture placement whose own action override says spawnPoint,
  // e.g. "arrive at this pad". Only tile actions used to be scanned, so marking a
  // placed item was silently ignored: the map looked right in Tiled and players
  // kept landing wherever the zone's stored arrive tile happened to be.
  const cols = sanitized.cols as number;
  const arrive = spawnPointTile(sanitized, cols);
  if (arrive) zones.edit(zoneId, { arrive });

  const furniture = (sanitized.furniture ?? []) as Array<{ id?: string }>;
  return {
    cols: normalized.cols,
    rows: normalized.rows,
    furnitureCount: normalized.furniture.length,
    imageCount: images.length,
    unresolvedCount: furniture.filter((f) => !f.id).length,
  };
}

/** Create a zone matching `zoneId` if none exists yet, sized from the map
 *  that was just imported for it — so importing a .tmj for a not-yet-known
 *  zone (whether by hand via the CLI scripts or picked up by
 *  pushed) is enough on its own; no separate "create zone" step
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

/**
 * The tile a 'spawnPoint' action marks, or null if the map has none.
 *
 * Tile actions (ActionArea) win over furniture, and within each the first one
 * found wins — a mapper who places two has already made an ambiguous map, and
 * picking deterministically beats picking randomly.
 *
 * Only a placement's OWN action counts, never its catalog default: a spawn point
 * is a statement about this map ("players arrive here"), not a property of a kind
 * of furniture, and reading the default would make every copy of such an item a
 * spawn candidate.
 *
 * Worth knowing when authoring: an instance action REPLACES the item's catalog
 * action (see effectiveAction), so putting spawnPoint on a beam pad stops that pad
 * being a portal. To keep both, mark the arrival tile with an ActionArea point
 * beside the pad instead.
 */
function spawnPointTile(layout: Record<string, unknown>, cols: number): { col: number; row: number } | null {
  const tileActions = layout.tileActions as Array<{ kind?: string } | null> | undefined;
  const idx = tileActions?.findIndex((a) => a?.kind === 'spawnPoint') ?? -1;
  if (idx >= 0) return { col: idx % cols, row: Math.floor(idx / cols) };
  const furniture = (layout.furniture ?? []) as Array<{ col?: number; row?: number; action?: { kind?: string } }>;
  const marked = furniture.find((f) => f.action?.kind === 'spawnPoint');
  return marked && typeof marked.col === 'number' && typeof marked.row === 'number'
    ? { col: marked.col, row: marked.row }
    : null;
}
