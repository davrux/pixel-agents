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
import { getAnimationFrames, getCatalogEntry, getOnStateType } from '../layout/furnitureCatalog.js';
import {
  createDefaultLayout,
  getBlockedTiles,
  layoutToFurnitureInstances,
  layoutToSeats,
  layoutToTileMap,
} from '../layout/layoutSerializer.js';
import { findPath, getWalkableTiles, isWalkable } from '../layout/tileMap.js';
import {
  getLoadedCharacterCount,
  getLoadedPetVariantCount,
  getNpcConfig,
  getNpcPosePlaybackLength,
} from '../sprites/spriteData.js';
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
import { snapToTile, stepAlongPath } from './entity.js';
import { matrixEffectSeeds } from './matrixEffect.js';
import type { NpcAction, NpcAffordances, PetTarget } from './pets.js';
import { beginPetDespawn, createPet, petPose, updatePet } from './pets.js';


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
  /** Per-user pinned character palette (folderName → palette index). */
  private palettePrefs = new Map<string, number>();

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
  /** Optional server-injected NPC decision fn (the mistreevous brain). When set,
   *  it chooses a pet's idle activity; otherwise the engine's built-in roll runs. */
  private npcDecide?: (pet: Pet, affordances: NpcAffordances) => NpcAction;

  constructor(layout?: OfficeLayout) {
    this.layout = layout || createDefaultLayout();
    this.tileMap = layoutToTileMap(this.layout);
    this.seats = layoutToSeats(this.layout.furniture);
    this.blockedTiles = getBlockedTiles(this.layout.furniture);
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
    this.blockedTiles = getBlockedTiles(layout.furniture);
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
      const entry = getCatalogEntry(item.type);
      if (!entry?.appliance) continue; // data-driven: only furniture marked as an appliance

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

  /** After the character roster shrinks, drop pinned palettes that no longer
   *  exist and re-randomise (diverse) any live agents stuck on a missing
   *  palette — so a deleted custom character falls back to a random skin.
   *  Returns the folderNames whose pinned palette was dropped. */
  dropInvalidPalettes(count: number): string[] {
    const dropped: string[] = [];
    for (const [name, pal] of this.palettePrefs) {
      if (pal >= count) {
        this.palettePrefs.delete(name);
        dropped.push(name);
      }
    }
    for (const ch of this.characters.values()) {
      if (ch.isSubagent || ch.palette < count) continue;
      const pick = this.pickDiversePalette();
      ch.palette = pick.palette;
      ch.hueShift = pick.hueShift;
    }
    return dropped;
  }

  /** Unpin a user's character palette and re-randomise their live agents
   *  (back to a diverse skin). */
  clearPalettePref(folderName: string): void {
    if (!folderName || !this.palettePrefs.has(folderName)) return;
    this.palettePrefs.delete(folderName);
    for (const ch of this.characters.values()) {
      if (!ch.isSubagent && ch.folderName === folderName) {
        const pick = this.pickDiversePalette();
        ch.palette = pick.palette;
        ch.hueShift = pick.hueShift;
      }
    }
  }

  /** Pin a user's character palette and recolor any of their live agents. */
  setPalettePref(folderName: string, palette: number): void {
    if (!folderName) return;
    this.palettePrefs.set(folderName, palette);
    for (const ch of this.characters.values()) {
      if (!ch.isSubagent && ch.folderName === folderName) {
        ch.palette = palette;
        ch.hueShift = 0;
      }
    }
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
    const pref = folderName ? this.palettePrefs.get(folderName) : undefined;
    if (preferredPalette !== undefined) {
      palette = preferredPalette;
      hueShift = preferredHueShift ?? 0;
    } else if (pref !== undefined) {
      // The viewer pinned a character for this user → always use it.
      palette = pref;
      hueShift = 0;
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

  // ── Players (human viewer avatars) ────────────────────────────────

  /** Spawn a human player's avatar (a viewer-driven Character, not the agent
   *  FSM) at a free walkable tile. Returns its id. */
  addPlayer(preferredPalette?: number, name?: string, spawnAt?: { col: number; row: number }): number {
    const id = this.nextPlayerId++;
    let palette: number;
    let hueShift: number;
    if (preferredPalette !== undefined) {
      palette = preferredPalette;
      hueShift = 0;
    } else {
      const pick = this.pickDiversePalette();
      palette = pick.palette;
      hueShift = pick.hueShift;
    }
    const ch = createCharacter(id, palette, null, null, hueShift);
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
   *  furniture footprint, and not occupied by another character or pet. Prefers
   *  `preferred` (e.g. a zone's arrival tile) when it's free; else a random free
   *  tile; else any walkable tile as a last resort. */
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
      isWalkable(t.col, t.row, this.tileMap, this.blockedTiles) && !occupied.has(`${t.col},${t.row}`);

    if (preferred && isFree(preferred)) return preferred;
    const free = this.walkableTiles.filter(isFree);
    const pool = free.length > 0 ? free : this.walkableTiles;
    return pool.length > 0 ? pool[Math.floor(Math.random() * pool.length)] : { col: 1, row: 1 };
  }

  /** Recolor a character (used to change a player's chosen avatar skin). */
  setCharacterPalette(id: number, palette: number, hueShift = 0): void {
    const ch = this.characters.get(id);
    if (ch) {
      ch.palette = palette;
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

  /** Walk a player's avatar to a tile (viewer click-to-move). Paths via the
   *  shared pathfinder; returns false if the target is unreachable/unwalkable. */
  walkPlayer(id: number, col: number, row: number): boolean {
    const ch = this.characters.get(id);
    if (!ch || !ch.isPlayer) return false;
    if (!isWalkable(col, row, this.tileMap, this.blockedTiles)) return false;
    const path = findPath(ch.tileCol, ch.tileRow, col, row, this.tileMap, this.blockedTiles);
    if (path.length === 0) return false;
    ch.heldDir = null; // a click-to-walk target overrides any held WASD direction
    ch.path = path;
    ch.moveProgress = 0;
    ch.state = CharacterState.WALK;
    ch.frame = 0;
    ch.frameTimer = 0;
    return true;
  }

  /** Set (or clear, with null) a player's held WASD direction. Continuous
   *  keyboard walking: while held, the player steps tile-by-tile that way
   *  (validated per step). Abandons any in-flight click-to-walk path. */
  setPlayerDir(id: number, dir: Direction | null): boolean {
    const ch = this.characters.get(id);
    if (!ch || !ch.isPlayer) return false;
    ch.heldDir = dir;
    // Drop a click-to-walk target so the key takes over, but keep the current
    // in-progress step so the avatar isn't stranded mid-tile.
    if (dir !== null && ch.path.length > 1) ch.path = [ch.path[0]];
    return true;
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

  /** Advance a player's avatar: click-to-walk feeds a path; WASD feeds a held
   *  direction that steps tile-by-tile (chained so it doesn't stutter). */
  private updatePlayerMovement(ch: Character, dt: number): void {
    // Standing at a tile with a key held → begin a step that way.
    if (ch.path.length === 0) this.tryStepHeldDir(ch);

    if (ch.path.length === 0) {
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
        ch.state = CharacterState.IDLE;
        // Came to rest on a portal tile → queue it (room offers a destination
        // picker). Only on arrival/rest, so walking across doesn't spam it.
        if (this.portalTiles.has(`${ch.tileCol},${ch.tileRow}`)) this.pendingPortals.push(ch.id);
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

  /** A free seat (any pet) or, for cats, a free desk exists somewhere. */
  private hasRestAffordance(pet: Pet): boolean {
    for (const seat of this.seats.values()) {
      if (!seat.assigned) return true;
    }
    if (pet.kind === PetKindEnum.CAT) {
      for (const item of this.layout.furniture) {
        const entry = getCatalogEntry(item.type);
        if (entry?.category === 'desks' && this.isFurnitureFreeForPet(item.uid)) return true;
      }
    }
    return false;
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
   * Find + claim a free interaction target reachable from the pet for `action`:
   *  - 'sit'  → any free chair seat (dogs & cats) or, for cats, a tile adjacent
   *             to a free desk/table
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
        path,
      });
    }

    // Desks/tables (cats only) — sit on an adjacent walkable tile
    if (action === 'sit' && pet.kind === PetKindEnum.CAT) {
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
          action: 'sit',
          seatId: null,
          furnitureUid: item.uid,
          stationId: null,
          agentId: null,
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
