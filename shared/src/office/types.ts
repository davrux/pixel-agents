export {
  DEFAULT_COLS,
  DEFAULT_ROWS,
  MATRIX_EFFECT_DURATION_SEC as MATRIX_EFFECT_DURATION,
  MAX_COLS,
  MAX_ROWS,
  TILE_SIZE,
} from './constants.js';

export const TileType = {
  WALL: 0,
  FLOOR_1: 1,
  FLOOR_2: 2,
  FLOOR_3: 3,
  FLOOR_4: 4,
  FLOOR_5: 5,
  FLOOR_6: 6,
  FLOOR_7: 7,
  FLOOR_8: 8,
  FLOOR_9: 9,
  FLOOR_10: 10, // grass (garden/outside zones) — floors/floor_9.png
  FLOOR_11: 11, // water (ponds) — floors/floor_10.png
  VOID: 255,
} as const;
export type TileType = (typeof TileType)[keyof typeof TileType];

/** Re-export ColorValue for consumers that import color types from office/types */
export type { ColorValue } from './colorTypes.js';
import type { ColorValue } from './colorTypes.js';

export const CharacterState = {
  IDLE: 'idle',
  WALK: 'walk',
  TYPE: 'type',
  SIT: 'sit', // player rest emote (sit in place); cleared by moving
} as const;
export type CharacterState = (typeof CharacterState)[keyof typeof CharacterState];

/**
 * Animation pose — what a character is *doing*, decoupled from the movement
 * state so the renderer can pick frames without re-deriving tool/station logic.
 * Computed server-side (it needs stationId) and synced. Add new poses here and
 * map them in spriteForPose(); 'coffee' reuses the idle frames until dedicated
 * art exists.
 */
export const CharacterPose = {
  IDLE: 'idle',
  WALK: 'walk',
  TYPING: 'typing',
  READING: 'reading',
  COFFEE: 'coffee',
  SIT: 'sit', // sit-in-place; uses a synthesized seated frame until art is authored
} as const;
export type CharacterPose = (typeof CharacterPose)[keyof typeof CharacterPose];

export const Direction = {
  DOWN: 0,
  LEFT: 1,
  RIGHT: 2,
  UP: 3,
} as const;
export type Direction = (typeof Direction)[keyof typeof Direction];

/** 2D array of hex color strings: '' = transparent, '#RRGGBB' = opaque, '#RRGGBBAA' = semi-transparent. [row][col] */
export type SpriteData = string[][];

export interface Seat {
  /** Chair furniture uid */
  uid: string;
  /** Tile col where agent sits */
  seatCol: number;
  /** Tile row where agent sits */
  seatRow: number;
  /** Direction character faces when sitting (toward adjacent desk) */
  facingDir: Direction;
  assigned: boolean;
}

export type Posture = 'sit' | 'stand';
export type StationKind = 'desk' | 'lounge' | 'appliance';

/**
 * A place an agent can occupy and do something at — the generalised version of
 * Seat. Appliances such as the coffee machine yield a `stand` point on the
 * adjacent walkable tile, facing the furniture. Capacity is one (`occupantId`).
 *
 * For now this models the new standing stations only; chair seats still use the
 * `Seat` type above and are intended to fold into this in a later step.
 */
export interface InteractionPoint {
  uid: string;
  /** Tile col the agent stands/sits on */
  col: number;
  /** Tile row the agent stands/sits on */
  row: number;
  /** Direction the agent faces while here (toward the furniture) */
  facingDir: Direction;
  posture: Posture;
  station: StationKind;
  /** Furniture type this point belongs to (e.g. 'COFFEE_MACHINE') */
  furnitureType: string;
  /** Agent id currently occupying it, or null when free */
  occupantId: number | null;
}

// ── Pets ─────────────────────────────────────────────────────
export const PetKind = { DOG: 'dog', CAT: 'cat', DUCK: 'duck' } as const;
export type PetKind = (typeof PetKind)[keyof typeof PetKind];

export const PetState = {
  SPAWN: 'spawn', // brief fade-in before wandering
  WANDER: 'wander', // walking along a path
  IDLE: 'idle', // standing still, deciding next move
  SIT: 'sit', // sitting at claimed furniture, tail wagging
  DRINK: 'drink', // standing at a claimed appliance station (coffee), idle pose
  TALK: 'talk', // standing next to a claimed agent, facing it (talk pose)
  DESPAWN: 'despawn', // fade-out, then delete
} as const;
export type PetState = (typeof PetState)[keyof typeof PetState];

export interface Pet {
  id: number;
  kind: PetKind;
  /** Which sprite-sheet variant (dog_N / cat_N / duck_N) */
  variant: number;
  state: PetState;
  dir: Direction;
  /** Pixel position (tile-center anchored) */
  x: number;
  y: number;
  tileCol: number;
  tileRow: number;
  path: Array<{ col: number; row: number }>;
  moveProgress: number;
  frame: number;
  frameTimer: number;
  /** Countdown to next wander decision while idle */
  wanderTimer: number;
  // Interaction target / claim
  targetKind: 'seat' | 'furniture' | 'station' | 'agent' | null;
  /** What the pet will do on reaching its target (null when none); see NpcAction.
   *  Kept as a literal union (mirrors NpcAction) to avoid an engine→types cycle. */
  targetAction: 'wander' | 'sit' | 'chase' | 'flee' | 'drink' | 'talk' | null;
  targetSeatId: string | null;
  /** Claimed appliance station uid (coffee), or null. */
  targetStationId: string | null;
  /** Claimed agent id being talked to, or null. */
  targetAgentId: number | null;
  targetFurnitureUid: string | null;
  /** Tile the pet sits on while interacting */
  sitTileCol: number;
  sitTileRow: number;
  sitFacingDir: Direction;
  /** Remaining time to stay seated */
  sitTimer: number;
  /** Vertical render lift (px) while resting: >0 when sitting ON a desk surface,
   *  so the renderer draws the pet up on the desk top (0 for floor/chair sits). */
  restLift: number;
  /** Counts up; despawn triggered at PET_LIFESPAN_SEC */
  lifespanTimer: number;
  /** Active spawn/despawn fade effect */
  effect: 'spawn' | 'despawn' | null;
  effectTimer: number;
}

export interface FurnitureInstance {
  sprite: SpriteData;
  /** Pixel x (top-left) */
  x: number;
  /** Pixel y (top-left) */
  y: number;
  /** Y value used for depth sorting (typically bottom edge) */
  zY: number;
  /** Render-time horizontal flip flag (for mirrored side variants) */
  mirrored?: boolean;
}

export interface ToolActivity {
  toolId: string;
  status: string;
  done: boolean;
  permissionWait?: boolean;
}

export const EditTool = {
  TILE_PAINT: 'tile_paint',
  WALL_PAINT: 'wall_paint',
  FURNITURE_PLACE: 'furniture_place',
  FURNITURE_PICK: 'furniture_pick',
  SELECT: 'select',
  EYEDROPPER: 'eyedropper',
  ERASE: 'erase',
} as const;
export type EditTool = (typeof EditTool)[keyof typeof EditTool];

/** A furniture item's interaction affordance: marks it as an appliance station
 *  an NPC (or agent) walks up to and uses. Coffee for now; extensible (fridge,
 *  water cooler, …). Empty/undefined = ordinary furniture. */
export type ApplianceKind = 'coffee';

export interface FurnitureCatalogEntry {
  type: string; // asset ID from furniture manifest
  label: string;
  footprintW: number;
  footprintH: number;
  sprite: SpriteData;
  isDesk: boolean;
  category?: string;
  /** Interaction station this furniture provides (coffee, …), or undefined. */
  appliance?: ApplianceKind;
  /** Whether this furniture is a zone portal (door / beam pad): walking to it
   *  offers a destination picker. */
  portal?: boolean;
  /** Whether this furniture is a conference monitor: clicking it joins a
   *  per-monitor video call (WebRTC). */
  conference?: boolean;
  /** Whether this furniture is an arcade cabinet: clicking it launches a DOS game. */
  arcade?: boolean;
  /** Whether this furniture creates ad-hoc meeting rooms: clicking it opens a
   *  dialog to mint a random-link, password-optional, expiring video/audio room. */
  meetingRoom?: boolean;
  /** Orientation from rotation group: 'front' | 'back' | 'left' | 'right' */
  orientation?: string;
  /** Whether this item can be placed on top of desk/table surfaces */
  canPlaceOnSurfaces?: boolean;
  /** Number of tile rows from the top of the footprint that are "background" (allow placement, still block walking). Default 0. */
  backgroundTiles?: number;
  /** Whether this item can be placed on wall tiles */
  canPlaceOnWalls?: boolean;
  /** Whether a wall-mountable item (canPlaceOnWalls) may ALSO be placed on
   *  ordinary floor tiles, rather than requiring a wall. No effect if
   *  canPlaceOnWalls is false (floor is already the only option then). */
  canPlaceOnFloor?: boolean;
  /** Whether this is a side-oriented asset that produces a mirrored "left" variant */
  mirrorSide?: boolean;
}

export interface PlacedFurniture {
  uid: string;
  type: string; // asset ID from furniture manifest
  col: number;
  row: number;
  /** Optional color override for furniture */
  color?: ColorValue;
  /** Optional instance name (e.g. a conference monitor's stable room name). */
  name?: string;
  /** Wall-mounted items only (canPlaceOnWalls): which side a player approaches
   *  from, when a wall has walkable floor on BOTH sides (e.g. a room divider)
   *  and the correct side genuinely can't be inferred from the tile map alone.
   *  DOWN = approached from the art side (the row the sprite renders in,
   *  above the wall); UP = approached from the far side (below the wall).
   *  Ignored when only one side is walkable — isWalkable already resolves
   *  that case on its own. Unset defaults to UP (the far side), matching the
   *  engine's long-standing default. Editable via LayoutEditor's flip-facing
   *  control (shown for wall-mountable, interactive items). */
  facing?: Direction;
  /** Manual stacking override for items sharing a tile (e.g. a table, a cup on
   *  it, and a wall TV all overlapping) — a relative layer index among the
   *  overlapping group, not an absolute depth. Positive = closer to front,
   *  negative = further back. Set via LayoutEditor's "bring to front"/"send
   *  to back" controls (shown only when the selection overlaps another
   *  item); unset (0) leaves the normal position-based sort order untouched. */
  zOffset?: number;
}

export interface OfficeLayout {
  version: 1;
  cols: number;
  rows: number;
  tiles: TileType[];
  furniture: PlacedFurniture[];
  /** Per-tile color settings, parallel to tiles array. null = wall/no color */
  tileColors?: Array<ColorValue | null>;
  /** Per-tile "blocks movement" flag, parallel to tiles array — independent of
   *  floor pattern (e.g. a puddle painted with the same pattern as the rest of
   *  the room, but this one tile shouldn't be walkable). true = blocked;
   *  false/missing = normal. Painted with the editor's Block tool; merged into
   *  officeState's blockedTiles alongside furniture footprints. */
  tileBlocked?: boolean[];
  /** Bumped when the bundled default layout changes; forces a reset on existing installs */
  layoutRevision?: number;
}

export interface Character {
  id: number;
  state: CharacterState;
  /** Animation pose (server-computed, synced). Optional on the engine side; the
   *  renderer reads it, falling back to deriving from state when absent. */
  pose?: CharacterPose;
  dir: Direction;
  /** Pixel position */
  x: number;
  y: number;
  /** Current tile column */
  tileCol: number;
  /** Current tile row */
  tileRow: number;
  /** Remaining path steps (tile coords) */
  path: Array<{ col: number; row: number }>;
  /** 0-1 lerp between current tile and next tile */
  moveProgress: number;
  /** Current tool name for typing vs reading animation, or null */
  currentTool: string | null;
  /** Stable skin id (e.g. `char_3`) — which character template this uses. */
  skin: string;
  /** Hue shift in degrees (0 = no shift, ≥45 for repeated palettes) */
  hueShift: number;
  /** Animation frame index */
  frame: number;
  /** Time accumulator for animation */
  frameTimer: number;
  /** Timer for idle wander decisions */
  wanderTimer: number;
  /** Number of wander moves completed in current roaming cycle */
  wanderCount: number;
  /** Max wander moves before returning to seat for rest */
  wanderLimit: number;
  /** Whether the agent is actively working */
  isActive: boolean;
  /** Assigned seat uid, or null if no seat */
  seatId: string | null;
  /** Interaction station (e.g. coffee machine) being visited, or null */
  stationId: string | null;
  /** Remaining time to stand at the current station, in seconds */
  stationTimer: number;
  /** Cooldown before the agent may take another coffee break, in seconds */
  coffeeCooldown: number;
  /** Active speech bubble type, or null if none showing */
  bubbleType: 'permission' | 'waiting' | null;
  /** Countdown timer for bubble (waiting: 2→0, permission: unused) */
  bubbleTimer: number;
  /** Timer to stay seated while inactive after seat reassignment (counts down to 0) */
  seatTimer: number;
  /** Whether this character represents a sub-agent (spawned by Task tool) */
  isSubagent: boolean;
  /** Whether this character is a human player's avatar (viewer-driven, not the
   *  agent FSM; spawned on join). */
  isPlayer: boolean;
  /** Player marked themselves away (/afk); shows an "afk" marker, cleared on move. */
  afk?: boolean;
  /** Held WASD direction for continuous keyboard walking, or null. Server-only
   *  movement intent (not synced) — the resulting transform/state is synced. */
  heldDir?: Direction | null;
  /** When walking to a seat (click-to-sit), the direction to face on arrival;
   *  null = no pending sit. Server-only intent. */
  pendingSitFacing?: Direction | null;
  /** When walking to a conference monitor, the monitor key to join + the facing
   *  on arrival; null = none. Server-only intent. */
  pendingConference?: { key: string; facing: Direction } | null;
  /** When walking to an appliance (e.g. coffee machine), the station to start
   *  standing at + the facing on arrival; null = none. Server-only intent. */
  pendingAppliance?: { stationUid: string; facing: Direction } | null;
  /** When walking to an arcade cabinet or meeting-room kiosk, what to notify
   *  the room of on arrival (the room then tells the owning client to open its
   *  local UI — see officeState.walkPlayerToInteraction); null = none.
   *  Server-only intent. */
  pendingInteraction?: { kind: 'arcade' | 'meetingRoom'; col: number; row: number; facing: Direction } | null;
  /** Parent agent ID if this is a sub-agent, null otherwise */
  parentAgentId: number | null;
  /** Active matrix spawn/despawn effect, or null */
  matrixEffect: 'spawn' | 'despawn' | null;
  /** Timer counting up from 0 to MATRIX_EFFECT_DURATION */
  matrixEffectTimer: number;
  /** Per-column random seeds (16 values) for staggered rain timing */
  matrixEffectSeeds: number[];
  /** Workspace folder name (only set for multi-root workspaces) */
  folderName?: string;

  // -- Agent Teams --
  /** Team name this agent belongs to */
  teamName?: string;
  /** Role name within the team (null for lead) */
  agentName?: string;
  /** Whether this agent is the team lead */
  isTeamLead?: boolean;
  /** ID of the lead agent (set on teammates) */
  leadAgentId?: number;
  /** True when lead spawns teammates via tmux (run_in_background Agent calls) */
  teamUsesTmux?: boolean;
  /** Cumulative input tokens consumed */
  inputTokens: number;
  /** Cumulative output tokens consumed */
  outputTokens: number;
}
