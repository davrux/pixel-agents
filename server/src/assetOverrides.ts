/**
 * Merge layer for editable assets. The bundled files are the read-only defaults;
 * rows in the SQLite `assets` table (appStore) override or add individual assets.
 * buildMerged() overlays those overrides onto a file-default bundle, producing the
 * bundle the engine initialises from and the messages clients receive.
 *
 * Naming convention (one row per asset, "same name as the source file"):
 *   character → char_<i>   pet → dog_<i> / cat_<i>
 *   furniture → <assetId>  (data: { sprite?, catalog? })
 *   image     → <assetId>  (data: { data, width, height, label }, no bundled defaults)
 *
 * Floor/wall are NOT overridable assets — they're pre-baked, closed-palette
 * static files from the Tiled pipeline (server/scripts/bake-floor-wall-tiled.mts,
 * served at /assets/tiled/png — see docs/design.md),
 * not something the live game decodes/colorizes/sends per-connection anymore.
 */
import { appStore } from './appStore.js';
import type { AssetBundle } from './assets.js';

export const ASSET_TYPES = ['character', 'pet', 'furniture', 'image'] as const;
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
  /** Where each id's art is as an IMAGE (see LoadedAssets.refs) — what the client
   *  is sent instead of pixels. */
  const furnitureRefs = { ...(raw.furnitureRefs as Record<string, unknown>) };
  const furnitureCatalog = [...(raw.furnitureCatalog as Array<{ id?: string }>)];
  // Snapshot BEFORE overrides are applied — bundledFurnitureIds are the
  // non-deletable defaults (deleteAsset on one of these only resets it back
  // to itself, since there's no override to remove); anything else is
  // user-added/imported and genuinely disappears on delete.
  const bundledFurnitureIds = furnitureCatalog.map((c) => c.id).filter((id): id is string => !!id);
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

  // Images (no bundled defaults — raw.images always starts empty), id-keyed
  // like furniture (not positional like floor/wall — there's no "slot 0" to
  // preserve for an upload).
  const images = [...(raw.images as Array<{ id?: string }>)];
  for (const { name, data } of orderedAssets('image')) {
    const entry = { ...(data as Record<string, unknown>), id: name };
    const k = images.findIndex((c) => c.id === name);
    if (k >= 0) images[k] = entry;
    else images.push(entry);
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
      case 'furnitureAssetsLoaded':
        return {
          type: 'furnitureAssetsLoaded',
          catalog: furnitureCatalog,
          spriteRefs: furnitureRefs,
          // Pixels ONLY for ids no image covers. Today that means stored assets
          // whose art is not a file at all — which is what the 7.6 MB was: 1763
          // sprites, all of them file-backed, re-sent on every join.
          sprites: Object.fromEntries(Object.entries(furnitureSprites).filter(([id]) => !furnitureRefs[id])),
          bundledIds: bundledFurnitureIds,
        };
      case 'imagesLoaded':
        return { type: 'imagesLoaded', images };
      default:
        return m;
    }
  });

  return {
    providerCapabilities: defaults.providerCapabilities,
    messages,
    raw: { ...raw, characters, dogs, cats, ducks, furnitureCatalog, furnitureSprites, furnitureRefs, images },
  };
}

/** The broadcast message a given asset type maps to (for re-sync after an edit). */
export function messageTypeForAsset(type: AssetType): string {
  return {
    character: 'characterSpritesLoaded',
    pet: 'petSpritesLoaded',
    furniture: 'furnitureAssetsLoaded',
    image: 'imagesLoaded',
  }[type];
}

// ── Process-wide merged-bundle cache ──────────────────────────────
// Assets are global (not per-zone), so the merged result is identical for
// every room — computing it independently in each one is pure duplicated
// work, and worse, requires every OTHER already-running room to be told to
// redo it too. One cache, built lazily and invalidated on save/delete;
// every room just reads it.
let defaultsBundle: AssetBundle | null = null;
let cached: AssetBundle | null = null;

/** Call once at boot, before any room can be created. */
export function initAssetDefaults(defaults: AssetBundle): void {
  defaultsBundle = defaults;
  cached = null;
}

/** The current merged bundle (file defaults + DB overrides). Cached until
 *  invalidateMergedBundle() runs after a save/delete. */
export function getMergedBundle(): AssetBundle {
  if (!defaultsBundle) throw new Error('assetOverrides: initAssetDefaults() was not called at boot');
  if (!cached) cached = buildMerged(defaultsBundle);
  return cached;
}

/** Replace the FILE-DEFAULT furniture catalog/sprites in place (distinct from
 *  invalidateMergedBundle, which only drops the DB-override merge cache — the
 *  file defaults themselves are otherwise frozen at boot). Used by
 *  assets.ts's watchFurnitureTilesets when a Tiled tileset file changes on
 *  disk, so a save-in-Tiled reaches already-connected players without a
 *  server restart. */
export function updateFurnitureDefaults(
  catalog: unknown[],
  sprites: Record<string, unknown>,
  refs: Record<string, unknown>,
): void {
  if (!defaultsBundle) return;
  defaultsBundle.raw.furnitureCatalog = catalog;
  defaultsBundle.raw.furnitureSprites = sprites;
  (defaultsBundle.raw as Record<string, unknown>).furnitureRefs = refs;
  const msg = findMessage(defaultsBundle, 'furnitureAssetsLoaded');
  const payload = {
    catalog,
    spriteRefs: refs,
    sprites: Object.fromEntries(Object.entries(sprites).filter(([id]) => !refs[id])),
  };
  if (msg) Object.assign(msg, payload);
  else defaultsBundle.messages.push({ type: 'furnitureAssetsLoaded', ...payload });
  cached = null;
}

/** Drop the cache so the next getMergedBundle() call re-reads the DB. */
export function invalidateMergedBundle(): void {
  cached = null;
}
