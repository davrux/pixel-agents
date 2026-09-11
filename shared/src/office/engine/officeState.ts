import {
  AUTO_ON_FACING_DEPTH,
  AUTO_ON_SIDE_DEPTH,
  CHARACTER_HIT_HALF_WIDTH,
  CHARACTER_HIT_HEIGHT,
  CHARACTER_SITTING_OFFSET_PX,
  COFFEE_BREAK_CHANCE,
  COFFEE_COOLDOWN_MAX_SEC,
  COFFEE_COOLDOWN_MIN_SEC,
  COFFEE_STAND_MAX_SEC,
  COFFEE_STAND_MIN_SEC,
  DISMISS_BUBBLE_FAST_FADE_SEC,
  INACTIVE_SEAT_TIMER_MIN_SEC,
  INACTIVE_SEAT_TIMER_RANGE_SEC,
  PET_CHASE_RANGE_TILES,
  PET_EFFECT_DURATION_SEC,
  PET_FLEE_RANGE_TILES,
  PET_CATCH_RADIUS_TILES,
  PET_SHOO_RADIUS_TILES,
  PET_TARGET_PATH_TRIES,
  SPAWN_PROBE_TRIES,
  WAITING_BUBBLE_DURATION_SEC,
  WALK_SPEED_PX_PER_SEC,
} from '../constants.js';
import { isPlayerAvatarSkin, agentCount } from '../../protocol.js';
import {
  effectiveAction,
  isClickAction,
  resolveOnState,
  resolveBackgroundTiles,
  resolvePetCanSitOn,
  entryFor,
} from '../layout/furnitureCatalog.js';
import {
  createDefaultLayout,
  getBlockedFloorTiles,
  getBlockedTiles,
  getReachThroughTiles,
  layoutToSitPoints,
  layoutToTileMap,
} from '../layout/layoutSerializer.js';
import { DEFAULT_WARP_STYLE, warpStyle, type WarpStyleId } from '../effects.js';
import { canStep, DIRS_4, findPath, getWalkableTiles, isWalkable, nearestWalkableTile } from '../layout/tileMap.js';
import { faceBlockedTiles, wallOnNorthEdge } from '../wallEdges.js';
import {
  computeActionAreas,
  actionAreaAnchor,
  actionAreaIdAt,
  meetingAreaAt,
  meetingCanonicalAnchors,
  type ActionAreaMap,
  type MeetingAreaIdentity,
} from '../layout/actionAreas.js';
import {
  firstSkinId,
  getSkinIds,
  getLoadedPetVariantCount,
  getPetConfig,
  getPetPosePlaybackLength,
} from '../sprites/spriteData.js';
import type {
  Action,
  ApplianceKind,
  Character,
  FurnitureCatalogEntry,
  InteractionPoint,
  OfficeLayout,
  Pet,
  PetKind,
  PlacedFurniture,
  PlayerSpot,
  GroundMap,
} from '../types.js';
import {
  APPLIANCES_FOR,
  CHASES,
  CharacterState,
  ControllerKind,
  Direction,
  fleesFrom,
  PetKind as PetKindEnum,
  PetState,
  TILE_SIZE,
  TileType,
} from '../types.js';
import { claimPoint, createCharacter, releasePoint, updateCharacter } from './characters.js';
import { snapToTile, stepAlongPath } from './entity.js';
import { announceDue, hourChimes, QuoteSchedule, talkingObjects, type SpokenLine } from './talkingObjects.js';
import type { PetAction, PetAffordances, PetTarget, PetTargetSpec } from './pets.js';
import {
  beginPetDespawn,
  beginScuffle,
  createPet,
  endScuffleAlone,
  petPose,
  pickReachable,
  updatePet,
} from './pets.js';

/** Union of every source of non-walkable tiles: furniture footprints and
 *  tiles the layout itself marks blocked (layout.tileBlocked, independent of
 *  floor pattern). The single Set isWalkable checks. */
function computeBlockedTiles(layout: OfficeLayout): Set<string> {
  return new Set([
    ...getBlockedTiles(layout.furniture),
    ...getBlockedFloorTiles(layout),
    // A wall face is solid wall, so its cells are never walkable — see
    // faceBlockedTiles for why this is derived rather than painted.
    ...faceBlockedTiles(layout.walls, layout.cols),
  ]);
}

/** "col,row" keys of every tile carrying a tile action (any kind) — a plain
 *  click-to-move walk should route around these when it can (see walkPlayer),
 *  rather than cutting through a meeting room/kiosk/etc. on its way somewhere
 *  else. Furniture-sourced actions don't need an equivalent set: their tiles
 *  are already non-walkable via computeBlockedTiles (you approach them, you
 *  don't cut through them). */
function computeActionTileKeys(layout: OfficeLayout): Set<string> {
  const keys = new Set<string>();
  const actions = layout.tileActions;
  if (!actions) return keys;
  for (let i = 0; i < actions.length; i++) {
    if (actions[i]) keys.add(`${i % layout.cols},${Math.floor(i / layout.cols)}`);
  }
  return keys;
}

export class OfficeState {
  layout: OfficeLayout;
  tileMap: GroundMap;
  /** Every place a character can occupy: chairs (posture 'sit') and appliance
   *  stand tiles (posture 'stand') in one map, one occupant each. Absorbed the
   *  separate `seats`/`stations` pair — see InteractionPoint. */
  points: Map<string, InteractionPoint> = new Map();
  /** Standing interaction points derived from appliances (coffee machine, …). */
  blockedTiles: Set<string>;
  /** Walls as edges between cells (see types.ts's WallEdges) — what every
   *  findPath below consults so a wall blocks the STEP between two cells
   *  instead of costing a walkable cell of its own. Undefined on a layout that
   *  still uses WALL tiles. */
  walls: OfficeLayout['walls'];
  /** "col,row" of every tile occupied by an `approachThrough` furniture item —
   *  see getReachThroughTiles/computeApproachTiles. */
  private reachThroughTiles: Set<string>;
  /** "col,row" of every tile carrying a tile action — see computeActionTileKeys.
   *  Only walkPlayer's plain click-to-move consults this (a soft detour cost
   *  in findPath, not a hard block); pet wandering, seats, and appliance/
   *  action approach paths ignore it entirely. */
  private actionTileKeys: Set<string>;
  /** Flood-filled meeting-room tile actions (see computeActionAreas) — read
   *  via areaIdAt()/areaAnchor(), never mutated in place. */
  private actionAreas: ActionAreaMap;
  /** slug+video -> canonical anchor, rebuilt with actionAreas. Cached because the
   *  membership check below runs per character per tick. */
  private meetingCanonical: Map<string, { col: number; row: number }>;
  /**
   * Current furniture placements with the on-state applied — the engine's own view of what
   * stands where, and what the seats and blocked cells are derived from.
   *
   * It no longer carries an animation FRAME. A frame is presentation timing (invariant 2), and
   * expressing it as a different art id made it synced state: the ambient animation swapped this
   * array five times a second, the room rebuilt all 163 `FurnitureSync` records from it, and every
   * viewer received the whole map — 11 442 bytes per patch in a world where nothing moved, while
   * the actual difference was four short art ids. The client resolves the frame itself now, from
   * the same `animationFrameAt` and the same catalog it already builds.
   */
  furniturePlacements: PlacedFurniture[] = [];
  walkableTiles: Array<{ col: number; row: number }>;
  /**
   * Three tables derived from the layout, built once with it — the same treatment
   * `blockedTiles` and `walkableTiles` already get, and for the same reason: they are answers
   * about the MAP, and a map changes only when one is pushed.
   *
   * They existed as three loops before, run per question: `occupiedSurfaceTiles` walked all 164
   * placements TWICE per pet decision (once for the affordance, once for the target search),
   * `seatFacesFurniture` re-found its placement with a linear `find` inside a loop over
   * placements, and `findFreeSpawnTile` rebuilt the whole footprint set plus a filter over all
   * 2651 walkable tiles on every join. Measured on uponu, that made a pet's 'sit' decision cost
   * 2.0 ms and a join 0.2 ms; see the methods for the numbers after.
   *
   * Assigned WHOLESALE in `layoutDerived()` from both call sites, never mutated incrementally, so
   * they cannot drift from the layout and `leaks.mjs` reads them as layout-bounded. A catalog
   * reload counts as a layout change and already triggers a rebuild (SimRoom does it on
   * ASSET_CHANGED), which is what keeps `entryFor` results from going stale in here.
   */
  private footprintUids: Map<string, Set<string>> = new Map();
  private surfaceUids: Map<string, Set<string>> = new Map();
  private spawnablePool: Array<{ col: number; row: number }> = [];
  characters: Map<number, Character> = new Map();
  /**
   * The uids whose piece is currently switched ON — the one thing about furniture that IS a world
   * decision, because it comes from who sits where (see autoOnSitters) and from the click-toggle.
   * Sorted, so a comparison of two of these answers "did anything change" without a set diff.
   */
  furnitureOnUids: string[] = [];
  /** Auto-on fingerprint as of the last rebuild (see autoOnSignature). */
  private lastAutoOnSig = '';
  /** Furniture uids currently switched on via the click-to-toggle Action (see
   *  toggleFurniture) — ephemeral, like auto-on-facing: never written to the
   *  saved layout, resets to "off" on reload. */
  private manuallyToggledOn = new Set<string>();
  selectedAgentId: number | null = null;
  cameraFollowId: number | null = null;
  hoveredAgentId: number | null = null;
  hoveredTile: { col: number; row: number } | null = null;
  /** Maps "parentId:toolId" → sub-agent character ID (negative) */
  subagentIdMap: Map<string, number> = new Map();
  /** Reverse lookup: sub-agent character ID → parent info */
  subagentMeta: Map<number, { parentAgentId: number; parentToolId: string }> = new Map();
  private nextSubagentId = -1;
  /** Per-user pinned character skin (folderName → skin id). */
  private skinPrefs = new Map<string, string>();
  private warpStylePrefs = new Map<string, WarpStyleId>();

  // ── Pets ──────────────────────────────────────────────────
  /** Live pets, keyed by a dedicated id space (disjoint from characters). */
  pets: Map<number, Pet> = new Map();
  /** Non-chair furniture uids currently claimed by a pet. */
  /** Sit points a pet has claimed. Separate from InteractionPoint.occupantId
   *  because pet ids and character ids share one number space, so a pet could
   *  not be told apart from a character in that slot — but the exclusion is
   *  mutual all the same: both sides consult both (see findFreeSitPoint). It
   *  mirrors petFurnitureClaims/petStationClaims below. */
  private petSeatClaims: Set<string> = new Set();
  private petFurnitureClaims: Set<string> = new Set();
  /** Appliance-station uids currently claimed by a pet (mutually exclusive with
   *  an agent's `occupantId` claim on the same station). */
  private petStationClaims: Set<string> = new Set();
  /** Agent ids a pet is currently talking to (one pet per agent at a time). */
  private petTalkClaims: Set<number> = new Set();
  /** Per-pet-variant spawn countdown (seconds), keyed by `${kind}_${variant}`. */
  private petSpawnTimers = new Map<string, number>();
  /** Which pet variants may spawn in this room/zone (per-zone config). Default:
   *  all. Set by the room from the zone's `pets` setting. */
  private petSpawnFilter: (kind: PetKind, variant: number) => boolean = () => true;
  private nextPetId = 1_000_000;
  /** Player avatar ids live in their own band (agents use Claude ids, subagents
   *  negative, pets 1_000_000+). */
  private nextPlayerId = 2_000_000;
  /** Tiles that trigger a zone portal — derived from placed furniture whose
   *  effective action is 'portal' (the walkable footprint tiles). Arrival
   *  fires through pendingActionArrivals below, same as every other action. */
  private portalTiles: Set<string> = new Set();
  /** Players who reached a furniture action's stand tile (walk-then-
   *  trigger), drained by the room — see takePendingActionArrivals /
   *  walkPlayerToAction / SimRoom.handleActionArrivals. */
  private pendingActionArrivals: Array<{ id: number; action: Action; col: number; row: number }> = [];
  /** Lines a talking object said this tick, drained by the room — see
   *  takeSpokenLines / talkingObjects.ts / SimRoom.handleSpokenLines. Bounded by
   *  construction rather than by a cap: the only things that append are the hour
   *  turning and a quote coming due, at most one line each per talking object,
   *  and the room drains it in the same tick that filled it. */
  private spokenLines: SpokenLine[] = [];
  /** Which hour the talking objects have already announced (`null` = this room
   *  has not ticked yet, so the next tick adopts the hour instead of announcing
   *  it — see announceDue). */
  private lastChimeStamp: number | null = null;
  /** The placements that talk, derived from the layout like actionAreas beside
   *  it. Kept rather than filtered per tick because the quote schedule needs it
   *  on every tick and the filter costs an `entryFor` per placement — see
   *  hourChimes. */
  private talkers: PlacedFurniture[] = [];
  /** When each talking object says its next quote (see QuoteSchedule). Empty of
   *  quotes until the server hands the pool over — setQuotes. */
  private readonly quoteSchedule = new QuoteSchedule();
  /** Optional server-injected pet decision fn (the mistreevous brain). When set,
   *  it chooses a pet's idle activity; otherwise the engine's built-in roll runs. */
  private petDecide?: (pet: Pet, affordances: PetAffordances) => PetAction;

  constructor(layout?: OfficeLayout) {
    this.layout = layout || createDefaultLayout();
    this.tileMap = layoutToTileMap(this.layout);
    this.blockedTiles = computeBlockedTiles(this.layout);
    this.walls = this.layout.walls;
    this.reachThroughTiles = getReachThroughTiles(this.layout.furniture);
    this.actionAreas = computeActionAreas(this.layout);
    this.meetingCanonical = meetingCanonicalAnchors(this.layout);
    this.actionTileKeys = computeActionTileKeys(this.layout);
    this.talkers = talkingObjects(this.layout.furniture);
    // No characters/manual toggles exist yet at construction, so the auto-on/toggle modifications
    // rebuildFurnitureInstances() would apply are all no-ops right now — the raw layout furniture
    // IS the correct initial placement list. Without this it stays stuck at its [] field default
    // until something explicitly calls rebuildFromLayout(), which is how a freshly created room
    // once managed to have no furniture at all.
    this.furniturePlacements = this.layout.furniture;
    this.walkableTiles = getWalkableTiles(this.tileMap, this.blockedTiles);
    this.layoutDerived();
    this.buildPoints();
    this.computePortalTiles();
  }

  /** Rebuild all derived state from a new layout. Reassigns existing characters.
   *  @param shift Optional pixel shift to apply when grid expands left/up */
  rebuildFromLayout(layout: OfficeLayout, shift?: { col: number; row: number }): void {
    // Pets hold seat/furniture/tile claims that won't survive a layout rebuild.
    // Drop them outright; they respawn naturally from the spawn loop.
    this.pets.clear();
    this.petSeatClaims.clear();
    this.petFurnitureClaims.clear();
    this.petStationClaims.clear();
    this.petTalkClaims.clear();

    // Drop manual on/off toggle state for any uid that no longer exists in
    // the new layout — a straight .clear() would also lose legitimate state
    // for furniture that survives an unrelated edit untouched (same uid),
    // but a stale uid (item deleted, or a Tiled re-import that regenerates
    // every uid) would otherwise linger in this set forever.
    if (this.manuallyToggledOn.size > 0) {
      const stillPlaced = new Set(layout.furniture.map((f) => f.uid));
      for (const uid of this.manuallyToggledOn) {
        if (!stillPlaced.has(uid)) this.manuallyToggledOn.delete(uid);
      }
    }

    this.layout = layout;
    this.tileMap = layoutToTileMap(layout);
    this.blockedTiles = computeBlockedTiles(layout);
    this.walls = layout.walls;
    this.reachThroughTiles = getReachThroughTiles(layout.furniture);
    this.actionAreas = computeActionAreas(layout);
    this.meetingCanonical = meetingCanonicalAnchors(layout);
    this.actionTileKeys = computeActionTileKeys(layout);
    this.talkers = talkingObjects(layout.furniture);
    // A surviving whale keeps its wait; one that was deleted (or whose uid a
    // Tiled re-import regenerated) is forgotten here rather than held forever.
    this.quoteSchedule.prune(new Set(this.talkers.map((t) => t.uid)));
    this.rebuildFurnitureInstances();
    this.walkableTiles = getWalkableTiles(this.tileMap, this.blockedTiles);
    this.layoutDerived();

    // Station uids are regenerated; drop stale claims on every character.
    this.buildPoints();
    this.computePortalTiles();
    for (const ch of this.characters.values()) {
      ch.atPointId = null;
      ch.atPointTimer = 0;
    }

    // Shift character positions when grid expands left/up
    if (shift && (shift.col !== 0 || shift.row !== 0)) {
      for (const ch of this.characters.values()) {
        ch.tileCol += shift.col;
        ch.tileRow += shift.row;
        ch.x += shift.col * TILE_SIZE;
        ch.y += shift.row * TILE_SIZE;
        // Clear path since tile coords changed
        ch.path = [];
        ch.moveProgress = 0;
      }
    }

    // Occupancy is re-DERIVED here rather than reset and rebuilt: `occupantId`
    // names its holder, so re-applying what the characters themselves say is the
    // whole job, and a claim on a point the new layout no longer has simply drops
    // out. The old `assigned` boolean couldn't be checked against anything, which
    // is why this needed two passes and a comment about preserving assignments.
    for (const p of this.points.values()) p.occupantId = null;
    const reclaim = (ch: Character, uid: string): boolean => {
      const p = this.points.get(uid);
      if (!p || (p.occupantId !== null && p.occupantId !== ch.id)) return false;
      p.occupantId = ch.id;
      return true;
    };
    for (const ch of this.characters.values()) {
      if (ch.homePointId && !reclaim(ch, ch.homePointId)) ch.homePointId = null;
    }
    for (const ch of this.characters.values()) {
      if (ch.atPointId && !reclaim(ch, ch.atPointId)) {
        ch.atPointId = null;
        ch.atPointTimer = 0;
      }
    }

    // Whoever kept their own point stands on it again.
    for (const ch of this.characters.values()) {
      const home = ch.homePointId ? this.points.get(ch.homePointId) : undefined;
      if (!home) continue;
      ch.tileCol = home.col;
      ch.tileRow = home.row;
      ch.x = home.col * TILE_SIZE + TILE_SIZE / 2;
      ch.y = home.row * TILE_SIZE + TILE_SIZE / 2;
      ch.dir = home.facingDir;
    }

    // Anyone left without one gets a free point — agents only. A player has no
    // desk of their own (homePointId is the agent-side reservation), and handing
    // them one here would teleport them onto a chair the moment a map is pushed.
    for (const ch of this.characters.values()) {
      if (ch.homePointId || ch.controller === ControllerKind.HUMAN) continue;
      const uid = this.findFreeSitPoint();
      if (!uid) continue;
      const point = this.points.get(uid)!;
      point.occupantId = ch.id;
      ch.homePointId = uid;
      ch.tileCol = point.col;
      ch.tileRow = point.row;
      ch.x = point.col * TILE_SIZE + TILE_SIZE / 2;
      ch.y = point.row * TILE_SIZE + TILE_SIZE / 2;
      ch.dir = point.facingDir;
    }

    // Relocate any characters that ended up outside bounds or on non-walkable tiles
    for (const ch of this.characters.values()) {
      if (ch.homePointId) continue; // seated characters are fine
      if (
        ch.tileCol < 0 ||
        ch.tileCol >= layout.cols ||
        ch.tileRow < 0 ||
        ch.tileRow >= layout.rows
      ) {
        this.relocateCharacterToWalkable(ch);
      }
    }
  }

  /** Move a character to a random walkable tile (never inside a meeting area). */
  private relocateCharacterToWalkable(ch: Character): void {
    if (this.walkableTiles.length === 0) return;
    const pool = this.spawnableTiles();
    const spawn = pool[Math.floor(Math.random() * pool.length)];
    ch.tileCol = spawn.col;
    ch.tileRow = spawn.row;
    ch.x = spawn.col * TILE_SIZE + TILE_SIZE / 2;
    ch.y = spawn.row * TILE_SIZE + TILE_SIZE / 2;
    ch.path = [];
    ch.moveProgress = 0;
  }

  getLayout(): OfficeLayout {
    return this.layout;
  }

  /** Which meeting-room area (if any) a tile belongs to — see
   *  computeActionAreas. The room re-derives each character's area from this
   *  every tick (SimRoom's meeting-area membership tracking); nothing here
   *  is cached per-character. */
  areaIdAt(col: number, row: number): number | null {
    return actionAreaIdAt(this.actionAreas, this.layout.cols, this.layout.rows, col, row);
  }

  /** An area id's stable anchor tile — the per-area room name (and its
   *  video:boolean setting, via layout.tileActions at this tile) is derived
   *  from this (mirrors a conference monitor falling back to its own anchor
   *  tile when it has no explicit name; see conferenceKey). */
  areaAnchor(areaId: number): { col: number; row: number } | null {
    return actionAreaAnchor(this.actionAreas, areaId);
  }

  /** Which meeting call the tile at (col,row) belongs to, or null if it is not a
   *  meeting tile. Areas that agree about name and video are ONE call even when they
   *  do not touch; the identity rule itself lives in `layout/actionAreas.ts`. */
  meetingAreaAt(col: number, row: number): MeetingAreaIdentity | null {
    return meetingAreaAt(this.layout, this.actionAreas, col, row, this.meetingCanonical);
  }

  /** Where a named call is addressed — its raster-first anchor across all areas
   *  sharing the name. Lets a caller answer for a call nobody currently stands in. */
  meetingCanonicalAnchor(slug: string, video: boolean): { col: number; row: number } | null {
    return this.meetingCanonical.get(`${slug} ${video ? 1 : 0}`) ?? null;
  }

  /** Walkable tiles minus any meeting area — nobody should ever spawn/land
   *  standing in a walk-in meeting area (it would auto-join them into a call
   *  before they've even chosen anything). Falls back to the unrestricted
   *  walkable set if meeting areas somehow cover the whole map, so a spawn
   *  is never simply impossible. */
  private spawnableTiles(): Array<{ col: number; row: number }> {
    return this.spawnablePool;
  }

  /** The blocked-tile key of a character's own point, or null */
  private ownSeatKey(ch: Character): string | null {
    if (!ch.homePointId) return null;
    const point = this.points.get(ch.homePointId);
    return point ? `${point.col},${point.row}` : null;
  }

  /**
   * Temporarily unblock one tile, run fn, then put `blockedTiles` back exactly as it was.
   *
   * Two properties are the reason this is one helper rather than the delete/restore pair written
   * out per call site. It restores what was THERE — a tile that was not blocked does not become
   * blocked, which is not hypothetical: `blockedTiles` is rebuilt only when a layout is set, so a
   * key added by mistake stays for the life of the zone. And it restores through `finally`, so a
   * throw inside fn cannot leave a tile blocked either.
   */
  private withTileUnblocked<T>(key: string | null, fn: () => T): T {
    const had = key !== null && this.blockedTiles.has(key);
    if (had && key !== null) this.blockedTiles.delete(key);
    try {
      return fn();
    } finally {
      if (had && key !== null) this.blockedTiles.add(key);
    }
  }

  /** Temporarily unblock a character's own seat, run fn, then re-block */
  private withOwnSeatUnblocked<T>(ch: Character, fn: () => T): T {
    return this.withTileUnblocked(this.ownSeatKey(ch), fn);
  }

  // ── Interaction stations (coffee machine, …) ──────────────

  /** All walkable tiles orthogonally adjacent to a footprint (not overlapping
   *  it), each paired with the facing direction that looks back at the
   *  footprint. Shared "stand here to interact" candidate generator —
   *  appliances, conference monitors, arcade cabinets and meeting-room kiosks
   *  all derive their approach spot(s) from this one implementation.
   *
   *  Wall-mounted items (footprint's bottom row anchored on a WALL tile — the
   *  convention every 2-row wall item placement uses, see LayoutEditor's
   *  wallFootprintOk) render their art in the row ABOVE the wall row (see
   *  e.g. conferenceAssets.ts), but that says nothing about which side a
   *  player should approach from — most such walls are a room's own boundary,
   *  with void/blocked space on the art's side and the real room on the far
   *  side of the wall, so isWalkable already picks the right side for free.
   *  The only case that needs help is a divider wall with walkable floor on
   *  BOTH sides (art side included) — there the naive 4-neighbor scan below
   *  would otherwise also offer the tile behind the wall as an equally valid
   *  approach, walking a player to the blank back of the screen. Which side
   *  is correct in that ambiguous case can't be inferred from the tile map
   *  (established the hard way, twice) — every engine that solves this well
   *  (RPG Maker's per-direction tile passage, Grid Engine's ge_collide_*)
   *  stores it as authored data instead, so `facing` (PlacedFurniture, set at
   *  placement time) is authoritative here; the tile map only decides when
   *  one side isn't walkable at all.
   *
   *  A blocked immediate neighbor doesn't always end the search either: if
   *  it's occupied by an `approachThrough` item (see PlacedFurniture — e.g. a
   *  kitchen counter with a coffee machine mounted behind it), the search
   *  keeps stepping outward past it looking for the real stand tile, so the
   *  player ends up in front of the counter facing the appliance beyond it. */
  private computeApproachTiles(
    col: number,
    row: number,
    w: number,
    h: number,
    allowedSides?: Array<'N' | 'S' | 'E' | 'W'>,
  ): Array<{ col: number; row: number; facing: Direction }> {
    // An explicit allow-list (PlacedFurniture.approachSides) is a deliberate
    // per-instance choice — it overrides the wall-ambiguity auto-resolution
    // below entirely rather than combining with it, so picking e.g. only 'S'
    // behaves the same on a plain floor item as on an ambiguous wall one.
    const restrict = allowedSides && allowedSides.length > 0 ? allowedSides : null;
    const wallRow = row + h - 1;
    let wallMounted = true;
    for (let dc = 0; dc < w && wallMounted; dc++) {
      // "Mounted on a wall" means the item's bottom row stands against one —
      // i.e. that row's north boundary carries a wall edge, the row itself being
      // ordinary floor (see wallEdges.ts's wallOnNorthEdge).
      if (!wallOnNorthEdge(this.walls, this.layout.cols, col + dc, wallRow)) wallMounted = false;
    }
    const artRow = row - 1; // just north of the sprite's own body — the ambiguous side
    const farRow = wallRow + 1; // just south of the wall — the room on the wall's far side
    let ambiguous = false;
    if (wallMounted && !restrict) {
      ambiguous = true;
      for (let dc = 0; dc < w && ambiguous; dc++) {
        if (!isWalkable(col + dc, artRow, this.tileMap, this.blockedTiles)) ambiguous = false;
        if (!isWalkable(col + dc, farRow, this.tileMap, this.blockedTiles)) ambiguous = false;
      }
    }
    const seen = new Set<string>();
    const approaches: Array<{ col: number; row: number; facing: Direction }> = [];
    for (let dr = 0; dr < h; dr++) {
      for (let dc = 0; dc < w; dc++) {
        const fc = col + dc;
        const fr = row + dr;
        const cands: Array<[number, number, number, number, Direction, 'N' | 'S' | 'E' | 'W']> = [
          [fc, fr - 1, 0, -1, Direction.DOWN, 'N'],
          [fc, fr + 1, 0, 1, Direction.UP, 'S'],
          [fc - 1, fr, -1, 0, Direction.RIGHT, 'W'],
          [fc + 1, fr, 1, 0, Direction.LEFT, 'E'],
        ];
        for (const [nc0, nr0, ddc, ddr, approachFacing, side] of cands) {
          if (restrict && !restrict.includes(side)) continue;
          // Ambiguous case: the far side (south of the wall) wins, and the
          // whole art side loses — not just the tile directly above the
          // footprint. A *lateral* neighbor of the sprite's own body row (e.g.
          // standing beside a narrow cabinet, at the same height as its
          // screen) is on the art side exactly as much as the tile straight
          // above it, and both must lose equally. Judged on the immediate
          // neighbor (pre reach-through), not wherever it ends up below —
          // that's about which side of the WALL this is, unaffected by a
          // counter sitting further out on the same side. A mapper who wants
          // the art side instead says so with approachSides, which skips this
          // resolution entirely (it used to be a per-instance `facing`, which
          // no content ever set).
          if (ambiguous && nr0 < wallRow) continue;
          // Reach-through: a blocked immediate neighbor that's occupied by an
          // `approachThrough` item (e.g. a kitchen counter) doesn't end the
          // search — keep stepping outward in the same direction until an
          // actually-walkable tile turns up (or a real dead end does), so
          // the player ends up standing in front of the counter instead of
          // never finding a spot at all. Capped to stay well clear of
          // pathological chains without a real furniture layout ever needing
          // more than one or two hops.
          let nc = nc0;
          let nr = nr0;
          let hops = 0;
          while (
            !isWalkable(nc, nr, this.tileMap, this.blockedTiles) &&
            this.reachThroughTiles.has(`${nc},${nr}`) &&
            hops < 8
          ) {
            nc += ddc;
            nr += ddr;
            hops++;
          }
          const k = `${nc},${nr}`;
          const inFoot = nc >= col && nc < col + w && nr >= row && nr < row + h;
          if (seen.has(k) || inFoot || !isWalkable(nc, nr, this.tileMap, this.blockedTiles)) continue;
          seen.add(k);
          approaches.push({ col: nc, row: nr, facing: approachFacing });
        }
      }
    }
    return approaches;
  }

  /**
   * (Re)build the whole points map: every sittable tile as a `sit` point, plus one
   * `stand` point PER walkable tile adjacent to each appliance (not just the
   * first) — so multiple visitors spread out around it instead of stacking on a
   * single fixed tile. findFreeAppliance() picks randomly among every free entry
   * across every appliance, so registering more entries per appliance is all that
   * is needed for that to also randomise position around one appliance.
   *
   * Both kinds live in ONE map, so this builds both: an earlier version of this
   * merge had the sit points built at the call site and then silently erased here
   * by a `new Map()`, which left the zone with no seats at all.
   */
  private buildPoints(): void {
    this.points = layoutToSitPoints(this.layout.furniture);
    for (const item of this.layout.furniture) {
      const entry = entryFor(item);
      if (!entry) continue;
      // effectiveAction, not the raw catalog flag — an item's own Action
      // override (the editor's Action… button) must be able to turn ANY
      // furniture into a station, not just ones the catalog itself flags.
      const action = effectiveAction(item, entry);
      if (action?.kind !== 'appliance') continue;
      const spots = this.computeApproachTiles(item.col, item.row, entry.footprintW, entry.footprintH, item.approachSides).filter(
        (c) => !this.isPointTile(c.col, c.row),
      );
      spots.forEach((spot, i) => {
        const uid = `station:${item.uid}:${i}`;
        this.points.set(uid, {
          uid,
          col: spot.col,
          row: spot.row,
          facingDir: spot.facing,
          posture: 'stand',
          occupantId: null,
          // Which appliance this belongs to, so a lookup can want one kind and get only that.
          //
          // Defaulted, not trusted: an action may arrive as `{ kind: 'appliance' }` with no pose —
          // the Tiled importer fills in `coffee` (actionProps.ts) but a catalog entry need not, and
          // a placement override need not either. Storing `undefined` here would leave that
          // appliance usable by NOBODY, since every lookup asks for a kind it allows. Coffee is
          // the same default the importer uses, so an appliance that never said what it is keeps
          // behaving as it did.
          appliance: action.pose ?? 'coffee',
        });
      });
    }
  }

  private isPointTile(col: number, row: number): boolean {
    for (const s of this.points.values()) {
      if (s.col === col && s.row === row) return true;
    }
    return false;
  }

  /**
   * A free stand point belonging to an appliance of `kind`, at random among all of them.
   *
   * The `appliance === kind` test is the whole filter and it is doing two jobs: it picks the right
   * KIND, and it excludes seats by construction (a seat carries no appliance). Before this, the
   * search looked at neither — it walked every point in the map, so an agent on a coffee break
   * could march over to a free desk chair and stand on it, and a pet could claim a coffee machine.
   */
  private findFreeAppliance(kinds: readonly ApplianceKind[]): string | null {
    const free: string[] = [];
    for (const [uid, s] of this.points) {
      if (!s.appliance || !kinds.includes(s.appliance)) continue;
      if (s.occupantId === null && !this.petStationClaims.has(uid)) free.push(uid);
    }
    if (free.length === 0) return null;
    return free[Math.floor(Math.random() * free.length)];
  }

  /** Any appliance station free for a pet to claim (cheap existence check). */
  /** Whether any appliance of `kind` has a free stand point — the affordance behind "may I go?". */
  private hasFreeAppliance(kinds: readonly ApplianceKind[]): boolean {
    for (const [uid, s] of this.points) {
      if (!s.appliance || !kinds.includes(s.appliance)) continue;
      if (s.occupantId === null && !this.petStationClaims.has(uid)) return true;
    }
    return false;
  }

  /** Occasionally send an idle, inactive agent to stand at a free appliance. */
  private maybeStartCoffeeBreak(ch: Character, dt: number): void {
    if (ch.coffeeCooldown > 0) ch.coffeeCooldown -= dt;
    // Only when idle, off the clock, not already on a break, and standing still.
    if (ch.isActive || ch.atPointId || ch.state !== CharacterState.IDLE) return;
    if (ch.path.length > 0 || ch.coffeeCooldown > 0 || this.points.size === 0) return;
    if (Math.random() >= COFFEE_BREAK_CHANCE) return;

    const uid = this.findFreeAppliance(APPLIANCES_FOR.character);
    if (!uid) return;
    const station = this.points.get(uid)!;
    const path = this.withOwnSeatUnblocked(ch, () =>
      findPath(ch.tileCol, ch.tileRow, station.col, station.row, this.tileMap, this.blockedTiles, undefined, this.walls),
    );

    // Reserve the station and head over (start the cooldown regardless).
    station.occupantId = ch.id;
    ch.atPointId = uid;
    ch.coffeeCooldown =
      COFFEE_COOLDOWN_MIN_SEC + Math.random() * (COFFEE_COOLDOWN_MAX_SEC - COFFEE_COOLDOWN_MIN_SEC);
    if (path.length > 0) {
      ch.path = path;
      ch.moveProgress = 0;
      ch.state = CharacterState.WALK;
      ch.frame = 0;
      ch.frameTimer = 0;
    } else {
      // Already on the tile — stand immediately.
      ch.dir = station.facingDir;
      ch.atPointTimer =
        COFFEE_STAND_MIN_SEC + Math.random() * (COFFEE_STAND_MAX_SEC - COFFEE_STAND_MIN_SEC);
    }
  }

  /**
   * "col,row" of everything that switches itself on for whoever sits facing it
   * (see FurnitureCatalogEntry.onState) — a workstation, in the only sense the
   * engine needs: not "is this a computer" but "does sitting here light
   * something up".
   *
   * Shared by findFreeSitPoint, which prefers such a seat when placing an agent,
   * and rebuildFurnitureInstances, which actually performs the switching. Those
   * two used to describe the same set independently — one by asking for the
   * 'electronics' category, the other by asking for a state pair — so a mapper
   * could make an item light up without agents preferring to sit at it.
   */
  private seatDrivenSwitchableTiles(): Set<string> {
    const tiles = new Set<string>();
    for (const item of this.layout.furniture) {
      const entry = entryFor(item);
      if (!entry || !this.isSeatDrivenSwitchable(item, entry)) continue;
      for (let dr = 0; dr < entry.footprintH; dr++) {
        for (let dc = 0; dc < entry.footprintW; dc++) {
          tiles.add(`${item.col + dc},${item.row + dr}`);
        }
      }
    }
    return tiles;
  }

  /** Does this item have an on-state that a seated character triggers? An item
   *  carrying the 'toggle' Action is a light-switch instead — it answers to a
   *  click and to nothing else, so sitting near it must not flip it. */
  private isSeatDrivenSwitchable(item: PlacedFurniture, entry: FurnitureCatalogEntry): boolean {
    if (resolveOnState(item, entry) === item.id) return false;
    return effectiveAction(item, entry)?.kind !== 'toggle';
  }

  private findFreeSitPoint(): string | null {
    const switchableTiles = this.seatDrivenSwitchableTiles();

    // Collect free sit points, split into those facing a switchable and the rest
    const pcSeats: string[] = [];
    const otherSeats: string[] = [];
    for (const [uid, point] of this.points) {
      if (point.posture !== 'sit') continue; // an appliance's stand tile is not a desk
      // Free means free for anyone: a point a PLAYER is sitting on has an
      // occupantId now, which is the whole reason this merge happened — the old
      // boolean only ever knew about agents.
      if (point.occupantId !== null || this.petSeatClaims.has(uid)) continue;
      // A desk inside a walk-in meeting area is a perfectly good desk. This used
      // to skip them, guarding against "silently pulling agents into calls" — a
      // consequence that cannot occur: membership in a meeting area is derived
      // for PLAYERS only (see SimRoom.syncCharacters), so an agent standing in
      // one joins nothing, is in no participant list, and mints no token. The
      // guard did have a cost: once a mapper drew a meeting area over the open-
      // plan office, most desks stopped being used at all. Spawning is a
      // different matter and still avoids areas (spawnableTiles) — that one
      // protects players, for whom landing inside an area IS joining a call.

      // Check if this seat faces electronics (same logic as auto-state detection)
      let facesPC = false;
      const dCol =
        point.facingDir === Direction.RIGHT ? 1 : point.facingDir === Direction.LEFT ? -1 : 0;
      const dRow = point.facingDir === Direction.DOWN ? 1 : point.facingDir === Direction.UP ? -1 : 0;
      for (let d = 1; d <= AUTO_ON_FACING_DEPTH && !facesPC; d++) {
        const tileCol = point.col + dCol * d;
        const tileRow = point.row + dRow * d;
        if (switchableTiles.has(`${tileCol},${tileRow}`)) {
          facesPC = true;
          break;
        }
        if (dCol !== 0) {
          if (
            switchableTiles.has(`${tileCol},${tileRow - 1}`) ||
            switchableTiles.has(`${tileCol},${tileRow + 1}`)
          ) {
            facesPC = true;
            break;
          }
        } else {
          if (
            switchableTiles.has(`${tileCol - 1},${tileRow}`) ||
            switchableTiles.has(`${tileCol + 1},${tileRow}`)
          ) {
            facesPC = true;
            break;
          }
        }
      }
      (facesPC ? pcSeats : otherSeats).push(uid);
    }

    // Pick randomly: prefer PC seats, then any seat
    if (pcSeats.length > 0) return pcSeats[Math.floor(Math.random() * pcSeats.length)];
    if (otherSeats.length > 0) return otherSeats[Math.floor(Math.random() * otherSeats.length)];
    return null;
  }

  /**
   * Pick a diverse skin for a new agent based on currently active agents: the
   * least-used one, ties broken at random. As many agents as there are skins get
   * a distinct look; beyond that skins simply repeat and two agents look alike.
   *
   * That repetition used to be papered over with a random hue rotation (≥45°),
   * which cost a full recoloured copy of every frame per distinct hue — and only
   * ever triggered once the skins ran out. Looking alike is accepted instead; the
   * way to more variety is more art, not more copies.
   */
  private pickDiverseSkin(): string {
    // Count how many non-sub-agents use each loaded skin id.
    const ids = getSkinIds();
    if (ids.length === 0) return firstSkinId();
    const counts = new Map<string, number>(ids.map((id) => [id, 0]));
    for (const ch of this.characters.values()) {
      if (ch.isSubagent) continue;
      if (counts.has(ch.skin)) counts.set(ch.skin, (counts.get(ch.skin) ?? 0) + 1);
    }
    const minCount = Math.min(...counts.values());
    // Available = skins at the minimum count (least used).
    const available = ids.filter((id) => counts.get(id) === minCount);
    return available[Math.floor(Math.random() * available.length)];
  }

  /** After the skin roster changes, drop pinned skins that no longer exist and
   *  re-randomise (diverse) any live agents stuck on a missing skin — so a
   *  deleted custom character falls back to a random skin. Returns the
   *  folderNames whose pinned skin was dropped. */
  dropInvalidSkins(validIds: Set<string>): string[] {
    const dropped: string[] = [];
    for (const [name, skin] of this.skinPrefs) {
      // Player-owned avatars (pa:…) live outside the gallery and are never
      // dropped by a template change.
      if (isPlayerAvatarSkin(skin)) continue;
      if (!validIds.has(skin)) {
        this.skinPrefs.delete(name);
        dropped.push(name);
      }
    }
    for (const ch of this.characters.values()) {
      if (ch.isSubagent || isPlayerAvatarSkin(ch.skin) || validIds.has(ch.skin)) continue;
      ch.skin = this.pickDiverseSkin();
    }
    return dropped;
  }

  /** Unpin a user's character skin and re-randomise their live agents
   *  (back to a diverse skin). */
  clearSkinPref(folderName: string): void {
    if (!folderName || !this.skinPrefs.has(folderName)) return;
    this.skinPrefs.delete(folderName);
    for (const ch of this.characters.values()) {
      if (!ch.isSubagent && ch.folderName === folderName) {
        ch.skin = this.pickDiverseSkin();
      }
    }
  }

  /** Pin a user's character skin and recolor any of their live agents. */
  setSkinPref(folderName: string, skin: string): void {
    if (!folderName) return;
    this.skinPrefs.set(folderName, skin);
    for (const ch of this.characters.values()) {
      if (!ch.isSubagent && ch.folderName === folderName) {
        ch.skin = skin;
      }
    }
  }

  addAgent(
    id: number,
    preferredSkin?: string,
    preferredSeatId?: string,
    skipSpawnEffect?: boolean,
    folderName?: string,
  ): void {
    if (this.characters.has(id)) return;

    const pref = folderName ? this.skinPrefs.get(folderName) : undefined;
    // A pinned skin always wins (the viewer chose it for this user).
    const skin = preferredSkin ?? pref ?? this.pickDiverseSkin();

    // Try the preferred point first, then any free one
    let pointId: string | null = null;
    if (preferredSeatId) {
      const preferred = this.points.get(preferredSeatId);
      if (preferred && preferred.posture === 'sit' && preferred.occupantId === null) {
        pointId = preferredSeatId;
      }
    }
    if (!pointId) {
      pointId = this.findFreeSitPoint();
    }

    let ch: Character;
    if (pointId) {
      const point = this.points.get(pointId)!;
      point.occupantId = id;
      ch = createCharacter(id, skin, pointId, point);
    } else {
      // No seats — spawn at a random walkable tile (never inside a meeting area).
      const pool = this.spawnableTiles();
      const spawn = pool.length > 0 ? pool[Math.floor(Math.random() * pool.length)] : { col: 1, row: 1 };
      ch = createCharacter(id, skin, null, null);
      ch.x = spawn.col * TILE_SIZE + TILE_SIZE / 2;
      ch.y = spawn.row * TILE_SIZE + TILE_SIZE / 2;
      ch.tileCol = spawn.col;
      ch.tileRow = spawn.row;
    }

    if (folderName) {
      ch.folderName = folderName;
    }
    if (!skipSpawnEffect) {
      this.beginWarp(ch, 'spawn');
    }
    this.characters.set(id, ch);
  }

  removeAgent(id: number): void {
    const ch = this.characters.get(id);
    if (!ch) return;
    if (ch.matrixEffect === 'despawn') return; // already despawning
    // Let go of both relations at once — the reservation and wherever it stands.
    if (ch.homePointId) {
      const home = this.points.get(ch.homePointId);
      if (home && home.occupantId === id) home.occupantId = null;
    }
    if (ch.atPointId) {
      const at = this.points.get(ch.atPointId);
      if (at && at.occupantId === id) at.occupantId = null;
      ch.atPointId = null;
    }
    if (this.selectedAgentId === id) this.selectedAgentId = null;
    if (this.cameraFollowId === id) this.cameraFollowId = null;
    // Start despawn animation instead of immediate delete
    this.beginWarp(ch, 'despawn');
    ch.bubbleType = null;
  }

  // ── Human-controlled pawns (a viewer's avatar) ────────────────────

  /**
   * The pawn `id`, but only if a HUMAN controller drives it.
   *
   * Every command below used to open with `if (!ch || !ch.isPlayer) return …` — ten copies of one
   * rule, which is the shape a mistake hides in: the day one of them forgets, a `playerMove`
   * message moves an agent. Stated once, it is also the only thing that makes the command surface
   * a property of the CONTROLLER rather than a habit. Callers still supply the id from the
   * session, never from a payload (SimRoom maps sessionId → pawn id); this is applicability, not
   * authorisation.
   */
  /** Said once per process, not per pawn or per tick: a Set keyed by id or kind would grow with
   *  whatever produced the bad value, and this is a code bug, not a data condition. */
  private unclaimedWarned = false;
  private warnUnclaimedPawn(kind: number): void {
    if (this.unclaimedWarned) return;
    this.unclaimedWarned = true;
    console.warn(
      `[office] a character pawn has controller ${kind} — no controller drives it, so it will stand still. ` +
        `Every pawn gets one at creation (addAgent/addPlayer); a new ControllerKind needs a case in update().`,
    );
  }

  private humanPawn(id: number): Character | null {
    const ch = this.characters.get(id);
    return ch && ch.controller === ControllerKind.HUMAN ? ch : null;
  }

  // ── Players (human viewer avatars) ────────────────────────────────

  /** Spawn a human player's avatar (a viewer-driven Character, not the agent
   *  FSM) at a free walkable tile. Returns its id. */
  addPlayer(preferredSkin?: string, name?: string, spawnAt?: { col: number; row: number }): number {
    const id = this.nextPlayerId++;
    const skin = preferredSkin ?? this.pickDiverseSkin();
    const ch = createCharacter(id, skin, null, null);
    ch.controller = ControllerKind.HUMAN;
    ch.heldDir = null;
    ch.isActive = false;
    ch.state = CharacterState.IDLE;
    if (name) ch.folderName = name; // the owning user — shown as the avatar's name
    // Spawn at the requested tile when it's free, else a free random tile (never
    // on a wall, furniture, or another entity).
    const spawn = this.findFreeSpawnTile(spawnAt);
    ch.tileCol = spawn.col;
    ch.tileRow = spawn.row;
    ch.x = spawn.col * TILE_SIZE + TILE_SIZE / 2;
    ch.y = spawn.row * TILE_SIZE + TILE_SIZE / 2;
    this.beginWarp(ch, 'spawn');
    this.characters.set(id, ch);
    return id;
  }

  /**
   * What a returning viewer should resume from (see PlayerSpot), or null if the
   * id is not a player's.
   *
   * Read from the character rather than tracked as the player moves: the truth is
   * already in `OfficeState`, and anything remembered alongside it would be a
   * second copy to keep in step. Sitting is two different facts — a claimed seat
   * (`pointId` names the chair) and the chair-less sit toggle (`sit`) — because
   * putting each back is a different act.
   */
  playerSpot(id: number): PlayerSpot | null {
    const ch = this.humanPawn(id);
    if (!ch) return null;
    const spot: PlayerSpot = { col: ch.tileCol, row: ch.tileRow, dir: ch.dir };
    if (ch.atPointId) spot.pointId = ch.atPointId;
    else if (ch.state === CharacterState.SIT) spot.sit = true;
    if (ch.afk) spot.afk = true;
    return spot;
  }

  /**
   * Put a player back the way they left (see PlayerSpot), as far as the world
   * still allows.
   *
   * Called right after addPlayer, and deliberately allowed to override where that
   * put them: `findFreeSpawnTile` answers a different question — where to *place*
   * somebody automatically, which is why it refuses furniture tiles and meeting
   * areas — and a chair is exactly a furniture tile. This is not placement, it is
   * a resume: the tile is one the player was standing on a moment ago, and the
   * only reasons not to honour it are that the world has moved on. Every one of
   * those is checked here rather than assumed:
   *
   * - a point that no longer exists (the furniture was removed, or the map was
   *   re-imported and uids changed) restores nothing;
   * - a point somebody else now holds is theirs — the same first-come rule as
   *   every other claim (`claimPoint`), and the player just stands instead;
   * - a tile that is no longer walkable leaves them wherever addPlayer put them.
   */
  resumePlayer(id: number, spot: PlayerSpot): void {
    const ch = this.humanPawn(id);
    if (!ch) return;
    // Facing is worth keeping even when nothing else can be: a resumed avatar
    // that turns to face south says "you were moved" all by itself. The stored
    // spot is validated where it is read back (appStore.getPlayerSpot), so this
    // takes it as the Direction its type says it is.
    ch.dir = spot.dir;
    ch.afk = spot.afk === true;

    const point = spot.pointId ? this.points.get(spot.pointId) : undefined;
    if (point && (point.occupantId === null || point.occupantId === ch.id)) {
      this.placePlayerAt(ch, point.col, point.row);
      ch.dir = point.facingDir;
      claimPoint(ch, this.points, point.uid);
      // Players hold a pose until they move — no countdown, exactly as
      // useAppliance/sitPlayerAt leave it (a pet's coffee break is the timed one).
      ch.atPointTimer = 0;
      ch.state = point.posture === 'sit' ? CharacterState.SIT : CharacterState.IDLE;
      return;
    }

    // No point (or it is gone/taken): stand — or sit in place — on the stored
    // tile when it is still somewhere a character can be.
    if (this.tileFreeForResume(ch, spot.col, spot.row)) this.placePlayerAt(ch, spot.col, spot.row);
    if (spot.sit) ch.state = CharacterState.SIT;
  }

  /** Move a player's avatar onto a tile outright: no path, no walk, tile and
   *  pixel position in step (a resume, not movement). */
  private placePlayerAt(ch: Character, col: number, row: number): void {
    ch.tileCol = col;
    ch.tileRow = row;
    ch.path = [];
    ch.moveProgress = 0;
    snapToTile(ch);
  }

  /** Whether a resume may put `ch` on this tile: walkable now, and nobody else
   *  standing there. Meeting areas are allowed on purpose — the player was
   *  already in that call, and being pushed out of it by a reload is the very
   *  thing a resume is for (contrast findFreeSpawnTile, which places somebody
   *  automatically and must never opt them into one). */
  private tileFreeForResume(ch: Character, col: number, row: number): boolean {
    if (!isWalkable(col, row, this.tileMap, this.blockedTiles)) return false;
    for (const other of this.characters.values()) {
      if (other.id !== ch.id && other.tileCol === col && other.tileRow === row) return false;
    }
    for (const pet of this.pets.values()) {
      if (pet.tileCol === col && pet.tileRow === row) return false;
    }
    return true;
  }

  /** A free walkable tile to spawn on: not a wall/blocked tile, not under any
   *  furniture footprint, not occupied by another character or pet, and never
   *  inside a meeting area (see spawnableTiles). Prefers `preferred` (e.g. a
   *  zone's arrival tile) when it's free; else a random free tile; else any
   *  OTHER non-meeting-area walkable tile (even if occupied — a visually
   *  stacked spawn beats an unwanted auto-join into a call); only once every
   *  single walkable tile is inside a meeting area does it fall back to the
   *  fully unrestricted set, so a spawn is never simply impossible. */
  private findFreeSpawnTile(preferred?: { col: number; row: number }): { col: number; row: number } {
    // Who is standing where is live state, so it is still counted per call — a few hundred
    // entries. What is NOT live is the furniture: `footprintUids` already knows every cell a
    // piece covers (see layoutDerived), and rebuilding that set per join is what this used to do.
    const occupied = new Set<string>();
    for (const ch of this.characters.values()) occupied.add(`${ch.tileCol},${ch.tileRow}`);
    for (const p of this.pets.values()) occupied.add(`${p.tileCol},${p.tileRow}`);
    const isFree = (t: { col: number; row: number }): boolean =>
      isWalkable(t.col, t.row, this.tileMap, this.blockedTiles) &&
      !occupied.has(`${t.col},${t.row}`) &&
      !this.footprintUids.has(`${t.col},${t.row}`) &&
      this.areaIdAt(t.col, t.row) === null;

    if (preferred && isFree(preferred)) return preferred;
    const spawnable = this.spawnableTiles(); // walkable, outside any meeting area
    // One free tile is all this needs, so draw at random rather than filtering all of them:
    // rejection sampling, so the choice stays uniform over the free tiles. See
    // SPAWN_PROBE_TRIES for why eight, and why the filter below is still here.
    for (let probe = 0; probe < SPAWN_PROBE_TRIES && spawnable.length > 0; probe++) {
      const tile = spawnable[Math.floor(Math.random() * spawnable.length)];
      if (isFree(tile)) return tile;
    }
    const free = spawnable.filter(isFree);
    const pool = free.length > 0 ? free : spawnable.length > 0 ? spawnable : this.walkableTiles;
    return pool.length > 0 ? pool[Math.floor(Math.random() * pool.length)] : { col: 1, row: 1 };
  }

  /**
   * Start a warp phase on a character: the phase, its timer, and the style it plays in.
   *
   * One place, deliberately — nine sites begin a phase (joins, despawns, both halves of a warp,
   * subagents), and a style resolved at eight of them is a style forgotten at the ninth. It comes
   * from the OWNER's stored preference and never from a message, so every viewer draws the same
   * thing — which also means an agent warps like the account that owns it, the rule its skin
   * already follows.
   */
  private beginWarp(ch: Character, phase: 'spawn' | 'despawn'): void {
    ch.matrixEffect = phase;
    ch.matrixEffectTimer = 0;
    ch.warpStyle = (ch.folderName ? this.warpStylePrefs.get(ch.folderName) : undefined) ?? DEFAULT_WARP_STYLE;
  }

  /** A user's chosen warp style, seeded when a room starts and updated when they change it.
   *  Keyed by the owner name, exactly like `skinPrefs`. */
  setWarpStylePref(folderName: string, style: WarpStyleId): void {
    this.warpStylePrefs.set(folderName, style);
  }

  /** Set a character's owner name (a player's display name; shown as its label). */
  setCharacterName(id: number, name: string): void {
    const ch = this.characters.get(id);
    if (ch) ch.folderName = name;
  }

  /**
   * Remove a player's avatar (immediate; viewers leave abruptly).
   *
   * Releasing the claim is not tidiness: a point is occupied by an *id*, and an id
   * whose character is gone can never release it again — the chair somebody
   * disconnected from stayed occupied by a ghost, so neither an agent nor the
   * player themselves could ever take it again (until the layout was rebuilt, or
   * the server restarted, which is what hid it). A reload is a departure and an
   * arrival in quick succession, so this is also what lets the returning player
   * claim their own seat back (see resumePlayer).
   */
  removePlayer(id: number): void {
    if (this.selectedAgentId === id) this.selectedAgentId = null;
    if (this.cameraFollowId === id) this.cameraFollowId = null;
    const ch = this.characters.get(id);
    if (ch) releasePoint(ch, this.points);
    this.characters.delete(id);
  }

  /** Walk a player's avatar to a tile (viewer click-to-move). A click on a
   *  wall/furniture/blocked-floor tile redirects to the nearest walkable tile
   *  instead of failing outright, so clicking "on" an obstacle walks the
   *  avatar up to it rather than doing nothing. Paths via the shared
   *  pathfinder; returns false if nothing walkable is reachable at all. */
  walkPlayer(id: number, col: number, row: number): boolean {
    const ch = this.humanPawn(id);
    if (!ch) return false;
    // Outside the play area (off the map, or a VOID gap in it) — no-op, not
    // "walk to the nearest real tile". A click ON a real but non-walkable
    // tile (a wall, furniture) still resolves to the nearest walkable spot,
    // same as before — this only rejects clicks that hit no tile at all.
    const clicked = this.tileMap[row]?.[col];
    if (clicked === undefined || clicked === TileType.VOID) return false;
    const target = nearestWalkableTile(col, row, this.tileMap, this.blockedTiles);
    if (!target) return false;
    // Route around tile actions when a detour exists (see computeActionTileKeys)
    // — a plain walk-click shouldn't cut through a meeting room/kiosk/etc. on
    // its way somewhere else, but can still land ON one directly when that's
    // the actual target (its own cost is unavoidable either way).
    const path = findPath(ch.tileCol, ch.tileRow, target.col, target.row, this.tileMap, this.blockedTiles, this.actionTileKeys, this.walls);
    if (path.length === 0) return false;
    ch.heldDir = null; // a click-to-walk target overrides any held WASD direction
    ch.pendingSitFacing = null; // …and cancels a pending click-to-sit
    ch.pendingAction = null; // …and a pending walk-to-action (monitor/kiosk/arcade/…)
    ch.pendingAppliance = null; // …and a pending walk-to-appliance
    ch.afk = false; // moving clears the afk marker
    ch.path = path;
    ch.moveProgress = 0;
    ch.state = CharacterState.WALK;
    ch.frame = 0;
    ch.frameTimer = 0;
    return true;
  }

  /** Right-click "warp": instant teleport to a walkable tile, no walking — the
   *  same despawn→reposition→spawn "Matrix" visual as a disconnect, but the
   *  character is never deleted (see update()'s pendingWarp branch). Strict
   *  walkability: only an exact walkable tile is a valid target, no
   *  nearestWalkableTile snapping like walkPlayer — you can't warp into a
   *  wall. Available to every player (not admin-gated). */
  warpPlayer(id: number, col: number, row: number): boolean {
    const ch = this.humanPawn(id);
    if (!ch) return false;
    if (!isWalkable(col, row, this.tileMap, this.blockedTiles)) return false;
    // Unlike findFreeSpawnTile/findFreeSitPoint (automatic placement, which must
    // never silently drop someone into a call), a warp is the player's own
    // explicit choice of destination — it may land on a meeting-area tile,
    // same as walking there; membership picks it up on the next tick (see
    // updateMeetingRoomMembership).
    if (ch.atPointId) releasePoint(ch, this.points);
    if (ch.homePointId) {
      const home = this.points.get(ch.homePointId);
      if (home && home.occupantId === ch.id) home.occupantId = null;
      ch.homePointId = null;
    }
    ch.heldDir = null;
    ch.pendingSitFacing = null;
    ch.pendingAction = null;
    ch.pendingAppliance = null;
    ch.afk = false;
    ch.path = [];
    ch.bubbleType = null;
    // You arrive on your feet. Releasing the point above frees the chair but says
    // nothing about the pose, so a player who warped while seated stayed in the
    // SIT state and materialised sitting on thin air at the far end — chair-less,
    // still drawn with the seated offset.
    ch.state = CharacterState.IDLE;
    ch.pendingWarp = { col, row };
    if (ch.matrixEffect !== 'despawn') {
      this.beginWarp(ch, 'despawn');
    }
    return true;
  }

  /** Walk a player to a seat tile (chair/bench) and sit there, facing the seat's
   *  direction. Returns false if there's no seat at the tile or it's unreachable.
   *  The seat tile is normally blocked, so it's temporarily unblocked to path. */
  sitPlayerAt(id: number, col: number, row: number): boolean {
    const ch = this.humanPawn(id);
    if (!ch) return false;
    let point: InteractionPoint | undefined;
    for (const p of this.points.values()) {
      if (p.posture === 'sit' && p.col === col && p.row === row) {
        point = p;
        break;
      }
    }
    if (!point) return false;
    // Symmetric occupancy: you cannot sit where somebody else already is. The
    // same rule that stops an agent being sent to a player's chair (see
    // claimPoint) — one occupant per point, whoever asks.
    if (point.occupantId !== null && point.occupantId !== ch.id) return false;
    ch.heldDir = null;
    ch.afk = false; // moving to a seat clears the afk marker
    ch.pendingAction = null; // a click-to-sit cancels a pending walk-to-action
    ch.pendingAppliance = null; // …and a pending walk-to-appliance
    if (ch.tileCol === col && ch.tileRow === row) {
      ch.path = [];
      ch.moveProgress = 0;
      snapToTile(ch);
      ch.dir = point.facingDir;
      ch.state = CharacterState.SIT;
      ch.pendingSitFacing = null;
      // Claiming replaces any appliance claim we held (claimPoint releases the
      // old one), which is what used to be a bare releasePoint here.
      claimPoint(ch, this.points, point.uid);
      return true;
    }
    const key = `${col},${row}`;
    const wasBlocked = this.blockedTiles.has(key);
    if (wasBlocked) this.blockedTiles.delete(key); // allow pathing onto the seat
    const path = findPath(ch.tileCol, ch.tileRow, col, row, this.tileMap, this.blockedTiles, undefined, this.walls);
    if (wasBlocked) this.blockedTiles.add(key);
    if (path.length === 0) return false;
    ch.path = path;
    ch.moveProgress = 0;
    ch.state = CharacterState.WALK;
    ch.pendingSitFacing = point.facingDir; // sit on arrival
    ch.pendingSitPointId = point.uid; // …and take the point then, not now
    return true;
  }

  /** Set (or clear, with null) a player's held WASD direction. Continuous
   *  keyboard walking: while held, the player steps tile-by-tile that way
   *  (validated per step). Abandons any in-flight click-to-walk path. */
  setPlayerDir(id: number, dir: Direction | null): boolean {
    const ch = this.humanPawn(id);
    if (!ch) return false;
    if (dir !== null && ch.state === CharacterState.SIT) ch.state = CharacterState.IDLE; // stand up to move
    if (dir !== null) {
      ch.pendingSitFacing = null; // cancel a walk-to-seat
      ch.pendingAction = null; // …and a walk-to-action
      ch.pendingAppliance = null; // …and a walk-to-appliance
      ch.afk = false; // moving clears the afk marker
    }
    ch.heldDir = dir;
    // Drop a click-to-walk target so the key takes over, but keep the current
    // in-progress step so the avatar isn't stranded mid-tile.
    if (dir !== null && ch.path.length > 1) ch.path = [ch.path[0]];
    return true;
  }

  /** Toggle a player's sit-in-place rest. Sitting clears any movement; standing
   *  returns to idle. Moving (click/WASD) also stands the player up. */
  setPlayerSit(id: number, sit: boolean): boolean {
    const ch = this.humanPawn(id);
    if (!ch) return false;
    if (sit) {
      ch.path = [];
      ch.heldDir = null;
      ch.pendingSitFacing = null;
      ch.pendingAction = null;
      ch.pendingAppliance = null;
      ch.moveProgress = 0;
      snapToTile(ch);
      ch.state = CharacterState.SIT;
      // Sitting down at an appliance's stand tile ends the pose — updatePlayerMovement
      // returns early while SIT, so nothing else would drop the claim.
      releasePoint(ch, this.points);
    } else if (ch.state === CharacterState.SIT) {
      ch.state = CharacterState.IDLE;
    }
    return true;
  }

  /** Toggle (or set) a player's afk marker. Returns the new state, or null if
   *  the id isn't a player. Cleared automatically on movement (see clearAfk). */
  setPlayerAfk(id: number, on?: boolean): boolean | null {
    const ch = this.humanPawn(id);
    if (!ch) return null;
    ch.afk = on ?? !ch.afk;
    return ch.afk;
  }

  /** If a held direction is set, queue a single step to the adjacent tile that
   *  way (when the step is allowed); otherwise just face it.
   *
   *  `canStep`, not `isWalkable`: a wall is an **edge between** two cells, not a
   *  blocked cell (see wallEdges.ts), so both cells either side of it are
   *  perfectly standable and only the crossing is refused. Asking whether the
   *  target tile is walkable therefore let WASD walk straight through every wall
   *  in the game, while click-to-walk — which goes through the same `canStep` in
   *  findPath — respected them. */
  private tryStepHeldDir(ch: Character): void {
    const d = ch.heldDir;
    if (d === null || d === undefined) return;
    const dc = d === Direction.LEFT ? -1 : d === Direction.RIGHT ? 1 : 0;
    const dr = d === Direction.UP ? -1 : d === Direction.DOWN ? 1 : 0;
    const col = ch.tileCol + dc;
    const row = ch.tileRow + dr;
    if (!canStep(ch.tileCol, ch.tileRow, col, row, this.tileMap, this.blockedTiles, this.walls)) {
      ch.dir = d; // face the wall, don't move
      return;
    }
    ch.path = [{ col, row }];
    ch.moveProgress = 0;
  }

  /** Recompute portal trigger tiles from placed furniture whose effective
   *  action is 'portal': only the item's own walkable footprint tiles — you
   *  activate a door/beam pad by standing on it, not by approaching from an
   *  adjacent tile. Portal furniture is non-blocking (backgroundTiles), so
   *  its tile is walkable. */
  private computePortalTiles(): void {
    const tiles = new Set<string>();
    for (const item of this.layout.furniture) {
      const entry = entryFor(item);
      if (!entry || effectiveAction(item, entry)?.kind !== 'portal') continue;
      for (let dr = 0; dr < entry.footprintH; dr++) {
        for (let dc = 0; dc < entry.footprintW; dc++) {
          const fc = item.col + dc;
          const fr = item.row + dr;
          if (isWalkable(fc, fr, this.tileMap, this.blockedTiles)) tiles.add(`${fc},${fr}`);
        }
      }
    }
    this.portalTiles = tiles;
  }

  /** Drain players who reached a furniture action's stand tile this tick —
   *  the room adds 'meetingRoom' arrivals to that room's membership, and
   *  tells the client to open its own local UI for everything else (see
   *  SimRoom.handleActionArrivals). */
  /**
   * Finished fights, waiting to be counted — drained by the room once per tick.
   *
   * The engine does not write to a database (nothing in `shared` does), and the room does not know
   * when a cloud clears. So the outcome is reported the way action arrivals are: pushed here as it
   * happens, taken by whoever owns the storage. One entry per fight, by pet SLOT (`dog_0`), because
   * an instance lives ten minutes and a slot is what a leaderboard names.
   */
  private pendingScuffleResults: Array<{ winner: string; loser: string }> = [];

  takeScuffleResults(): Array<{ winner: string; loser: string }> {
    if (this.pendingScuffleResults.length === 0) return [];
    const out = this.pendingScuffleResults;
    this.pendingScuffleResults = [];
    return out;
  }

  takePendingActionArrivals(): Array<{ id: number; action: Action; col: number; row: number }> {
    if (this.pendingActionArrivals.length === 0) return [];
    const out = this.pendingActionArrivals;
    this.pendingActionArrivals = [];
    return out;
  }

  /** Let the talking objects speak: the hour when it turns, and each piece's
   *  quote when its own wait runs out (see talkingObjects.ts). Costs one
   *  `new Date` and one pass over the talkers per tick — the talkers are derived
   *  layout state, so nothing rescans the furniture 20 times a second, and a
   *  zone with nothing that talks leaves after the date. */
  private tickTalkingObjects(nowMs: number): void {
    const { due, stamp } = announceDue(nowMs, this.lastChimeStamp);
    this.lastChimeStamp = stamp;
    if (this.talkers.length === 0) return;
    if (due) this.spokenLines.push(...hourChimes(this.talkers, nowMs));
    // Two independent clocks: a quote runs on its own 20-to-60-minute wait and
    // is said whatever o'clock that turns out to be (see QuoteSchedule.chimes).
    this.spokenLines.push(...this.quoteSchedule.chimes(this.talkers, nowMs));
  }

  /** Install the quotes talking objects say (see QuoteSchedule). Server-injected
   *  like setPetDecider, and for the same reason: the pool is a file in the repo
   *  and the engine has no business reading one. */
  setQuotes(quotes: readonly string[], rnd?: () => number): void {
    this.quoteSchedule.setQuotes(quotes, rnd);
  }

  /** What the talking objects said this tick (see SpokenLine), emptied by the
   *  read — the room broadcasts them and nothing keeps a history: a bubble is a
   *  moment, and a viewer who was not there has not missed a fact. */
  takeSpokenLines(): SpokenLine[] {
    if (this.spokenLines.length === 0) return [];
    const out = this.spokenLines;
    this.spokenLines = [];
    return out;
  }

  /** Walk a player to one of the walkable tiles around a furniture item's
   *  action (conference monitor, link-manager kiosk, arcade cabinet, iframe
   *  sprite, or a 'meetingRoom' override on plain furniture — see Action),
   *  facing it, then queue the arrival notification. Triggers in place if
   *  already at any approach tile; otherwise picks randomly among the
   *  reachable ones, so simultaneous visitors don't all converge on one
   *  fixed tile. Returns false if there's no CLICK action at that tile (see
   *  isClickAction) or nowhere reachable to stand — appliances go through
   *  useAppliance instead (they use the pre-built station/occupancy system,
   *  not computeApproachTiles), and a talking object is not walked up to at
   *  all. */
  walkPlayerToAction(id: number, anchorCol: number, anchorRow: number): boolean {
    const ch = this.humanPawn(id);
    if (!ch) return false;
    // A tile can carry more than one furniture item (e.g. a cup placed on a
    // table via occupiesSurface) — of the ones a click actually reaches (see
    // isClickAction), prefer whichever renders on top: the higher
    // manual "bring to front" override, then whichever was placed later (the
    // editor convention — you place the base first, decorations on top
    // after; this is also what a Tiled object layer's own list order
    // becomes on import, see docs/design.md).
    // An action-less item on top of an actioned one (e.g. a plain decoration
    // sitting on an actioned desk) does NOT shadow the action underneath —
    // only items that are themselves in the running (have an action) get
    // ranked against each other.
    const candidates = this.layout.furniture.filter((f) => {
      if (f.col !== anchorCol || f.row !== anchorRow) return false;
      return isClickAction(effectiveAction(f, entryFor(f)));
    });
    candidates.sort((a, b) => {
      const aOff = a.zOffset ?? 0;
      const bOff = b.zOffset ?? 0;
      if (aOff !== bOff) return bOff - aOff;
      return this.layout.furniture.indexOf(b) - this.layout.furniture.indexOf(a);
    });
    const item = candidates[0];
    const action = item ? effectiveAction(item, entryFor(item)) : null;
    if (!action) return false;
    const entry = entryFor(item!);
    const fw = entry?.footprintW ?? 1;
    const fh = entry?.footprintH ?? 1;
    ch.heldDir = null;
    ch.pendingSitFacing = null;
    ch.pendingAppliance = null;
    ch.pendingAction = null;

    const approaches = this.computeApproachTiles(anchorCol, anchorRow, fw, fh, item!.approachSides);

    // Strict proximity: you only trigger an action by actually standing at
    // one of its approach tiles (now, or on arrival after walking there). No
    // trigger-in-place fallback from afar.
    const here = approaches.find((a) => a.col === ch.tileCol && a.row === ch.tileRow);
    if (here) {
      ch.dir = here.facing;
      this.pendingActionArrivals.push({ id, action, col: anchorCol, row: anchorRow }); // already there → fire now
      return true;
    }
    if (approaches.length === 0) return false; // no walkable spot at the item → can't reach it
    const reachable = approaches
      .map((a) => ({ a, path: findPath(ch.tileCol, ch.tileRow, a.col, a.row, this.tileMap, this.blockedTiles, undefined, this.walls) }))
      .filter((r) => r.path.length > 0);
    if (reachable.length === 0) return false; // unreachable from here
    const pick = reachable[Math.floor(Math.random() * reachable.length)];
    ch.path = pick.path;
    ch.moveProgress = 0;
    ch.state = CharacterState.WALK;
    ch.pendingAction = { action, col: anchorCol, row: anchorRow, facing: pick.a.facing };
    return true;
  }

  /** Walk a player to one of an appliance's stand tiles (e.g. coffee machine),
   *  facing it, then hold the cosmetic "using it" pose (COFFEE) on arrival —
   *  same atPointId/occupantId claim the agent FSM already uses for pet coffee
   *  breaks (see characters.ts), just started by a click instead of AI. Unlike
   *  a pet's timed break, a player holds the pose indefinitely (stationTimer
   *  stays 0 and never counts down) until they walk away or sit down — see
   *  updatePlayerMovement. Triggers immediately if already standing at ANY of
   *  the appliance's stand tiles; otherwise picks randomly among the free
   *  (unoccupied) reachable ones — falling back to any reachable one if all
   *  are currently occupied — so simultaneous visitors spread out around the
   *  appliance instead of stacking on one fixed tile. Returns false if there's
   *  no appliance at that tile or no stand tile was derivable (buildStations). */
  useAppliance(id: number, anchorCol: number, anchorRow: number): boolean {
    const ch = this.humanPawn(id);
    if (!ch) return false;
    // An appliance can share its tile with the surface it sits on (e.g. a
    // coffee machine placed atop a counter) — match the appliance item
    // specifically (effectiveAction, so an override counts too — see
    // buildStations), not just whatever's first at that tile.
    const item = this.layout.furniture.find(
      (f) => f.col === anchorCol && f.row === anchorRow && effectiveAction(f, entryFor(f))?.kind === 'appliance',
    );
    if (!item) return false;
    const prefix = `station:${item.uid}:`;
    const spots = [...this.points.entries()].filter(([uid]) => uid.startsWith(prefix));
    if (spots.length === 0) return false;
    ch.heldDir = null;
    ch.pendingSitFacing = null;
    ch.pendingAction = null;

    const here = spots.find(([, s]) => s.col === ch.tileCol && s.row === ch.tileRow);
    if (here) {
      const [uid, s] = here;
      ch.dir = s.facingDir;
      ch.atPointId = uid;
      s.occupantId = ch.id;
      ch.atPointTimer = 0; // players hold the pose until they move (no timeout)
      ch.pendingAppliance = null;
      return true;
    }
    const reachable = spots
      .map(([uid, s]) => ({ uid, s, path: findPath(ch.tileCol, ch.tileRow, s.col, s.row, this.tileMap, this.blockedTiles, undefined, this.walls) }))
      .filter((r) => r.path.length > 0);
    if (reachable.length === 0) return false;
    const free = reachable.filter((r) => r.s.occupantId === null);
    const pool = free.length > 0 ? free : reachable;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    ch.path = pick.path;
    ch.moveProgress = 0;
    ch.state = CharacterState.WALK;
    ch.pendingAppliance = { stationUid: pick.uid, facing: pick.s.facingDir };
    return true;
  }

  /** Advance a player's avatar: click-to-walk feeds a path; WASD feeds a held
   *  direction that steps tile-by-tile (chained so it doesn't stutter). */
  private updatePlayerMovement(ch: Character, dt: number): void {
    if (ch.state === CharacterState.SIT) return; // sitting still; movement input stands up
    // A new walk (WASD held-step queued below, or a path already queued by
    // walkPlayer/useAppliance) ends any appliance pose right away — players
    // aren't run through the agent FSM (see the controller branch above), so
    // nothing else would release this claim once they move on.
    if (ch.atPointId && ch.path.length > 0) releasePoint(ch, this.points);
    // Standing at a tile with a key held → begin a step that way.
    if (ch.path.length === 0) this.tryStepHeldDir(ch);

    if (ch.path.length === 0) {
      // Standing still keeps any appliance pose (☕ over the avatar) — unlike an
      // pet's timed coffee break (updateCharacter's IDLE case), a player's claim
      // has no timeout: it's released when they walk away (above) or sit down
      // (sitPlayerAt / setPlayerSit).
      if (ch.state !== CharacterState.IDLE) ch.state = CharacterState.IDLE;
      return; // idle (no portal check here — only fires on arrival, below)
    }
    ch.state = CharacterState.WALK;
    ch.frameTimer += dt;
    stepAlongPath(ch, dt, WALK_SPEED_PX_PER_SEC);
    if (ch.path.length === 0) {
      snapToTile(ch);
      // Chain the next held step so continuous walking has no per-tile idle frame.
      this.tryStepHeldDir(ch);
      if (ch.path.length === 0) {
        if (ch.pendingAction) {
          // Reached a furniture action's stand tile → face it + queue the
          // arrival (room adds us to a 'meetingRoom's membership, or tells
          // us to open our own local UI for anything else — see
          // SimRoom.handleActionArrivals / 'actionReady').
          ch.dir = ch.pendingAction.facing;
          ch.state = CharacterState.IDLE;
          this.pendingActionArrivals.push({ id: ch.id, action: ch.pendingAction.action, col: ch.pendingAction.col, row: ch.pendingAction.row });
          ch.pendingAction = null;
        } else if (ch.pendingAppliance) {
          // Reached an appliance's stand tile → face it, claim it, hold the pose.
          ch.dir = ch.pendingAppliance.facing;
          ch.state = CharacterState.IDLE;
          ch.atPointId = ch.pendingAppliance.stationUid;
          const claimed = this.points.get(ch.pendingAppliance.stationUid);
          if (claimed) claimed.occupantId = ch.id;
          ch.atPointTimer = 0; // held until the player moves away (no timeout)
          ch.pendingAppliance = null;
        } else if (ch.pendingSitFacing !== null && ch.pendingSitFacing !== undefined) {
          // Arrived at a seat (click-to-sit) → sit facing the seat's direction.
          // The point is claimed HERE, not when the walk started: somebody may
          // have taken it in the meantime, and then we just stand there.
          const target = ch.pendingSitPointId ? this.points.get(ch.pendingSitPointId) : undefined;
          const free = !target || target.occupantId === null || target.occupantId === ch.id;
          ch.pendingSitPointId = null;
          if (free) {
            ch.dir = ch.pendingSitFacing;
            ch.state = CharacterState.SIT;
            if (target) claimPoint(ch, this.points, target.uid);
          } else {
            ch.state = CharacterState.IDLE;
          }
          ch.pendingSitFacing = null;
        } else {
          ch.state = CharacterState.IDLE;
          // Came to rest on a portal tile → queue it (room offers a destination
          // picker). Only on arrival/rest, so walking across doesn't spam it.
          if (this.portalTiles.has(`${ch.tileCol},${ch.tileRow}`)) {
            this.pendingActionArrivals.push({ id: ch.id, action: { kind: 'portal' }, col: ch.tileCol, row: ch.tileRow });
          }
          // A tile action other than 'meetingRoom' (which is automatic
          // membership-by-position, tracked separately every tick — see
          // SimRoom's meeting-room membership update) fires once on arrival,
          // same as a portal above.
          const tileAction = this.layout.tileActions?.[ch.tileRow * this.layout.cols + ch.tileCol];
          if (tileAction && tileAction.kind !== 'meetingRoom') {
            this.pendingActionArrivals.push({ id: ch.id, action: tileAction, col: ch.tileCol, row: ch.tileRow });
          }
        }
      }
    }
  }

  /** The sit point at a tile, or null */
  getSeatAtTile(col: number, row: number): string | null {
    for (const [uid, point] of this.points) {
      if (point.posture === 'sit' && point.col === col && point.row === row) return uid;
    }
    return null;
  }

  /** Reassign an agent from their current seat to a new seat */
  reassignSeat(agentId: number, pointId: string): void {
    const ch = this.characters.get(agentId);
    if (!ch) return;
    // Take the new point first — if somebody holds it, nothing changes at all,
    // which is better than releasing the old one and ending up with neither.
    const point = this.points.get(pointId);
    if (!point || point.posture !== 'sit' || (point.occupantId !== null && point.occupantId !== ch.id)) return;
    if (ch.homePointId && ch.homePointId !== pointId) {
      const old = this.points.get(ch.homePointId);
      if (old && old.occupantId === ch.id) old.occupantId = null;
    }
    point.occupantId = ch.id;
    ch.homePointId = pointId;
    // Pathfind to new seat (unblock own seat tile for this query)
    const path = this.withOwnSeatUnblocked(ch, () =>
      findPath(ch.tileCol, ch.tileRow, point.col, point.row, this.tileMap, this.blockedTiles, undefined, this.walls),
    );
    if (path.length > 0) {
      ch.path = path;
      ch.moveProgress = 0;
      ch.state = CharacterState.WALK;
      ch.frame = 0;
      ch.frameTimer = 0;
    } else {
      // Already at seat or no path — sit down
      ch.state = CharacterState.TYPE;
      ch.dir = point.facingDir;
      ch.frame = 0;
      ch.frameTimer = 0;
      if (!ch.isActive) {
        ch.seatTimer = INACTIVE_SEAT_TIMER_MIN_SEC + Math.random() * INACTIVE_SEAT_TIMER_RANGE_SEC;
      }
    }
  }

  /** Send an agent back to their currently assigned seat */
  sendToSeat(agentId: number): void {
    const ch = this.characters.get(agentId);
    if (!ch || !ch.homePointId) return;
    const point = this.points.get(ch.homePointId);
    if (!point) return;
    const path = this.withOwnSeatUnblocked(ch, () =>
      findPath(ch.tileCol, ch.tileRow, point.col, point.row, this.tileMap, this.blockedTiles, undefined, this.walls),
    );
    if (path.length > 0) {
      ch.path = path;
      ch.moveProgress = 0;
      ch.state = CharacterState.WALK;
      ch.frame = 0;
      ch.frameTimer = 0;
    } else {
      // Already at seat — sit down
      ch.state = CharacterState.TYPE;
      ch.dir = point.facingDir;
      ch.frame = 0;
      ch.frameTimer = 0;
      if (!ch.isActive) {
        ch.seatTimer = INACTIVE_SEAT_TIMER_MIN_SEC + Math.random() * INACTIVE_SEAT_TIMER_RANGE_SEC;
      }
    }
  }

  /** Walk an agent to an arbitrary walkable tile (right-click command) */
  walkToTile(agentId: number, col: number, row: number): boolean {
    const ch = this.characters.get(agentId);
    if (!ch || ch.isSubagent) return false;
    if (!isWalkable(col, row, this.tileMap, this.blockedTiles)) {
      // Also allow walking to own seat tile (blocked for others but not self)
      const key = this.ownSeatKey(ch);
      if (!key || key !== `${col},${row}`) return false;
    }
    const path = this.withOwnSeatUnblocked(ch, () =>
      findPath(ch.tileCol, ch.tileRow, col, row, this.tileMap, this.blockedTiles, undefined, this.walls),
    );
    if (path.length === 0) return false;
    ch.path = path;
    ch.moveProgress = 0;
    ch.state = CharacterState.WALK;
    ch.frame = 0;
    ch.frameTimer = 0;
    return true;
  }

  /** Create a sub-agent character with the parent's palette. Returns the sub-agent ID. */
  addSubagent(parentAgentId: number, parentToolId: string): number {
    const key = `${parentAgentId}:${parentToolId}`;
    if (this.subagentIdMap.has(key)) return this.subagentIdMap.get(key)!;

    const id = this.nextSubagentId--;
    const parentCh = this.characters.get(parentAgentId);
    const skin = parentCh ? parentCh.skin : firstSkinId();

    // Find the closest walkable tile to the parent, avoiding tiles occupied by other characters
    const parentCol = parentCh ? parentCh.tileCol : 0;
    const parentRow = parentCh ? parentCh.tileRow : 0;
    const dist = (c: number, r: number) => Math.abs(c - parentCol) + Math.abs(r - parentRow);

    // Build set of tiles occupied by existing characters
    const occupiedTiles = new Set<string>();
    for (const [, other] of this.characters) {
      occupiedTiles.add(`${other.tileCol},${other.tileRow}`);
    }

    let spawn = { col: parentCol, row: parentRow };
    if (this.walkableTiles.length > 0) {
      let closest = this.walkableTiles[0];
      let closestDist = Infinity;
      for (const tile of this.walkableTiles) {
        if (occupiedTiles.has(`${tile.col},${tile.row}`)) continue;
        const d = dist(tile.col, tile.row);
        if (d < closestDist) {
          closest = tile;
          closestDist = d;
        }
      }
      spawn = closest;
    }

    const ch = createCharacter(id, skin, null, null);
    ch.x = spawn.col * TILE_SIZE + TILE_SIZE / 2;
    ch.y = spawn.row * TILE_SIZE + TILE_SIZE / 2;
    ch.tileCol = spawn.col;
    ch.tileRow = spawn.row;
    // Face the same direction as the parent agent
    if (parentCh) ch.dir = parentCh.dir;
    ch.isSubagent = true;
    ch.parentAgentId = parentAgentId;
    // A sub-agent belongs to whoever owns its parent, so it carries the same
    // owner name and is labelled like every other agent avatar.
    if (parentCh?.folderName) ch.folderName = parentCh.folderName;
    this.beginWarp(ch, 'spawn');
    this.characters.set(id, ch);

    this.subagentIdMap.set(key, id);
    this.subagentMeta.set(id, { parentAgentId, parentToolId });
    return id;
  }

  /** Remove a specific sub-agent character and free its seat */
  removeSubagent(parentAgentId: number, parentToolId: string): void {
    const key = `${parentAgentId}:${parentToolId}`;
    const id = this.subagentIdMap.get(key);
    if (id === undefined) return;

    const ch = this.characters.get(id);
    if (ch) {
      if (ch.matrixEffect === 'despawn') {
        // Already despawning — just clean up maps
        this.subagentIdMap.delete(key);
        this.subagentMeta.delete(id);
        return;
      }
      if (ch.homePointId) {
        const home = this.points.get(ch.homePointId);
        if (home && home.occupantId === ch.id) home.occupantId = null;
      }
      // Start despawn animation — keep character in map for rendering
      this.beginWarp(ch, 'despawn');
      ch.bubbleType = null;
    }
    // Clean up tracking maps immediately so keys don't collide
    this.subagentIdMap.delete(key);
    this.subagentMeta.delete(id);
    if (this.selectedAgentId === id) this.selectedAgentId = null;
    if (this.cameraFollowId === id) this.cameraFollowId = null;
  }

  /** Remove all sub-agents belonging to a parent agent */
  removeAllSubagents(parentAgentId: number): void {
    const toRemove: string[] = [];
    for (const [key, id] of this.subagentIdMap) {
      const meta = this.subagentMeta.get(id);
      if (meta && meta.parentAgentId === parentAgentId) {
        const ch = this.characters.get(id);
        if (ch) {
          if (ch.matrixEffect === 'despawn') {
            // Already despawning — just clean up maps
            this.subagentMeta.delete(id);
            toRemove.push(key);
            continue;
          }
          if (ch.homePointId) {
            const home = this.points.get(ch.homePointId);
            if (home && home.occupantId === ch.id) home.occupantId = null;
          }
          // Start despawn animation
          this.beginWarp(ch, 'despawn');
          ch.bubbleType = null;
        }
        this.subagentMeta.delete(id);
        if (this.selectedAgentId === id) this.selectedAgentId = null;
        if (this.cameraFollowId === id) this.cameraFollowId = null;
        toRemove.push(key);
      }
    }
    for (const key of toRemove) {
      this.subagentIdMap.delete(key);
    }
  }

  /** Look up the sub-agent character ID for a given parent+toolId, or null */
  getSubagentId(parentAgentId: number, parentToolId: string): number | null {
    return this.subagentIdMap.get(`${parentAgentId}:${parentToolId}`) ?? null;
  }

  setAgentActive(id: number, active: boolean): void {
    const ch = this.characters.get(id);
    if (ch) {
      ch.isActive = active;
      if (!active) {
        // Sentinel -1: signals turn just ended, skip next seat rest timer.
        // Prevents the WALK handler from setting a 2-4 min rest on arrival.
        ch.seatTimer = -1;
        ch.path = [];
        ch.moveProgress = 0;
      }
      this.rebuildFurnitureInstances();
    }
  }

  /** Every character that currently switches nearby electronics ON by sitting at
   *  them, as `(col, row, facingDir)` of where they sit. Two kinds qualify, and a
   *  human player is deliberately one of them: sitting down at a desk lights its
   *  monitor exactly as an agent's does, which is what a player expects to see.
   *
   *  An agent counts only while its turn is active (an idle agent resting in a
   *  chair leaves the screen dark); a player counts whenever seated, since a
   *  player has no notion of an active turn (`isActive` is false by construction
   *  and `homePointId` — the agent-side reservation — is never assigned to
   *  them, which is why they used to be skipped here entirely). */
  private autoOnSitters(): Array<{ col: number; row: number; dir: Direction }> {
    const out: Array<{ col: number; row: number; dir: Direction }> = [];
    for (const ch of this.characters.values()) {
      if (ch.controller === ControllerKind.HUMAN) {
        if (ch.state === CharacterState.SIT) out.push({ col: ch.tileCol, row: ch.tileRow, dir: ch.dir });
        continue;
      }
      if (!ch.isActive || !ch.homePointId) continue;
      const home = this.points.get(ch.homePointId);
      if (home) out.push({ col: home.col, row: home.row, dir: home.facingDir });
    }
    return out;
  }

  /** Fingerprint of who sits where, facing where — the auto-on input, compared every tick (see
   *  update) so sitting down or standing up switches electronics right away. It is now the ONLY
   *  reason a rebuild happens, which is what makes a still world cost nothing on the wire. */
  private autoOnSignature(): string {
    let sig = '';
    for (const s of this.autoOnSitters()) sig += `${s.col},${s.row},${s.dir}|`;
    return sig;
  }

  /**
   * Rebuild the placement list with the on-state applied: a character seated facing a desk
   * switches its electronics on (see autoOnSitters), and a click-toggle piece stays on until it
   * is clicked again.
   *
   * Reached only by the things that can change that answer — a new layout, a toggle, somebody
   * sitting down or standing up. It used to run five times a second as well, because the ambient
   * animation frame was expressed here as a different art id; that half now lives in the client.
   */
  private rebuildFurnitureInstances(): void {
    this.lastAutoOnSig = this.autoOnSignature();
    // Collect the tiles those sitters face
    const autoOnTiles = new Set<string>();
    for (const sitter of this.autoOnSitters()) {
      // Find the desk tile(s) faced from the seat
      const dCol = sitter.dir === Direction.RIGHT ? 1 : sitter.dir === Direction.LEFT ? -1 : 0;
      const dRow = sitter.dir === Direction.DOWN ? 1 : sitter.dir === Direction.UP ? -1 : 0;
      // Check tiles in the facing direction (desk could be 1-3 tiles deep)
      for (let d = 1; d <= AUTO_ON_FACING_DEPTH; d++) {
        autoOnTiles.add(`${sitter.col + dCol * d},${sitter.row + dRow * d}`);
      }
      // Also check tiles to the sides of the facing direction (desks can be wide)
      for (let d = 1; d <= AUTO_ON_SIDE_DEPTH; d++) {
        const baseCol = sitter.col + dCol * d;
        const baseRow = sitter.row + dRow * d;
        if (dCol !== 0) {
          // Facing left/right: check tiles above and below
          autoOnTiles.add(`${baseCol},${baseRow - 1}`);
          autoOnTiles.add(`${baseCol},${baseRow + 1}`);
        } else {
          // Facing up/down: check tiles left and right
          autoOnTiles.add(`${baseCol - 1},${baseRow}`);
          autoOnTiles.add(`${baseCol + 1},${baseRow}`);
        }
      }
    }

    // Which pieces are on, and the placements with that applied, built in one pass on purpose:
    // the list is what this engine walks, the uids are what a client is told, and a client that
    // reached a different answer would draw a dark monitor at a working desk.
    const on: string[] = [];
    // Return type annotated on the callback, not just on the constant: without
    // it TypeScript infers the callback's own type and a stray property rides
    // along unnoticed. That is exactly how `type: frame` survived here — the
    // field was renamed to `id` in the Tiled migration and these swaps kept
    // writing the old name, so on/off never changed sprite.
    const modifiedFurniture: PlacedFurniture[] = this.layout.furniture.map((item): PlacedFurniture => {
      const entry = entryFor(item);
      if (!entry) return item;
      const onType = resolveOnState(item, entry);
      // Not a state pair at all (a goldfish bowl animates but has no on/off): nothing to switch.
      if (onType === item.id) return item;

      // Manually toggled (click-to-toggle) on/off — independent of seating;
      // only ever set for items carrying the 'toggle' Action (see toggleFurniture).
      if (this.manuallyToggledOn.has(item.uid)) {
        on.push(item.uid);
        return { ...item, id: onType };
      }

      // Auto-on: an active agent seated facing this furniture turns it "on" —
      // only for a seat-driven switchable; a click-toggle item only responds to
      // toggleFurniture(), never to who's sitting nearby.
      if (autoOnTiles.size > 0 && this.isSeatDrivenSwitchable(item, entry)) {
        for (let dr = 0; dr < entry.footprintH; dr++) {
          for (let dc = 0; dc < entry.footprintW; dc++) {
            if (autoOnTiles.has(`${item.col + dc},${item.row + dr}`)) {
              on.push(item.uid);
              return { ...item, id: onType };
            }
          }
        }
      }
      return item;
    });

    this.furniturePlacements = modifiedFurniture;
    this.furnitureOnUids = on.sort();
  }

  /** Flip a click-to-toggle item's on/off state (the 'toggle' Action) — a
   *  literal light-switch. `anchorCol/anchorRow` is the same anchor tile
   *  walkPlayerToAction resolved the action from; re-find the item there
   *  (same candidate rule: the topmost item that actually has an action)
   *  rather than threading its uid through the whole arrival-queue payload.
   *  No-ops if that item has no on-state to flip. */
  toggleFurniture(anchorCol: number, anchorRow: number): void {
    const item = this.layout.furniture.find((f) => {
      if (f.col !== anchorCol || f.row !== anchorRow) return false;
      return effectiveAction(f, entryFor(f))?.kind === 'toggle';
    });
    if (!item || resolveOnState(item, entryFor(item)) === item.id) return;
    if (this.manuallyToggledOn.has(item.uid)) this.manuallyToggledOn.delete(item.uid);
    else this.manuallyToggledOn.add(item.uid);
    this.rebuildFurnitureInstances();
  }

  setAgentTool(id: number, tool: string | null): void {
    const ch = this.characters.get(id);
    if (ch) {
      ch.currentTool = tool;
    }
  }

  showPermissionBubble(id: number): void {
    const ch = this.characters.get(id);
    if (ch) {
      ch.bubbleType = 'permission';
      ch.bubbleTimer = 0;
    }
  }

  clearPermissionBubble(id: number): void {
    const ch = this.characters.get(id);
    if (ch && ch.bubbleType === 'permission') {
      ch.bubbleType = null;
      ch.bubbleTimer = 0;
    }
  }

  showWaitingBubble(id: number): void {
    const ch = this.characters.get(id);
    if (ch) {
      ch.bubbleType = 'waiting';
      ch.bubbleTimer = WAITING_BUBBLE_DURATION_SEC;
    }
  }

  /** Dismiss bubble on click — permission: instant, waiting: quick fade */
  dismissBubble(id: number): void {
    const ch = this.characters.get(id);
    if (!ch || !ch.bubbleType) return;
    if (ch.bubbleType === 'permission') {
      ch.bubbleType = null;
      ch.bubbleTimer = 0;
    } else if (ch.bubbleType === 'waiting') {
      // Trigger immediate fade (0.3s remaining)
      ch.bubbleTimer = Math.min(ch.bubbleTimer, DISMISS_BUBBLE_FAST_FADE_SEC);
    }
  }

  setTeamInfo(
    id: number,
    teamName?: string,
    agentName?: string,
    isTeamLead?: boolean,
    leadAgentId?: number,
    teamUsesTmux?: boolean,
  ): void {
    const ch = this.characters.get(id);
    if (!ch) return;
    ch.teamName = teamName;
    ch.agentName = agentName;
    ch.isTeamLead = isTeamLead;
    ch.leadAgentId = leadAgentId;
    if (teamUsesTmux !== undefined) {
      ch.teamUsesTmux = teamUsesTmux;
    }
  }

  /**
   * Token counters for an agent, clamped on the way in.
   *
   * The feed validates at its own boundary (`agentCount`), and this clamps anyway: these two
   * numbers are the only values in the engine that come from a transcript somebody else wrote, and
   * they end up in a `uint32` on the wire where a wrong TYPE throws at assignment — inside the
   * simulation tick, which is how one quoted number ended a whole server process. A public engine
   * setter that cannot be poisoned is worth four lines.
   */
  setAgentTokens(id: number, inputTokens: number, outputTokens: number): void {
    const ch = this.characters.get(id);
    if (!ch) return;
    ch.inputTokens = agentCount(inputTokens) ?? ch.inputTokens;
    ch.outputTokens = agentCount(outputTokens) ?? ch.outputTokens;
  }

  /**
   * Advance the world by `dt` seconds.
   *
   * `nowMs` is the wall clock, and it is a parameter for the same reason `dt` is
   * one: the only things in here that read a real calendar are the talking
   * objects' hourly announcement and their quote schedule (see
   * talkingObjects.ts), and a test that had to wait for an hour boundary — or
   * for a twenty-minute one — would not be written. Production passes nothing
   * and gets the server's clock — the one clock the whole world shares.
   */
  update(dt: number, nowMs: number = Date.now()): void {
    this.tickTalkingObjects(nowMs);
    // Furniture: the only reason a rebuild can be due is that somebody sat down, stood up or
    // turned in their seat, which switches nearby electronics. The animation clock used to be the
    // other reason and is gone — a frame belongs to the client (invariant 2), and while it lived
    // here it swapped this list five times a second and put the whole map on the wire with it.
    if (this.autoOnSignature() !== this.lastAutoOnSig) {
      this.rebuildFurnitureInstances();
    }

    const toDelete: number[] = [];
    for (const ch of this.characters.values()) {
      // Handle matrix effect animation
      if (ch.matrixEffect) {
        ch.matrixEffectTimer += dt;
        // The ACTIVE style decides how long a phase lasts, and that is why the duration is world
        // state and not the renderer's business: the body is repositioned exactly at this boundary.
        if (ch.matrixEffectTimer >= warpStyle(ch.warpStyle).durationSec) {
          if (ch.matrixEffect === 'spawn') {
            // Spawn complete — clear effect, resume normal FSM
            ch.matrixEffect = null;
            ch.matrixEffectTimer = 0;
            ch.warpStyle = null;
          } else if (ch.pendingWarp) {
            // Despawn half of a warp — reposition, then spawn back in at the
            // new tile (see warpPlayer). Never deleted, unlike a real leave.
            ch.tileCol = ch.pendingWarp.col;
            ch.tileRow = ch.pendingWarp.row;
            ch.x = ch.pendingWarp.col * TILE_SIZE + TILE_SIZE / 2;
            ch.y = ch.pendingWarp.row * TILE_SIZE + TILE_SIZE / 2;
            ch.pendingWarp = null;
            // Arrive facing the viewer. A warp keeps the same Character, so
            // without this you materialise still facing whatever way you last
            // walked before stepping into the portal — often away from the
            // camera, which reads as arriving with your back turned. A freshly
            // joined player already starts DOWN (see createCharacter).
            ch.dir = Direction.DOWN;
            this.beginWarp(ch, 'spawn');
          } else {
            // Despawn complete — mark for deletion
            toDelete.push(ch.id);
          }
        }
        continue; // skip normal FSM while effect is active
      }

      // ── Controller dispatch ────────────────────────────────────────────────────────────
      // One place decides who moves this pawn, and every kind is named. It was an `if` on a
      // boolean, which is the same thing for two controllers and nothing at all for three: a
      // fourth (a humanoid whose behaviour the world invents) is a case here and a value in
      // ControllerKind, and nowhere else.
      if (ch.controller === ControllerKind.HUMAN) {
        // Viewer-driven: no FSM, just advance along whatever path the input commanded.
        this.updatePlayerMovement(ch, dt);
        continue;
      }
      if (ch.controller !== ControllerKind.AGENT) {
        // NONE (nobody claimed this pawn) or a controller this build does not know. Running the
        // agent FSM on it would be the wrong default — an unclaimed pawn would start wandering
        // off to fetch coffee — so it holds still and says so once.
        this.warnUnclaimedPawn(ch.controller);
        continue;
      }

      // Maybe head off for a coffee break (idle, inactive agents only).
      this.maybeStartCoffeeBreak(ch, dt);

      // Temporarily unblock own seat so character can pathfind to it
      this.withOwnSeatUnblocked(ch, () =>
        updateCharacter(
          ch,
          dt,
          this.walkableTiles,
          this.points,
          this.tileMap,
          this.blockedTiles,
          this.walls,
        ),
      );

      // Tick bubble timer for waiting bubbles
      if (ch.bubbleType === 'waiting') {
        ch.bubbleTimer -= dt;
        if (ch.bubbleTimer <= 0) {
          ch.bubbleType = null;
          ch.bubbleTimer = 0;
        }
      }
    }
    // Remove characters that finished despawn
    for (const id of toDelete) {
      this.characters.delete(id);
    }

    this.updatePets(dt);
  }

  getCharacters(): Character[] {
    return Array.from(this.characters.values());
  }

  /** A single character by id, or undefined. */
  getCharacter(id: number): Character | undefined {
    return this.characters.get(id);
  }

  getPets(): Pet[] {
    return Array.from(this.pets.values());
  }

  /** Inject the pet decision fn (server's mistreevous brain). It receives the
   *  pet and a cheap world-affordance snapshot. Clears with null. */
  setPetDecider(fn: ((pet: Pet, affordances: PetAffordances) => PetAction) | null): void {
    this.petDecide = fn ?? undefined;
  }

  /** Cheap, pathfinding-free snapshot of what a pet could interact with now, fed
   *  to the brain so it picks a sensible action. Reachability is confirmed later
   *  by findFreePetTarget; this only checks existence so it's cheap per tick. */
  private computePetAffordances(pet: Pet): PetAffordances {
    // Per-variant behaviour switches (editable; default all-on). A flag with nothing to apply to
    // is inert on its own: emptying a row in CHASES leaves that kind's `chase` switched on and
    // hunting nobody, which is what a permission does when there is nothing to permit. Today's
    // table is a ring, so every kind has both a quarry and a hunter.
    const b = getPetConfig(pet.kind, pet.variant).behaviors;
    return {
      canRest: b.rest && this.hasRestAffordance(pet),
      // Who hunts whom comes from one table, and fleeing is the same table read backwards — see
      // chaseQuarryFor / hunterNear, which are the same two questions the walking interrupt asks.
      canChase: this.chaseQuarryFor(pet) !== null,
      threatened: this.hunterNear(pet) !== null,
      // A pet uses the appliances pets may use — a fountain or a bowl, never a coffee machine —
      // and only if the map has one. None placed, no visit: the absence is the answer, not a
      // special case. Which of the two it lands at decides what it does there (see APPLIANCES).
      canDrink: b.feedDrink && this.hasFreeAppliance(APPLIANCES_FOR.pet),
      // Talk: any kind may approach an agent that no other pet is chatting with.
      canTalk: b.talk && this.hasTalkableAgent(),
    };
  }

  /** Any non-subagent, non-despawning agent not already claimed for a chat. */
  private hasTalkableAgent(): boolean {
    for (const ch of this.characters.values()) {
      if (ch.isSubagent || ch.matrixEffect === 'despawn') continue;
      if (!this.petTalkClaims.has(ch.id)) return true;
    }
    return false;
  }

  /** First walkable tile orthogonally adjacent to (col,row), facing back toward
   *  it — a stand spot beside an agent. */
  private adjacentApproach(col: number, row: number): { col: number; row: number; facing: Direction } | null {
    const around = [
      { col, row: row - 1, facing: Direction.DOWN },
      { col, row: row + 1, facing: Direction.UP },
      { col: col - 1, row, facing: Direction.RIGHT },
      { col: col + 1, row, facing: Direction.LEFT },
    ];
    for (const a of around) {
      if (isWalkable(a.col, a.row, this.tileMap, this.blockedTiles)) return a;
    }
    return null;
  }

  /** A free seat or a free pet perch (a `petCanSitOn` item with at least one
   *  column clear of whatever else is standing on it) exists somewhere — any pet
   *  may rest on either. Cheap: no pathfinding (reachability is confirmed later
   *  by findFreePetTarget). */
  private hasRestAffordance(_pet: Pet): boolean {
    for (const point of this.points.values()) {
      if (point.posture === 'sit' && point.occupantId === null) return true;
    }
    const occupied = this.occupiedSurfaceTiles();
    const unavailable = this.petUnavailableFurniture();
    for (const item of this.layout.furniture) {
      const entry = entryFor(item);
      if (!entry || !resolvePetCanSitOn(item, entry)) continue;
      if (unavailable.has(item.uid)) continue;
      if (this.freeDeskRestColumn(item, entry, occupied) !== null) return true;
    }
    return false;
  }

  /**
   * "col,row" → the uids of every item solidly standing there, so a pet's
   * would-be perch can be tested for "is something else already on this spot".
   *
   * This used to enumerate the KINDS of thing that could be in the way — the
   * 'electronics' category, plus anything flagged `occupiesSurface` — which
   * meant a mapper putting some third kind of object on a desk got a pet
   * sitting inside it. A monitor and a flower pot are in the way for the same
   * reason, which is that they are there.
   *
   * Background rows don't count (same rule as getBlockedTiles): a painting hung
   * on the wall behind a desk overlaps the desk's top row without occupying it,
   * and never blocked a perch before.
   */
  private occupiedSurfaceTiles(): Map<string, Set<string>> {
    return this.surfaceUids;
  }

  /**
   * Build the three layout-derived tables in one pass over the placements.
   *
   * `footprintUids` covers every cell a piece occupies, `surfaceUids` the same minus its
   * background rows — the two questions that were asked with two loops. One pass, because both
   * walk the same footprints and the difference is where the row loop starts.
   *
   * `spawnablePool` is the walkable tiles outside any meeting area, which is what
   * `findFreeSpawnTile` used to filter for on every join (the engine deliberately never spawns
   * anybody standing in a walk-in meeting area). The empty-pool fallback is baked in here rather
   * than left to the caller, so there is one answer to "where may somebody appear".
   */
  private layoutDerived(): void {
    const footprint = new Map<string, Set<string>>();
    const surface = new Map<string, Set<string>>();
    const add = (into: Map<string, Set<string>>, key: string, uid: string): void => {
      let uids = into.get(key);
      if (!uids) {
        uids = new Set();
        into.set(key, uids);
      }
      uids.add(uid);
    };
    for (const item of this.layout.furniture) {
      const entry = entryFor(item);
      if (!entry) continue;
      const bgRows = resolveBackgroundTiles(item, entry);
      for (let dr = 0; dr < entry.footprintH; dr++) {
        for (let dc = 0; dc < entry.footprintW; dc++) {
          const key = `${item.col + dc},${item.row + dr}`;
          add(footprint, key, item.uid);
          if (dr >= bgRows) add(surface, key, item.uid);
        }
      }
    }
    this.footprintUids = footprint;
    this.surfaceUids = surface;
    const outside = this.walkableTiles.filter((t) => this.areaIdAt(t.col, t.row) === null);
    this.spawnablePool = outside.length > 0 ? outside : this.walkableTiles;
  }

  /** First column of this perch with nothing else standing on it, as a rest spot
   *  anchored on the item's BOTTOM footprint row (so it depth-sorts in front of
   *  the sprite) plus the lift that raises the pet onto the surface. Null if
   *  every column is taken. Pure existence check — no reachability. */
  private freeDeskRestColumn(
    item: PlacedFurniture,
    entry: { footprintW: number; footprintH: number; height: number },
    occupied: Map<string, Set<string>>,
  ): { col: number; row: number; lift: number } | null {
    const bottomRow = item.row + entry.footprintH - 1;
    for (let dc = 0; dc < entry.footprintW; dc++) {
      let columnFree = true;
      for (let dr = 0; dr < entry.footprintH; dr++) {
        // The perch covers its own tiles, so "occupied" means somebody ELSE is
        // standing here too.
        const uids = occupied.get(`${item.col + dc},${item.row + dr}`);
        if (uids && [...uids].some((uid) => uid !== item.uid)) {
          columnFree = false;
          break;
        }
      }
      if (!columnFree) continue;
      // A perch's sprite is exactly footprintH tiles tall, so lifting by the
      // part above the bottom row (spriteH − one tile) lands the pet on top.
      return { col: item.col + dc, row: bottomRow, lift: entry.height - TILE_SIZE };
    }
    return null;
  }

  /**
   * The quarry this pet may hunt right now, or null — the switch is on, the cooldown is spent, and
   * something its species hunts is within shoo range.
   *
   * One place, because two callers ask it: the affordance handed to the brain at a decision point,
   * and the interrupt that lets a WALKING pet notice what it passes. Two copies of this would be
   * two places to forget the cooldown.
   */
  private chaseQuarryFor(pet: Pet): Pet | null {
    const b = getPetConfig(pet.kind, pet.variant).behaviors;
    if (!b.chase || pet.chaseCooldown > 0) return null;
    const quarry = this.nearestLivingPetOfKinds(pet, CHASES[pet.kind]);
    // A quarry that has just scuffled is not available, and it is hidden from the hunter's INTENT
    // and not merely from the catch: a dog running after a cat it cannot possibly catch is a
    // chase with no ending, which is exactly the shape of the bug this replaces.
    return quarry && this.catchable(quarry) ? quarry : null;
  }

  /**
   * May this pet be caught right now?
   *
   * Three ways to be off limits, and each was a way the old code produced a fight that never
   * ended: it is already in a cloud, it is in the BEAT after one (the state is `WIN`/`LOSE` there,
   * not `SCUFFLE`, so the old check missed it and a second hunter could grab the loser while its
   * badge was still up — measured as clouds every 1-2 seconds against a cloud-plus-beat of 2.7),
   * or its cooldown is still running.
   */
  private catchable(pet: Pet): boolean {
    if (pet.state === PetState.SCUFFLE || pet.state === PetState.WIN || pet.state === PetState.LOSE) return false;
    return pet.chaseCooldown <= 0;
  }

  /** The hunter this pet should run from right now, or null. `fleesFrom` derives the kinds. */
  private hunterNear(pet: Pet): Pet | null {
    const b = getPetConfig(pet.kind, pet.variant).behaviors;
    if (!b.flee) return null;
    return this.nearestLivingPetOfKinds(pet, fleesFrom(pet.kind));
  }

  /**
   * What a walking pet should drop everything for, with the path to do it — or null.
   *
   * Running away wins over hunting, the same order the behaviour tree uses at a decision point:
   * being prey is the more urgent fact about your situation than being hungry.
   */
  private reactionOpportunity(pet: Pet): { action: NonNullable<Pet['reaction']>; path: Array<{ col: number; row: number }> } | null {
    const action: Pet['reaction'] = this.hunterNear(pet) ? 'flee' : this.chaseQuarryFor(pet) ? 'chase' : null;
    if (!action) return null;
    const path = this.navigatePetReaction(pet, action);
    return path && path.length > 0 ? { action, path } : null;
  }

  /**
   * Catch a quarry, and keep every cloud a PAIR.
   *
   * Here rather than in `updatePet` because it is the only question in the pet FSM that needs two
   * animals at once — the same reason `nearestLivingPetOfKinds` lives here. Runs once per tick, not
   * once per pet.
   *
   * The catch condition is deliberately narrow: the hunter must be ACTIVELY chasing. A dog that
   * happens to wander past a sitting cat does not start a brawl, or the world would be nothing but
   * clouds; what earns one is having pursued and cornered.
   */
  private resolveScuffles(): void {
    // Pairs first: a partner that despawned, aged out or was deleted leaves one animal standing
    // invisible behind a cloud the renderer will not draw (it needs both ends to place one).
    // A pair is "in a scuffle" for the cloud AND for the beat that follows it: the loser's retreat
    // reads the partner id, so a WIN/LOSE pet still has one and must still be checked.
    const paired = (p: Pet): boolean =>
      p.state === PetState.SCUFFLE || p.state === PetState.WIN || p.state === PetState.LOSE;
    for (const pet of this.pets.values()) {
      if (!paired(pet)) continue;
      const partner = pet.scufflePartnerId === null ? undefined : this.pets.get(pet.scufflePartnerId);
      if (!partner || !paired(partner) || partner.scufflePartnerId !== pet.id) {
        endScuffleAlone(pet);
      }
    }

    for (const hunter of this.pets.values()) {
      if (hunter.reaction !== 'chase' || hunter.state === PetState.SCUFFLE) continue;
      // The cooldown belongs HERE as well as in the affordance, and that is not belt and braces:
      // the affordance only advises the brain, so anything that makes a pet chase anyway — another
      // decider, a test, a future controller — would otherwise re-catch the same quarry on the tick
      // after a cloud cleared, which is the endless loop of clouds the cooldown exists to prevent.
      if (hunter.chaseCooldown > 0) continue;
      const quarry = this.nearestLivingPetOfKinds(hunter, CHASES[hunter.kind], PET_CATCH_RADIUS_TILES);
      // One question, asked in one place (`catchable`): already in a cloud, still in the beat after
      // one, or still cooling down. A scuffle is a pair, so a second dog joining would need a third
      // partner id and there is nothing to point it at.
      if (!quarry || !this.catchable(quarry)) continue;
      // Order matters now: beginScuffle rolls the outcome in the hunter's favour.
      beginScuffle(hunter, quarry);
    }
  }

  /** Nearest non-despawning pet of any of `kinds` within `radius` tiles (Chebyshev
   *  distance) of `pet`, or null. Used for chase/flee detection and for the catch. */
  private nearestLivingPetOfKinds(pet: Pet, kinds: readonly PetKindEnum[], radius = PET_SHOO_RADIUS_TILES): Pet | null {
    // An empty relation costs nothing to answer, and this runs per pet per tick — so answer
    // before walking the collection. Today's ring gives every kind one quarry and one hunter, but
    // the relation is DATA: a row emptied in CHASES is one word away, and this is the guard that
    // keeps it cheap rather than a scan that finds nothing.
    if (kinds.length === 0) return null;
    let best: Pet | null = null;
    let bestDist = radius + 1;
    for (const other of this.pets.values()) {
      if (other.id === pet.id || !kinds.includes(other.kind)) continue;
      if (other.state === PetState.SPAWN || other.state === PetState.DESPAWN) continue;
      const dist = Math.max(Math.abs(other.tileCol - pet.tileCol), Math.abs(other.tileRow - pet.tileRow));
      if (dist <= radius && dist < bestDist) {
        best = other;
        bestDist = dist;
      }
    }
    return best;
  }

  /**
   * A retreat away from ONE named pet — the animal that just won the cloud.
   *
   * Separate from the 'flee' reaction on purpose: that one runs from whatever this SPECIES flees,
   * and a cat that lost to a bird flees no bird by species. Losing is about who beat you, not about
   * what your kind is afraid of.
   */
  private fleePathFrom(pet: Pet, otherId: number | null): Array<{ col: number; row: number }> | null {
    const other = otherId === null ? undefined : this.pets.get(otherId);
    if (!other) return null;
    return this.pathAwayFrom(pet, other);
  }

  /**
   * Reactive movement path: a hunter paths toward its nearest quarry ('chase'); the quarry paths
   * to a reachable tile that increases its distance from the nearest hunter ('flee'). Which kinds
   * those are comes from `CHASES` in both cases. Returns null when no useful path exists.
   *
   * **Who the other animal is comes from the same two questions the intent does** —
   * `chaseQuarryFor` and `hunterNear`, not a second call to `nearestLivingPetOfKinds`. This is
   * asked on the re-aim cadence for a chase already running, and it used to skip both filters, so
   * a hunter kept pursuing a quarry that had just fought and could not be caught for 90 seconds:
   * `catchable` hid it from the hunter's INTENT while this path handed it a route to it twice a
   * second. AGENTS.md states the rule the other way round — a dog running after a cat it cannot
   * possibly catch is a chase with no ending — and an in-flight chase is not an exception to it.
   * The flee half goes through `hunterNear` for the same reason, which adds only its `flee`
   * switch: fleeing is deliberately NOT gated by the cooldown, because being unavailable for a
   * brawl is not the same as feeling safe.
   *
   * The consequence to expect rather than debug: a chase now ENDS the moment its quarry becomes
   * protected, instead of following it around until it leaves the shoo radius.
   */
  private navigatePetReaction(pet: Pet, action: PetAction): Array<{ col: number; row: number }> | null {
    if (action === 'chase') {
      const quarry = this.chaseQuarryFor(pet);
      if (!quarry) return null;
      // Bounded in STEPS, like the flee half — see PET_CHASE_RANGE_TILES for why 15 and not 10.
      // A quarry five tiles away behind a wall used to cost a search of the whole walkable
      // component, twice a second, and then the hunter walked a route it could never finish.
      const path = findPath(
        pet.tileCol,
        pet.tileRow,
        quarry.tileCol,
        quarry.tileRow,
        this.tileMap,
        this.blockedTiles,
        undefined,
        this.walls,
        PET_CHASE_RANGE_TILES,
      );
      return path.length > 0 ? path : null;
    }
    if (action === 'flee') {
      const hunter = this.hunterNear(pet);
      return hunter ? this.pathAwayFrom(pet, hunter) : null;
    }
    return null;
  }

  /**
   * A reachable tile that puts more distance between `pet` and `from`, and the path to it.
   *
   * One implementation, two callers: the 'flee' reaction (away from whatever the species flees) and
   * the loser's retreat after a cloud (away from the animal that beat it). It was inline in the
   * reaction before; a second copy for the retreat is a second place to get the range wrong.
   *
   * Measured at 172 µs per call over the real uponu map (2634 walkable tiles), asked once every
   * PET_REACTION_REPATH_SEC per fleeing animal. The cost was in three places, and this addresses
   * all three:
   *
   *  • **A straight dash needs no pathfinder at all.** An animal running away runs AWAY — so try
   *    stepping directly, using `canStep` — the pathfinder's own per-step predicate, so a dash
   *    cannot cross a wall edge that an A* would have refused. One short A* was 50 µs; a
   *    seven-step dash is a handful of array reads. In open floor — the common case — the answer is now free, and it is also the more
   *    natural picture: a cat bolts, it does not compute an optimal route around the sofa.
   *  • **When the dash IS blocked, one bounded flood fill replaces a guess plus a search.** The
   *    old shape filtered all 2634 walkable tiles, sorted them by distance from the hunter and
   *    asked A* whether the best eight were reachable — and an A* that cannot reach its target is
   *    the most expensive one there is, because it exhausts everything it can reach before saying
   *    no. A BFS bounded to the flee range in STEPS gives reachability and the route together:
   *    428 µs for that case, down to about 30.
   *
   * What the fast path gives up is optimality: where the straight line is blocked after two steps
   * it takes those two steps instead of routing seven tiles around the obstacle. That is not a
   * regression in behaviour but a shorter hop, and the reaction re-aims half a second later from
   * wherever it got to — which is what that cadence is for. When the dash cannot move at all (a
   * corner, a wall in the face) the search below runs, and being cornered is exactly when it
   * matters that it does.
   */
  private pathAwayFrom(pet: Pet, from: Pet): Array<{ col: number; row: number }> | null {
    const dist = (c: number, r: number): number => Math.max(Math.abs(c - from.tileCol), Math.abs(r - from.tileRow));
    const cur = dist(pet.tileCol, pet.tileRow);

    // ── the dash ────────────────────────────────────────────────────────────
    // Only a step along an axis that currently DETERMINES the Chebyshev distance increases it: a
    // pet directly east of its hunter gets no farther by walking north. So the candidate axes are
    // the ones whose delta equals the distance — one of them normally, both when the two stand
    // diagonally, and both when they share a tile (distance 0, any direction is away).
    const dc = Math.sign(pet.tileCol - from.tileCol) || 1;
    const dr = Math.sign(pet.tileRow - from.tileRow) || 1;
    const axes: Array<[number, number]> = [];
    // The heading it is ALREADY running along comes first, as long as it still works. Without that
    // memory this function recomputed the best answer from scratch twice a second, and in a
    // confined space the best answer alternates as the hunter moves: measured in an 8x8 room, a cat
    // visited nine tiles in forty seconds and reversed direction thirteen times — the "both of them
    // running up and down" that started this. An animal that has decided to run keeps running.
    const held = pet.fleeHeading;
    if (held && dist(pet.tileCol + held.dc, pet.tileRow + held.dr) > cur) axes.push([held.dc, held.dr]);
    // And it does not double back. The memory alone was not enough: the moment the held heading is
    // blocked — a wall, a corner — the next choice could be its exact opposite, and then the animal
    // ping-pongs between two tiles. Measured in the 8x8 room: 21 reversals out of 21 samples
    // before, and still a median of 11 with the memory alone. Forbidding the reverse makes the
    // pattern impossible, and it has a second effect worth having: a genuinely cornered animal runs
    // out of directions instead of oscillating, stops fleeing, and gets caught — a chase that
    // RESOLVES rather than one that loops until somebody despawns.
    const reverse = held ? { dc: -held.dc, dr: -held.dr } : null;
    const allowed = (stepC: number, stepR: number): boolean =>
      !reverse || !(stepC === reverse.dc && stepR === reverse.dr);
    if (Math.abs(pet.tileCol - from.tileCol) === cur && allowed(dc, 0)) axes.push([dc, 0]);
    if (Math.abs(pet.tileRow - from.tileRow) === cur && allowed(0, dr)) axes.push([0, dr]);
    for (const [stepC, stepR] of axes) {
      const dash: Array<{ col: number; row: number }> = [];
      let col = pet.tileCol;
      let row = pet.tileRow;
      for (let i = 0; i < PET_FLEE_RANGE_TILES; i++) {
        const nextCol = col + stepC;
        const nextRow = row + stepR;
        // `canStep` is the pathfinder's OWN per-step predicate (walkable target, no wall edge
        // crossed), so a dash cannot go anywhere an A* would refuse — and it derives `cols` from
        // the tile map itself, which is one fewer thing to pass wrongly.
        if (!canStep(col, row, nextCol, nextRow, this.tileMap, this.blockedTiles, this.walls)) break;
        dash.push({ col: nextCol, row: nextRow });
        col = nextCol;
        row = nextRow;
      }
      if (dash.length > 0) {
        pet.fleeHeading = { dc: stepC, dr: stepR };
        return dash;
      }
    }

    // ── cornered: one bounded flood fill, not a guess plus a search ─────────
    // The dash is blocked, so the way out bends. This used to pick the tiles farthest from the
    // hunter and ask A* whether each was reachable — which is the wrong way round twice over: a
    // guessed target is often unreachable, and an A* that CANNOT reach its target is the most
    // expensive kind, because it exhausts everything it can reach before saying no (measured: 428 µs
    // for the cornered case, against 50 µs for a short path that exists).
    //
    // A flood fill answers reachability and the route in one pass, and it is bounded by the flee
    // range in STEPS rather than in straight-line distance — "how far can I get in seven steps",
    // which is also the more honest reading of a frightened animal. At most a few hundred tiles are
    // visited, no matter how the map is shaped.
    const cols = this.layout.cols;
    const startIdx = pet.tileRow * cols + pet.tileCol;
    const prev = new Map<number, number>([[startIdx, -1]]);
    const depth = new Map<number, number>([[startIdx, 0]]);
    const queue: number[] = [startIdx];
    let bestIdx = -1;
    let bestD = cur;
    for (let head = 0; head < queue.length; head++) {
      const idx = queue[head];
      const col = idx % cols;
      const row = (idx - col) / cols;
      const d = dist(col, row);
      // Farther than where we started, and the closest such tile wins ties: a short escape is a
      // faster escape, and the reaction re-aims in half a second anyway.
      if (d > bestD) {
        bestD = d;
        bestIdx = idx;
      }
      const steps = depth.get(idx)!;
      if (steps >= PET_FLEE_RANGE_TILES) continue;
      for (const { dc: dCol, dr: dRow } of DIRS_4) {
        // The detour may not START by doubling back either — same reason as the dash above. Only
        // the FIRST step is restricted: once the animal is on its way, a bend is a bend.
        if (steps === 0 && !allowed(dCol, dRow)) continue;
        const nextCol = col + dCol;
        const nextRow = row + dRow;
        const nextIdx = nextRow * cols + nextCol;
        if (prev.has(nextIdx)) continue;
        if (!canStep(col, row, nextCol, nextRow, this.tileMap, this.blockedTiles, this.walls)) continue;
        prev.set(nextIdx, idx);
        depth.set(nextIdx, steps + 1);
        queue.push(nextIdx);
      }
    }
    if (bestIdx < 0) return null;
    // Walk the parents back and hand the path over the way findPath does: start excluded, end
    // included.
    const path: Array<{ col: number; row: number }> = [];
    for (let idx = bestIdx; idx !== startIdx; idx = prev.get(idx)!) {
      const col = idx % cols;
      path.push({ col, row: (idx - col) / cols });
    }
    path.reverse();
    if (path.length === 0) return null;
    // The first step of the detour becomes the remembered heading, so once the bend is taken the
    // animal keeps going that way instead of reconsidering half a second later.
    pet.fleeHeading = { dc: Math.sign(path[0].col - pet.tileCol), dr: Math.sign(path[0].row - pet.tileRow) };
    return path;
  }

  // ── Pet lifecycle ─────────────────────────────────────────

  /** Number of connected agents (real agents, excluding sub-agents & despawning). */
  getConnectedAgentCount(): number {
    let n = 0;
    for (const ch of this.characters.values()) {
      if (ch.id > 0 && !ch.isSubagent && ch.controller === ControllerKind.AGENT && ch.matrixEffect !== 'despawn') n++;
    }
    return n;
  }

  /** Tick spawning, the per-pet FSM, and deletion of finished despawns. */
  private updatePets(dt: number): void {
    const ctx = {
      walkableTiles: this.walkableTiles,
      tileMap: this.tileMap,
      blockedTiles: this.blockedTiles,
      walls: this.walls,
      findTarget: (pet: Pet, action: PetAction) => this.findFreePetTarget(pet, action),
      releaseClaim: (pet: Pet) => this.releasePetClaim(pet),
      // Wrap the injected brain so it receives a fresh affordance snapshot; left
      // undefined when no brain is set so the actuator uses its sit-chance roll.
      decideAction: this.petDecide
        ? (pet: Pet) => this.petDecide!(pet, this.computePetAffordances(pet))
        : undefined,
      navigateReaction: (pet: Pet, action: PetAction) => this.navigatePetReaction(pet, action),
      noticeReaction: (pet: Pet) => this.reactionOpportunity(pet),
      fleeFrom: (pet: Pet, otherId: number | null) => this.fleePathFrom(pet, otherId),
      // Spec-driven frame advance: cycle within the current pose track's real
      // length (resolved from the pet's sheet), so server and client agree and
      // longer custom tracks aren't truncated by a hardcoded modulo.
      posePlaybackLength: (pet: Pet) => getPetPosePlaybackLength(pet.kind, pet.variant, petPose(pet)),
    };

    this.resolveScuffles();

    const toDelete: number[] = [];
    for (const pet of this.pets.values()) {
      // The transition SCUFFLE → WIN happens exactly once per fight and only for the winner, which
      // makes it the one place a result can be recorded without counting it twice. Read here rather
      // than inside the FSM because the loser's SLOT has to be looked up, and only OfficeState can
      // see the other animal.
      const wasFighting = pet.state === PetState.SCUFFLE;
      updatePet(pet, dt, ctx);
      if (wasFighting && pet.state === PetState.WIN) {
        const loser = pet.scufflePartnerId === null ? undefined : this.pets.get(pet.scufflePartnerId);
        if (loser) {
          this.pendingScuffleResults.push({
            winner: `${pet.kind}_${pet.variant}`,
            loser: `${loser.kind}_${loser.variant}`,
          });
        }
      }
      if (pet.state === PetState.DESPAWN && pet.effectTimer >= PET_EFFECT_DURATION_SEC) {
        toDelete.push(pet.id);
      }
    }
    for (const id of toDelete) {
      const pet = this.pets.get(id);
      if (pet) this.releasePetClaim(pet);
      this.pets.delete(id);
    }

    // Per-pet-variant spawning (lifespan despawn frees slots).
    this.tickPetSpawns(dt);
  }

  /** Each active pet variant spawns up to its `maxConcurrent` on its own random
   *  interval [minSec, maxSec]. Independent of agent count (config-driven). */
  private tickPetSpawns(dt: number): void {
    if (this.walkableTiles.length === 0) return;
    // Living instances per `${kind}_${variant}`.
    const living = new Map<string, number>();
    for (const p of this.pets.values()) {
      if (p.state === PetState.DESPAWN) continue;
      const k = `${p.kind}_${p.variant}`;
      living.set(k, (living.get(k) ?? 0) + 1);
    }
    // Every kind there is, read from the enum rather than listed here: the third one was renamed
    // from `duck` to `bird` (a category, so an owl needs no fourth value), and a hardcoded list is
    // exactly the place that gets forgotten when a fourth one does arrive.
    for (const name of Object.values(PetKindEnum)) {
      const count = getLoadedPetVariantCount(name);
      for (let v = 0; v < count; v++) {
        const key = `${name}_${v}`;
        const cfg = getPetConfig(name, v);
        // Globally active AND enabled for this zone (per-zone pet config).
        if (!cfg.active || !this.petSpawnFilter(name as PetKind, v)) {
          this.petSpawnTimers.delete(key); // re-staggers when reactivated
          continue;
        }
        let t = this.petSpawnTimers.get(key);
        if (t === undefined) t = randomRange(0, cfg.maxSec); // stagger first spawn
        t -= dt;
        if (t <= 0) {
          if ((living.get(key) ?? 0) < cfg.maxConcurrent) {
            this.spawnPetVariant(name as PetKind, v);
            living.set(key, (living.get(key) ?? 0) + 1);
          }
          t = randomRange(cfg.minSec, cfg.maxSec);
        }
        this.petSpawnTimers.set(key, t);
      }
    }
  }

  /** Spawn a specific pet variant at a free walkable tile. */
  private spawnPetVariant(kind: PetKind, variant: number): void {
    if (this.walkableTiles.length === 0) return;
    const occupied = new Set<string>();
    for (const ch of this.characters.values()) occupied.add(`${ch.tileCol},${ch.tileRow}`);
    for (const p of this.pets.values()) occupied.add(`${p.tileCol},${p.tileRow}`);
    const free = this.walkableTiles.filter((t) => !occupied.has(`${t.col},${t.row}`));
    const pool = free.length > 0 ? free : this.walkableTiles;
    const spawn = pool[Math.floor(Math.random() * pool.length)];

    const id = this.nextPetId++;
    this.pets.set(id, createPet(id, kind, variant, spawn));
  }

  /** Trigger early despawn for a specific pet (e.g. cleared externally). */
  despawnPet(id: number): void {
    const pet = this.pets.get(id);
    if (pet) beginPetDespawn(pet, { releaseClaim: (p) => this.releasePetClaim(p) });
  }

  /** Restrict which pet variants spawn in this zone (per-zone config). Also
   *  despawns any currently-living pets that the new filter disallows, so a
   *  change takes effect immediately. */
  setPetSpawnFilter(fn: (kind: PetKind, variant: number) => boolean): void {
    this.petSpawnFilter = fn;
    for (const p of this.pets.values()) {
      if (p.state !== PetState.DESPAWN && !fn(p.kind as PetKind, p.variant)) this.despawnPet(p.id);
    }
  }

  // ── Pet furniture interaction ─────────────────────────────

  /** Release a pet's seat/furniture/station claim. */
  private releasePetClaim(pet: Pet): void {
    if (pet.targetSeatId) this.petSeatClaims.delete(pet.targetSeatId);
    if (pet.targetFurnitureUid) {
      this.petFurnitureClaims.delete(pet.targetFurnitureUid);
    }
    if (pet.targetStationId) {
      this.petStationClaims.delete(pet.targetStationId);
    }
    if (pet.targetAgentId !== null) {
      this.petTalkClaims.delete(pet.targetAgentId);
    }
  }

  /** Whether a non-chair furniture item is free for a pet to approach. */
  /**
   * The furniture a pet may NOT perch on: claimed by another pet, or in use by an agent actively
   * seated facing it.
   *
   * Asked ONCE per decision and read as a set, which is the whole point. It used to be
   * `isFurnitureFreeForPet(uid)` called per perchable placement, and each call looped every
   * character and re-found the placement with a linear `find` — placements × characters ×
   * placements, plus a footprint Set allocated per pair. Measured on uponu: one call cost 1.1 µs
   * with a single agent and **102 µs with 300**, and the two loops that ask it walk 21 perches.
   * Turning the question round makes it one pass over the characters instead: the tiles a seat
   * faces are known, and `footprintUids` says who is standing on them.
   */
  private petUnavailableFurniture(): Set<string> {
    const out = new Set<string>(this.petFurnitureClaims);
    for (const ch of this.characters.values()) {
      if (!ch.isActive || !ch.homePointId) continue;
      const point = this.points.get(ch.homePointId);
      if (!point) continue;
      const dCol = point.facingDir === Direction.RIGHT ? 1 : point.facingDir === Direction.LEFT ? -1 : 0;
      const dRow = point.facingDir === Direction.DOWN ? 1 : point.facingDir === Direction.UP ? -1 : 0;
      for (let d = 1; d <= AUTO_ON_FACING_DEPTH; d++) {
        const uids = this.footprintUids.get(`${point.col + dCol * d},${point.row + dRow * d}`);
        if (uids) for (const uid of uids) out.add(uid);
      }
    }
    return out;
  }

  /**
   * Find + claim a free interaction target reachable from the pet for `action`:
   *  - 'sit'  → any free chair seat, or a free desk surface column (no computer
   *             or coffee mug on it) the pet rests on top of — any kind
   *  - 'drink' → a free WATER bowl (never a coffee machine), any kind
   * Returns the claimed target (with a path), or null.
   *
   * **It picks first and paths once.** It used to path EVERY candidate and pick at random from
   * the reachable ones — one full BFS per free seat, per perch, per station, per unclaimed agent,
   * i.e. O(candidates × area) and the only term quadratic in map area. `pickReachable` (pets.ts)
   * probes at most `PET_TARGET_PATH_TRIES` of them, uniformly. Measured on uponu: a 'sit' decision
   * offers 101 candidates and cost **38.3 ms of pathing, now 0.29 ms** — against a 50 ms tick
   * budget and a whole tick of 0.066 ms. The numbers per branch are in `PET_TARGET_PATH_TRIES`.
   *
   * What that trades away, deliberately: the choice used to be uniform over REACHABLE candidates
   * and is now uniform over candidates with retry — the same distribution whenever probes
   * succeed, and a give-up on a map whose walkable floor is genuinely split into islands. The FSM
   * already has that outcome: `hasRestAffordance` advertises seats WITHOUT checking reachability,
   * and a null from here has always fallen through to a random wander with a 1.5-8 s re-decide.
   * If islands ever make it visible, the fix is one component flood fill per decision — one
   * search whatever the candidate count, the same insight `pathAwayFrom` is built on — not a
   * search per candidate again.
   */
  private findFreePetTarget(pet: Pet, action: PetAction): PetTarget | null {
    const specs = this.petTargetSpecs(pet, action);
    if (specs.length === 0) return null;
    const picked = pickReachable(specs, PET_TARGET_PATH_TRIES, (spec) => this.pathToPetTargetTile(pet, spec));
    if (!picked) return null;
    // Claimed once, for the chosen candidate only — so a decision that finds nothing reachable
    // leaves no seat, station, agent or desk marked as taken by a pet that never went.
    this.claimPetTarget(picked.candidate);
    return { ...picked.candidate, path: picked.path };
  }

  /** Every target of `action` this pet could take, by the cheap tests alone — free, unclaimed,
   *  of the right kind. Reachability is deliberately NOT among them: that is what costs a search,
   *  and `findFreePetTarget` asks it for the few candidates it actually considers. */
  private petTargetSpecs(pet: Pet, action: PetAction): PetTargetSpec[] {
    const specs: PetTargetSpec[] = [];

    // Water bowls — stand on the bowl's tile. A pet never uses a coffee machine, and the
    // `appliance === 'water'` test is also what keeps it off seats: this loop used to walk every
    // point in the map, so a "drinking" pet could claim a desk chair and block an agent from it.
    if (action === 'drink') {
      for (const [uid, s] of this.points) {
        if (!s.appliance || !APPLIANCES_FOR.pet.includes(s.appliance)) continue;
        if (s.occupantId !== null || this.petStationClaims.has(uid)) continue;
        specs.push({
          kind: 'station',
          action: 'drink',
          seatId: null,
          furnitureUid: null,
          stationId: uid,
          appliance: s.appliance,
          agentId: null,
          sitCol: s.col,
          sitRow: s.row,
          facing: s.facingDir,
          restLift: 0,
        });
      }
    }

    // Agents (talk) — stand on a walkable tile beside an un-claimed agent.
    if (action === 'talk') {
      for (const ch of this.characters.values()) {
        if (ch.isSubagent || ch.matrixEffect === 'despawn') continue;
        if (this.petTalkClaims.has(ch.id)) continue;
        const approach = this.adjacentApproach(ch.tileCol, ch.tileRow);
        if (!approach) continue;
        specs.push({
          kind: 'agent',
          action: 'talk',
          seatId: null,
          furnitureUid: null,
          stationId: null,
          agentId: ch.id,
          sitCol: approach.col,
          sitRow: approach.row,
          facing: approach.facing,
          restLift: 0,
        });
      }
    }

    // Chairs (the same sit points characters use).
    if (action === 'sit') {
      for (const [uid, point] of this.points) {
        if (point.posture !== 'sit') continue;
        if (point.occupantId !== null || this.petSeatClaims.has(uid)) continue;
        specs.push({
          kind: 'seat',
          action: 'sit',
          seatId: uid,
          furnitureUid: null,
          stationId: null,
          agentId: null,
          sitCol: point.col,
          sitRow: point.row,
          facing: point.facingDir,
          restLift: 0,
        });
      }
    }

    // Desks/tables — rest ON the surface, but only on a column with no computer
    // or coffee mug. Anchor on the desk's bottom row (so the pet depth-sorts in
    // front of the desk) and carry the lift that raises it onto the surface.
    if (action === 'sit') {
      const occupied = this.occupiedSurfaceTiles();
      const unavailable = this.petUnavailableFurniture();
      for (const item of this.layout.furniture) {
        const entry = entryFor(item);
        if (!entry || !resolvePetCanSitOn(item, entry)) continue;
        if (unavailable.has(item.uid)) continue;
        const spot = this.freeDeskRestColumn(item, entry, occupied);
        if (!spot) continue;
        specs.push({
          kind: 'furniture',
          action: 'sit',
          seatId: null,
          furnitureUid: item.uid,
          stationId: null,
          agentId: null,
          sitCol: spot.col,
          sitRow: spot.row,
          // Face the viewer while lounging on the desk top.
          facing: Direction.DOWN,
          restLift: spot.lift,
        });
      }
    }

    return specs;
  }

  /**
   * The route from the pet to one candidate's tile — `[]` when it is already standing there,
   * null when it cannot get there. That distinction is `pickReachable`'s contract, and it is why
   * this returns null rather than an empty array for a failure.
   *
   * The destination tile is unblocked for the search, uniformly for all four kinds. Two of them
   * (a chair seat, a desk perch) sit on a tile that is blocked for WALKING — which is what the
   * two hand-rolled delete/restore dances this replaced were for; for the other two the unblock
   * is a no-op, because their tile is walkable by construction.
   */
  private pathToPetTargetTile(pet: Pet, spec: PetTargetSpec): Array<{ col: number; row: number }> | null {
    if (pet.tileCol === spec.sitCol && pet.tileRow === spec.sitRow) return [];
    const path = this.withTileUnblocked(`${spec.sitCol},${spec.sitRow}`, () =>
      findPath(pet.tileCol, pet.tileRow, spec.sitCol, spec.sitRow, this.tileMap, this.blockedTiles, undefined, this.walls),
    );
    return path.length > 0 ? path : null;
  }

  /** Mark the chosen target as taken, so agents and other pets won't take it. */
  private claimPetTarget(spec: PetTargetSpec): void {
    if (spec.kind === 'seat' && spec.seatId) {
      this.petSeatClaims.add(spec.seatId);
    } else if (spec.kind === 'station' && spec.stationId) {
      this.petStationClaims.add(spec.stationId);
    } else if (spec.kind === 'agent' && spec.agentId !== null) {
      this.petTalkClaims.add(spec.agentId);
    } else if (spec.furnitureUid) {
      this.petFurnitureClaims.add(spec.furnitureUid);
    }
  }

  /** Get character at pixel position (for hit testing). Returns id or null. */
  getCharacterAt(worldX: number, worldY: number): number | null {
    const chars = this.getCharacters().sort((a, b) => b.y - a.y);
    for (const ch of chars) {
      // Skip characters that are despawning
      if (ch.matrixEffect === 'despawn') continue;
      // Character sprite is 16x24, anchored bottom-center
      // Apply sitting offset to match visual position
      const sittingOffset = ch.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET_PX : 0;
      const anchorY = ch.y + sittingOffset;
      const left = ch.x - CHARACTER_HIT_HALF_WIDTH;
      const right = ch.x + CHARACTER_HIT_HALF_WIDTH;
      const top = anchorY - CHARACTER_HIT_HEIGHT;
      const bottom = anchorY;
      if (worldX >= left && worldX <= right && worldY >= top && worldY <= bottom) {
        return ch.id;
      }
    }
    return null;
  }
}

function randomRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}
