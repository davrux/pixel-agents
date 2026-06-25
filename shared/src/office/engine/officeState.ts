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
  PET_AGENTS_PER_PET,
  PET_EFFECT_DURATION_SEC,
  PET_MAX,
  PET_SPAWN_INTERVAL_MAX_SEC,
  PET_SPAWN_INTERVAL_MIN_SEC,
  WAITING_BUBBLE_DURATION_SEC,
} from '../constants.js';
import { getAnimationFrames, getCatalogEntry, getOnStateType } from '../layout/furnitureCatalog.js';
import {
  createDefaultLayout,
  getBlockedTiles,
  layoutToFurnitureInstances,
  layoutToSeats,
  layoutToTileMap,
} from '../layout/layoutSerializer.js';
import { findPath, getWalkableTiles, isWalkable } from '../layout/tileMap.js';
import { getLoadedCharacterCount, getLoadedPetVariantCount } from '../sprites/spriteData.js';
import type {
  Character,
  FurnitureInstance,
  InteractionPoint,
  OfficeLayout,
  Pet,
  PetKind,
  PlacedFurniture,
  Seat,
  TileType as TileTypeVal,
} from '../types.js';
import {
  CharacterState,
  Direction,
  MATRIX_EFFECT_DURATION,
  PetKind as PetKindEnum,
  PetState,
  TILE_SIZE,
} from '../types.js';
import { createCharacter, updateCharacter } from './characters.js';
import { matrixEffectSeeds } from './matrixEffect.js';
import type { PetTarget } from './pets.js';
import { beginPetDespawn, createPet, updatePet } from './pets.js';

/** Furniture types that yield a standing interaction point (a place to walk to
 *  and stand at). Coffee machine for now; extend with FRIDGE, WATER_COOLER, … */
const APPLIANCE_TYPES = new Set(['COFFEE_MACHINE']);

export class OfficeState {
  layout: OfficeLayout;
  tileMap: TileTypeVal[][];
  seats: Map<string, Seat>;
  /** Standing interaction points derived from appliances (coffee machine, …). */
  stations: Map<string, InteractionPoint> = new Map();
  blockedTiles: Set<string>;
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

  // ── Pets ──────────────────────────────────────────────────
  /** Live pets, keyed by a dedicated id space (disjoint from characters). */
  pets: Map<number, Pet> = new Map();
  /** Non-chair furniture uids currently claimed by a pet. */
  private petFurnitureClaims: Set<string> = new Set();
  private petSpawnTimer = 0;
  private nextPetId = 1_000_000;

  constructor(layout?: OfficeLayout) {
    this.layout = layout || createDefaultLayout();
    this.tileMap = layoutToTileMap(this.layout);
    this.seats = layoutToSeats(this.layout.furniture);
    this.blockedTiles = getBlockedTiles(this.layout.furniture);
    this.furniture = layoutToFurnitureInstances(this.layout.furniture);
    this.walkableTiles = getWalkableTiles(this.tileMap, this.blockedTiles);
    this.buildStations();
  }

  /** Rebuild all derived state from a new layout. Reassigns existing characters.
   *  @param shift Optional pixel shift to apply when grid expands left/up */
  rebuildFromLayout(layout: OfficeLayout, shift?: { col: number; row: number }): void {
    // Pets hold seat/furniture/tile claims that won't survive a layout rebuild.
    // Drop them outright; they respawn naturally from the spawn loop.
    this.pets.clear();
    this.petFurnitureClaims.clear();

    this.layout = layout;
    this.tileMap = layoutToTileMap(layout);
    this.seats = layoutToSeats(layout.furniture);
    this.blockedTiles = getBlockedTiles(layout.furniture);
    this.rebuildFurnitureInstances();
    this.walkableTiles = getWalkableTiles(this.tileMap, this.blockedTiles);

    // Station uids are regenerated; drop stale claims on every character.
    this.buildStations();
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

  /** Move a character to a random walkable tile */
  private relocateCharacterToWalkable(ch: Character): void {
    if (this.walkableTiles.length === 0) return;
    const spawn = this.walkableTiles[Math.floor(Math.random() * this.walkableTiles.length)];
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

  /** Derive a one-capacity standing point next to each appliance: the first
   *  walkable tile adjacent to its footprint, facing the furniture. */
  private buildStations(): void {
    this.stations = new Map();
    for (const item of this.layout.furniture) {
      if (!APPLIANCE_TYPES.has(item.type)) continue;
      const entry = getCatalogEntry(item.type);
      if (!entry) continue;
      const w = entry.footprintW;
      const h = entry.footprintH;

      // Candidate stand tiles around the footprint (front/below first), each
      // facing back toward the appliance.
      const candidates: Array<{ col: number; row: number; facing: Direction }> = [];
      for (let dc = 0; dc < w; dc++) {
        candidates.push({ col: item.col + dc, row: item.row + h, facing: Direction.UP });
        candidates.push({ col: item.col + dc, row: item.row - 1, facing: Direction.DOWN });
      }
      for (let dr = 0; dr < h; dr++) {
        candidates.push({ col: item.col - 1, row: item.row + dr, facing: Direction.RIGHT });
        candidates.push({ col: item.col + w, row: item.row + dr, facing: Direction.LEFT });
      }

      const spot = candidates.find(
        (c) =>
          isWalkable(c.col, c.row, this.tileMap, this.blockedTiles) &&
          !this.isStationTile(c.col, c.row),
      );
      if (!spot) continue;

      const uid = `station:${item.uid}`;
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
      if (s.occupantId === null) free.push(uid);
    }
    if (free.length === 0) return null;
    return free[Math.floor(Math.random() * free.length)];
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
  private pickDiversePalette(): { palette: number; hueShift: number } {
    // Count how many non-sub-agents use each base palette (0-5)
    const paletteCount = getLoadedCharacterCount();
    const counts = new Array(paletteCount).fill(0) as number[];
    for (const ch of this.characters.values()) {
      if (ch.isSubagent) continue;
      if (ch.palette < paletteCount) counts[ch.palette]++;
    }
    const minCount = Math.min(...counts);
    // Available = palettes at the minimum count (least used)
    const available: number[] = [];
    for (let i = 0; i < paletteCount; i++) {
      if (counts[i] === minCount) available.push(i);
    }
    const palette = available[Math.floor(Math.random() * available.length)];
    // First round (minCount === 0): no hue shift. Subsequent rounds: random ≥45°.
    let hueShift = 0;
    if (minCount > 0) {
      hueShift = HUE_SHIFT_MIN_DEG + Math.floor(Math.random() * HUE_SHIFT_RANGE_DEG);
    }
    return { palette, hueShift };
  }

  addAgent(
    id: number,
    preferredPalette?: number,
    preferredHueShift?: number,
    preferredSeatId?: string,
    skipSpawnEffect?: boolean,
    folderName?: string,
  ): void {
    if (this.characters.has(id)) return;

    let palette: number;
    let hueShift: number;
    if (preferredPalette !== undefined) {
      palette = preferredPalette;
      hueShift = preferredHueShift ?? 0;
    } else {
      const pick = this.pickDiversePalette();
      palette = pick.palette;
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
      ch = createCharacter(id, palette, seatId, seat, hueShift);
    } else {
      // No seats — spawn at random walkable tile
      const spawn =
        this.walkableTiles.length > 0
          ? this.walkableTiles[Math.floor(Math.random() * this.walkableTiles.length)]
          : { col: 1, row: 1 };
      ch = createCharacter(id, palette, null, null, hueShift);
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
    const palette = parentCh ? parentCh.palette : 0;
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

    const ch = createCharacter(id, palette, null, null, hueShift);
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

  getPets(): Pet[] {
    return Array.from(this.pets.values());
  }

  // ── Pet lifecycle ─────────────────────────────────────────

  /** Number of connected agents (real agents, excluding sub-agents & despawning). */
  getConnectedAgentCount(): number {
    let n = 0;
    for (const ch of this.characters.values()) {
      if (ch.id > 0 && !ch.isSubagent && ch.matrixEffect !== 'despawn') n++;
    }
    return n;
  }

  private petTargetCount(): number {
    return Math.min(PET_MAX, Math.floor(this.getConnectedAgentCount() / PET_AGENTS_PER_PET));
  }

  /** Tick spawning, the per-pet FSM, and deletion of finished despawns. */
  private updatePets(dt: number): void {
    const ctx = {
      walkableTiles: this.walkableTiles,
      tileMap: this.tileMap,
      blockedTiles: this.blockedTiles,
      findTarget: (pet: Pet) => this.findFreePetTarget(pet),
      releaseClaim: (pet: Pet) => this.releasePetClaim(pet),
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

    // Spawn / despawn toward the target count
    const target = this.petTargetCount();
    const living = [...this.pets.values()].filter((p) => p.state !== PetState.DESPAWN);
    if (living.length > target) {
      // Too many (agents left) — retire the oldest living pet early
      const oldest = living.reduce((a, b) => (a.lifespanTimer >= b.lifespanTimer ? a : b));
      beginPetDespawn(oldest, ctx);
    } else if (living.length < target) {
      this.petSpawnTimer -= dt;
      if (this.petSpawnTimer <= 0) {
        this.spawnPet();
        this.petSpawnTimer = randomRange(PET_SPAWN_INTERVAL_MIN_SEC, PET_SPAWN_INTERVAL_MAX_SEC);
      }
    }
  }

  /** Spawn one random pet at a free walkable tile (no-op if no sprites/tiles). */
  private spawnPet(): void {
    if (this.walkableTiles.length === 0) return;
    const dogs = getLoadedPetVariantCount('dog');
    const cats = getLoadedPetVariantCount('cat');
    const kinds: PetKind[] = [];
    if (dogs > 0) kinds.push(PetKindEnum.DOG);
    if (cats > 0) kinds.push(PetKindEnum.CAT);
    if (kinds.length === 0) return;

    const kind = kinds[Math.floor(Math.random() * kinds.length)];
    const variantCount = kind === PetKindEnum.DOG ? dogs : cats;
    const variant = Math.floor(Math.random() * variantCount);

    // Avoid spawning on a tile occupied by a character or pet
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

  // ── Pet furniture interaction ─────────────────────────────

  /** Release a pet's seat/furniture claim. */
  private releasePetClaim(pet: Pet): void {
    if (pet.targetSeatId) {
      const seat = this.seats.get(pet.targetSeatId);
      if (seat) seat.assigned = false;
    }
    if (pet.targetFurnitureUid) {
      this.petFurnitureClaims.delete(pet.targetFurnitureUid);
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

  /** First walkable tile adjacent to a furniture footprint (for cats to sit beside). */
  private firstAdjacentWalkableTile(
    item: PlacedFurniture,
    entry: { footprintW: number; footprintH: number },
  ): { col: number; row: number } | null {
    const dirs = [
      { dc: 0, dr: -1 },
      { dc: 0, dr: 1 },
      { dc: -1, dr: 0 },
      { dc: 1, dr: 0 },
    ];
    for (let dr = 0; dr < entry.footprintH; dr++) {
      for (let dc = 0; dc < entry.footprintW; dc++) {
        for (const d of dirs) {
          const col = item.col + dc + d.dc;
          const row = item.row + dr + d.dr;
          if (isWalkable(col, row, this.tileMap, this.blockedTiles)) {
            return { col, row };
          }
        }
      }
    }
    return null;
  }

  /**
   * Find + claim a free interaction target reachable from the pet:
   *  - dogs & cats: any free chair seat
   *  - cats also: a tile adjacent to a free desk/table
   * Returns the claimed target (with a path), or null.
   */
  private findFreePetTarget(pet: Pet): PetTarget | null {
    const candidates: PetTarget[] = [];

    // Chairs (reuse seats) — temporarily unblock the seat tile to path onto it
    for (const [uid, seat] of this.seats) {
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
        seatId: uid,
        furnitureUid: null,
        sitCol: seat.seatCol,
        sitRow: seat.seatRow,
        facing: seat.facingDir,
        path,
      });
    }

    // Desks/tables (cats only) — sit on an adjacent walkable tile
    if (pet.kind === PetKindEnum.CAT) {
      for (const item of this.layout.furniture) {
        const entry = getCatalogEntry(item.type);
        if (!entry || entry.category !== 'desks') continue;
        if (!this.isFurnitureFreeForPet(item.uid)) continue;
        const adj = this.firstAdjacentWalkableTile(item, entry);
        if (!adj) continue;
        const path = findPath(pet.tileCol, pet.tileRow, adj.col, adj.row, this.tileMap, this.blockedTiles);
        const reachable = path.length > 0 || (pet.tileCol === adj.col && pet.tileRow === adj.row);
        if (!reachable) continue;
        // Face from the sit tile toward the furniture
        const dc = item.col - adj.col;
        const dr = item.row - adj.row;
        const facing =
          Math.abs(dc) >= Math.abs(dr)
            ? dc >= 0
              ? Direction.RIGHT
              : Direction.LEFT
            : dr >= 0
              ? Direction.DOWN
              : Direction.UP;
        candidates.push({
          kind: 'furniture',
          seatId: null,
          furnitureUid: item.uid,
          sitCol: adj.col,
          sitRow: adj.row,
          facing,
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
