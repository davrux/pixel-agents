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

/**
 * A generic action attachable to any placed furniture instance
 * (`PlacedFurniture.action`) or any tile (`OfficeLayout.tileActions`) —
 * replaces the old per-feature furniture-catalog flags (conference/arcade/
 * meetingRoom/appliance) and the tile-only `tilePrivateArea` boolean with one
 * model. Player-only: NPCs/agents never trigger any of these (enforced once,
 * server-side, in OfficeState.walkPlayerToAction's `ch.isPlayer` check).
 *
 * Trigger rule: a furniture action requires an explicit click (walk-then-
 * open, like today's arcade/kiosk/conference); a tile action fires the
 * moment a player's tile matches it (like today's portals and meeting
 * areas) — 'meetingRoom' on a tile is membership-by-position (join/leave by
 * walking in/out, no explicit trigger), everything else on a tile is
 * edge-triggered once on arrival.
 */
export type Action =
  /** In-world video/audio call via ConferenceUI/LiveKitConference — on
   *  furniture this is today's conference monitor (explicit join/leave
   *  click); on a tile this is today's walk-in meeting area (automatic
   *  membership). video:false = camera never offered, audio+chat only. */
  | { kind: 'meetingRoom'; video: boolean }
  /** Opens the "manage my shareable /meet/<slug> links" dialog — today's
   *  meeting kiosk. The actual call happens on the separate /meet page, not
   *  in-world. */
  | { kind: 'linkManager' }
  /** Opens a sandboxed iframe overlay with this URL. https:// only. */
  | { kind: 'iframe'; url: string }
  /** Cosmetic pose+timer, no room/video — today's coffee machine. */
  | { kind: 'appliance'; pose: ApplianceKind }
  /** js-dos emulator overlay with per-player saves + an optional
   *  multiplayer lobby — today's arcade cabinet. */
  | { kind: 'arcade' };

export interface FurnitureCatalogEntry {
  type: string; // asset ID from furniture manifest
  label: string;
  footprintW: number;
  footprintH: number;
  sprite: SpriteData;
  isDesk: boolean;
  category?: string;
  /** Whether this furniture is a zone portal (door / beam pad): walking to it
   *  offers a destination picker. */
  portal?: boolean;
  /** This type's default Action (see effectiveAction) — every placed instance
   *  gets this unless it carries its own PlacedFurniture.action override. Set
   *  via FurnitureEditor's Action picker (the same TILE_ACTION_CHOICES list
   *  LayoutEditor uses for per-instance overrides). */
  action?: Action;
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
  /** @deprecated superseded by approachSides (LayoutEditor no longer exposes
   *  a control for this) — kept only so old saved layouts keep resolving a
   *  wall-mounted item's ambiguous side exactly as before. Still read by
   *  computeApproachTiles as the fallback when approachSides is unset/empty.
   *  DOWN = approached from the art side (the row the sprite renders in,
   *  above the wall); UP = approached from the far side (below the wall). */
  facing?: Direction;
  /** Which side(s) a player may approach this item from, for any Action-
   *  bearing or appliance item (not just wall-mounted ones) — see
   *  computeApproachTiles. Unset or empty = today's automatic behaviour
   *  (every physically open side works, with `facing` still resolving a
   *  wall's ambiguous side); a non-empty set is an explicit allow-list that
   *  overrides that automatic resolution entirely. Editable via
   *  LayoutEditor's 🧭 "Approach sides…" control. */
  approachSides?: Array<'N' | 'S' | 'E' | 'W'>;
  /** Manual stacking override for items sharing a tile (e.g. a table, a cup on
   *  it, and a wall TV all overlapping) — a relative layer index among the
   *  overlapping group, not an absolute depth. Positive = closer to front,
   *  negative = further back. Set via LayoutEditor's "bring to front"/"send
   *  to back" controls (shown only when the selection overlaps another
   *  item); unset (0) leaves the normal position-based sort order untouched. */
  zOffset?: number;
  /** Per-instance action override (see Action) — takes priority over the
   *  catalog entry's own default action (FurnitureCatalogEntry.action; see
   *  effectiveAction in furnitureCatalog.ts). Lets any placed item carry any
   *  action, e.g. turning a specific arcade cabinet into a link-manager
   *  kiosk instead, without a new catalog type. */
  action?: Action;
}

/** A free-text label placed on one tile — purely decorative (no footprint,
 *  no walkability effect), rendered as a floating sign at that tile. Placed/
 *  edited/deleted via the editor's Text tool (one prompt per click, no
 *  drag-paint); an empty edit deletes it. Draggable in the Select tool like
 *  furniture. */
export interface PlacedText {
  uid: string;
  col: number;
  row: number;
  text: string;
  /** Font size in px. Unset = the default (see TEXT_LABEL_DEFAULT_FONT_SIZE). */
  fontSize?: number;
  /** CSS font-family value, one of TEXT_LABEL_FONT_CHOICES (protocol.ts).
   *  Unset = the default pixel font. Closed set (not free text) — sanitized
   *  server-side same as everything else user-authored in a layout. */
  fontFamily?: string;
  /** Free rotation in degrees (0-359, normalized), pivoted at the label's own
   *  anchor (bottom-center of its tile). Unset = 0 (upright, unrotated). */
  angle?: number;
}

/** One tile's Action (see Action), positioned by its own (col,row) — sparse:
 *  only tiles that actually carry an action have an entry, unlike the old
 *  dense-array field this replaced (most tiles never do). This shape is
 *  also what makes the format map cleanly onto a Tiled object layer, where
 *  every entry is naturally "an object with a position" rather than a slot
 *  in a per-cell grid (see OfficeLayout.tileActions). At most one entry per
 *  (col,row) — a second paint at the same tile replaces the first. */
export interface TileAction {
  col: number;
  row: number;
  action: Action;
}

export interface OfficeLayout {
  version: 2;
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
  /** Per-tile action (see Action and TileAction) — painted with the editor's
   *  Action tool. For 'meetingRoom' tiles, every maximal 4-connected group of
   *  same-kind tiles is one area (id assigned by flood fill at layout-build
   *  time, see computeActionAreas — never stored, always derived, so ids stay
   *  unique/contiguous by construction and two areas painted separately then
   *  later bridged just merge into one on the next rebuild); standing in one
   *  automatically joins you (no explicit click), independent of a furniture
   *  'meetingRoom' action's explicit join/leave click. Every other action
   *  kind fires once when a player's tile matches it (edge-triggered, like a
   *  portal). */
  tileActions?: TileAction[];
  /** Free-text labels — see PlacedText. Painted with the editor's Text tool. */
  texts?: PlacedText[];
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
  /** When walking to a furniture item's action (conference monitor,
   *  link-manager kiosk, arcade cabinet, iframe sprite, …), what to notify
   *  the room of on arrival (the room then tells the owning client to open
   *  its local UI, or — for 'meetingRoom' — adds them to that room's
   *  membership; see officeState.walkPlayerToAction); null = none.
   *  Server-only intent. Appliances are a separate field (pendingAppliance)
   *  since they use the pre-built station/occupancy system, not this. */
  pendingAction?: { action: Action; col: number; row: number; facing: Direction } | null;
  /** When walking to an appliance (e.g. coffee machine), the station to start
   *  standing at + the facing on arrival; null = none. Server-only intent. */
  pendingAppliance?: { stationUid: string; facing: Direction } | null;
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
