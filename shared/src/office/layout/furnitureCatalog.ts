import type { Action, ApplianceKind, FurnitureCatalogEntry, PlacedFurniture, SpriteData } from '../types.js';

export interface LoadedAssetData {
  catalog: Array<{
    id: string;
    label: string;
    category: string;
    width: number;
    height: number;
    footprintW: number;
    footprintH: number;
    isDesk: boolean;
    groupId?: string;
    orientation?: string; // 'front' | 'back' | 'left' | 'right' | 'side'
    state?: string; // 'on' | 'off'
    /** On a state-pair item: what turns it on — see FurnitureCatalogEntry.onTrigger. */
    onTrigger?: 'autoFacing' | 'click';
    canPlaceOnSurfaces?: boolean;
    backgroundTiles?: number;
    canPlaceOnWalls?: boolean;
    canPlaceOnFloor?: boolean;
    mirrorSide?: boolean;
    portal?: boolean; // zone portal (door / beam pad)
    /** This type's default Action (see FurnitureCatalogEntry.action). */
    action?: Action;
    /** @deprecated legacy per-kind flags, still read as a fallback when
     *  `action` is absent (see legacyCatalogAction) — old manifests, DB
     *  overrides, and the hand-generated conference/arcade/meetingRoom
     *  assets still set these instead of `action` directly. */
    appliance?: string; // interaction station kind ('coffee', …)
    conference?: boolean; // conference monitor (click → join a video call)
    arcade?: boolean; // arcade cabinet (click → launch a DOS game)
    meetingRoom?: boolean; // meeting-room kiosk (click → mint an ad-hoc video room link)
    rotationScheme?: string;
    animationGroup?: string;
    frame?: number;
    /** How long (ms) this frame shows before advancing — Tiled's own
     *  `<frame duration=".."/>` unit. Missing on older data → DEFAULT_ANIMATION_FRAME_MS. */
    durationMs?: number;
    /** Imported-tileset provenance — see FurnitureCatalogEntry.source/sourceKey. */
    source?: string;
    sourceKey?: string;
  }>;
  sprites: Record<string, SpriteData>;
}

/** Fallback per-frame duration for animation data saved before per-frame
 *  timing existed (or that simply omits it) — keeps old content playing at
 *  the same speed it always has. */
export const DEFAULT_ANIMATION_FRAME_MS = 200;

export type FurnitureCategory =
  | 'desks'
  | 'chairs'
  | 'storage'
  | 'decor'
  | 'electronics'
  | 'wall'
  | 'kitchens'
  | 'misc';

/** @internal */
export interface CatalogEntryWithCategory extends FurnitureCatalogEntry {
  category: FurnitureCategory;
}

// ── State groups ────────────────────────────────────────────────
// Maps asset ID → its on/off counterpart (symmetric for toggle)
const stateGroups = new Map<string, string>();
// Directional maps for getOnStateType / getOffStateType
const offToOn = new Map<string, string>(); // off asset → on asset
const onToOff = new Map<string, string>(); // on asset → off asset
// Maps EITHER side of a state pair → what turns it on (see getOnTrigger)
const onTriggerByType = new Map<string, 'autoFacing' | 'click'>();

// ── Animation groups ────────────────────────────────────────────
export interface AnimationFrameInfo {
  id: string;
  durationMs: number;
}
// Maps animation group ID → ordered {id, durationMs} by frame index
const animationGroups = new Map<string, AnimationFrameInfo[]>();

// Internal catalog (includes all variants for getCatalogEntry lookups)
let internalCatalog: CatalogEntryWithCategory[] | null = null;

// Dynamic catalog built from loaded assets (when available)
// Only includes "front" variants for grouped items (shown in editor palette)
let dynamicCatalog: CatalogEntryWithCategory[] | null = null;
let dynamicCategories: FurnitureCategory[] | null = null;

/** Fallback Action for a catalog asset that hasn't been migrated to the
 *  single `action` field yet — the catalog-level counterpart of
 *  effectiveAction's old per-flag fallback (one default per TYPE here,
 *  rather than per placed instance). An explicit appliance value (incl. ''
 *  to disable) wins; when never set, the bundled COFFEE_MACHINE legacy-
 *  defaults to coffee. */
function legacyCatalogAction(asset: LoadedAssetData['catalog'][number]): Action | null {
  if (asset.conference) return { kind: 'meetingRoom', video: true };
  if (asset.meetingRoom) return { kind: 'linkManager' };
  if (asset.arcade) return { kind: 'arcade' };
  const pose = typeof asset.appliance === 'string' ? asset.appliance : asset.id === 'COFFEE_MACHINE' ? 'coffee' : '';
  return pose ? { kind: 'appliance', pose: pose as ApplianceKind } : null;
}

/**
 * Build catalog from loaded assets. Returns true if successful.
 * Once built, all getCatalog* functions use the dynamic catalog.
 * Uses ONLY custom assets (excludes hardcoded furniture when assets are loaded).
 */
export function buildDynamicCatalog(assets: LoadedAssetData): boolean {
  if (!assets?.catalog || !assets?.sprites) return false;

  // Build all entries (including non-front variants)
  const allEntries = assets.catalog
    .map((asset) => {
      const sprite = assets.sprites[asset.id];
      if (!sprite) {
        console.warn(`No sprite data for asset ${asset.id}`);
        return null;
      }
      return {
        type: asset.id,
        label: asset.label,
        footprintW: asset.footprintW,
        footprintH: asset.footprintH,
        sprite,
        isDesk: asset.isDesk,
        category: asset.category as FurnitureCategory,
        ...(asset.orientation ? { orientation: asset.orientation } : {}),
        ...(asset.canPlaceOnSurfaces ? { canPlaceOnSurfaces: true } : {}),
        ...(asset.backgroundTiles ? { backgroundTiles: asset.backgroundTiles } : {}),
        ...(asset.canPlaceOnWalls ? { canPlaceOnWalls: true } : {}),
        ...(asset.canPlaceOnFloor ? { canPlaceOnFloor: true } : {}),
        ...(asset.mirrorSide ? { mirrorSide: true } : {}),
        ...(asset.portal ? { portal: true } : {}),
        ...(asset.onTrigger ? { onTrigger: asset.onTrigger } : {}),
        ...(asset.source ? { source: asset.source } : {}),
        ...(asset.sourceKey ? { sourceKey: asset.sourceKey } : {}),
        // A direct `action` wins; else fall back to the legacy per-kind flags
        // (old manifests/DB overrides, and the hand-generated conference/
        // arcade/meetingRoom assets, still only set those) — see
        // legacyCatalogAction. Same one-field-supersedes-many-flags shape as
        // effectiveAction's item.action vs. entry.action, one level up.
        ...(() => {
          const action = asset.action ?? legacyCatalogAction(asset);
          return action ? { action } : {};
        })(),
      };
    })
    .filter((e): e is CatalogEntryWithCategory => e !== null);

  // Create virtual ":left" entries for mirrorSide assets — a simple, standalone
  // horizontal-flip clone (e.g. a side-view monitor also facing the other
  // way), NOT tied to any grouping/rotation mechanism. Shows up as its own,
  // independently-placeable catalog entry, same as any other orientation
  // variant (see the "no rotation groups" note below) — the mapper picks
  // whichever facing they want directly, no in-place flip tool.
  for (const asset of assets.catalog) {
    if (asset.mirrorSide && asset.orientation === 'side') {
      const sideEntry = allEntries.find((e) => e.type === asset.id);
      if (sideEntry) {
        allEntries.push({
          ...sideEntry,
          type: `${asset.id}:left`,
          orientation: 'left',
          mirrorSide: true,
        });
      }
    }
  }

  if (allEntries.length === 0) return false;

  // No rotation-group system: every orientation variant (front/back/side/…)
  // is its own independent, always-visible catalog entry — the mapper places
  // whichever one they want directly, there's no in-place rotate tool. (Was
  // groupId+orientation-linked with a hidden non-front subset; dropped since
  // Tiled's rotate handle geometrically rotates the graphic, which is wrong
  // for perspective pixel art — see docs/design/tiled-editor-integration.md.)
  stateGroups.clear();
  offToOn.clear();
  onToOff.clear();
  onTriggerByType.clear();
  animationGroups.clear();

  // Build state groups (on ↔ off pairs within the same groupId — "orientation"
  // in the key is vestigial from imports that still tag it, harmless either way)
  const stateMap = new Map<string, Map<string, string>>(); // "groupId|orientation" → (state → assetId)
  const triggerMap = new Map<string, 'autoFacing' | 'click'>(); // same key → onTrigger, if set
  for (const asset of assets.catalog) {
    if (asset.groupId && asset.state) {
      const key = `${asset.groupId}|${asset.orientation || ''}`;
      let sm = stateMap.get(key);
      if (!sm) {
        sm = new Map();
        stateMap.set(key, sm);
      }
      if (asset.onTrigger && !triggerMap.has(key)) triggerMap.set(key, asset.onTrigger);
      // For animation groups, use the first frame as the "on" representative
      if (asset.animationGroup && asset.frame !== undefined && asset.frame > 0) continue;
      sm.set(asset.state, asset.id);
    }
  }
  for (const [key, sm] of stateMap) {
    const onId = sm.get('on');
    const offId = sm.get('off');
    if (onId && offId) {
      stateGroups.set(onId, offId);
      stateGroups.set(offId, onId);
      offToOn.set(offId, onId);
      onToOff.set(onId, offId);
      const trigger = triggerMap.get(key);
      if (trigger) {
        onTriggerByType.set(onId, trigger);
        onTriggerByType.set(offId, trigger);
      }
    }
  }

  // Build animation groups
  const animGroupCollector = new Map<string, Array<{ id: string; frame: number; durationMs: number }>>();
  for (const asset of assets.catalog) {
    if (asset.animationGroup && asset.frame !== undefined) {
      let frames = animGroupCollector.get(asset.animationGroup);
      if (!frames) {
        frames = [];
        animGroupCollector.set(asset.animationGroup, frames);
      }
      frames.push({ id: asset.id, frame: asset.frame, durationMs: asset.durationMs ?? DEFAULT_ANIMATION_FRAME_MS });
    }
  }
  for (const [groupId, frames] of animGroupCollector) {
    frames.sort((a, b) => a.frame - b.frame);
    animationGroups.set(
      groupId,
      frames.map((f) => ({ id: f.id, durationMs: f.durationMs })),
    );
  }

  // Track "on" variant IDs and non-first animation frame IDs to exclude from the visible catalog
  const onStateIds = new Set<string>();
  const nonFirstFrameIds = new Set<string>();
  for (const asset of assets.catalog) {
    if (asset.state === 'on') onStateIds.add(asset.id);
    if (asset.animationGroup && asset.frame !== undefined && asset.frame > 0) {
      nonFirstFrameIds.add(asset.id);
    }
  }

  // Store full internal catalog (all variants — for getCatalogEntry lookups)
  internalCatalog = allEntries;

  // Visible catalog: exclude "on" state variants and non-first anim frames —
  // every orientation variant stays visible now (no rotation groups to hide
  // a non-front subset behind).
  const visibleEntries = allEntries.filter((e) => !onStateIds.has(e.type) && !nonFirstFrameIds.has(e.type));

  // Strip a state suffix from labels for on/off pairs (e.g. imported data
  // still tagging "... - Off").
  for (const entry of visibleEntries) {
    if (stateGroups.has(entry.type)) {
      entry.label = entry.label
        .replace(/ - Front - Off$/, '')
        .replace(/ - Front$/, '')
        .replace(/ - Off$/, '');
    }
  }

  dynamicCatalog = visibleEntries;
  dynamicCategories = Array.from(new Set(visibleEntries.map((e) => e.category)))
    .filter((c): c is FurnitureCategory => !!c)
    .sort();

  const animGroupCount = animationGroups.size;
  console.log(
    `✓ Built dynamic catalog with ${allEntries.length} assets (${visibleEntries.length} visible, ${stateGroups.size / 2} state pairs, ${animGroupCount} animation groups)`,
  );
  return true;
}

export function getCatalogEntry(type: string): CatalogEntryWithCategory | undefined {
  // Check internal catalog (includes all variants, e.g., non-front rotations)
  if (internalCatalog) {
    return internalCatalog.find((e) => e.type === type);
  }
  return dynamicCatalog?.find((e) => e.type === type);
}

export function getCatalogByCategory(category: FurnitureCategory): CatalogEntryWithCategory[] {
  const catalog = dynamicCatalog ?? [];
  return catalog.filter((e) => e.category === category);
}

/** Find a previously-imported entry by its (source tileset, tile-within-that-
 *  tileset) identity, regardless of what catalog id it ended up with — lets a
 *  re-import update this exact entry in place instead of creating a
 *  duplicate. Only the visible catalog is searched (frame>0 members of a
 *  multi-frame import share the same source/sourceKey as their frame-0
 *  entry, so matching against the internal catalog would find the wrong,
 *  non-representative member first). */
export function findBySourceKey(source: string, sourceKey: string): CatalogEntryWithCategory | undefined {
  return (dynamicCatalog ?? []).find((e) => e.source === source && e.sourceKey === sourceKey);
}

/** Every distinct import source (tileset name) currently in the catalog,
 *  each with its member entries — for the Assets panel's "group by import
 *  source" view. */
export function getImportSources(): Array<{ source: string; entries: CatalogEntryWithCategory[] }> {
  const bySource = new Map<string, CatalogEntryWithCategory[]>();
  for (const e of dynamicCatalog ?? []) {
    if (!e.source) continue;
    let list = bySource.get(e.source);
    if (!list) bySource.set(e.source, (list = []));
    list.push(e);
  }
  return Array.from(bySource, ([source, entries]) => ({ source, entries })).sort((a, b) =>
    a.source.localeCompare(b.source),
  );
}

/** A placed item's effective action (see Action): its own override
 *  (`item.action`) if set, else the catalog type's own default
 *  (`entry.action`, itself already resolved from any legacy per-kind flags
 *  — see legacyCatalogAction) — so every item placed before the Action
 *  system existed keeps working with zero data changes. */
export function effectiveAction(item: PlacedFurniture, entry: FurnitureCatalogEntry | undefined): Action | null {
  return item.action ?? entry?.action ?? null;
}

/* Currently unused since the editor palette is organized by category. */
// function getActiveCatalog(): CatalogEntryWithCategory[] {
//   return dynamicCatalog ?? [];
// }

export function getActiveCategories(): Array<{ id: FurnitureCategory; label: string }> {
  const categories = dynamicCategories ?? [];
  return FURNITURE_CATEGORIES.filter((c) => categories.includes(c.id));
}

/** @internal */
export const FURNITURE_CATEGORIES: Array<{ id: FurnitureCategory; label: string }> = [
  { id: 'desks', label: 'Desks' },
  { id: 'chairs', label: 'Chairs' },
  { id: 'storage', label: 'Storage' },
  { id: 'electronics', label: 'Tech' },
  { id: 'decor', label: 'Decor' },
  { id: 'wall', label: 'Wall' },
  { id: 'kitchens', label: 'Kitchen' },
  { id: 'misc', label: 'Misc' },
];

/** Returns the toggled state variant (on↔off), or null if no state variant exists. */
export function getToggledType(currentType: string): string | null {
  return stateGroups.get(currentType) ?? null;
}

/** Returns the "on" variant if this type has one, otherwise returns the type unchanged. */
export function getOnStateType(currentType: string): string {
  return offToOn.get(currentType) ?? currentType;
}

/** What turns an on/off state pair on (see FurnitureCatalogEntry.onTrigger) —
 *  either side's id works. Null if `type` has no state pair at all;
 *  'autoFacing' if it has one but never recorded an explicit trigger (old
 *  data predating this field — keeps behaving exactly as before). */
export function getOnTrigger(type: string): 'autoFacing' | 'click' | null {
  if (!stateGroups.has(type)) return null;
  return onTriggerByType.get(type) ?? 'autoFacing';
}

/** Returns the "off" variant if this type has one, otherwise returns the type unchanged - unused */
// function getOffStateType(currentType: string): string {
//   return onToOff.get(currentType) ?? currentType;
// }

/** Get the ordered {id, durationMs} animation frames for a given type, or
 *  null if it isn't part of any animation group. */
export function getAnimationFrameData(type: string): AnimationFrameInfo[] | null {
  for (const [, frames] of animationGroups) {
    if (frames.some((f) => f.id === type)) return frames;
  }
  return null;
}

/** Get ordered animation frame asset IDs for a given type, or null if not animated. */
export function getAnimationFrames(type: string): string[] | null {
  return getAnimationFrameData(type)?.map((f) => f.id) ?? null;
}

/** Which frame of `type`'s animation group is showing at `elapsedMs` — the
 *  standard way engines play back a Tiled `<animation>` (accumulate elapsed
 *  time, loop it against the group's total duration, walk each frame's own
 *  duration to find where that lands). Returns null if `type` isn't animated. */
export function animationFrameAt(type: string, elapsedMs: number): string | null {
  const frames = getAnimationFrameData(type);
  if (!frames || frames.length === 0) return null;
  const total = frames.reduce((sum, f) => sum + f.durationMs, 0);
  if (total <= 0) return frames[0].id;
  let t = elapsedMs % total;
  for (const f of frames) {
    if (t < f.durationMs) return f.id;
    t -= f.durationMs;
  }
  return frames[frames.length - 1].id;
}

/** Is this the mirrored (":left") clone of a mirrorSide asset? Renderer/hit-
 *  test use this to flip the sprite — see buildDynamicCatalog's virtual
 *  ":left" entry, which is the only thing that ever sets orientation:'left'. */
export function isMirroredLeft(type: string): boolean {
  return getCatalogEntry(type)?.orientation === 'left';
}
