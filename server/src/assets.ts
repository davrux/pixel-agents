import * as fs from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadCharacterSprites,
  loadFurnitureTilesets,
  loadPetSprites,
} from './assetLoader.js';
import { READING_TOOLS, SUBAGENT_TOOL_NAMES } from './constants.js';
import { updateFurnitureDefaults } from './assetOverrides.js';
import { controlBus, ASSET_CHANGED_EVENT } from './controlBus.js';

/** The exact on-join message sequence the original webview expects, built once
 *  at startup. Each entry is a ready-to-send {type, ...payload} object. */
export interface AssetBundle {
  providerCapabilities: Record<string, unknown>;
  messages: Record<string, unknown>[];
  /** Raw decoded data used to initialise the server-side office engine. */
  raw: {
    characters: unknown[];
    dogs: unknown[];
    cats: unknown[];
    ducks: unknown[];
    furnitureCatalog: unknown[];
    furnitureSprites: Record<string, unknown>;
    /** Uploaded background images (see shared/office/imageAssets.ts) — no
     *  bundled defaults, always starts empty. */
    images: unknown[];
  };
}

const __dirname = dirname(fileURLToPath(import.meta.url));
/** Holds the `assets/` directory (assets/tiled, /floors, ...). Defaults to
 *  the repo root; override with PIXEL_STREAM_ASSETS_DIR for custom deployments. */
export const ASSETS_ROOT = process.env.PIXEL_STREAM_ASSETS_DIR?.trim() || resolve(__dirname, '..', '..');

/** Furniture catalog + sprites: whatever assets/tiled/furniture-*.tsj yields,
 *  plus the generated, non-tileset furniture (portals + conference monitor +
 *  arcade cabinet + meeting-room kiosk + uponu wall logo) — real, editable
 *  catalog entries built in code rather than authored in Tiled. Split out
 *  from loadAssetBundle so watchFurnitureTilesets can re-run just this half
 *  when a .tsj file changes on disk, without reloading characters/pets/floor/wall. */
export async function buildFurnitureCatalogAndSprites(): Promise<{
  catalog: unknown[];
  sprites: Record<string, unknown>;
  loaded: boolean;
}> {
  const furniture = await loadFurnitureTilesets(ASSETS_ROOT);
  // Everything comes from the tilesets. There used to be a second source here —
  // portals, conference monitor, arcade cabinet, meeting kiosk and the wall logos
  // were drawn in code and appended to the catalog, while a baked copy of the same
  // art sat in furniture-decor.tsj purely so Tiled could show a real sprite. Two
  // copies of one picture, and the behaviour was authored in Tiled either way, so
  // the code half was pure duplication (see git history for the generators and
  // bake-generated-furniture.mts).
  const catalog = furniture?.catalog ?? [];
  const sprites: Record<string, unknown> = furniture ? Object.fromEntries(furniture.sprites) : {};
  return { catalog, sprites, loaded: !!furniture };
}

export async function loadAssetBundle(): Promise<AssetBundle> {
  const [characters, pets, furniture] = await Promise.all([
    loadCharacterSprites(ASSETS_ROOT),
    loadPetSprites(ASSETS_ROOT),
    buildFurnitureCatalogAndSprites(),
  ]);

  const messages: Record<string, unknown>[] = [];
  if (characters) messages.push({ type: 'characterSpritesLoaded', characters: characters.characters });
  if (pets) messages.push({ type: 'petSpritesLoaded', dogs: pets.dogs, cats: pets.cats, ducks: pets.ducks });
  if (furniture.loaded) {
    messages.push({
      type: 'furnitureAssetsLoaded',
      catalog: furniture.catalog,
      sprites: furniture.sprites,
    });
  }
  // No bundled images — always present so assetOverrides.ts's buildMerged()
  // has a message to rebuild once the first one is uploaded.
  messages.push({ type: 'imagesLoaded', images: [] });

  return {
    providerCapabilities: {
      type: 'providerCapabilities',
      readingTools: READING_TOOLS,
      subagentToolNames: SUBAGENT_TOOL_NAMES,
    },
    messages,
    raw: {
      characters: characters?.characters ?? [],
      dogs: pets?.dogs ?? [],
      cats: pets?.cats ?? [],
      ducks: pets?.ducks ?? [],
      furnitureCatalog: furniture.catalog,
      furnitureSprites: furniture.sprites,
      images: [],
    },
  };
}

/** Any tileset — the watcher cannot tell from the name whether a file holds
 *  furniture (see isFurnitureTileset), and rebuilding the catalog after a
 *  floor-sheet save is a cheap no-op rather than a reason to keep a naming
 *  convention load-bearing. */
const TILESET_FILENAME_RE = /\.tsj$/;

/** "Save in Tiled → live", no server restart: watches assets/tiled for
 *  tileset changes and reloads the furniture catalog into the
 *  process-wide defaults (see assetOverrides.ts's updateFurnitureDefaults),
 *  then tells every zone to re-broadcast — same path a saveAsset edit takes
 *  (see SimRoom.ts's ASSET_CHANGED_EVENT handling). Call once at boot, after
 *  initAssetDefaults(). No separate prod/dev flag: harmless to leave running
 *  in any deployment, since a stable one never touches assets/tiled.
 *  See docs/design/tiled-editor-integration.md. */
/** Rebuild the furniture catalog from whatever is on disk now and tell every
 *  zone to re-broadcast. Exported because assets can arrive two ways: a file
 *  saved in Tiled locally (the watcher below) and a push from another machine
 *  (tiled/zonePushApi.ts) — the second writes files the watcher does not cover
 *  (floor/wall sheets, PNGs) and should not depend on an fs event to finish the
 *  job. Returns the item count for logging. */
export async function reloadFurnitureCatalog(): Promise<number> {
  const { catalog, sprites } = await buildFurnitureCatalogAndSprites();
  updateFurnitureDefaults(catalog, sprites);
  controlBus.emit(ASSET_CHANGED_EVENT, 'furniture');
  return catalog.length;
}

export function watchFurnitureTilesets(): void {
  const tiledDir = join(ASSETS_ROOT, 'assets', 'tiled');
  if (!fs.existsSync(tiledDir)) return;

  let pending: NodeJS.Timeout | null = null;
  const reload = () => {
    pending = null;
    void reloadFurnitureCatalog()
      .then((n) => console.log(`[tiled-watch] furniture catalog reloaded (${n} items)`))
      .catch((err) => console.warn('[tiled-watch] reload failed:', err instanceof Error ? err.message : err));
  };

  // Debounced: editors commonly emit several fs events (write + rename) per save.
  fs.watch(tiledDir, (_event, filename) => {
    if (!filename || !TILESET_FILENAME_RE.test(filename)) return;
    if (pending) clearTimeout(pending);
    pending = setTimeout(reload, 200);
  });
  console.log(`[tiled-watch] watching ${tiledDir} for *.tsj changes`);
}
