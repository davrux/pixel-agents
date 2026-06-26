/**
 * Merge layer for editable assets. The bundled files are the read-only defaults;
 * rows in the SQLite `assets` table (appStore) override or add individual assets.
 * buildMerged() overlays those overrides onto a file-default bundle, producing the
 * bundle the engine initialises from and the messages clients receive.
 *
 * Naming convention (one row per asset, "same name as the source file"):
 *   character → char_<i>   pet → dog_<i> / cat_<i>
 *   floor     → floor_<i>  wall → wall_<i>
 *   furniture → <assetId>  (data: { sprite?, catalog? })
 */
import { appStore } from './appStore.js';
import type { AssetBundle } from './assets.js';

export const ASSET_TYPES = ['character', 'pet', 'floor', 'wall', 'furniture'] as const;
export type AssetType = (typeof ASSET_TYPES)[number];

/** Parse `${prefix}_<n>` → n, or null. */
function indexOf(name: string, prefix: string): number | null {
  const m = new RegExp(`^${prefix}_(\\d+)$`).exec(name);
  return m ? Number(m[1]) : null;
}

/** Set arr[i]=data, or append when i === length (so new assets can be added). */
function place<T>(arr: T[], i: number, data: T): void {
  if (i >= 0 && i < arr.length) arr[i] = data;
  else if (i === arr.length) arr.push(data);
}

function findMessage(bundle: AssetBundle, type: string): Record<string, unknown> | undefined {
  return bundle.messages.find((m) => m.type === type);
}

/** Build a merged bundle: file defaults with the DB asset overrides applied.
 *  Only references are rebuilt (arrays/messages); pixel data is shared. */
export function buildMerged(defaults: AssetBundle): AssetBundle {
  const raw = defaults.raw;

  // Characters
  const characters = [...(raw.characters as unknown[])];
  for (const { name, data } of appStore.listAssets('character')) {
    const i = indexOf(name, 'char');
    if (i !== null) place(characters, i, data);
  }

  // Pets (dogs + cats)
  const dogs = [...(raw.dogs as unknown[])];
  const cats = [...(raw.cats as unknown[])];
  for (const { name, data } of appStore.listAssets('pet')) {
    const di = indexOf(name, 'dog');
    if (di !== null) {
      place(dogs, di, data);
      continue;
    }
    const ci = indexOf(name, 'cat');
    if (ci !== null) place(cats, ci, data);
  }

  // Furniture (sprite and/or catalog entry, keyed by assetId)
  const furnitureSprites = { ...(raw.furnitureSprites as Record<string, unknown>) };
  const furnitureCatalog = [...(raw.furnitureCatalog as Array<{ type?: string }>)];
  for (const { name, data } of appStore.listAssets('furniture')) {
    const d = data as { sprite?: unknown; catalog?: { type?: string } };
    if (d && d.sprite !== undefined) furnitureSprites[name] = d.sprite;
    if (d && d.catalog) {
      const k = furnitureCatalog.findIndex((c) => c.type === name);
      if (k >= 0) furnitureCatalog[k] = d.catalog;
      else furnitureCatalog.push(d.catalog);
    }
  }

  // Floors + walls live only in their broadcast messages (not in raw).
  const floors = [...(((findMessage(defaults, 'floorTilesLoaded')?.sprites as unknown[]) ?? []))];
  for (const { name, data } of appStore.listAssets('floor')) {
    const i = indexOf(name, 'floor');
    if (i !== null) place(floors, i, data);
  }
  const walls = [...(((findMessage(defaults, 'wallTilesLoaded')?.sets as unknown[]) ?? []))];
  for (const { name, data } of appStore.listAssets('wall')) {
    const i = indexOf(name, 'wall');
    if (i !== null) place(walls, i, data);
  }

  // Rebuild the asset messages from merged data; keep everything else (layout).
  const messages = defaults.messages.map((m) => {
    switch (m.type) {
      case 'characterSpritesLoaded':
        return { type: 'characterSpritesLoaded', characters };
      case 'petSpritesLoaded':
        return { type: 'petSpritesLoaded', dogs, cats };
      case 'floorTilesLoaded':
        return { type: 'floorTilesLoaded', sprites: floors };
      case 'wallTilesLoaded':
        return { type: 'wallTilesLoaded', sets: walls };
      case 'furnitureAssetsLoaded':
        return { type: 'furnitureAssetsLoaded', catalog: furnitureCatalog, sprites: furnitureSprites };
      default:
        return m;
    }
  });

  return {
    providerCapabilities: defaults.providerCapabilities,
    messages,
    raw: { ...raw, characters, dogs, cats, furnitureCatalog, furnitureSprites },
  };
}

/** The broadcast message a given asset type maps to (for re-sync after an edit). */
export function messageTypeForAsset(type: AssetType): string {
  return {
    character: 'characterSpritesLoaded',
    pet: 'petSpritesLoaded',
    floor: 'floorTilesLoaded',
    wall: 'wallTilesLoaded',
    furniture: 'furnitureAssetsLoaded',
  }[type];
}
