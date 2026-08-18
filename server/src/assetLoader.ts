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

import { PNG } from 'pngjs';

import { CAT_COUNT, DOG_COUNT, DUCK_COUNT } from './core/assets/constants.js';
import type { FurnitureAsset } from './core/assets/manifestUtils.js';
import { parseFurnitureTileset, type TiledTilesetJson } from './core/assets/tiledFurniture.js';
import { isDecalTileset, isFurnitureTileset } from './tiled/tiledRegistry.js';
import {
  decodeCharacterPng,
  decodePetPng,
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


export type { FurnitureAsset };

export interface LoadedAssets {
  catalog: FurnitureAsset[];
  sprites: Map<string, string[][]>; // assetId -> SpriteData
  /**
   * Where each id's art lives as an IMAGE: the path (relative to assets/tiled)
   * plus the rect inside it. This is what the client is sent instead of pixels —
   * 1763 sprites were 7.6 MB of hex strings per join, where an image is fetched
   * once and cached. The server keeps the decoded pixels for itself, since the
   * headless engine has no browser to decode with.
   */
  refs: Map<string, { img: string; x: number; y: number; w: number; h: number }>;
}

/**
 * Load the furniture catalog from every assets/tiled/furniture-*.tsj file —
 * category is a per-tile property now (see tiledFurniture.ts), not tied to
 * which file a tile lives in, so any number of files in any grouping works.
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
    const refs = new Map<string, { img: string; x: number; y: number; w: number; h: number }>();

    // Every .tsj is read and then judged by what is in it — a tileset holds
    // furniture if its tiles say FurnitureTile. Naming it `furniture-*.tsj` is
    // no longer required (see isFurnitureTileset).
    const tilesetFiles = fs.readdirSync(tiledDir).filter((f) => f.endsWith('.tsj')).sort();
    for (const file of tilesetFiles) {
      const tilesetPath = path.join(tiledDir, file);

      let tiled: TiledTilesetJson;
      try {
        tiled = JSON.parse(fs.readFileSync(tilesetPath, 'utf-8')) as TiledTilesetJson;
      } catch (err) {
        console.warn(`  ⚠️  Could not parse ${tilesetPath}: ${err instanceof Error ? err.message : err}`);
        continue;
      }
      // Decal tilesets come in through the same door: a decal needs a sprite
      // under an id and nothing else, which is precisely what this catalog is,
      // and it then reaches the client over the existing furnitureAssetsLoaded
      // message. What a decal is NOT is decided where it matters — no synced
      // object, no behaviour read off it (see tiledFurniture.ts's buildAsset).
      if (!isFurnitureTileset(tiled) && !isDecalTileset(tiled)) continue;

      const tilesetDir = path.dirname(tilesetPath);
      const entries = parseFurnitureTileset(tiled);
      // One read+decode per FILE, not per tile: a grid tileset's tiles all
      // crop the same sheet (decal-overworld has ~a thousand), and re-decoding
      // it for each would turn the catalog load quadratic for no reason.
      const decoded = new Map<string, PNG>();
      for (const { asset, imagePath, crop } of entries) {
        try {
          const assetPath = path.join(tilesetDir, imagePath);
          const resolvedAsset = path.resolve(assetPath);
          const resolvedDir = path.resolve(tilesetDir);
          if (!resolvedAsset.startsWith(resolvedDir + path.sep) && resolvedAsset !== resolvedDir) {
            console.warn(`  [AssetLoader] Skipping tile with image path outside tileset directory: ${imagePath}`);
            continue;
          }
          let png = decoded.get(assetPath);
          if (!png) {
            if (!fs.existsSync(assetPath)) {
              console.warn(`  ⚠️  Image not found: ${imagePath} (${asset.id})`);
              continue;
            }
            png = PNG.sync.read(fs.readFileSync(assetPath));
            decoded.set(assetPath, png);
          }
          sprites.set(asset.id, pngToSpriteData(png, asset.width, asset.height, crop));
          // The same fact the decode just used, in the form a browser wants: which
          // file, which rect. A collection tile's whole PNG is its rect; a grid
          // tile's is the crop.
          refs.set(asset.id, {
            // As written in the tileset, i.e. relative to assets/tiled — which is
            // exactly the path the client fetches under.
            img: imagePath,
            x: crop?.x ?? 0,
            y: crop?.y ?? 0,
            w: asset.width,
            h: asset.height,
          });
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
    return { catalog, sprites, refs };
  } catch (err) {
    console.error(`[AssetLoader] ❌ Error loading furniture tilesets: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}


// ── Character sprite loading ────────────────────────────────

export interface LoadedCharacterSprites {
  /** Pre-colored characters, each with 7 frames per direction */
  characters: CharacterDirectionSprites[];
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

