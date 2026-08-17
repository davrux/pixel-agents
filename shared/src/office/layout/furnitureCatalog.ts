import type { Action, Direction as DirectionVal, FurnitureCatalogEntry, PlacedFurniture, SpriteData } from '../types.js';
import { Direction } from '../types.js';

export interface LoadedAssetData {
  catalog: Array<{
    id: string;
    label: string;
    width: number;
    height: number;
    footprintW: number;
    footprintH: number;
    /** Behaviour defaults for this type — see FurnitureCatalogEntry, and the
     *  resolve* helpers below for how a placed instance overrides them. */
    canSitOn?: boolean;
    sitFacing?: DirectionVal;
    petCanSitOn?: boolean;
    canWalkOver?: boolean;
    /** Map art rather than furniture — see FurnitureCatalogEntry.decal. */
    decal?: boolean;
    backgroundTiles?: number;
    /** Catalog id this item becomes when switched on — see
     *  FurnitureCatalogEntry.onState. */
    onState?: string;
    /** This type's default Action (see FurnitureCatalogEntry.action) — the
     *  only way a catalog entry gets one; no per-kind legacy flags anymore
     *  (conference/arcade/meetingRoom/appliance/portal booleans, and the
     *  hardcoded COFFEE_MACHINE id special case, are gone — every generated
     *  and Tiled-authored item sets this directly). */
    action?: Action;
    animationGroup?: string;
    frame?: number;
    /** How long (ms) this frame shows before advancing — Tiled's own
     *  `<frame duration=".."/>` unit. Missing on older data → DEFAULT_ANIMATION_FRAME_MS. */
    durationMs?: number;
  }>;
  sprites: Record<string, SpriteData>;
}

/** Fallback per-frame duration for animation data saved before per-frame
 *  timing existed (or that simply omits it) — keeps old content playing at
 *  the same speed it always has. */
export const DEFAULT_ANIMATION_FRAME_MS = 200;

// ── Animation groups ────────────────────────────────────────────
export interface AnimationFrameInfo {
  id: string;
  durationMs: number;
}
// Maps animation group ID → ordered {id, durationMs} by frame index
const animationGroups = new Map<string, AnimationFrameInfo[]>();

/** Every catalog entry, on/off partners and non-first animation frames
 *  included — a lookup table, not a palette. There used to be a second,
 *  filtered "visible" list feeding the in-game furniture palette's category
 *  sections; with authoring moved entirely to Tiled (whose own tileset panel
 *  shows every tile, unfiltered) there is nothing left to filter for. */
let catalog: FurnitureCatalogEntry[] | null = null;

/**
 * Build the catalog from loaded assets. Returns true if successful.
 * Uses ONLY custom assets (excludes hardcoded furniture when assets are loaded).
 */
export function buildDynamicCatalog(assets: LoadedAssetData): boolean {
  if (!assets?.catalog || !assets?.sprites) return false;

  const allEntries = assets.catalog
    .map((asset) => {
      const sprite = assets.sprites[asset.id];
      if (!sprite) {
        console.warn(`No sprite data for asset ${asset.id}`);
        return null;
      }
      return {
        id: asset.id,
        label: asset.label,
        footprintW: asset.footprintW,
        footprintH: asset.footprintH,
        sprite,
        ...(asset.canSitOn ? { canSitOn: true } : {}),
        // `!== undefined`, not truthiness: Direction.DOWN is 0, so a plain
        // `asset.sitFacing ? …` would silently drop every south-facing seat.
        ...(asset.sitFacing !== undefined ? { sitFacing: asset.sitFacing } : {}),
        ...(asset.petCanSitOn ? { petCanSitOn: true } : {}),
        // Missing here for two days, which is what made a rug dragged straight
        // from the Tilesets panel block movement: the tile said canWalkOver, the
        // tileset reader passed it on, and this mapping dropped it — so only a
        // placement that spelled the override out worked, and toggling the
        // checkbox off and on "fixed" a rug by writing exactly that. The asset
        // type was missing the field too, so nothing failed to compile.
        ...(asset.canWalkOver ? { canWalkOver: true } : {}),
        ...(asset.decal ? { decal: true } : {}),
        ...(asset.backgroundTiles ? { backgroundTiles: asset.backgroundTiles } : {}),
        ...(asset.onState ? { onState: asset.onState } : {}),
        ...(asset.action ? { action: asset.action } : {}),
      };
    })
    .filter((e): e is NonNullable<typeof e> => e !== null);

  if (allEntries.length === 0) return false;

  animationGroups.clear();

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

  catalog = allEntries;

  const statePairs = allEntries.filter((e) => e.onState).length;
  console.log(`✓ Built dynamic catalog with ${allEntries.length} assets (${statePairs} state pairs, ${animationGroups.size} animation groups)`);
  return true;
}

export function getCatalogEntry(id: string): FurnitureCatalogEntry | undefined {
  return catalog?.find((e) => e.id === id);
}

/** A placed item's effective action (see Action): its own override
 *  (`item.action`) if set, else the catalog type's own default
 *  (`entry.action`). */
export function effectiveAction(item: PlacedFurniture, entry: FurnitureCatalogEntry | undefined): Action | null {
  return item.action ?? entry?.action ?? null;
}

// ── Behaviour resolution ────────────────────────────────────────
// Each of these answers one question about one PLACED item. The pattern is
// always the same — the instance's own value if it set one, else the type's
// default, else the "does nothing" fallback — so that a mapper can state a
// behaviour once on the tile and still contradict it on a single placement.

/** May a character sit here? */
export function resolveCanSitOn(item: PlacedFurniture, entry: FurnitureCatalogEntry | undefined): boolean {
  return item.canSitOn ?? entry?.canSitOn ?? false;
}

/**
 * Which way does a character sitting here look?
 *
 * Defaults to UP (north) when nobody said: the overwhelmingly common case is a
 * seat at a desk against a wall, and guessing wrong is cheap and visible. This
 * deliberately replaced a derivation that looked for an adjacent desk tile and
 * fell back to DOWN — which needed a notion of "desk" in the engine, and still
 * guessed wrong for anything that wasn't one.
 *
 * An explicit instance value is taken literally, while a value inherited from
 * the catalog follows the instance's flips: the type's default describes the
 * unflipped art ("this chair faces right"), so mirroring the art has to mirror
 * the seat with it, or a character sits facing into the chair's back. A mapper
 * who states sitFacing on the placement itself has already accounted for the
 * flip they applied, and gets exactly what they asked for.
 */
export function resolveSitFacing(item: PlacedFurniture, entry: FurnitureCatalogEntry | undefined): DirectionVal {
  // `!== undefined` throughout, never truthiness — Direction.DOWN is 0.
  if (item.sitFacing !== undefined) return item.sitFacing;
  return mirrorFacing(entry?.sitFacing ?? Direction.UP, item.flippedHorizontally, item.flippedVertically);
}

/** May a pet rest on top of this? (Whether one actually FITS also depends on
 *  what else is standing on the tile — see officeState.ts.) */
export function resolvePetCanSitOn(item: PlacedFurniture, entry: FurnitureCatalogEntry | undefined): boolean {
  return item.petCanSitOn ?? entry?.petCanSitOn ?? false;
}

/** Is this placement a floor decal you walk over? See
 *  FurnitureCatalogEntry.canWalkOver for why walkability and render depth are
 *  one property. */
export function resolveCanWalkOver(item: PlacedFurniture, entry: FurnitureCatalogEntry | undefined): boolean {
  return item.canWalkOver ?? entry?.canWalkOver ?? false;
}

/** How many rows from the top of this placement stay walkable — see
 *  FurnitureCatalogEntry.backgroundTiles for why this one is normally the
 *  type's business and only exceptionally the instance's. */
export function resolveBackgroundTiles(item: PlacedFurniture, entry: FurnitureCatalogEntry | undefined): number {
  return item.backgroundTiles ?? entry?.backgroundTiles ?? 0;
}

/** Mirror a facing direction to match a flipped sprite — see resolveSitFacing
 *  for when this applies and when it deliberately doesn't. */
export function mirrorFacing(dir: DirectionVal, flippedHorizontally?: boolean, flippedVertically?: boolean): DirectionVal {
  if (flippedHorizontally) {
    if (dir === Direction.LEFT) dir = Direction.RIGHT;
    else if (dir === Direction.RIGHT) dir = Direction.LEFT;
  }
  if (flippedVertically) {
    if (dir === Direction.UP) dir = Direction.DOWN;
    else if (dir === Direction.DOWN) dir = Direction.UP;
  }
  return dir;
}

/** The "on" variant of this placement, or its own id unchanged if it has none —
 *  so `resolveOnState(item, entry) === item.id` is also the test for "this isn't
 *  a state pair at all". Only ever resolves one step: the "on" half is not itself
 *  expected to name a further state. */
export function resolveOnState(item: PlacedFurniture, entry: FurnitureCatalogEntry | undefined): string {
  const onState = item.onState ?? entry?.onState;
  return onState && onState !== item.id ? onState : item.id;
}

/** Get the ordered {id, durationMs} animation frames for a given type, or
 *  null if it isn't part of any animation group. */
export function getAnimationFrameData(type: string): AnimationFrameInfo[] | null {
  for (const [, frames] of animationGroups) {
    if (frames.some((f) => f.id === type)) return frames;
  }
  return null;
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

