import * as fs from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadCharacterSprites,
  loadFurnitureTilesets,
  loadPetSprites,
} from './assetLoader.js';
import { READING_TOOLS, SUBAGENT_TOOL_NAMES } from './constants.js';
import { ATLAS_MANIFEST_REL, ensureFurnitureAtlas } from './tiled/furnitureAtlas.js';
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
    /** id → image + rect, what the client draws from (see LoadedAssets.refs). */
    furnitureRefs: Record<string, unknown>;
    /** Uploaded background images (see shared/office/imageAssets.ts) — no
     *  bundled defaults, always starts empty. */
    images: unknown[];
  };
}

const __dirname = dirname(fileURLToPath(import.meta.url));
/** Holds the `assets/` directory (assets/tiled, /characters, ...). Defaults to
 *  the repo root; override with PIXEL_STREAM_ASSETS_DIR for custom deployments. */
export const ASSETS_ROOT = process.env.PIXEL_STREAM_ASSETS_DIR?.trim() || resolve(__dirname, '..', '..');

/** Furniture catalog + sprites: whatever assets/tiled/furniture-*.tsj yields —
 *  the tilesets are the only source (the code-drawn fixtures that used to be
 *  appended here are ordinary tiles now; see below). Split out
 *  from loadAssetBundle so watchFurnitureTilesets can re-run just this half
 *  when a .tsj file changes on disk, without reloading characters/pets/floor/wall. */
/**
 * The baked atlas's manifest, if it is on disk — which ids it holds and where.
 *
 * Read here so the message can point at the atlas instead of at 385 individual
 * PNGs: one request and one texture in the client rather than hundreds. Absent
 * means "not baked yet", and every id then simply refers to its own file, which
 * still works.
 */
function atlasRefs(): Record<string, { img: string; x: number; y: number; w: number; h: number }> {
  try {
    const file = join(ASSETS_ROOT, 'assets', 'tiled', ATLAS_MANIFEST_REL);
    if (!fs.existsSync(file)) return {};
    const manifest = JSON.parse(fs.readFileSync(file, 'utf-8')) as {
      image?: string;
      frames?: Record<string, { x: number; y: number; w: number; h: number }>;
    };
    if (!manifest.image || !manifest.frames) return {};
    const img = manifest.image;
    return Object.fromEntries(Object.entries(manifest.frames).map(([id, r]) => [id, { img, ...r }]));
  } catch (err) {
    console.warn(`[assets] could not read the furniture atlas manifest: ${(err as Error)?.message}`);
    return {};
  }
}

export async function buildFurnitureCatalogAndSprites(): Promise<{
  catalog: unknown[];
  sprites: Record<string, unknown>;
  /** id → image + rect, for the client. See LoadedAssets.refs. */
  refs: Record<string, unknown>;
  loaded: boolean;
}> {
  // Keep the derived artifact current before anything reads it. The atlas is
  // packed FROM these tilesets, so a stale one silently changes the delivery
  // format: ids it lacks travel as their own file instead, and whether that
  // happens depended on somebody remembering to run a script. Baking here covers
  // both callers — startup and the tileset watcher. A source PNG edited without
  // touching its tileset is picked up at the next start, since the watcher
  // watches tilesets.
  const atlas = ensureFurnitureAtlas(ASSETS_ROOT);
  console.log(`[assets] furniture atlas ${atlas.baked ? 're-baked' : ''}${atlas.baked ? ': ' : ''}${atlas.reason}`);
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
  // Per-file refs from the loader, then the atlas on top: for an id the atlas
  // carries, that is the better source (one image for all of them), and for
  // anything it does not — a grid sheet's tile, art added since the bake — the
  // file ref stands.
  const refs: Record<string, unknown> = {
    ...(furniture ? Object.fromEntries(furniture.refs) : {}),
    ...atlasRefs(),
  };
  return { catalog, sprites, refs, loaded: !!furniture };
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
      spriteRefs: furniture.refs,
      // Pixels only for ids no image covers — see assetOverrides.ts's buildMerged.
      sprites: Object.fromEntries(Object.entries(furniture.sprites).filter(([id]) => !furniture.refs[id])),
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
      furnitureRefs: furniture.refs,
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
 *  See docs/design.md. */
/** Rebuild the furniture catalog from whatever is on disk now and tell every
 *  zone to re-broadcast. Exported because assets can arrive two ways: a file
 *  saved in Tiled locally (the watcher below) and a push from another machine
 *  (tiled/zonePushApi.ts) — the second writes files the watcher does not cover
 *  (floor/wall sheets, PNGs) and should not depend on an fs event to finish the
 *  job. Returns the item count for logging. */
export async function reloadFurnitureCatalog(): Promise<number> {
  const { catalog, sprites, refs } = await buildFurnitureCatalogAndSprites();
  updateFurnitureDefaults(catalog, sprites, refs);
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
