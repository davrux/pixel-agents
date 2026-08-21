import { turnFacing, turnedExtent } from '../tileOrientation.js';
import type { Action, Direction as DirectionVal, FurnitureCatalogEntry, PlacedFurniture, SpriteData } from '../types.js';
import { Direction, TILE_SIZE } from '../types.js';

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
  /** Pixels per id — what the server keeps for itself. The client is sent
   *  `spriteRefs` instead and receives no pixels at all, so this is optional. */
  sprites?: Record<string, SpriteData>;
  /**
   * Where each id's art is drawn from: an image (relative to assets/tiled) plus
   * the rect inside it. This is what replaced shipping the pixels — 1763 sprites
   * were 7.6 MB of hex strings per join, against images the browser fetches once
   * and caches (see server/scripts/bake-furniture-atlas.mts, and the grid decal
   * sets, which are sheets already).
   */
  spriteRefs?: Record<string, { img: string; x: number; y: number; w: number; h: number }>;
}

/** Fallback per-frame duration for animation data saved before per-frame
 *  timing existed (or that simply omits it) — keeps old content playing at
 *  the same speed it always has. */
const DEFAULT_ANIMATION_FRAME_MS = 200;

// ── Animation groups ────────────────────────────────────────────
interface AnimationFrameInfo {
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
 * id → entry, rebuilt with the catalog.
 *
 * `getCatalogEntry` was a linear `find` over every asset, and it is called from per-tick
 * engine loops (through entryFor, and directly by the serializer and the renderer). Measured
 * with the 1773-asset catalog this repo builds: 24.2 µs per call, which made one lookup cost
 * more than the rest of a tick's work on a placement. An index is the same answer in 0.06 µs.
 * Bounded by the catalog it mirrors, and replaced wholesale when that is rebuilt.
 */
let byId: Map<string, FurnitureCatalogEntry> | null = null;

/**
 * Build the catalog from loaded assets. Returns true if successful.
 * Uses ONLY custom assets (excludes hardcoded furniture when assets are loaded).
 */
/** Called with the id → image+rect table when one arrives, so the renderer can
 *  resolve art without the pixels. Registered by the client (see
 *  client/src/render/sprites.ts's setSpriteRefs); the headless server leaves it
 *  unset and keeps using its own decoded sprites. */
let spriteRefSink: ((refs: LoadedAssetData['spriteRefs']) => void) | null = null;
export function onSpriteRefs(sink: (refs: LoadedAssetData['spriteRefs']) => void): void {
  spriteRefSink = sink;
}

export function buildDynamicCatalog(assets: LoadedAssetData): boolean {
  if (!assets?.catalog) return false;
  if (assets.spriteRefs) spriteRefSink?.(assets.spriteRefs);

  const allEntries = assets.catalog
    .map((asset) => {
      // Pixels are optional now: the server's own catalog has them, the client's
      // does not — it draws each id from a fetched image instead (spriteRefs).
      // What must always be present is the SIZE, which is what depth sorting and
      // the pet lift read (see FurnitureCatalogEntry.width/height).
      const sprite = assets.sprites?.[asset.id];
      return {
        id: asset.id,
        label: asset.label,
        footprintW: asset.footprintW,
        footprintH: asset.footprintH,
        width: asset.width,
        height: asset.height,
        ...(sprite ? { sprite } : {}),
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
  // Rebuilt here and nowhere else, so it cannot drift from the array it indexes. The FIRST
  // entry for an id wins, which is what the linear `find` returned — a duplicate id must not
  // start resolving to the other one.
  byId = new Map();
  for (const e of allEntries) if (!byId.has(e.id)) byId.set(e.id, e);

  const statePairs = allEntries.filter((e) => e.onState).length;
  console.log(`✓ Built dynamic catalog with ${allEntries.length} assets (${statePairs} state pairs, ${animationGroups.size} animation groups)`);
  return true;
}

export function getCatalogEntry(id: string): FurnitureCatalogEntry | undefined {
  return byId?.get(id);
}

/**
 * The catalog entry as it applies to THIS placement.
 *
 * A placement may carry its own drawn size (Tiled's object resize — see
 * PlacedFurniture.width), and a size is not only a picture: the cells a piece occupies
 * follow from it, and those decide blocking, seats, approach tiles, pet perching and
 * depth. Resolving both in one place is what keeps them from disagreeing — which is
 * exactly what a first attempt at this did, by scaling the sprite alone.
 *
 * Returns the shared entry itself when there is no override, so the common case
 * allocates nothing: this is called from per-tick engine loops.
 */
export function entryFor(item: {
  id: string;
  width?: number;
  height?: number;
  angle?: number;
}): FurnitureCatalogEntry | undefined {
  const entry = getCatalogEntry(item.id);
  if (!entry) return undefined;
  // A turn has to be resolved HERE for the same reason a resized placement is: the cells a
  // piece occupies decide blocking, seats, approach tiles, pet perching and depth, so a turn
  // that only reached the renderer would draw a desk lying across two cells while the
  // collision still stood in one. What comes back is the box the piece OCCUPIES — a swap for
  // a quarter turn, the enclosing rectangle for any other angle (see turnedExtent). The ART
  // keeps its own size; the renderer gets that separately, because for a diagonal piece the
  // two are different things.
  const placedW = item.width || entry.width;
  const placedH = item.height || entry.height;
  const { w: width, h: height } = turnedExtent(placedW, placedH, item.angle);
  if (width === entry.width && height === entry.height) return entry;
  const memo = resolved.get(item);
  // Keyed by the placement, but only valid while it still resolves to the SAME shared entry
  // and the same box: a placement's id changes when an appliance switches on (see
  // resolveOnState), and the catalog itself is rebuilt on a push. Either would otherwise hand
  // back the previous item's art and footprint.
  if (memo && memo.from === entry && memo.built.width === width && memo.built.height === height) return memo.built;
  const footprintH = Math.max(1, Math.ceil(height / TILE_SIZE));
  const built: FurnitureCatalogEntry = {
    ...entry,
    width,
    height,
    // Ceil, never zero: a piece drawn smaller than a cell still stands somewhere, and
    // rounding down would let it block nothing while covering half a tile.
    footprintW: Math.max(1, Math.ceil(width / TILE_SIZE)),
    footprintH,
    // Background rows are counted in CELLS of the art's own size, so they have to
    // shrink with it — the espresso machine says "my top row is air", and at half size
    // that row is half a cell, not a whole one. Without this, scaling a two-cell
    // appliance to one made it entirely air: an appliance you walk straight through.
    // Floored, so the doubt goes to solid; an item that is air all the way (a bowl on a
    // table, backgroundTiles 1 on 1-cell art) stays that way, since 1 × 1 floors to 1.
    ...(entry.backgroundTiles
      ? { backgroundTiles: Math.min(footprintH, Math.floor(entry.backgroundTiles * (height / entry.height))) }
      : {}),
  };
  resolved.set(item, { from: entry, built });
  return built;
}

/**
 * The resolved entry per placement object — a WeakMap, so it holds nothing alive and needs
 * no invalidation: a rebuilt layout brings new placement objects and the old ones go.
 *
 * Why it exists: this function is called from per-tick engine loops, and every placement that
 * is not the art's own size built a fresh object on EVERY call. That predates turning (a
 * resized placement paid it too) and turning would have multiplied it, since a whole zone can
 * be turned. Measured on the uponu map, per OfficeState.update tick: see the numbers in
 * AGENTS.md. The guard above re-checks the size, so a stale entry cannot survive a change
 * that somehow mutates a placement in place.
 */
const resolved = new WeakMap<object, { from: FurnitureCatalogEntry; built: FurnitureCatalogEntry }>();

/** A placed item's effective action (see Action): its own override
 *  (`item.action`) if set, else the catalog type's own default
 *  (`entry.action`). */
export function effectiveAction(item: PlacedFurniture, entry: FurnitureCatalogEntry | undefined): Action | null {
  return item.action ?? entry?.action ?? null;
}

/**
 * Does clicking this action walk the player up to it and fire it there?
 *
 * "Has an action" used to be the same question, and both sides asked it by
 * excluding one kind by name (`kind !== 'appliance'`) in two files that had to
 * agree: the client decides what to offer a click on, the server decides what a
 * click may do, and a disagreement is either a dead click or a walk to nothing.
 * It is one function now, because there are two exclusions:
 *
 *   - 'appliance' has its own approach path (applianceApproach → useAppliance),
 *     built on the station/occupancy system rather than computeApproachTiles.
 *   - 'talkingObject' is fired by the clock, not by anyone — walking up to a
 *     statue to be told the time is not the interaction (see Action).
 *
 * Kinds that only mean something on a TILE ('spawnPoint', consumed at import)
 * are deliberately NOT excluded: they answer this question by never being on a
 * piece of furniture, and listing them here would suggest the click path is
 * where that is decided.
 *
 * A type guard rather than a plain boolean, so `if (isClickAction(a))` also
 * narrows away the null the callers just tested for.
 */
export function isClickAction(action: Action | null | undefined): action is Action {
  return !!action && action.kind !== 'appliance' && action.kind !== 'talkingObject';
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
  // Turned after the mirrors, matching how both Tiled and the renderer compose the two
  // (see turnFacing). The placement's own override above is deliberately NOT turned: a
  // mapper who typed a facing on THIS placement stated it in world terms, looking at the
  // map — only the tile's baked default is in the art's own frame.
  return turnFacing(
    mirrorFacing(entry?.sitFacing ?? Direction.UP, item.flippedHorizontally, item.flippedVertically),
    item.angle,
  );
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
function mirrorFacing(dir: DirectionVal, flippedHorizontally?: boolean, flippedVertically?: boolean): DirectionVal {
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
function getAnimationFrameData(type: string): AnimationFrameInfo[] | null {
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

