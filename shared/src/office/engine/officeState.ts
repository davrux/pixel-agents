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
  FURNITURE_ANIM_INTERVAL_SEC,
  HUE_SHIFT_MIN_DEG,
  HUE_SHIFT_RANGE_DEG,
  INACTIVE_SEAT_TIMER_MIN_SEC,
  INACTIVE_SEAT_TIMER_RANGE_SEC,
  PET_EFFECT_DURATION_SEC,
  PET_FLEE_RANGE_TILES,
  PET_SHOO_RADIUS_TILES,
  WAITING_BUBBLE_DURATION_SEC,
  WALK_SPEED_PX_PER_SEC,
} from '../constants.js';
import { isPlayerAvatarSkin } from '../../protocol.js';
import { effectiveAction, getAnimationFrames, getCatalogEntry, getOnStateType } from '../layout/furnitureCatalog.js';
import {
  createDefaultLayout,
  getBlockedFloorTiles,
  getBlockedTiles,
  layoutToFurnitureInstances,
  layoutToSeats,
  layoutToTileMap,
} from '../layout/layoutSerializer.js';
import { findPath, getWalkableTiles, isWalkable, nearestWalkableTile } from '../layout/tileMap.js';
import { buildActionByTile, actionAreaTileKeys, meetingAreaAt as findMeetingAreaAt } from '../layout/actionAreas.js';
import {
  firstSkinId,
  getSkinIds,
  getLoadedPetVariantCount,
  getNpcConfig,
  getNpcPosePlaybackLength,
} from '../sprites/spriteData.js';
import type {
  Action,
  ActionArea,
  Character,
  FurnitureInstance,
  InteractionPoint,
  OfficeLayout,
  Pet,
  PetKind,
  PlacedFurniture,
  Seat,
  TileGid as TileTypeVal,
} from '../types.js';
import {
  CharacterState,
  Direction,
  MATRIX_EFFECT_DURATION,
  PetKind as PetKindEnum,
  PetState,
  TILE_SIZE,
} from '../types.js';
import { isVoid, isWall } from '../tileGid.js';
import { createCharacter, releaseStation, updateCharacter } from './characters.js';
import { snapToTile, stepAlongPath } from './entity.js';
import { matrixEffectSeeds } from './matrixEffect.js';
import type { NpcAction, NpcAffordances, PetTarget } from './pets.js';
import { beginPetDespawn, createPet, petPose, updatePet } from './pets.js';

/** Union of every source of non-walkable tiles: furniture footprints and
 *  areas the layout itself marks blocked (layout.blockedAreas, independent of
 *  floor pattern). The single Set isWalkable checks. */
function computeBlockedTiles(layout: OfficeLayout): Set<string> {
  return new Set([...getBlockedTiles(layout.furniture), ...getBlockedFloorTiles(layout)]);
}

export class OfficeState {
  layout: OfficeLayout;
  tileMap: TileTypeVal[][];
  seats: Map<string, Seat>;
  /** Standing interaction points derived from appliances (coffee machine, …). */
  stations: Map<string, InteractionPoint> = new Map();
  blockedTiles: Set<string>;
  /** "col,row" of every tile covered by an ActionArea — see actionAreaTileKeys.
   *  Only walkPlayer's plain click-to-move consults this (a soft detour cost
   *  in findPath, not a hard block); NPC wandering, seats, and appliance/
   *  action approach paths ignore it entirely. */
  private actionTileKeys: Set<string>;
  /** "col,row" → Action, built once per layout (re)build (see
   *  buildActionByTile) — O(1) lookup for the per-character arrival check
   *  in updatePlayerMovement, instead of scanning layout.actionAreas per call. */
  private actionByTile: Map<string, Action>;
  furniture: FurnitureInstance[];
  /** Current furniture placements after auto-on/animation (server syncs these). */
  furniturePlacements: PlacedFurniture[] = [];
  walkableTiles: Array<{ col: number; row: number }>;
  characters: Map<number, Character> = new Map();
  /** Accumulated time for furniture animation frame cycling */
  furnitureAnimTimer = 0;
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

  // ── Pets ──────────────────────────────────────────────────
  /** Live pets, keyed by a dedicated id space (disjoint from characters). */
  pets: Map<number, Pet> = new Map();
  /** Non-chair furniture uids currently claimed by a pet. */
  private petFurnitureClaims: Set<string> = new Set();
  /** Appliance-station uids currently claimed by a pet (mutually exclusive with
   *  an agent's `occupantId` claim on the same station). */
  private petStationClaims: Set<string> = new Set();
  /** Agent ids a pet is currently talking to (one pet per agent at a time). */
  private petTalkClaims: Set<number> = new Set();
  /** Per-NPC-variant spawn countdown (seconds), keyed by `${kind}_${variant}`. */
  private petSpawnTimers = new Map<string, number>();
  /** Which NPC variants may spawn in this room/zone (per-zone config). Default:
   *  all. Set by the room from the zone's `npc` setting. */
  private npcSpawnFilter: (kind: PetKind, variant: number) => boolean = () => true;
  private nextPetId = 1_000_000;
  /** Player avatar ids live in their own band (agents use Claude ids, subagents
   *  negative, pets 1_000_000+). */
  private nextPlayerId = 2_000_000;
  /** Tiles that trigger a zone portal (derived from placed `portal` furniture:
   *  the walkable footprint tiles + their walkable neighbours), and player ids
   *  that just stepped on one (drained by the room → destination picker). */
  private portalTiles: Set<string> = new Set();
  private pendingPortals: number[] = [];
  /** Players who reached a furniture action's stand tile (walk-then-
   *  trigger), drained by the room — see takePendingActionArrivals /
   *  walkPlayerToAction / SimRoom.handleActionArrivals. */
  private pendingActionArrivals: Array<{ id: number; action: Action; col: number; row: number }> = [];
  /** Optional server-injected NPC decision fn (the mistreevous brain). When set,
   *  it chooses a pet's idle activity; otherwise the engine's built-in roll runs. */
  private npcDecide?: (pet: Pet, affordances: NpcAffordances) => NpcAction;

  constructor(layout?: OfficeLayout) {
    this.layout = layout || createDefaultLayout();
    this.tileMap = layoutToTileMap(this.layout);
    this.seats = layoutToSeats(this.layout.furniture);
    this.blockedTiles = computeBlockedTiles(this.layout);
    this.actionTileKeys = actionAreaTileKeys(this.layout);
    this.actionByTile = buildActionByTile(this.layout);
    this.furniture = layoutToFurnitureInstances(this.layout.furniture);
    this.walkableTiles = getWalkableTiles(this.tileMap, this.blockedTiles);
    this.buildStations();
    this.computePortalTiles();
  }

  /** Rebuild all derived state from a new layout. Reassigns existing characters.
   *  @param shift Optional pixel shift to apply when grid expands left/up */
  rebuildFromLayout(layout: OfficeLayout, shift?: { col: number; row: number }): void {
    // Pets hold seat/furniture/tile claims that won't survive a layout rebuild.
    // Drop them outright; they respawn naturally from the spawn loop.
    this.pets.clear();
    this.petFurnitureClaims.clear();
    this.petStationClaims.clear();
    this.petTalkClaims.clear();

    this.layout = layout;
    this.tileMap = layoutToTileMap(layout);
    this.seats = layoutToSeats(layout.furniture);
    this.blockedTiles = computeBlockedTiles(layout);
    this.actionTileKeys = actionAreaTileKeys(layout);
    this.actionByTile = buildActionByTile(layout);
    this.rebuildFurnitureInstances();
    this.walkableTiles = getWalkableTiles(this.tileMap, this.blockedTiles);

    // Station uids are regenerated; drop stale claims on every character.
    this.buildStations();
    this.computePortalTiles();
    for (const ch of this.characters.values()) {
      ch.stationId = null;
      ch.stationTimer = 0;
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

    // Reassign characters to new seats, preserving existing assignments when possible
    for (const seat of this.seats.values()) {
      seat.assigned = false;
    }

    // First pass: try to keep characters at their existing seats
    for (const ch of this.characters.values()) {
      if (ch.seatId && this.seats.has(ch.seatId)) {
        const seat = this.seats.get(ch.seatId)!;
        if (!seat.assigned) {
          seat.assigned = true;
          // Snap character to seat position
          ch.tileCol = seat.seatCol;
          ch.tileRow = seat.seatRow;
          const cx = seat.seatCol * TILE_SIZE + TILE_SIZE / 2;
          const cy = seat.seatRow * TILE_SIZE + TILE_SIZE / 2;
          ch.x = cx;
          ch.y = cy;
          ch.dir = seat.facingDir;
          continue;
        }
      }
      ch.seatId = null; // will be reassigned below
    }

    // Second pass: assign remaining characters to free seats
    for (const ch of this.characters.values()) {
      if (ch.seatId) continue;
      const seatId = this.findFreeSeat();
      if (seatId) {
        this.seats.get(seatId)!.assigned = true;
        ch.seatId = seatId;
        const seat = this.seats.get(seatId)!;
        ch.tileCol = seat.seatCol;
        ch.tileRow = seat.seatRow;
        ch.x = seat.seatCol * TILE_SIZE + TILE_SIZE / 2;
        ch.y = seat.seatRow * TILE_SIZE + TILE_SIZE / 2;
        ch.dir = seat.facingDir;
      }
    }

    // Relocate any characters that ended up outside bounds or on non-walkable tiles
    for (const ch of this.characters.values()) {
      if (ch.seatId) continue; // seated characters are fine
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

  /** The meeting-room ActionArea (if any) a tile belongs to — see
   *  meetingAreaAt. The room re-derives each character's area from this every
   *  tick (SimRoom's meeting-area membership tracking); nothing here is
   *  cached per-character. The area's own `id`/`col`/`row` (stable across
   *  edits unless the rect itself is moved/resized) is what SimRoom keys
   *  membership on — see SimRoom.updateMeetingRoomMembership. */
  meetingAreaAt(col: number, row: number): ActionArea | null {
    return findMeetingAreaAt(this.layout, col, row);
  }

  /** Walkable tiles minus any meeting area — nobody should ever spawn/land
   *  standing in a walk-in meeting area (it would auto-join them into a call
   *  before they've even chosen anything). Falls back to the unrestricted
   *  walkable set if meeting areas somehow cover the whole map, so a spawn
   *  is never simply impossible. */
  private spawnableTiles(): Array<{ col: number; row: number }> {
    const pool = this.walkableTiles.filter((t) => this.meetingAreaAt(t.col, t.row) === null);
    return pool.length > 0 ? pool : this.walkableTiles;
  }

  /** Get the blocked-tile key for a character's own seat, or null */
  private ownSeatKey(ch: Character): string | null {
    if (!ch.seatId) return null;
    const seat = this.seats.get(ch.seatId);
    if (!seat) return null;
    return `${seat.seatCol},${seat.seatRow}`;
  }

  /** Temporarily unblock a character's own seat, run fn, then re-block */
  private withOwnSeatUnblocked<T>(ch: Character, fn: () => T): T {
    const key = this.ownSeatKey(ch);
    if (key) this.blockedTiles.delete(key);
    const result = fn();
    if (key) this.blockedTiles.add(key);
    return result;
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
   *  one side isn't walkable at all. */
  private computeApproachTiles(
    col: number,
    row: number,
    w: number,
    h: number,
    facing?: Direction,
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
      const neighborGid = this.tileMap[wallRow]?.[col + dc];
      if (neighborGid === undefined || !isWall(neighborGid)) wallMounted = false;
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
    // The art-side approach faces DOWN (toward the wall from the north); the
    // far-side approach faces UP (toward the wall from the south) — see the
    // cands table below. Default (facing unset) keeps the engine's
    // long-standing far-side default.
    const wantFacing = facing ?? Direction.UP;
    const seen = new Set<string>();
    const approaches: Array<{ col: number; row: number; facing: Direction }> = [];
    for (let dr = 0; dr < h; dr++) {
      for (let dc = 0; dc < w; dc++) {
        const fc = col + dc;
        const fr = row + dr;
        const cands: Array<[number, number, Direction, 'N' | 'S' | 'E' | 'W']> = [
          [fc, fr - 1, Direction.DOWN, 'N'],
          [fc, fr + 1, Direction.UP, 'S'],
          [fc - 1, fr, Direction.RIGHT, 'W'],
          [fc + 1, fr, Direction.LEFT, 'E'],
        ];
        for (const [nc, nr, approachFacing, side] of cands) {
          if (restrict && !restrict.includes(side)) continue;
          const k = `${nc},${nr}`;
          const inFoot = nc >= col && nc < col + w && nr >= row && nr < row + h;
          // Ambiguous case: reject the whole wrong side, not just the tile
          // directly above/below the footprint — a *lateral* neighbor of the
          // sprite's own body row (e.g. standing beside a narrow cabinet, at
          // the same height as its screen) is on the art side exactly as much
          // as the tile straight above it, and both must lose equally to
          // whichever side `facing` actually picked.
          if (ambiguous && nr < wallRow && wantFacing !== Direction.DOWN) continue;
          if (ambiguous && nr > wallRow && wantFacing !== Direction.UP) continue;
          if (seen.has(k) || inFoot || !isWalkable(nc, nr, this.tileMap, this.blockedTiles)) continue;
          seen.add(k);
          approaches.push({ col: nc, row: nr, facing: approachFacing });
        }
      }
    }
    return approaches;
  }

  /** One standing point PER walkable tile adjacent to each appliance (not just
   *  the first) — so multiple visitors spread out around it instead of
   *  stacking on a single fixed tile. findFreeStation() already picks randomly
   *  among every free entry across every appliance, so registering more
   *  entries per appliance is all that's needed for that to also randomize
   *  position around one single appliance. */
  private buildStations(): void {
    this.stations = new Map();
    for (const item of this.layout.furniture) {
      const entry = getCatalogEntry(item.type);
      if (!entry) continue;
      // effectiveAction, not the raw catalog flag — an item's own Action
      // override (the editor's Action… button) must be able to turn ANY
      // furniture into a station, not just ones the catalog itself flags.
      if (effectiveAction(item, entry)?.kind !== 'appliance') continue;
      const spots = this.computeApproachTiles(item.col, item.row, entry.footprintW, entry.footprintH, item.facing, item.approachSides).filter(
        (c) => !this.isStationTile(c.col, c.row),
      );
      spots.forEach((spot, i) => {
        const uid = `station:${item.uid}:${i}`;
        this.stations.set(uid, {
          uid,
          col: spot.col,
          row: spot.row,
          facingDir: spot.facing,
          posture: 'stand',
          station: 'appliance',
          furnitureType: item.type,
          occupantId: null,
        });
      });
    }
  }

  private isStationTile(col: number, row: number): boolean {
    for (const s of this.stations.values()) {
      if (s.col === col && s.row === row) return true;
    }
    return false;
  }

  private findFreeStation(): string | null {
    const free: string[] = [];
    for (const [uid, s] of this.stations) {
      if (s.occupantId === null && !this.petStationClaims.has(uid)) free.push(uid);
    }
    if (free.length === 0) return null;
    return free[Math.floor(Math.random() * free.length)];
  }

  /** Any appliance station free for a pet to claim (cheap existence check). */
  private hasFreeStation(): boolean {
    for (const [uid, s] of this.stations) {
      if (s.occupantId === null && !this.petStationClaims.has(uid)) return true;
    }
    return false;
  }

  /** Occasionally send an idle, inactive agent to stand at a free appliance. */
  private maybeStartCoffeeBreak(ch: Character, dt: number): void {
    if (ch.coffeeCooldown > 0) ch.coffeeCooldown -= dt;
    // Only when idle, off the clock, not already on a break, and standing still.
    if (ch.isActive || ch.stationId || ch.state !== CharacterState.IDLE) return;
    if (ch.path.length > 0 || ch.coffeeCooldown > 0 || this.stations.size === 0) return;
    if (Math.random() >= COFFEE_BREAK_CHANCE) return;

    const uid = this.findFreeStation();
    if (!uid) return;
    const station = this.stations.get(uid)!;
    const path = this.withOwnSeatUnblocked(ch, () =>
      findPath(ch.tileCol, ch.tileRow, station.col, station.row, this.tileMap, this.blockedTiles),
    );

    // Reserve the station and head over (start the cooldown regardless).
    station.occupantId = ch.id;
    ch.stationId = uid;
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
      ch.stationTimer =
        COFFEE_STAND_MIN_SEC + Math.random() * (COFFEE_STAND_MAX_SEC - COFFEE_STAND_MIN_SEC);
    }
  }

  private findFreeSeat(): string | null {
    // Build set of tiles occupied by electronics (PCs, monitors, etc.)
    const electronicsTiles = new Set<string>();
    for (const item of this.layout.furniture) {
      const entry = getCatalogEntry(item.type);
      if (!entry || entry.category !== 'electronics') continue;
      for (let dr = 0; dr < entry.footprintH; dr++) {
        for (let dc = 0; dc < entry.footprintW; dc++) {
          electronicsTiles.add(`${item.col + dc},${item.row + dr}`);
        }
      }
    }

    // Collect free seats, split into those facing electronics and the rest
    const pcSeats: string[] = [];
    const otherSeats: string[] = [];
    for (const [uid, seat] of this.seats) {
      if (seat.assigned) continue;

      // Check if this seat faces electronics (same logic as auto-state detection)
      let facesPC = false;
      const dCol =
        seat.facingDir === Direction.RIGHT ? 1 : seat.facingDir === Direction.LEFT ? -1 : 0;
      const dRow = seat.facingDir === Direction.DOWN ? 1 : seat.facingDir === Direction.UP ? -1 : 0;
      for (let d = 1; d <= AUTO_ON_FACING_DEPTH && !facesPC; d++) {
        const tileCol = seat.seatCol + dCol * d;
        const tileRow = seat.seatRow + dRow * d;
        if (electronicsTiles.has(`${tileCol},${tileRow}`)) {
          facesPC = true;
          break;
        }
        if (dCol !== 0) {
          if (
            electronicsTiles.has(`${tileCol},${tileRow - 1}`) ||
            electronicsTiles.has(`${tileCol},${tileRow + 1}`)
          ) {
            facesPC = true;
            break;
          }
        } else {
          if (
            electronicsTiles.has(`${tileCol - 1},${tileRow}`) ||
            electronicsTiles.has(`${tileCol + 1},${tileRow}`)
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
   * Pick a diverse palette for a new agent based on currently active agents.
   * First 6 agents each get a unique skin (random order). Beyond 6, skins
   * repeat in balanced rounds with a random hue shift (≥45°).
   */
  private pickDiverseSkin(): { skin: string; hueShift: number } {
    // Count how many non-sub-agents use each loaded skin id.
    const ids = getSkinIds();
    if (ids.length === 0) return { skin: firstSkinId(), hueShift: 0 };
    const counts = new Map<string, number>(ids.map((id) => [id, 0]));
    for (const ch of this.characters.values()) {
      if (ch.isSubagent) continue;
      if (counts.has(ch.skin)) counts.set(ch.skin, (counts.get(ch.skin) ?? 0) + 1);
    }
    const minCount = Math.min(...counts.values());
    // Available = skins at the minimum count (least used).
    const available = ids.filter((id) => counts.get(id) === minCount);
    const skin = available[Math.floor(Math.random() * available.length)];
    // First round (minCount === 0): no hue shift. Subsequent rounds: random ≥45°.
    let hueShift = 0;
    if (minCount > 0) {
      hueShift = HUE_SHIFT_MIN_DEG + Math.floor(Math.random() * HUE_SHIFT_RANGE_DEG);
    }
    return { skin, hueShift };
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
      const pick = this.pickDiverseSkin();
      ch.skin = pick.skin;
      ch.hueShift = pick.hueShift;
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
        const pick = this.pickDiverseSkin();
        ch.skin = pick.skin;
        ch.hueShift = pick.hueShift;
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
        ch.hueShift = 0;
      }
    }
  }

  addAgent(
    id: number,
    preferredSkin?: string,
    preferredHueShift?: number,
    preferredSeatId?: string,
    skipSpawnEffect?: boolean,
    folderName?: string,
  ): void {
    if (this.characters.has(id)) return;

    let skin: string;
    let hueShift: number;
    const pref = folderName ? this.skinPrefs.get(folderName) : undefined;
    if (preferredSkin !== undefined) {
      skin = preferredSkin;
      hueShift = preferredHueShift ?? 0;
    } else if (pref !== undefined) {
      // The viewer pinned a character for this user → always use it.
      skin = pref;
      hueShift = 0;
    } else {
      const pick = this.pickDiverseSkin();
      skin = pick.skin;
      hueShift = pick.hueShift;
    }

    // Try preferred seat first, then any free seat
    let seatId: string | null = null;
    if (preferredSeatId && this.seats.has(preferredSeatId)) {
      const seat = this.seats.get(preferredSeatId)!;
      if (!seat.assigned) {
        seatId = preferredSeatId;
      }
    }
    if (!seatId) {
      seatId = this.findFreeSeat();
    }

    let ch: Character;
    if (seatId) {
      const seat = this.seats.get(seatId)!;
      seat.assigned = true;
      ch = createCharacter(id, skin, seatId, seat, hueShift);
    } else {
      // No seats — spawn at a random walkable tile (never inside a meeting area).
      const pool = this.spawnableTiles();
      const spawn = pool.length > 0 ? pool[Math.floor(Math.random() * pool.length)] : { col: 1, row: 1 };
      ch = createCharacter(id, skin, null, null, hueShift);
      ch.x = spawn.col * TILE_SIZE + TILE_SIZE / 2;
      ch.y = spawn.row * TILE_SIZE + TILE_SIZE / 2;
      ch.tileCol = spawn.col;
      ch.tileRow = spawn.row;
    }

    if (folderName) {
      ch.folderName = folderName;
    }
    if (!skipSpawnEffect) {
      ch.matrixEffect = 'spawn';
      ch.matrixEffectTimer = 0;
      ch.matrixEffectSeeds = matrixEffectSeeds();
    }
    this.characters.set(id, ch);
  }

  removeAgent(id: number): void {
    const ch = this.characters.get(id);
    if (!ch) return;
    if (ch.matrixEffect === 'despawn') return; // already despawning
    // Free seat and clear selection immediately
    if (ch.seatId) {
      const seat = this.seats.get(ch.seatId);
      if (seat) seat.assigned = false;
    }
    // Release any interaction-station claim.
    if (ch.stationId) {
      const station = this.stations.get(ch.stationId);
      if (station && station.occupantId === id) station.occupantId = null;
      ch.stationId = null;
    }
    if (this.selectedAgentId === id) this.selectedAgentId = null;
    if (this.cameraFollowId === id) this.cameraFollowId = null;
    // Start despawn animation instead of immediate delete
    ch.matrixEffect = 'despawn';
    ch.matrixEffectTimer = 0;
    ch.matrixEffectSeeds = matrixEffectSeeds();
    ch.bubbleType = null;
  }

  // ── Players (human viewer avatars) ────────────────────────────────

  /** Spawn a human player's avatar (a viewer-driven Character, not the agent
   *  FSM) at a free walkable tile. Returns its id. */
  addPlayer(preferredSkin?: string, name?: string, spawnAt?: { col: number; row: number }): number {
    const id = this.nextPlayerId++;
    let skin: string;
    let hueShift: number;
    if (preferredSkin !== undefined) {
      skin = preferredSkin;
      hueShift = 0;
    } else {
      const pick = this.pickDiverseSkin();
      skin = pick.skin;
      hueShift = pick.hueShift;
    }
    const ch = createCharacter(id, skin, null, null, hueShift);
    ch.isPlayer = true;
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
    ch.matrixEffect = 'spawn';
    ch.matrixEffectTimer = 0;
    ch.matrixEffectSeeds = matrixEffectSeeds();
    this.characters.set(id, ch);
    return id;
  }

  /** A free walkable tile to spawn on: not a wall/blocked tile, not under any
   *  furniture footprint, not occupied by another character or pet, and never
   *  inside a meeting area (see spawnableTiles). Prefers `preferred` (e.g. a
   *  zone's arrival tile) when it's free; else a random free tile; else any
   *  walkable tile as a last resort. */
  private findFreeSpawnTile(preferred?: { col: number; row: number }): { col: number; row: number } {
    const occupied = new Set<string>();
    for (const ch of this.characters.values()) occupied.add(`${ch.tileCol},${ch.tileRow}`);
    for (const p of this.pets.values()) occupied.add(`${p.tileCol},${p.tileRow}`);
    for (const item of this.layout.furniture) {
      const entry = getCatalogEntry(item.type);
      const fw = entry?.footprintW ?? 1;
      const fh = entry?.footprintH ?? 1;
      for (let dr = 0; dr < fh; dr++) {
        for (let dc = 0; dc < fw; dc++) occupied.add(`${item.col + dc},${item.row + dr}`);
      }
    }
    const isFree = (t: { col: number; row: number }): boolean =>
      isWalkable(t.col, t.row, this.tileMap, this.blockedTiles) &&
      !occupied.has(`${t.col},${t.row}`) &&
      this.meetingAreaAt(t.col, t.row) === null;

    if (preferred && isFree(preferred)) return preferred;
    const free = this.spawnableTiles().filter(isFree);
    const pool = free.length > 0 ? free : this.walkableTiles;
    return pool.length > 0 ? pool[Math.floor(Math.random() * pool.length)] : { col: 1, row: 1 };
  }

  /** Recolor a character (used to change a player's chosen avatar skin). */
  setCharacterSkin(id: number, skin: string, hueShift = 0): void {
    const ch = this.characters.get(id);
    if (ch) {
      ch.skin = skin;
      ch.hueShift = hueShift;
    }
  }

  /** Set a character's owner name (a player's display name; shown as its label). */
  setCharacterName(id: number, name: string): void {
    const ch = this.characters.get(id);
    if (ch) ch.folderName = name;
  }

  /** Remove a player's avatar (immediate; viewers leave abruptly). */
  removePlayer(id: number): void {
    if (this.selectedAgentId === id) this.selectedAgentId = null;
    if (this.cameraFollowId === id) this.cameraFollowId = null;
    this.characters.delete(id);
  }

  /** Walk a player's avatar to a tile (viewer click-to-move). A click on a
   *  wall/furniture/blocked-floor tile redirects to the nearest walkable tile
   *  instead of failing outright, so clicking "on" an obstacle walks the
   *  avatar up to it rather than doing nothing. Paths via the shared
   *  pathfinder; returns false if nothing walkable is reachable at all. */
  walkPlayer(id: number, col: number, row: number): boolean {
    const ch = this.characters.get(id);
    if (!ch || !ch.isPlayer) return false;
    // Outside the play area (off the map, or a VOID gap in it) — no-op, not
    // "walk to the nearest real tile". A click ON a real but non-walkable
    // tile (a wall, furniture) still resolves to the nearest walkable spot,
    // same as before — this only rejects clicks that hit no tile at all.
    const clicked = this.tileMap[row]?.[col];
    if (clicked === undefined || isVoid(clicked)) return false;
    const target = nearestWalkableTile(col, row, this.tileMap, this.blockedTiles);
    if (!target) return false;
    // Route around tile actions when a detour exists (see computeActionTileKeys)
    // — a plain walk-click shouldn't cut through a meeting room/kiosk/etc. on
    // its way somewhere else, but can still land ON one directly when that's
    // the actual target (its own cost is unavoidable either way).
    const path = findPath(ch.tileCol, ch.tileRow, target.col, target.row, this.tileMap, this.blockedTiles, this.actionTileKeys);
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

  /** Walk a player to a seat tile (chair/bench) and sit there, facing the seat's
   *  direction. Returns false if there's no seat at the tile or it's unreachable.
   *  The seat tile is normally blocked, so it's temporarily unblocked to path. */
  sitPlayerAt(id: number, col: number, row: number): boolean {
    const ch = this.characters.get(id);
    if (!ch || !ch.isPlayer) return false;
    let seat: Seat | undefined;
    for (const s of this.seats.values()) {
      if (s.seatCol === col && s.seatRow === row) {
        seat = s;
        break;
      }
    }
    if (!seat) return false;
    ch.heldDir = null;
    ch.afk = false; // moving to a seat clears the afk marker
    ch.pendingAction = null; // a click-to-sit cancels a pending walk-to-action
    ch.pendingAppliance = null; // …and a pending walk-to-appliance
    if (ch.tileCol === col && ch.tileRow === row) {
      ch.path = [];
      ch.moveProgress = 0;
      snapToTile(ch);
      ch.dir = seat.facingDir;
      ch.state = CharacterState.SIT;
      ch.pendingSitFacing = null;
      releaseStation(ch, this.stations); // sitting ends any appliance pose
      return true;
    }
    const key = `${col},${row}`;
    const wasBlocked = this.blockedTiles.has(key);
    if (wasBlocked) this.blockedTiles.delete(key); // allow pathing onto the seat
    const path = findPath(ch.tileCol, ch.tileRow, col, row, this.tileMap, this.blockedTiles);
    if (wasBlocked) this.blockedTiles.add(key);
    if (path.length === 0) return false;
    ch.path = path;
    ch.moveProgress = 0;
    ch.state = CharacterState.WALK;
    ch.pendingSitFacing = seat.facingDir; // sit on arrival
    return true;
  }

  /** Set (or clear, with null) a player's held WASD direction. Continuous
   *  keyboard walking: while held, the player steps tile-by-tile that way
   *  (validated per step). Abandons any in-flight click-to-walk path. */
  setPlayerDir(id: number, dir: Direction | null): boolean {
    const ch = this.characters.get(id);
    if (!ch || !ch.isPlayer) return false;
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
    const ch = this.characters.get(id);
    if (!ch || !ch.isPlayer) return false;
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
      releaseStation(ch, this.stations);
    } else if (ch.state === CharacterState.SIT) {
      ch.state = CharacterState.IDLE;
    }
    return true;
  }

  /** Toggle (or set) a player's afk marker. Returns the new state, or null if
   *  the id isn't a player. Cleared automatically on movement (see clearAfk). */
  setPlayerAfk(id: number, on?: boolean): boolean | null {
    const ch = this.characters.get(id);
    if (!ch || !ch.isPlayer) return null;
    ch.afk = on ?? !ch.afk;
    return ch.afk;
  }

  /** If a held direction is set, queue a single step to the adjacent tile that
   *  way (when walkable); otherwise just face it. */
  private tryStepHeldDir(ch: Character): void {
    const d = ch.heldDir;
    if (d === null || d === undefined) return;
    const dc = d === Direction.LEFT ? -1 : d === Direction.RIGHT ? 1 : 0;
    const dr = d === Direction.UP ? -1 : d === Direction.DOWN ? 1 : 0;
    const col = ch.tileCol + dc;
    const row = ch.tileRow + dr;
    if (!isWalkable(col, row, this.tileMap, this.blockedTiles)) {
      ch.dir = d; // face the wall, don't move
      return;
    }
    ch.path = [{ col, row }];
    ch.moveProgress = 0;
  }

  /** Recompute portal trigger tiles from placed `portal` furniture: only the
   *  item's own walkable footprint tiles — you activate a door/beam pad by
   *  standing on it, not by approaching from an adjacent tile. Portal furniture
   *  is non-blocking (backgroundTiles), so its tile is walkable. */
  private computePortalTiles(): void {
    const tiles = new Set<string>();
    for (const item of this.layout.furniture) {
      const entry = getCatalogEntry(item.type);
      if (!entry?.portal) continue;
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

  /** Drain players that stepped onto a portal tile this tick (room shows them a
   *  destination picker). */
  takePendingPortals(): number[] {
    if (this.pendingPortals.length === 0) return [];
    const out = this.pendingPortals;
    this.pendingPortals = [];
    return out;
  }

  /** Drain players who reached a furniture action's stand tile this tick —
   *  the room adds 'meetingRoom' arrivals to that room's membership, and
   *  tells the client to open its own local UI for everything else (see
   *  SimRoom.handleActionArrivals). */
  takePendingActionArrivals(): Array<{ id: number; action: Action; col: number; row: number }> {
    if (this.pendingActionArrivals.length === 0) return [];
    const out = this.pendingActionArrivals;
    this.pendingActionArrivals = [];
    return out;
  }

  /** Walk a player to one of the walkable tiles around a furniture item's
   *  action (conference monitor, link-manager kiosk, arcade cabinet, iframe
   *  sprite, or a 'meetingRoom' override on plain furniture — see Action),
   *  facing it, then queue the arrival notification. Triggers in place if
   *  already at any approach tile; otherwise picks randomly among the
   *  reachable ones, so simultaneous visitors don't all converge on one
   *  fixed tile. Returns false if there's no (non-appliance) action at that
   *  tile or nowhere reachable to stand — appliances go through
   *  useAppliance instead (they use the pre-built station/occupancy system,
   *  not computeApproachTiles). */
  walkPlayerToAction(id: number, anchorCol: number, anchorRow: number): boolean {
    const ch = this.characters.get(id);
    if (!ch || !ch.isPlayer) return false;
    // A tile can carry more than one furniture item (e.g. a cup placed on a
    // table via canPlaceOnSurfaces) — of the ones that actually HAVE a
    // (non-appliance) action, prefer whichever renders on top: a surface
    // item over the desk/table it sits on, then the higher manual "bring to
    // front" override, then whichever was placed later (the editor
    // convention — you place the base first, decorations on top after).
    // An action-less item on top of an actioned one (e.g. a plain decoration
    // sitting on an actioned desk) does NOT shadow the action underneath —
    // only items that are themselves in the running (have an action) get
    // ranked against each other.
    const candidates = this.layout.furniture.filter((f) => {
      if (f.col !== anchorCol || f.row !== anchorRow) return false;
      const a = effectiveAction(f, getCatalogEntry(f.type));
      return !!a && a.kind !== 'appliance';
    });
    candidates.sort((a, b) => {
      const aSurf = getCatalogEntry(a.type)?.canPlaceOnSurfaces ? 1 : 0;
      const bSurf = getCatalogEntry(b.type)?.canPlaceOnSurfaces ? 1 : 0;
      if (aSurf !== bSurf) return bSurf - aSurf;
      const aOff = a.zOffset ?? 0;
      const bOff = b.zOffset ?? 0;
      if (aOff !== bOff) return bOff - aOff;
      return this.layout.furniture.indexOf(b) - this.layout.furniture.indexOf(a);
    });
    const item = candidates[0];
    const action = item ? effectiveAction(item, getCatalogEntry(item.type)) : null;
    if (!action) return false;
    const entry = getCatalogEntry(item!.type);
    const fw = entry?.footprintW ?? 1;
    const fh = entry?.footprintH ?? 1;
    ch.heldDir = null;
    ch.pendingSitFacing = null;
    ch.pendingAppliance = null;
    ch.pendingAction = null;

    const approaches = this.computeApproachTiles(anchorCol, anchorRow, fw, fh, item!.facing, item!.approachSides);

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
      .map((a) => ({ a, path: findPath(ch.tileCol, ch.tileRow, a.col, a.row, this.tileMap, this.blockedTiles) }))
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
   *  same stationId/occupantId claim the agent FSM already uses for NPC coffee
   *  breaks (see characters.ts), just started by a click instead of AI. Unlike
   *  an NPC's timed break, a player holds the pose indefinitely (stationTimer
   *  stays 0 and never counts down) until they walk away or sit down — see
   *  updatePlayerMovement. Triggers immediately if already standing at ANY of
   *  the appliance's stand tiles; otherwise picks randomly among the free
   *  (unoccupied) reachable ones — falling back to any reachable one if all
   *  are currently occupied — so simultaneous visitors spread out around the
   *  appliance instead of stacking on one fixed tile. Returns false if there's
   *  no appliance at that tile or no stand tile was derivable (buildStations). */
  useAppliance(id: number, anchorCol: number, anchorRow: number): boolean {
    const ch = this.characters.get(id);
    if (!ch || !ch.isPlayer) return false;
    // An appliance can share its tile with the surface it sits on (e.g. a
    // coffee machine placed atop a counter) — match the appliance item
    // specifically (effectiveAction, so an override counts too — see
    // buildStations), not just whatever's first at that tile.
    const item = this.layout.furniture.find(
      (f) => f.col === anchorCol && f.row === anchorRow && effectiveAction(f, getCatalogEntry(f.type))?.kind === 'appliance',
    );
    if (!item) return false;
    const prefix = `station:${item.uid}:`;
    const spots = [...this.stations.entries()].filter(([uid]) => uid.startsWith(prefix));
    if (spots.length === 0) return false;
    ch.heldDir = null;
    ch.pendingSitFacing = null;
    ch.pendingAction = null;

    const here = spots.find(([, s]) => s.col === ch.tileCol && s.row === ch.tileRow);
    if (here) {
      const [uid, s] = here;
      ch.dir = s.facingDir;
      ch.stationId = uid;
      s.occupantId = ch.id;
      ch.stationTimer = 0; // players hold the pose until they move (no timeout)
      ch.pendingAppliance = null;
      return true;
    }
    const reachable = spots
      .map(([uid, s]) => ({ uid, s, path: findPath(ch.tileCol, ch.tileRow, s.col, s.row, this.tileMap, this.blockedTiles) }))
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
    // aren't run through the agent FSM (see the isPlayer branch above), so
    // nothing else would release this claim once they move on.
    if (ch.stationId && ch.path.length > 0) releaseStation(ch, this.stations);
    // Standing at a tile with a key held → begin a step that way.
    if (ch.path.length === 0) this.tryStepHeldDir(ch);

    if (ch.path.length === 0) {
      // Standing still keeps any appliance pose (☕ over the avatar) — unlike an
      // NPC's timed coffee break (updateCharacter's IDLE case), a player's claim
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
          ch.stationId = ch.pendingAppliance.stationUid;
          const claimed = this.stations.get(ch.pendingAppliance.stationUid);
          if (claimed) claimed.occupantId = ch.id;
          ch.stationTimer = 0; // held until the player moves away (no timeout)
          ch.pendingAppliance = null;
        } else if (ch.pendingSitFacing !== null && ch.pendingSitFacing !== undefined) {
          // Arrived at a seat (click-to-sit) → sit facing the seat's direction.
          ch.dir = ch.pendingSitFacing;
          ch.state = CharacterState.SIT;
          ch.pendingSitFacing = null;
        } else {
          ch.state = CharacterState.IDLE;
          // Came to rest on a portal tile → queue it (room offers a destination
          // picker). Only on arrival/rest, so walking across doesn't spam it.
          if (this.portalTiles.has(`${ch.tileCol},${ch.tileRow}`)) this.pendingPortals.push(ch.id);
          // A tile action other than 'meetingRoom' (which is automatic
          // membership-by-position, tracked separately every tick — see
          // SimRoom's meeting-room membership update) fires once on arrival,
          // same as a portal above.
          const tileAction = this.actionByTile.get(`${ch.tileCol},${ch.tileRow}`);
          if (tileAction && tileAction.kind !== 'meetingRoom') {
            this.pendingActionArrivals.push({ id: ch.id, action: tileAction, col: ch.tileCol, row: ch.tileRow });
          }
        }
      }
    }
  }

  /** Find seat uid at a given tile position, or null */
  getSeatAtTile(col: number, row: number): string | null {
    for (const [uid, seat] of this.seats) {
      if (seat.seatCol === col && seat.seatRow === row) return uid;
    }
    return null;
  }

  /** Reassign an agent from their current seat to a new seat */
  reassignSeat(agentId: number, seatId: string): void {
    const ch = this.characters.get(agentId);
    if (!ch) return;
    // Unassign old seat
    if (ch.seatId) {
      const old = this.seats.get(ch.seatId);
      if (old) old.assigned = false;
    }
    // Assign new seat
    const seat = this.seats.get(seatId);
    if (!seat || seat.assigned) return;
    seat.assigned = true;
    ch.seatId = seatId;
    // Pathfind to new seat (unblock own seat tile for this query)
    const path = this.withOwnSeatUnblocked(ch, () =>
      findPath(ch.tileCol, ch.tileRow, seat.seatCol, seat.seatRow, this.tileMap, this.blockedTiles),
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
      ch.dir = seat.facingDir;
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
    if (!ch || !ch.seatId) return;
    const seat = this.seats.get(ch.seatId);
    if (!seat) return;
    const path = this.withOwnSeatUnblocked(ch, () =>
      findPath(ch.tileCol, ch.tileRow, seat.seatCol, seat.seatRow, this.tileMap, this.blockedTiles),
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
      ch.dir = seat.facingDir;
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
      findPath(ch.tileCol, ch.tileRow, col, row, this.tileMap, this.blockedTiles),
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
    const hueShift = parentCh ? parentCh.hueShift : 0;

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

    const ch = createCharacter(id, skin, null, null, hueShift);
    ch.x = spawn.col * TILE_SIZE + TILE_SIZE / 2;
    ch.y = spawn.row * TILE_SIZE + TILE_SIZE / 2;
    ch.tileCol = spawn.col;
    ch.tileRow = spawn.row;
    // Face the same direction as the parent agent
    if (parentCh) ch.dir = parentCh.dir;
    ch.isSubagent = true;
    ch.parentAgentId = parentAgentId;
    ch.matrixEffect = 'spawn';
    ch.matrixEffectTimer = 0;
    ch.matrixEffectSeeds = matrixEffectSeeds();
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
      if (ch.seatId) {
        const seat = this.seats.get(ch.seatId);
        if (seat) seat.assigned = false;
      }
      // Start despawn animation — keep character in map for rendering
      ch.matrixEffect = 'despawn';
      ch.matrixEffectTimer = 0;
      ch.matrixEffectSeeds = matrixEffectSeeds();
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
          if (ch.seatId) {
            const seat = this.seats.get(ch.seatId);
            if (seat) seat.assigned = false;
          }
          // Start despawn animation
          ch.matrixEffect = 'despawn';
          ch.matrixEffectTimer = 0;
          ch.matrixEffectSeeds = matrixEffectSeeds();
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

  /** Rebuild furniture instances with auto-state applied (active agents turn electronics ON) */
  private rebuildFurnitureInstances(): void {
    // Collect tiles where active agents face desks
    const autoOnTiles = new Set<string>();
    for (const ch of this.characters.values()) {
      if (!ch.isActive || !ch.seatId) continue;
      const seat = this.seats.get(ch.seatId);
      if (!seat) continue;
      // Find the desk tile(s) the agent faces from their seat
      const dCol =
        seat.facingDir === Direction.RIGHT ? 1 : seat.facingDir === Direction.LEFT ? -1 : 0;
      const dRow = seat.facingDir === Direction.DOWN ? 1 : seat.facingDir === Direction.UP ? -1 : 0;
      // Check tiles in the facing direction (desk could be 1-3 tiles deep)
      for (let d = 1; d <= AUTO_ON_FACING_DEPTH; d++) {
        const tileCol = seat.seatCol + dCol * d;
        const tileRow = seat.seatRow + dRow * d;
        autoOnTiles.add(`${tileCol},${tileRow}`);
      }
      // Also check tiles to the sides of the facing direction (desks can be wide)
      for (let d = 1; d <= AUTO_ON_SIDE_DEPTH; d++) {
        const baseCol = seat.seatCol + dCol * d;
        const baseRow = seat.seatRow + dRow * d;
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

    // Build modified furniture list with auto-state and animation applied
    const animFrame = Math.floor(this.furnitureAnimTimer / FURNITURE_ANIM_INTERVAL_SEC);
    const modifiedFurniture: PlacedFurniture[] = this.layout.furniture.map((item) => {
      const entry = getCatalogEntry(item.type);
      if (!entry) return item;

      // Ambient (always-on) animation: a stateless animation member, e.g. the
      // goldfish bowl. Excludes state-paired members (PC), whose placed type is
      // the "off" variant and therefore has no animation frames of its own.
      const ambientFrames = getAnimationFrames(item.type);
      if (ambientFrames && ambientFrames.length > 1 && getOnStateType(item.type) === item.type) {
        return { ...item, type: ambientFrames[animFrame % ambientFrames.length] };
      }

      // Auto-on: an active agent seated facing this furniture turns it "on".
      if (autoOnTiles.size > 0) {
        for (let dr = 0; dr < entry.footprintH; dr++) {
          for (let dc = 0; dc < entry.footprintW; dc++) {
            if (autoOnTiles.has(`${item.col + dc},${item.row + dr}`)) {
              let onType = getOnStateType(item.type);
              if (onType !== item.type) {
                const frames = getAnimationFrames(onType);
                if (frames && frames.length > 1) {
                  onType = frames[animFrame % frames.length];
                }
                return { ...item, type: onType };
              }
              return item;
            }
          }
        }
      }
      return item;
    });

    this.furniturePlacements = modifiedFurniture;
    this.furniture = layoutToFurnitureInstances(modifiedFurniture);
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

  setAgentTokens(id: number, inputTokens: number, outputTokens: number): void {
    const ch = this.characters.get(id);
    if (!ch) return;
    ch.inputTokens = inputTokens;
    ch.outputTokens = outputTokens;
  }

  update(dt: number): void {
    // Furniture animation cycling
    const prevFrame = Math.floor(this.furnitureAnimTimer / FURNITURE_ANIM_INTERVAL_SEC);
    this.furnitureAnimTimer += dt;
    const newFrame = Math.floor(this.furnitureAnimTimer / FURNITURE_ANIM_INTERVAL_SEC);
    if (newFrame !== prevFrame) {
      this.rebuildFurnitureInstances();
    }

    const toDelete: number[] = [];
    for (const ch of this.characters.values()) {
      // Handle matrix effect animation
      if (ch.matrixEffect) {
        ch.matrixEffectTimer += dt;
        if (ch.matrixEffectTimer >= MATRIX_EFFECT_DURATION) {
          if (ch.matrixEffect === 'spawn') {
            // Spawn complete — clear effect, resume normal FSM
            ch.matrixEffect = null;
            ch.matrixEffectTimer = 0;
            ch.matrixEffectSeeds = [];
          } else {
            // Despawn complete — mark for deletion
            toDelete.push(ch.id);
          }
        }
        continue; // skip normal FSM while effect is active
      }

      // Players are viewer-driven, not run by the agent FSM — just advance along
      // any commanded path (movement input lands in P2).
      if (ch.isPlayer) {
        this.updatePlayerMovement(ch, dt);
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
          this.seats,
          this.stations,
          this.tileMap,
          this.blockedTiles,
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

  /** Inject the NPC decision fn (server's mistreevous brain). It receives the
   *  pet and a cheap world-affordance snapshot. Clears with null. */
  setNpcDecider(fn: ((pet: Pet, affordances: NpcAffordances) => NpcAction) | null): void {
    this.npcDecide = fn ?? undefined;
  }

  /** Cheap, pathfinding-free snapshot of what a pet could interact with now, fed
   *  to the brain so it picks a sensible action. Reachability is confirmed later
   *  by findFreePetTarget; this only checks existence so it's cheap per tick. */
  private computePetAffordances(pet: Pet): NpcAffordances {
    // Per-variant behaviour switches (editable; default all-on). The kind guards
    // below keep flags that don't apply to a kind inert (e.g. a duck's chaseCats).
    const b = getNpcConfig(pet.kind, pet.variant).behaviors;
    return {
      canRest: b.rest && this.hasRestAffordance(pet),
      // Shoo-cat: a dog chases a nearby cat; a cat flees a nearby dog.
      canChase: b.chaseCats && pet.kind === PetKindEnum.DOG && this.nearestLivingPetOfKind(pet, PetKindEnum.CAT) !== null,
      threatened: b.fleeDogs && pet.kind === PetKindEnum.CAT && this.nearestLivingPetOfKind(pet, PetKindEnum.DOG) !== null,
      // Coffee: any kind may visit a free appliance station.
      canDrink: b.drink && this.hasFreeStation(),
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

  /** A free seat or a free desk surface (a desk with at least one column clear of
   *  computers/mugs) exists somewhere — any pet may rest on either. Cheap: no
   *  pathfinding (reachability is confirmed later by findFreePetTarget). */
  private hasRestAffordance(_pet: Pet): boolean {
    for (const seat of this.seats.values()) {
      if (!seat.assigned) return true;
    }
    const occupied = this.occupiedDeskSurfaceTiles();
    for (const item of this.layout.furniture) {
      const entry = getCatalogEntry(item.type);
      if (entry?.category !== 'desks') continue;
      if (!this.isFurnitureFreeForPet(item.uid)) continue;
      if (this.freeDeskRestColumn(item, entry, occupied) !== null) return true;
    }
    return false;
  }

  /** Tiles covered by an on-desk item — a computer (electronics) or a coffee mug /
   *  other surface object (canPlaceOnSurfaces) — so a pet won't rest on that spot. */
  private occupiedDeskSurfaceTiles(): Set<string> {
    const tiles = new Set<string>();
    for (const item of this.layout.furniture) {
      const entry = getCatalogEntry(item.type);
      if (!entry) continue;
      if (entry.category !== 'electronics' && !entry.canPlaceOnSurfaces) continue;
      for (let dr = 0; dr < entry.footprintH; dr++) {
        for (let dc = 0; dc < entry.footprintW; dc++) {
          tiles.add(`${item.col + dc},${item.row + dr}`);
        }
      }
    }
    return tiles;
  }

  /** First desk column with no computer/mug on any of its tiles, as a rest spot
   *  anchored on the desk's BOTTOM footprint row (so it depth-sorts in front of
   *  the desk sprite) plus the lift that raises the pet onto the surface. Null if
   *  every column is occupied. Pure existence check — no reachability. */
  private freeDeskRestColumn(
    item: PlacedFurniture,
    entry: { footprintW: number; footprintH: number; sprite: { length: number } },
    occupied: Set<string>,
  ): { col: number; row: number; lift: number } | null {
    const bottomRow = item.row + entry.footprintH - 1;
    for (let dc = 0; dc < entry.footprintW; dc++) {
      let columnFree = true;
      for (let dr = 0; dr < entry.footprintH; dr++) {
        if (occupied.has(`${item.col + dc},${item.row + dr}`)) {
          columnFree = false;
          break;
        }
      }
      if (!columnFree) continue;
      // Desk sprites are exactly footprintH tiles tall, so lifting by the part
      // above the bottom row (spriteH − one tile) lands the pet on the surface.
      return { col: item.col + dc, row: bottomRow, lift: entry.sprite.length - TILE_SIZE };
    }
    return null;
  }

  /** Nearest non-despawning pet of `kind` within PET_SHOO_RADIUS_TILES (tile
   *  Chebyshev distance) of `pet`, or null. Used for shoo-cat detection. */
  private nearestLivingPetOfKind(pet: Pet, kind: PetKindEnum): Pet | null {
    let best: Pet | null = null;
    let bestDist = PET_SHOO_RADIUS_TILES + 1;
    for (const other of this.pets.values()) {
      if (other.id === pet.id || other.kind !== kind) continue;
      if (other.state === PetState.SPAWN || other.state === PetState.DESPAWN) continue;
      const dist = Math.max(Math.abs(other.tileCol - pet.tileCol), Math.abs(other.tileRow - pet.tileRow));
      if (dist <= PET_SHOO_RADIUS_TILES && dist < bestDist) {
        best = other;
        bestDist = dist;
      }
    }
    return best;
  }

  /** Reactive movement path for shoo-cat: a dog paths toward the nearest cat
   *  ('chase'); a cat paths to a reachable tile that increases its distance from
   *  the nearest dog ('flee'). Returns null when no useful path exists. */
  private navigatePetReaction(pet: Pet, action: NpcAction): Array<{ col: number; row: number }> | null {
    if (action === 'chase') {
      const cat = this.nearestLivingPetOfKind(pet, PetKindEnum.CAT);
      if (!cat) return null;
      const path = findPath(pet.tileCol, pet.tileRow, cat.tileCol, cat.tileRow, this.tileMap, this.blockedTiles);
      return path.length > 0 ? path : null;
    }
    if (action === 'flee') {
      const dog = this.nearestLivingPetOfKind(pet, PetKindEnum.DOG);
      if (!dog) return null;
      const distFromDog = (c: number, r: number): number =>
        Math.max(Math.abs(c - dog.tileCol), Math.abs(r - dog.tileRow));
      const cur = distFromDog(pet.tileCol, pet.tileRow);
      // Prefer reachable tiles that get farther from the dog but stay within a
      // flee range of the cat (so it doesn't bolt across the whole office).
      const candidates = this.walkableTiles
        .filter(
          (t) =>
            distFromDog(t.col, t.row) > cur &&
            Math.max(Math.abs(t.col - pet.tileCol), Math.abs(t.row - pet.tileRow)) <= PET_FLEE_RANGE_TILES,
        )
        .sort((a, b) => distFromDog(b.col, b.row) - distFromDog(a.col, a.row));
      for (const t of candidates.slice(0, 8)) {
        const path = findPath(pet.tileCol, pet.tileRow, t.col, t.row, this.tileMap, this.blockedTiles);
        if (path.length > 0) return path;
      }
      return null;
    }
    return null;
  }

  // ── Pet lifecycle ─────────────────────────────────────────

  /** Number of connected agents (real agents, excluding sub-agents & despawning). */
  getConnectedAgentCount(): number {
    let n = 0;
    for (const ch of this.characters.values()) {
      if (ch.id > 0 && !ch.isSubagent && !ch.isPlayer && ch.matrixEffect !== 'despawn') n++;
    }
    return n;
  }

  /** Tick spawning, the per-pet FSM, and deletion of finished despawns. */
  private updatePets(dt: number): void {
    const ctx = {
      walkableTiles: this.walkableTiles,
      tileMap: this.tileMap,
      blockedTiles: this.blockedTiles,
      findTarget: (pet: Pet, action: NpcAction) => this.findFreePetTarget(pet, action),
      releaseClaim: (pet: Pet) => this.releasePetClaim(pet),
      // Wrap the injected brain so it receives a fresh affordance snapshot; left
      // undefined when no brain is set so the actuator uses its sit-chance roll.
      decideAction: this.npcDecide
        ? (pet: Pet) => this.npcDecide!(pet, this.computePetAffordances(pet))
        : undefined,
      navigateReaction: (pet: Pet, action: NpcAction) => this.navigatePetReaction(pet, action),
      // Spec-driven frame advance: cycle within the current pose track's real
      // length (resolved from the pet's sheet), so server and client agree and
      // longer custom tracks aren't truncated by a hardcoded modulo.
      posePlaybackLength: (pet: Pet) => getNpcPosePlaybackLength(pet.kind, pet.variant, petPose(pet)),
    };

    const toDelete: number[] = [];
    for (const pet of this.pets.values()) {
      updatePet(pet, dt, ctx);
      if (pet.state === PetState.DESPAWN && pet.effectTimer >= PET_EFFECT_DURATION_SEC) {
        toDelete.push(pet.id);
      }
    }
    for (const id of toDelete) {
      const pet = this.pets.get(id);
      if (pet) this.releasePetClaim(pet);
      this.pets.delete(id);
    }

    // Per-NPC-variant spawning (lifespan despawn frees slots).
    this.tickNpcSpawns(dt);
  }

  /** Each active NPC variant spawns up to its `maxConcurrent` on its own random
   *  interval [minSec, maxSec]. Independent of agent count (config-driven). */
  private tickNpcSpawns(dt: number): void {
    if (this.walkableTiles.length === 0) return;
    // Living instances per `${kind}_${variant}`.
    const living = new Map<string, number>();
    for (const p of this.pets.values()) {
      if (p.state === PetState.DESPAWN) continue;
      const k = `${p.kind}_${p.variant}`;
      living.set(k, (living.get(k) ?? 0) + 1);
    }
    for (const name of ['dog', 'cat', 'duck'] as Array<'dog' | 'cat' | 'duck'>) {
      const count = getLoadedPetVariantCount(name);
      for (let v = 0; v < count; v++) {
        const key = `${name}_${v}`;
        const cfg = getNpcConfig(name, v);
        // Globally active AND enabled for this zone (per-zone NPC config).
        if (!cfg.active || !this.npcSpawnFilter(name as PetKind, v)) {
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

  /** Spawn a specific NPC variant at a free walkable tile. */
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

  /** Restrict which NPC variants spawn in this zone (per-zone config). Also
   *  despawns any currently-living pets that the new filter disallows, so a
   *  change takes effect immediately. */
  setNpcSpawnFilter(fn: (kind: PetKind, variant: number) => boolean): void {
    this.npcSpawnFilter = fn;
    for (const p of this.pets.values()) {
      if (p.state !== PetState.DESPAWN && !fn(p.kind as PetKind, p.variant)) this.despawnPet(p.id);
    }
  }

  // ── Pet furniture interaction ─────────────────────────────

  /** Release a pet's seat/furniture/station claim. */
  private releasePetClaim(pet: Pet): void {
    if (pet.targetSeatId) {
      const seat = this.seats.get(pet.targetSeatId);
      if (seat) seat.assigned = false;
    }
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
  private isFurnitureFreeForPet(uid: string): boolean {
    if (this.petFurnitureClaims.has(uid)) return false;
    // Not in use by an agent actively seated facing it
    for (const ch of this.characters.values()) {
      if (!ch.isActive || !ch.seatId) continue;
      const seat = this.seats.get(ch.seatId);
      if (seat && this.seatFacesFurniture(seat, uid)) return false;
    }
    return true;
  }

  /** Whether a seat faces (within depth) the given furniture item. */
  private seatFacesFurniture(seat: Seat, uid: string): boolean {
    const item = this.layout.furniture.find((f) => f.uid === uid);
    if (!item) return false;
    const entry = getCatalogEntry(item.type);
    if (!entry) return false;
    const footprint = new Set<string>();
    for (let dr = 0; dr < entry.footprintH; dr++) {
      for (let dc = 0; dc < entry.footprintW; dc++) {
        footprint.add(`${item.col + dc},${item.row + dr}`);
      }
    }
    const dCol = seat.facingDir === Direction.RIGHT ? 1 : seat.facingDir === Direction.LEFT ? -1 : 0;
    const dRow = seat.facingDir === Direction.DOWN ? 1 : seat.facingDir === Direction.UP ? -1 : 0;
    for (let d = 1; d <= AUTO_ON_FACING_DEPTH; d++) {
      if (footprint.has(`${seat.seatCol + dCol * d},${seat.seatRow + dRow * d}`)) return true;
    }
    return false;
  }

  /**
   * Find + claim a free interaction target reachable from the pet for `action`:
   *  - 'sit'  → any free chair seat, or a free desk surface column (no computer
   *             or coffee mug on it) the pet rests on top of — any kind
   *  - 'drink' → a free appliance station (coffee), any kind
   * Returns the claimed target (with a path), or null.
   */
  private findFreePetTarget(pet: Pet, action: NpcAction): PetTarget | null {
    const candidates: PetTarget[] = [];

    // Appliance stations (coffee) — stand on the station tile.
    if (action === 'drink') {
      for (const [uid, s] of this.stations) {
        if (s.occupantId !== null || this.petStationClaims.has(uid)) continue;
        const path = findPath(pet.tileCol, pet.tileRow, s.col, s.row, this.tileMap, this.blockedTiles);
        const reachable = path.length > 0 || (pet.tileCol === s.col && pet.tileRow === s.row);
        if (!reachable) continue;
        candidates.push({
          kind: 'station',
          action: 'drink',
          seatId: null,
          furnitureUid: null,
          stationId: uid,
          agentId: null,
          sitCol: s.col,
          sitRow: s.row,
          facing: s.facingDir,
          restLift: 0,
          path,
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
        const path = findPath(pet.tileCol, pet.tileRow, approach.col, approach.row, this.tileMap, this.blockedTiles);
        const reachable = path.length > 0 || (pet.tileCol === approach.col && pet.tileRow === approach.row);
        if (!reachable) continue;
        candidates.push({
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
          path,
        });
      }
    }

    // Chairs (reuse seats) — temporarily unblock the seat tile to path onto it
    for (const [uid, seat] of this.seats) {
      if (action !== 'sit') break;
      if (seat.assigned) continue;
      const key = `${seat.seatCol},${seat.seatRow}`;
      const had = this.blockedTiles.has(key);
      if (had) this.blockedTiles.delete(key);
      const path = findPath(
        pet.tileCol,
        pet.tileRow,
        seat.seatCol,
        seat.seatRow,
        this.tileMap,
        this.blockedTiles,
      );
      if (had) this.blockedTiles.add(key);
      const reachable = path.length > 0 || (pet.tileCol === seat.seatCol && pet.tileRow === seat.seatRow);
      if (!reachable) continue;
      candidates.push({
        kind: 'seat',
        action: 'sit',
        seatId: uid,
        furnitureUid: null,
        stationId: null,
        agentId: null,
        sitCol: seat.seatCol,
        sitRow: seat.seatRow,
        facing: seat.facingDir,
        restLift: 0,
        path,
      });
    }

    // Desks/tables — rest ON the surface, but only on a column with no computer
    // or coffee mug. Anchor on the desk's bottom row (so the pet depth-sorts in
    // front of the desk) and carry the lift that raises it onto the surface; the
    // bottom tile is normally blocked, so unblock it just long enough to path on.
    if (action === 'sit') {
      const occupied = this.occupiedDeskSurfaceTiles();
      for (const item of this.layout.furniture) {
        const entry = getCatalogEntry(item.type);
        if (!entry || entry.category !== 'desks') continue;
        if (!this.isFurnitureFreeForPet(item.uid)) continue;
        const spot = this.freeDeskRestColumn(item, entry, occupied);
        if (!spot) continue;
        const key = `${spot.col},${spot.row}`;
        const had = this.blockedTiles.has(key);
        if (had) this.blockedTiles.delete(key);
        const path = findPath(pet.tileCol, pet.tileRow, spot.col, spot.row, this.tileMap, this.blockedTiles);
        if (had) this.blockedTiles.add(key);
        const reachable = path.length > 0 || (pet.tileCol === spot.col && pet.tileRow === spot.row);
        if (!reachable) continue;
        candidates.push({
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
          path,
        });
      }
    }

    if (candidates.length === 0) return null;
    const chosen = candidates[Math.floor(Math.random() * candidates.length)];
    // Claim it so agents/other pets won't take it
    if (chosen.kind === 'seat' && chosen.seatId) {
      const seat = this.seats.get(chosen.seatId);
      if (seat) seat.assigned = true;
    } else if (chosen.kind === 'station' && chosen.stationId) {
      this.petStationClaims.add(chosen.stationId);
    } else if (chosen.kind === 'agent' && chosen.agentId !== null) {
      this.petTalkClaims.add(chosen.agentId);
    } else if (chosen.furnitureUid) {
      this.petFurnitureClaims.add(chosen.furnitureUid);
    }
    return chosen;
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
