import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadCharacterSprites,
  loadDefaultLayout,
  loadFloorTiles,
  loadFurnitureAssets,
  loadPetSprites,
  loadWallTiles,
} from './assetLoader.js';
import { READING_TOOLS, SUBAGENT_TOOL_NAMES } from './constants.js';
import { portalAssets } from './portalAssets.js';
import { conferenceAssets } from './conferenceAssets.js';
import { arcadeAssets } from './arcadeAssets.js';

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
    layout: Record<string, unknown> | null;
  };
}

const __dirname = dirname(fileURLToPath(import.meta.url));
/** Holds the `assets/` directory (assets/furniture, /floors, ...). Defaults to
 *  the repo root; override with PIXEL_STREAM_ASSETS_DIR for custom deployments. */
const ASSETS_ROOT = process.env.PIXEL_STREAM_ASSETS_DIR?.trim() || resolve(__dirname, '..', '..');

export async function loadAssetBundle(): Promise<AssetBundle> {
  const [characters, pets, floorTiles, wallTiles, furniture] = await Promise.all([
    loadCharacterSprites(ASSETS_ROOT),
    loadPetSprites(ASSETS_ROOT),
    loadFloorTiles(ASSETS_ROOT),
    loadWallTiles(ASSETS_ROOT),
    loadFurnitureAssets(ASSETS_ROOT),
  ]);
  const layout = loadDefaultLayout(ASSETS_ROOT);

  // Inject generated furniture (portals + conference monitor + arcade cabinet) into
  // the catalog so they're real, editable furniture.
  const generated = [...portalAssets(), ...conferenceAssets(), ...arcadeAssets()];
  const furnitureCatalog = [...(furniture?.catalog ?? []), ...generated.map((p) => p.entry)];
  const furnitureSprites: Record<string, unknown> = {
    ...(furniture ? Object.fromEntries(furniture.sprites) : {}),
    ...Object.fromEntries(generated.map((p) => [p.entry.id as string, p.sprite])),
  };

  const messages: Record<string, unknown>[] = [];
  if (characters) messages.push({ type: 'characterSpritesLoaded', characters: characters.characters });
  if (pets) messages.push({ type: 'petSpritesLoaded', dogs: pets.dogs, cats: pets.cats, ducks: pets.ducks });
  if (floorTiles) messages.push({ type: 'floorTilesLoaded', sprites: floorTiles.sprites });
  if (wallTiles) messages.push({ type: 'wallTilesLoaded', sets: wallTiles.sets });
  if (furniture) {
    messages.push({
      type: 'furnitureAssetsLoaded',
      catalog: furnitureCatalog,
      sprites: furnitureSprites,
    });
  }
  if (layout) {
    messages.push({ type: 'layoutLoaded', layout, activeLayout: 'Default', force: true });
  }

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
      furnitureCatalog,
      furnitureSprites,
      layout,
    },
  };
}
