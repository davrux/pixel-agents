/**
 * Asset Loader - Loads furniture assets from Tiled tileset files
 *
 * Scans assets/tiled/furniture-*.tsj, and loads all referenced PNGs into
 * SpriteData format for use in the webview. See
 * server/src/core/assets/tiledFurniture.ts and
 * docs/design/tiled-editor-integration.md.
 */

import * as fs from 'fs';
import * as path from 'path';

import { CAT_COUNT, DOG_COUNT, DUCK_COUNT, WALL_BITMASK_COUNT } from './core/assets/constants.js';
import type { FurnitureAsset } from './core/assets/manifestUtils.js';
import { FURNITURE_CATEGORY_FILES, parseFurnitureTileset, type TiledTilesetJson } from './core/assets/tiledFurniture.js';
import {
  decodeCharacterPng,
  decodeFloorPng,
  decodePetPng,
  parseWallPng,
  pngToSpriteData,
} from './core/assets/pngDecoder.js';
import type {
  CharacterDirectionSprites,
  PetDirectionSprites,
} from './core/assets/types.js';
export type { CharacterDirectionSprites, PetDirectionSprites } from './core/assets/types.js';
import {
  resolveCharacterSpec,
  type CharacterSpec,
} from '@pixel/shared/office/sprites/characterSpec.js';

import { LAYOUT_REVISION_KEY } from './constants.js';

export type { FurnitureAsset };

export interface LoadedAssets {
  catalog: FurnitureAsset[];
  sprites: Map<string, string[][]>; // assetId -> SpriteData
}

/**
 * Load the furniture catalog from assets/tiled/furniture-<category>.tsj —
 * one Tiled tileset file per curated category (see FURNITURE_CATEGORY_FILES).
 * Each tile's PNG path is resolved relative to the tileset file's own
 * directory (Tiled's own convention for a "Collection of Images" tileset).
 */
export async function loadFurnitureTilesets(workspaceRoot: string): Promise<LoadedAssets | null> {
  try {
    const tiledDir = path.join(workspaceRoot, 'assets', 'tiled');
    console.log(`[AssetLoader] Scanning Tiled furniture tilesets in: ${tiledDir}`);

    if (!fs.existsSync(tiledDir)) {
      console.log('ℹ️  No assets/tiled directory found at:', tiledDir);
      return null;
    }

    const catalog: FurnitureAsset[] = [];
    const sprites = new Map<string, string[][]>();

    for (const [category, slug] of Object.entries(FURNITURE_CATEGORY_FILES)) {
      const tilesetPath = path.join(tiledDir, `furniture-${slug}.tsj`);
      if (!fs.existsSync(tilesetPath)) continue;

      let tiled: TiledTilesetJson;
      try {
        tiled = JSON.parse(fs.readFileSync(tilesetPath, 'utf-8')) as TiledTilesetJson;
      } catch (err) {
        console.warn(`  ⚠️  Could not parse ${tilesetPath}: ${err instanceof Error ? err.message : err}`);
        continue;
      }

      const tilesetDir = path.dirname(tilesetPath);
      const entries = parseFurnitureTileset(tiled, category);
      for (const { asset, imagePath } of entries) {
        try {
          const assetPath = path.join(tilesetDir, imagePath);
          const resolvedAsset = path.resolve(assetPath);
          const resolvedDir = path.resolve(tilesetDir);
          if (!resolvedAsset.startsWith(resolvedDir + path.sep) && resolvedAsset !== resolvedDir) {
            console.warn(`  [AssetLoader] Skipping tile with image path outside tileset directory: ${imagePath}`);
            continue;
          }
          if (!fs.existsSync(assetPath)) {
            console.warn(`  ⚠️  Image not found: ${imagePath} (${asset.id})`);
            continue;
          }
          const pngBuffer = fs.readFileSync(assetPath);
          sprites.set(asset.id, pngToSpriteData(pngBuffer, asset.width, asset.height));
        } catch (err) {
          console.warn(`  ⚠️  Error loading ${asset.id}: ${err instanceof Error ? err.message : err}`);
        }
      }
      catalog.push(...entries.map((e) => e.asset));
    }

    if (catalog.length === 0) {
      console.log('ℹ️  No furniture tilesets found');
      return null;
    }

    console.log(`  ✓ Loaded ${sprites.size} / ${catalog.length} furniture assets from Tiled tilesets`);
    return { catalog, sprites };
  } catch (err) {
    console.error(`[AssetLoader] ❌ Error loading furniture tilesets: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

// ── Default layout loading ───────────────────────────────────

/**
 * Load the bundled default layout with the highest revision.
 * Scans for assets/default-layout-{N}.json files and picks the one
 * with the largest N. Falls back to assets/default-layout.json for
 * backward compatibility.
 */
export function loadDefaultLayout(assetsRoot: string): Record<string, unknown> | null {
  const assetsDir = path.join(assetsRoot, 'assets');
  try {
    // Scan for versioned default layouts: default-layout-{N}.json
    let bestRevision = 0;
    let bestPath: string | null = null;

    if (fs.existsSync(assetsDir)) {
      for (const file of fs.readdirSync(assetsDir)) {
        const match = /^default-layout-(\d+)\.json$/.exec(file);
        if (match) {
          const rev = parseInt(match[1], 10);
          if (rev > bestRevision) {
            bestRevision = rev;
            bestPath = path.join(assetsDir, file);
          }
        }
      }
    }

    // Fall back to unversioned default-layout.json
    if (!bestPath) {
      const fallback = path.join(assetsDir, 'default-layout.json');
      if (fs.existsSync(fallback)) {
        bestPath = fallback;
      }
    }

    if (!bestPath) {
      console.log('[AssetLoader] No default layout found in:', assetsDir);
      return null;
    }

    const content = fs.readFileSync(bestPath, 'utf-8');
    const layout = JSON.parse(content) as Record<string, unknown>;
    // Ensure layoutRevision matches the file's revision number
    if (bestRevision > 0 && !layout[LAYOUT_REVISION_KEY]) {
      layout[LAYOUT_REVISION_KEY] = bestRevision;
    }
    console.log(
      `[AssetLoader] Loaded default layout (${layout.cols}×${layout.rows}, revision ${layout[LAYOUT_REVISION_KEY] ?? 0}) from ${path.basename(bestPath)}`,
    );
    return layout;
  } catch (err) {
    console.error(
      `[AssetLoader] Error loading default layout: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }
}

// ── Wall tile loading ────────────────────────────────────────

interface LoadedWallTiles {
  /** Array of wall sets, each containing 16 sprites indexed by bitmask (N=1,E=2,S=4,W=8) */
  sets: string[][][][];
}

/**
 * Load wall tile sets from assets/walls/ folder.
 * Each file is named wall_N.png (e.g. wall_0.png, wall_1.png, ...).
 * Files are loaded in numeric order; each PNG is a 64×128 grid of 16 bitmask pieces.
 */
export async function loadWallTiles(assetsRoot: string): Promise<LoadedWallTiles | null> {
  try {
    const wallsDir = path.join(assetsRoot, 'assets', 'walls');
    if (!fs.existsSync(wallsDir)) {
      console.log('[AssetLoader] No walls/ directory found at:', wallsDir);
      return null;
    }

    console.log('[AssetLoader] Loading wall tiles from:', wallsDir);

    // Find all wall_N.png files and sort by index
    const entries = fs.readdirSync(wallsDir);
    const wallFiles: { index: number; filename: string }[] = [];
    for (const entry of entries) {
      const match = /^wall_(\d+)\.png$/i.exec(entry);
      if (match) {
        wallFiles.push({ index: parseInt(match[1], 10), filename: entry });
      }
    }

    if (wallFiles.length === 0) {
      console.log('[AssetLoader] No wall_N.png files found in walls/');
      return null;
    }

    wallFiles.sort((a, b) => a.index - b.index);

    const sets: string[][][][] = [];
    for (const { filename } of wallFiles) {
      const filePath = path.join(wallsDir, filename);
      const pngBuffer = fs.readFileSync(filePath);
      const sprites = parseWallPng(pngBuffer);
      sets.push(sprites);
    }

    console.log(
      `[AssetLoader] ✅ Loaded ${sets.length} wall tile set(s) (${sets.length * WALL_BITMASK_COUNT} pieces total)`,
    );
    return { sets };
  } catch (err) {
    console.error(
      `[AssetLoader] ❌ Error loading wall tiles: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }
}

interface LoadedFloorTiles {
  sprites: string[][][]; // N sprites (one per floor_N.png), each 16x16 SpriteData
}

/**
 * Load floor tile patterns from assets/floors/ folder.
 * Each file is named floor_N.png (e.g. floor_0.png, floor_1.png, ...).
 * Files are loaded in numeric order; each PNG is a 16×16 grayscale tile.
 */
export async function loadFloorTiles(assetsRoot: string): Promise<LoadedFloorTiles | null> {
  try {
    const floorsDir = path.join(assetsRoot, 'assets', 'floors');
    if (!fs.existsSync(floorsDir)) {
      console.log('[AssetLoader] No floors/ directory found at:', floorsDir);
      return null;
    }

    console.log('[AssetLoader] Loading floor tiles from:', floorsDir);

    // Find all floor_N.png files and sort by index
    const entries = fs.readdirSync(floorsDir);
    const floorFiles: { index: number; filename: string }[] = [];
    for (const entry of entries) {
      const match = /^floor_(\d+)\.png$/i.exec(entry);
      if (match) {
        floorFiles.push({ index: parseInt(match[1], 10), filename: entry });
      }
    }

    if (floorFiles.length === 0) {
      console.log('[AssetLoader] No floor_N.png files found in floors/');
      return null;
    }

    floorFiles.sort((a, b) => a.index - b.index);

    const sprites: string[][][] = [];
    for (const { filename } of floorFiles) {
      const filePath = path.join(floorsDir, filename);
      const pngBuffer = fs.readFileSync(filePath);
      const sprite = decodeFloorPng(pngBuffer);
      sprites.push(sprite);
    }

    console.log(`[AssetLoader] ✅ Loaded ${sprites.length} floor tile patterns from floors/`);
    return { sprites };
  } catch (err) {
    console.error(
      `[AssetLoader] ❌ Error loading floor tiles: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }
}

// ── Character sprite loading ────────────────────────────────

export interface LoadedCharacterSprites {
  /** Pre-colored characters, each with 7 frames per direction */
  characters: CharacterDirectionSprites[];
}

export function mergeCharacterSprites(
  a: LoadedCharacterSprites,
  b: LoadedCharacterSprites,
): LoadedCharacterSprites {
  return { characters: [...a.characters, ...b.characters] };
}

/**
 * Read an optional character manifest (char_N.json) and resolve it into a
 * CharacterSpec. Missing/invalid files fall back to the default 16×32 layout
 * (never throws), so dropping in a manifest is purely additive.
 */
function readCharacterSpec(manifestPath: string): CharacterSpec {
  try {
    if (fs.existsSync(manifestPath)) {
      return resolveCharacterSpec(JSON.parse(fs.readFileSync(manifestPath, 'utf-8')));
    }
  } catch (err) {
    console.warn(
      `[AssetLoader] Ignoring invalid character manifest ${path.basename(manifestPath)}: ${err instanceof Error ? err.message : err}`,
    );
  }
  return resolveCharacterSpec(undefined); // default spec
}

/**
 * Load pre-colored character sprites from assets/characters/ (PNGs, default 112×96).
 * Each PNG has 3 direction rows (down, up, right) × N frames (default 16×32 each);
 * an optional char_N.json manifest overrides the frame size + declares tracks.
 */
export async function loadCharacterSprites(
  assetsRoot: string,
): Promise<LoadedCharacterSprites | null> {
  try {
    const charDir = path.join(assetsRoot, 'assets', 'characters');
    // Scan all char_<n>.png (contiguous from 0), so the default roster is just
    // a matter of dropping in more files — no fixed count.
    const found: number[] = [];
    const entries = fs.existsSync(charDir) ? fs.readdirSync(charDir) : [];
    for (const e of entries) {
      const m = /^char_(\d+)\.png$/i.exec(e);
      if (m) found.push(parseInt(m[1], 10));
    }
    found.sort((a, b) => a - b);
    const characters: CharacterDirectionSprites[] = [];
    for (const ci of found) {
      if (ci !== characters.length) break; // stop at the first gap (keep indices stable)
      // Optional per-character manifest (char_N.json) overrides frame size and
      // declares animation tracks; absent → the default 16×32 layout.
      const spec = readCharacterSpec(path.join(charDir, `char_${ci}.json`));
      const decoded = decodeCharacterPng(
        fs.readFileSync(path.join(charDir, `char_${ci}.png`)),
        spec.frame.w,
        spec.frame.h,
      );
      characters.push({ ...decoded, spec });
    }
    if (characters.length === 0) {
      console.log(`[AssetLoader] No char_N.png files found in ${charDir}`);
      return null;
    }

    console.log(`[AssetLoader] ✅ Loaded ${characters.length} character sprites (3 directions each)`);
    return { characters };
  } catch (err) {
    console.error(
      `[AssetLoader] ❌ Error loading character sprites: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }
}

// ── Pet sprite loading ──────────────────────────────────────

export interface LoadedPetSprites {
  /** Dog variants, each with 6 frames per direction (down/up/right). */
  dogs: PetDirectionSprites[];
  /** Cat variants, each with 6 frames per direction. */
  cats: PetDirectionSprites[];
  /** Duck variants, each with 6 frames per direction. */
  ducks: PetDirectionSprites[];
}

/**
 * Load pet sprites from assets/pets/ (dog_N.png / cat_N.png, each 96×48:
 * 3 direction rows × 6 frames of 16×16).
 */
export async function loadPetSprites(assetsRoot: string): Promise<LoadedPetSprites | null> {
  try {
    const petsDir = path.join(assetsRoot, 'assets', 'pets');
    if (!fs.existsSync(petsDir)) {
      console.log('[AssetLoader] No pets/ directory found at:', petsDir);
      return null;
    }

    const loadVariants = (prefix: string, count: number): PetDirectionSprites[] => {
      const out: PetDirectionSprites[] = [];
      for (let i = 0; i < count; i++) {
        const filePath = path.join(petsDir, `${prefix}_${i}.png`);
        if (!fs.existsSync(filePath)) break;
        out.push(decodePetPng(fs.readFileSync(filePath)));
      }
      return out;
    };

    const dogs = loadVariants('dog', DOG_COUNT);
    const cats = loadVariants('cat', CAT_COUNT);
    const ducks = loadVariants('duck', DUCK_COUNT);
    if (dogs.length === 0 && cats.length === 0 && ducks.length === 0) return null;

    console.log(`[AssetLoader] ✅ Loaded ${dogs.length} dog + ${cats.length} cat + ${ducks.length} duck sprite sheets`);
    return { dogs, cats, ducks };
  } catch (err) {
    console.error(
      `[AssetLoader] ❌ Error loading pet sprites: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }
}

