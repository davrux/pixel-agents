export {
  DEFAULT_COLS,
  DEFAULT_ROWS,
  MATRIX_EFFECT_DURATION_SEC as MATRIX_EFFECT_DURATION,
  MAX_COLS,
  MAX_ROWS,
  TILE_SIZE,
} from './constants.js';

/** A ground cell is a floor pattern (1-based, matching a row of the floor set —
 *  see tiledSheetLayout.ts) or VOID. There is no WALL member: a wall is an EDGE
 *  between two cells now (see WallEdges), not a cell of its own, so 0 is simply
 *  an unused value rather than a meaning. */
export const TileType = {
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
  /** Render-time vertical flip flag — see PlacedFurniture.flippedVertically. */
  flippedVertically?: boolean;
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
  | { kind: 'meetingManager' }
  /** Opens a sandboxed iframe overlay with this URL. https:// only. */
  | { kind: 'iframe'; url: string }
  /** Cosmetic pose+timer, no room/video — today's coffee machine. */
  | { kind: 'appliance'; pose: ApplianceKind }
  /** js-dos emulator overlay with per-player saves + an optional
   *  multiplayer lobby — today's arcade cabinet. */
  | { kind: 'arcade' }
  /** Zone travel — walking onto this furniture's own footprint (or a tile
   *  carrying this action directly) offers a destination picker, same as
   *  today's door/beam-pad. Triggers on arrival/rest, like every other
   *  auto-firing action — not a click. */
  | { kind: 'portal' }
  /** Flip an on/off state pair (see FurnitureCatalogEntry.onState) between its
   *  two poses — a literal light-switch. Carrying this action is itself what
   *  makes the pair click-driven rather than seat-driven. No client notification;
   *  the resulting type swap reaches everyone through the normal furniture
   *  sync, same as the auto-facing on/off already does. */
  | { kind: 'toggle' }
  /** Marks a tile as this zone's arrival point — consumed once, at Tiled
   *  import time (see zoneImport.ts), to set the zone's own `arrive` col/row
   *  (previously only settable in-game via the Zones panel's "Arrival
   *  point" click flow). Only meaningful as a TILE action; a furniture
   *  instance carrying it does nothing at runtime — there's no per-arrival
   *  trigger the way portal/meetingRoom have, it's purely a marker read
   *  once on import. Left in tileActions afterward like any other action
   *  (so click-to-move still softly avoids walking across it), not
   *  stripped out. */
  | { kind: 'spawnPoint' };

/**
 * The behaviour of a piece of furniture is stated, never inferred.
 *
 * Every property below that describes what an item DOES (rather than what it
 * looks like) exists on both this catalog entry and on PlacedFurniture, and is
 * resolved instance-first — see furnitureCatalog.ts's resolve* helpers. The
 * catalog value is the sensible default for that art ("a chair is sittable"),
 * the instance value is the exception ("you may sit on THIS coffee machine").
 *
 * This replaced a set of rules that derived behaviour from `category`: chairs
 * were sittable because their category said 'chairs', desks hosted pets because
 * theirs said 'desks'. That meant a mapper who drew a new chair and gave it the
 * right category still got a chair nobody could sit on if they missed one of
 * several other properties, with nothing to point at. Categories are gone
 * entirely; behaviour is now visible on the tile itself.
 */
export interface FurnitureCatalogEntry {
  /** Stable, unique catalog identifier — was called `type` (renamed: this is
   *  an identity, not a taxonomy). */
  id: string;
  label: string;
  footprintW: number;
  footprintH: number;
  sprite: SpriteData;
  /** This type's default Action (see effectiveAction) — every placed instance
   *  gets this unless it carries its own PlacedFurniture.action override. */
  action?: Action;
  /** May a character sit on this? (see resolveCanSitOn) */
  canSitOn?: boolean;
  /** Which way a sitting character looks (see resolveSitFacing). */
  sitFacing?: Direction;
  /** May a pet rest on top of this? (see resolvePetCanSitOn) */
  petCanSitOn?: boolean;
  /** Number of tile rows from the top of the footprint that are "background"
   *  — stay walkable, and can have another item's footprint placed over
   *  them too (see layoutSerializer.ts's getBlockedTiles/
   *  getPlacementBlockedTiles, which both skip these rows). Default 0.
   *  Unlike its neighbours here this describes the ART — which rows of the
   *  sprite are a backrest or a wall-mounted upper half — so the catalog
   *  value is normally the right one; the instance override exists because
   *  nothing else can free up a furniture tile (Collision only ever adds). */
  backgroundTiles?: number;
  /** The catalog id this item turns INTO when switched on, for an on/off pair
   *  (e.g. a dark PC becoming a lit one). Set on the "off" half only; the
   *  named "on" half needs nothing. What triggers the switch follows from the
   *  Action rather than a separate setting: a 'toggle' Action means a click
   *  flips it, no action at all means it lights up on its own while someone
   *  sits facing it. Was derived from a shared `stateGroup` plus matching
   *  `state: off|on` values, which paired items by convention; naming the
   *  partner outright says the same thing without the guesswork. */
  onState?: string;
}

export interface PlacedFurniture {
  uid: string;
  /** Which catalog entry this is — see FurnitureCatalogEntry.id (was `type`). */
  id: string;
  col: number;
  row: number;
  /** Optional instance name (e.g. a conference monitor's stable room name). */
  name?: string;
  /** Per-instance overrides of the catalog defaults with the same names (see
   *  FurnitureCatalogEntry, and the resolve* helpers in furnitureCatalog.ts).
   *  Unset means "whatever this type says"; setting one is how a mapper makes
   *  a single placement behave unlike the rest of its kind. */
  canSitOn?: boolean;
  sitFacing?: Direction;
  petCanSitOn?: boolean;
  backgroundTiles?: number;
  onState?: string;
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
  /** Horizontal/vertical mirror, adopted directly from Tiled's own object-flip
   *  concept (named after Tiled's own `FLIPPED_HORIZONTALLY_FLAG`/
   *  `FLIPPED_VERTICALLY_FLAG` — see docs/design/tiled-editor-integration.md)
   *  rather than an invented term. No catalog-level gate on which types may
   *  use either — there's no equivalent gate in Tiled either, and whether a
   *  vertical flip looks right for a given hand-drawn 2.5D piece is the
   *  mapper's own call to make in Tiled, not this engine's to police.
   *  Continuous rotation, which Tiled's object model also supports, is still
   *  not adopted (same reasoning that killed rotation groups: there's no
   *  sensible rotated frame for art drawn from one fixed camera angle) — but
   *  a flip is just mirroring the SAME frame, always well-defined. */
  flippedHorizontally?: boolean;
  flippedVertically?: boolean;
  /** Lets players search THROUGH this item for a place to stand when
   *  approaching some other action/appliance behind it (e.g. a kitchen
   *  counter in front of a coffee machine) — see computeApproachTiles. This
   *  item still blocks ordinary movement/placement exactly as before; the
   *  only change is that the approach-tile search doesn't treat it as a dead
   *  end and keeps looking one tile further out in the same direction.
   *  Editable via LayoutEditor's Select tool ("Reach-through" toggle). Unset
   *  = false (today's behaviour: a blocked neighbor tile is never usable). */
  approachThrough?: boolean;
}

/** A free-text label placed on one tile — purely decorative (no footprint,
 *  no walkability effect), rendered as a floating sign at that tile. Placed/
 *  edited/deleted via the editor's Text tool (one prompt per click, no
 *  drag-paint); an empty edit deletes it. Draggable in the Select tool like
 *  furniture. */
export interface PlacedText {
  uid: string;
  /** Free pixel position (not tile-snapped) of the label's anchor — its
   *  bottom-center, matching Phaser's origin (0.5, 1) for the rendered Text
   *  object. Unlike furniture/images, a label can sit anywhere, same as an
   *  Insert-Text object in Tiled. */
  x: number;
  y: number;
  text: string;
  /** Font size in px. Unset = the default (see TEXT_LABEL_DEFAULT_FONT_SIZE). */
  fontSize?: number;
  /** CSS font-family value, one of TEXT_LABEL_FONT_CHOICES (protocol.ts).
   *  Unset = the default pixel font. Closed set (not free text) — sanitized
   *  server-side same as everything else user-authored in a layout. */
  fontFamily?: string;
  /** Free rotation in degrees (0-359, normalized), pivoted at the label's own
   *  anchor (bottom-center). Unset = 0 (upright, unrotated). */
  angle?: number;
  /** Text fill color, `#rrggbb` — read from/written to Tiled's own native
   *  Text object `color` property (which itself is `#rrggbb`/`#aarrggbb`; the
   *  alpha channel isn't modeled here, a label is always opaque). Unset =
   *  Tiled's own default for an unstyled text object (black). */
  color?: string;
}

/** A raster image (PNG) placed as pure background decoration — no footprint/
 *  walkability effect at all (unlike furniture's backgroundTiles, which still
 *  blocks part of its footprint; an image blocks nothing — put a floor
 *  pattern under it if the tile should be non-walkable). Rendered at a fixed
 *  depth just above the floor and below every (position-sorted) furniture
 *  piece/character, so it always reads as "on the floor", never "on the
 *  table". References a shared ImageAsset (see shared/office/imageAssets.ts)
 *  by id. Free pixel position/size (not tile-snapped) — matches Tiled's own
 *  Insert-Tile placement exactly, same free-position reasoning as
 *  PlacedText: a mapper can drag/resize to any size or position in Tiled,
 *  and it must land pixel-for-pixel the same in the game, not rounded to the
 *  nearest tile. */
export interface PlacedImage {
  uid: string;
  /** Top-left corner, in pixels. */
  x: number;
  y: number;
  /** Rendered size, in pixels — the image is stretched/shrunk to fill this
   *  exactly, same as Tiled's own resize handles do to the object box. */
  width: number;
  height: number;
  imageId: string;
  /** Mirror the image horizontally/vertically — maps directly onto Tiled's
   *  own GID flip bits (see mapBridge.ts), same convention as
   *  PlacedFurniture.flippedHorizontally. Unlike furniture (hand-drawn 2.5D
   *  art, vertical flip would render broken), an arbitrary uploaded image
   *  has no fixed camera angle, so both directions are supported. Unset =
   *  false. */
  flippedHorizontally?: boolean;
  flippedVertically?: boolean;
}

/**
 * Walls, as EDGES between cells rather than cells of their own.
 *
 * A vertical edge sits on a column boundary: index r*(cols+1)+c is the edge
 * between cell (c-1,r) and (c,r), so c runs 0..cols inclusive (c=0 and c=cols
 * are the map's outer boundary). A horizontal edge sits on a row boundary:
 * index r*cols+c is the edge between cell (c,r-1) and (c,r), r running
 * 0..rows inclusive.
 *
 * Why edges and not cells: a wall is 6px of art, but a wall CELL blocks all
 * 16px of movement and hides a whole floor tile, so cell walls always cost a
 * full tile of room for a thin line and leave ~10px of the cell reading as
 * floor you can't walk on. As an edge, a wall blocks only the step between its
 * two cells; both cells stay walkable floor.
 *
 * Rendering needs no new art: the four edges meeting at a lattice point form
 * exactly the same N=1/E=2/S=4/W=8 mask the cell autotile already uses (see
 * wallTiles.ts), so a wall network is drawn as those same pieces placed on the
 * lattice — half a tile up and left of the cell grid. `piece` overrides that
 * derived mask for one lattice point — this is how a north-wall FACE piece gets
 * placed, since nothing derives those from adjacency.
 */
export interface WallEdges {
  /** Column-boundary edges, (cols+1) × rows, row-major. true = wall. */
  vertical: boolean[];
  /** Row-boundary edges, cols × (rows+1), row-major. true = wall. */
  horizontal: boolean[];
  /** Which wall set each lattice point draws from (see tiledSheetLayout.ts's
   *  WALL_SET_FILES), (cols+1) × (rows+1), row-major. Missing/0 = set 0. */
  latticeSet?: number[];
  /** Per-lattice-point swatch into that set's palette, or null for "Natural".
   *  Same layout as latticeSet. */
  latticeColor?: Array<number | null>;
  /** Per-lattice-point piece override (see the interface comment) — null/absent
   *  derives the piece from the four incident edges. Same layout as latticeSet.
   *  For forcing a particular junction; wall FACES are not this, see faces. */
  latticePiece?: Array<number | null>;
  /**
   * North-wall FACE pieces: the flat wall surface a room is looked *at*, drawn
   * above the edge that actually blocks. Indexed per CELL (cols × rows,
   * row-major) — unlike everything else here, which is per lattice point.
   *
   * That difference is the whole reason faces are their own field. An edge piece
   * is drawn half a tile up and left so its 6px strip lands centred on the
   * boundary; a face piece fills its whole tile, so the same offset would shift
   * it 8px off the floor grid and put its cornice and vertical seams mid-cell.
   * Faces are cell-aligned surface, so they live on cells.
   *
   * Stack them to whatever height the wall should be (see the metro sets' last
   * four pieces: cornice / fill / baseboard / a 1-tall variant with both). A face
   * cell is non-walkable automatically (see wallEdges.ts's faceBlockedTiles) —
   * it depicts solid wall, so nothing should stand in it. The edge run along the
   * wall's base is still what blocks approach from the room side.
   */
  faces?: {
    /** Piece index per cell, or null for no face. cols × rows, row-major. */
    piece: Array<number | null>;
    /** Which wall set each face draws from. Same layout; missing/0 = set 0. */
    set?: number[];
    /** Per-face swatch, or null for "Natural". Same layout. */
    color?: Array<number | null>;
  };
}

export interface OfficeLayout {
  version: 1;
  cols: number;
  rows: number;
  tiles: TileType[];
  furniture: PlacedFurniture[];
  /** Per-tile color, parallel to tiles array — an index into whichever
   *  closed palette this tile's set uses (see palettes.ts's
   *  FLOOR_SET_PALETTES/WALL_SET_PALETTES), or null for "Natural" (no
   *  tint). The closed floor/wall palette made a continuous
   *  ColorValue{h,s,b,c} pointless: there are only 64 real choices, so the
   *  index into that fixed list IS the color — no HSL math needed anywhere
   *  at render time (see docs/design/tiled-editor-integration.md). */
  tileColors?: Array<number | null>;
  /** Per-tile floor style (which floor-<name>.tsj set, see
   *  tiledSheetLayout.ts's FLOOR_SET_FILES), parallel to tiles array — only
   *  meaningful where tiles[i] is a floor pattern (not WALL/VOID).
   *  Missing/0 = the base "floor" set. */
  tileFloorSet?: number[];
  /** Walls as edges between cells — the model that replaces WALL cells, see
   *  WallEdges. While both exist, a layout uses one or the other: a migrated
   *  layout has `walls` and no WALL entries in `tiles`. */
  walls?: WallEdges;
  /** Per-tile "blocks movement" flag, parallel to tiles array — independent of
   *  floor pattern (e.g. a puddle painted with the same pattern as the rest of
   *  the room, but this one tile shouldn't be walkable). true = blocked;
   *  false/missing = normal. Painted with the editor's Block tool; merged into
   *  officeState's blockedTiles alongside furniture footprints. */
  tileBlocked?: boolean[];
  /** Per-tile action (see Action), parallel to tiles array — painted with the
   *  editor's Action tool. For 'meetingRoom' tiles, every maximal
   *  4-connected group of same-kind tiles is one area (id assigned by flood
   *  fill at layout-build time, see computeActionAreas — never stored,
   *  always derived, so ids stay unique/contiguous by construction and two
   *  areas painted separately then later bridged just merge into one on the
   *  next rebuild); standing in one automatically joins you (no explicit
   *  click), independent of a furniture 'meetingRoom' action's explicit
   *  join/leave click. Every other action kind fires once when a player's
   *  tile matches it (edge-triggered, like a portal). */
  tileActions?: Array<Action | null>;
  /** Free-text labels — see PlacedText. Painted with the editor's Text tool. */
  texts?: PlacedText[];
  /** Background decoration images — see PlacedImage. Placed with the editor's
   *  Image tool. */
  images?: PlacedImage[];
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
  /** Right-click "warp" target — set by warpPlayer, consumed once the
   *  despawn half of the effect finishes (see OfficeState.update); null =
   *  no warp in progress. Server-only intent. */
  pendingWarp?: { col: number; row: number } | null;
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
