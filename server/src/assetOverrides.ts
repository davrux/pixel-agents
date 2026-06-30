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

/** Trailing `_<n>` index of an asset name (0 if none) — for ordering. */
function trailingIndex(name: string): number {
  const m = /_(\d+)$/.exec(name);
  return m ? Number(m[1]) : 0;
}

/** Overrides sorted by their numeric index, ascending. `place()` only appends
 *  when i === length, so user-added assets (char_6, char_7, …) must be applied
 *  in ascending order — SQLite returns rows unordered, and a lexical sort breaks
 *  at two digits (char_10 < char_6). Without this, higher indices are dropped. */
function orderedAssets(type: string): Array<{ name: string; data: unknown }> {
  return appStore.listAssets(type).sort((a, b) => trailingIndex(a.name) - trailingIndex(b.name));
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

  // Characters are id-keyed by a stable skin id (NOT array position). Bundled
  // skins get ids char_0..char_{N-1}; an override named char_<n> replaces that
  // id when present, else adds a new skin. Order and gaps no longer matter, so
  // creating/deleting skins can't silently drop others.
  const bundledChars = raw.characters as unknown[];
  const bundledIds = bundledChars.map((_, i) => `char_${i}`);
  // Give bundled skins a friendly default display name (editable in the editor)
  // so the UI never has to show the technical id. User overrides always carry a
  // name (server-validated), so only file defaults need this.
  const characters: Array<{ id: string; data: unknown }> = bundledChars.map((data, i) => ({
    id: `char_${i}`,
    data: (data as { name?: string }).name ? data : { ...(data as object), name: `Skin ${i + 1}` },
  }));
  // orderedAssets sorts by numeric index so appended user skins stay in order
  // (char_6, char_7, … — not lexical char_10 before char_6) for a tidy gallery.
  for (const { name, data } of orderedAssets('character')) {
    if (!/^char_\d+$/.test(name)) continue;
    const k = characters.findIndex((c) => c.id === name);
    if (k >= 0) characters[k] = { id: name, data };
    else characters.push({ id: name, data });
  }

  // Pets / NPCs (dogs + cats + ducks)
  const dogs = [...(raw.dogs as unknown[])];
  const cats = [...(raw.cats as unknown[])];
  const ducks = [...((raw.ducks as unknown[]) ?? [])];
  for (const { name, data } of orderedAssets('pet')) {
    const di = indexOf(name, 'dog');
    if (di !== null) {
      place(dogs, di, data);
      continue;
    }
    const ci = indexOf(name, 'cat');
    if (ci !== null) {
      place(cats, ci, data);
      continue;
    }
    const ki = indexOf(name, 'duck');
    if (ki !== null) place(ducks, ki, data);
  }

  // Furniture (sprite and/or catalog entry, keyed by assetId). Catalog items in
  // the bundle use `id` (the buildDynamicCatalog input shape), so match on that.
  const furnitureSprites = { ...(raw.furnitureSprites as Record<string, unknown>) };
  const furnitureCatalog = [...(raw.furnitureCatalog as Array<{ id?: string }>)];
  for (const { name, data } of orderedAssets('furniture')) {
    const d = data as { sprite?: unknown; catalog?: Record<string, unknown> };
    if (d && d.sprite !== undefined) furnitureSprites[name] = d.sprite;
    if (d && d.catalog) {
      const entry = { ...d.catalog, id: name }; // id must match the asset key
      const k = furnitureCatalog.findIndex((c) => c.id === name);
      if (k >= 0) furnitureCatalog[k] = entry;
      else furnitureCatalog.push(entry);
    }
  }

  // Floors + walls live only in their broadcast messages (not in raw).
  const floors = [...(((findMessage(defaults, 'floorTilesLoaded')?.sprites as unknown[]) ?? []))];
  for (const { name, data } of orderedAssets('floor')) {
    const i = indexOf(name, 'floor');
    if (i !== null) place(floors, i, data);
  }
  const walls = [...(((findMessage(defaults, 'wallTilesLoaded')?.sets as unknown[]) ?? []))];
  for (const { name, data } of orderedAssets('wall')) {
    const i = indexOf(name, 'wall');
    if (i !== null) place(walls, i, data);
  }

  // Rebuild the asset messages from merged data; keep everything else (layout).
  const messages = defaults.messages.map((m) => {
    switch (m.type) {
      case 'characterSpritesLoaded':
        // Each entry is { id, data }; bundledIds are the non-deletable skins
        // (anything not in bundledIds is user-added and deletable).
        return { type: 'characterSpritesLoaded', characters, bundledIds };
      case 'petSpritesLoaded':
        return { type: 'petSpritesLoaded', dogs, cats, ducks };
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
    raw: { ...raw, characters, dogs, cats, ducks, furnitureCatalog, furnitureSprites },
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
