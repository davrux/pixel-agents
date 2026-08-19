export {
  DEFAULT_COLS,
  DEFAULT_ROWS,
  MATRIX_EFFECT_DURATION_SEC as MATRIX_EFFECT_DURATION,
  MAX_COLS,
  MAX_ROWS,
  TILE_SIZE,
  DECAL_DEPTH,
  WALK_OVER_DEPTH,
} from './constants.js';

/**
 * The only special ground value there is.
 *
 * A ground cell holds a LOCAL TILE ID in its set's sheet (see
 * OfficeLayout.tiles), so there is nothing to enumerate: FLOOR_1…FLOOR_11 used to
 * live here as if the engine knew what a floor was, when they were only row
 * numbers in a baked sheet — no rule ever read them, and keeping them would invite
 * someone to believe pattern 10 means grass. There is no WALL member either: a
 * wall is an EDGE between two cells (see WallEdges), not a cell.
 */
export const TileType = {
  VOID: -1,
} as const;
export type TileType = (typeof TileType)[keyof typeof TileType];

/** The ground, cell by cell, row-major rows of columns: each value is a local
 *  tile id in that cell's ground set, or VOID. Deliberately plain numbers — the
 *  only thing any logic asks is "is this VOID", and the rest is a sheet
 *  coordinate the renderer resolves (see OfficeLayout.tiles). */
export type GroundMap = number[][];

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

export type Posture = 'sit' | 'stand';

/**
 * A place a character can occupy and do something at: a chair to sit on, or the
 * walkable tile in front of an appliance to stand at. Capacity is one, and
 * `occupantId` says who has it — that single slot is the whole point, and it
 * applies to players exactly as to agents.
 *
 * This absorbed the old `Seat` type, which modelled chairs separately with an
 * `assigned: boolean`. Two models for "somebody is here" is what let a player
 * sit on a chair without anything recording it, so the seat stayed free and an
 * agent could be assigned the very chair a player was sitting on. A boolean also
 * cannot be checked against reality; an id can.
 *
 * `posture` decides what occupying means — sitting down, or standing at
 * something. It used to sit here unread beside a `station: 'desk'|'lounge'|
 * 'appliance'` taxonomy and a `furnitureType` string that nothing ever consumed;
 * both went, this one is now what the pose derives from.
 */
export interface InteractionPoint {
  uid: string;
  /** Tile col the character stands/sits on */
  col: number;
  /** Tile row the character stands/sits on */
  row: number;
  /** Direction the character faces while here (toward the furniture) */
  facingDir: Direction;
  posture: Posture;
  /** Character id currently holding it, or null when free */
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

/**
 * One cell of a pre-baked sheet — which sheet, and where in its grid.
 *
 * The point of it: a baked floor or wall sheet already IS an atlas, so the client
 * has no business exploding it into pixels. It used to: the sheets arrive as
 * ~533 KB of PNG and were sliced into 3.79 million hex-string entries, roughly
 * 34 MB of heap, to hand the renderer a grid it then uploaded to the GPU tile by
 * tile. Now the sheet is one texture and this says which rectangle of it to draw,
 * which keeps `shared` free of graphics concepts: it names a cell, the renderer
 * turns that into a texture frame (client/src/render/sprites.ts's sheetFrame).
 *
 * `row`/`col` are the sheet's own grid, exactly as baked (see tiledSheetLayout.ts):
 * a row is a floor pattern or a wall piece, column 0 is Natural and column 1+i is
 * the set's palette entry i. `kind` decides the cell geometry, since wall cells
 * are 16×32 with a baked gap between them and floor cells are 16×16 without.
 */
export interface SheetCellRef {
  /** Set name — the sheet's identity, see OfficeLayout.floorSets / wallSets. */
  sheet: string;
  row: number;
  col: number;
}
// There used to be a `kind: 'floor' | 'wall'` here, so the renderer knew how big a
// cell was. It reads that off the SHEET now (SheetGrid.tileW/tileH, from the
// tileset's own tilewidth/tileheight), which is what made both the FloorTile and
// WallTile classes unnecessary: a cell of a sheet is a cell of a sheet.

/** A sheet cell placed in the world: the wall pieces and faces a layout draws.
 *  Same fields as FurnitureInstance minus the pixels, which is the whole point. */
export interface SheetInstance {
  ref: SheetCellRef;
  /** Pixel x/y of the top-left corner. */
  x: number;
  y: number;
  /** Y used for depth sorting — see FurnitureInstance.zY. */
  zY: number;
}

export interface FurnitureInstance {
  /** The pixels, when the renderer has to pack them itself. Absent once the art
   *  comes from a fetched image — see spriteId, which is then the answer. */
  sprite?: SpriteData;
  /** Which catalog entry this draws — the id, so a renderer can take the pixels
   *  from a baked atlas instead of from `sprite` (see
   *  client/src/render/sprites.ts's spriteTextureFor). Purely a rendering
   *  shortcut: the engine never reads it, and `sprite` stays the answer for
   *  anything the atlas does not carry. */
  spriteId?: string;
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
  /** Render alpha, 0..1 — see PlacedFurniture.opacity. Unset = opaque. */
  opacity?: number;
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
  | {
      kind: 'meetingRoom';
      video: boolean;
      /** What this room is called, shown on the call windows (see MeetingAreaUI
       *  and ConferenceUI). Authored as the `meetingRoomName` property on an
       *  ActionArea; absent = the generic label. It exists because walking from
       *  one meeting area straight into another gave no sign that the room had
       *  changed — the small popup and the big window both said the same generic
       *  thing. Named after the action kind it belongs to, like the `action*`
       *  properties beside it, so the map property and this field are one word. */
      meetingRoomName?: string;
    }
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
  /** Opens the TimeTracking panel — today's working time and the punch
   *  buttons — for the player who walked up. Today's time clock. Which
   *  account it books against is the player's own (held by their desktop app),
   *  not the machine's: the furniture is the terminal, not the identity, so
   *  any clock in any zone works and two people at one clock each punch their
   *  own card. */
  | { kind: 'timeClock' }
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
  /** The art's size in PIXELS. Present always, and the reason it exists: depth
   *  sorting and the pet's rest lift need the sprite's height, and the client no
   *  longer receives the pixels to measure — they are fetched as images and drawn
   *  by frame (see FurnitureInstance.spriteId). A footprint is a tile count and
   *  cannot answer this: art is bottom-anchored and routinely taller than the
   *  tiles it occupies. */
  width: number;
  height: number;
  /**
   * The art itself — only where something actually manipulates pixels.
   *
   * Optional because the client stopped being sent pixels: it gets an image and a
   * rect instead, which is what a browser is good at. The server still decodes
   * them for its own catalog, so anything running headless keeps working
   * unchanged. Never read it to learn a size; that is what width/height are for.
   */
  sprite?: SpriteData;
  /** This type's default Action (see effectiveAction) — every placed instance
   *  gets this unless it carries its own PlacedFurniture.action override. */
  action?: Action;
  /** May a character sit on this? (see resolveCanSitOn) */
  canSitOn?: boolean;
  /** Which way a sitting character looks (see resolveSitFacing). */
  sitFacing?: Direction;
  /** May a pet rest on top of this? (see resolvePetCanSitOn) */
  petCanSitOn?: boolean;
  /** Is this a floor decal you walk OVER rather than an obstacle — a rug, a
   *  doormat, a painted marking (see resolveCanWalkOver)? Two facts in one
   *  property, deliberately: such an item blocks nothing (getBlockedTiles skips
   *  it whole) AND renders at WALK_OVER_DEPTH, below every entity. Exempting it
   *  from collision alone would not be enough — ordinary furniture sorts by its
   *  sprite's bottom edge, so a rug two rows tall would be drawn over the feet
   *  of anyone standing on its upper row. Nobody would ever want one without
   *  the other, which is why this is one answer and not two. */
  canWalkOver?: boolean;
  /** Number of tile rows from the top of the footprint that are "background"
   *  — stay walkable, and can have another item's footprint placed over
   *  them too (see layoutSerializer.ts's getBlockedTiles, which skips these
   *  rows). Default 0. For a decal that is walkable in its ENTIRETY, use
   *  canWalkOver instead — it also fixes the render depth, which this does not.
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
  /**
   * This entry is map art, not furniture: a tile painted on a DecalLayer (see
   * PlacedDecal). It shares the catalog because a decal needs exactly what the
   * catalog provides — a sprite under a stable id — and nothing else. It is
   * never in OfficeState.furniture, never blocks, never sits anybody, and no
   * behaviour is read off it.
   */
  decal?: boolean;
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
  canWalkOver?: boolean;
  backgroundTiles?: number;
  onState?: string;
  /** Render alpha, 0..1 — Tiled's own per-object opacity, which is a native
   *  field on every object rather than a custom property, so there is nothing to
   *  declare in Pixels.tiled-project and nothing for the sync script to stamp.
   *  Unset = 1 = fully opaque. Purely cosmetic: a half-transparent chair is
   *  still a solid chair to collision and seating. */
  opacity?: number;
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
   *  `FLIPPED_VERTICALLY_FLAG` — see docs/design.md)
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

/**
 * One painted cell of a DecalLayer: a picture on the map, and nothing else.
 *
 * ── Why this exists next to PlacedFurniture ──
 *
 * Furniture is a live object. It is a FurnitureSync in OfficeState with fifteen
 * synced fields, it can be switched on and off, sat on, claimed, blocked
 * against, and every one of them is walked by the linear scans that answer "what
 * is on this tile". That is the right price for a chair and an absurd one for a
 * patch of grass — and a map of a street or a park is mostly patches of grass.
 * A decal instead rides along in the layout (one `layoutLoaded`, like the floor
 * and the walls), never changes, and no scan ever looks at it. So the hundredth
 * decal costs what the first did, while the hundredth chair does not.
 *
 * What it therefore cannot do: block (paint the cell into the CollisionLayer if
 * it should — that layer already exists and is read for exactly this), carry an
 * Action, be sat on, animate, or be overridden per placement. A tile-layer cell
 * holds a gid and nothing else, so there is nowhere to write an override even if
 * we wanted one: what the DecalTile says is what every painted cell of it does.
 *
 * `col`/`row` are the sprite's TOP-LEFT cell, the same convention as
 * PlacedFurniture, so both render through one code path. Note that this is NOT
 * where Tiled puts the cell: Tiled anchors an oversized tile at its cell's
 * BOTTOM edge, so the import converts (see mapBridge.ts) — and it must, or a map
 * would render differently in the game than it looks in the editor.
 */
export interface PlacedDecal {
  /** Which catalog entry this is — a decal one, see FurnitureCatalogEntry.decal.
   *  May equally be a furniture entry: painting furniture art on a decal layer is
   *  how a purely decorative object stops being a synced object. */
  id: string;
  col: number;
  row: number;
  /**
   * How this cell sorts against characters — resolved at import time from the
   * `occludes` property of the DecalLayer it was painted on, never from the tile
   * (see server/src/tiled/decalProps.ts for why the layer owns this).
   *
   * Absent/false — lies FLAT: DECAL_DEPTH, just above the floor, so characters
   * walk over it wherever they stand. Paving, grass, a shadow, flowers.
   *
   * true — STANDS: depth from this cell's own bottom edge, exactly as furniture,
   * so a character behind it is hidden and one in front of it is not. A tree, a
   * fence, a lamp post.
   *
   * Stored per cell rather than left for the client to look up, because the layer
   * it came from is not part of the layout — the same art on two layers must be
   * able to disagree, and after the import the cell is all that is left of it.
   */
  occludes?: boolean;
  /** Tiled's own tile-flip bits, same meaning as PlacedFurniture's. */
  flippedHorizontally?: boolean;
  flippedVertically?: boolean;
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
  /** Render alpha, 0..1 — see PlacedFurniture.opacity. Unset = opaque. */
  opacity?: number;
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
  /** Which wall set each lattice point draws from — an index into this
   *  layout's own `wallSets` table, (cols+1) × (rows+1), row-major.
   *  Missing/0 = the first entry. */
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
  /** 2 since ground cells hold a sheet's local tile id (see `tiles`); 1 stored a
   *  floor PATTERN plus a separate colour, and is migrated on read. */
  version: 1 | 2;
  cols: number;
  rows: number;
  /**
   * Per cell: the local tile id inside `floorSets[tileFloorSet[i]]`, or VOID.
   *
   * That is the whole ground model — a cell is a cell of some sheet, exactly like
   * a decal is. It used to be a floor PATTERN (1-based row) with the colour in
   * `tileColors`, which is the same information split in two, and it carried a
   * hidden restriction: only a tile of Tiled class `FloorTile` could be ground,
   * so painting a piece of an imported art sheet on the GroundLayer silently
   * produced a hole. Now any grid tileset can be ground, and the palette-baked
   * floor sets still work unchanged — a swatch is just a column in the sheet.
   */
  tiles: number[];
  furniture: PlacedFurniture[];
  /** LEGACY (version 1 only): per-tile palette swatch, or null for "Natural".
   *  Folded into `tiles` by the v1→v2 migration — a swatch was always just the
   *  column of the cell — and never written again. Walls still carry their own
   *  per-face colour; only the ground merged the two. */
  tileColors?: Array<number | null>;
  /** Per-tile ground set, parallel to tiles array — an index into THIS
   *  layout's own `floorSets` table, not a global one. Only meaningful where
   *  tiles[i] is not VOID. Missing/0 = the first entry. */
  tileFloorSet?: number[];
  /**
   * The tilesets this layout's ground uses, by name — `tileFloorSet` indexes this.
   * Any grid tileset may appear here, not only a baked floor set.
   *
   * Named here rather than referenced by a global position because that position
   * used to mean "index into a hardcoded FLOOR_SET_FILES array": renaming a
   * tileset broke it, and merely reordering that array silently restyled every
   * floor tile of every saved map. A map that names its own sets survives both,
   * and stays readable on its own. One entry per set the map uses (typically
   * one or two), so this costs a couple of strings rather than one per tile.
   *
   * Absent means "whatever the client loaded first" — which is what a
   * code-generated layout (createDefaultLayout and friends) gets, since nothing
   * in shared/ knows which tilesets exist on disk.
   */
  floorSets?: string[];
  /** The wall tilesets this layout uses, by name — `WallEdges.latticeSet` and
   *  `WallEdges.faces.set` index this. Same reasoning as floorSets. */
  wallSets?: string[];
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
  /** Painted map art — see PlacedDecal. Sparse (only cells that carry one), in
   *  paint order: every DecalLayer of the map in the order Tiled lists them,
   *  cell by cell. That order is the stacking order for flat decals, which all
   *  share one depth, so two DecalLayers stack the way the Layers panel shows
   *  them. */
  decals?: PlacedDecal[];
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
  /**
   * The sit point this agent calls its own — a *reservation*, held even while it
   * is away fetching coffee, so it comes back to the same desk instead of
   * hopping. Null for players and for an agent with no free point to take.
   *
   * Deliberately separate from `atPointId` below: those are two different
   * relations to the same kind of thing (mine vs. I am standing on it), and
   * collapsing them into one claim would mean releasing your desk every time you
   * walk to the coffee machine. Both index into OfficeState.points, and both go
   * through the same one-occupant-per-point rule.
   */
  homePointId: string | null;
  /** The point this character is occupying right now — a chair it sits on, or an
   *  appliance's stand tile. Players use this too (that is what closes the
   *  double-occupancy hole); null when standing anywhere else. */
  atPointId: string | null;
  /** Remaining time to stay at `atPointId`, in seconds (a coffee break's length) */
  atPointTimer: number;
  /** Cooldown before the agent may take another coffee break, in seconds */
  coffeeCooldown: number;
  /** Active speech bubble type, or null if none showing */
  bubbleType: 'permission' | 'waiting' | null;
  /** Countdown timer for bubble (waiting: 2→0, permission: unused) */
  bubbleTimer: number;
  /** Timer to stay seated while inactive after a point reassignment (counts down to 0) */
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
  /** Which point that walk is aimed at, claimed on arrival rather than on
   *  departure — somebody else may take it while you are still walking, and then
   *  you simply end up standing there. Server-only intent. */
  pendingSitPointId?: string | null;
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

/**
 * Where a player was and what they were doing, small enough to store and put
 * back — what a returning viewer resumes from.
 *
 * A reload is not a decision to go anywhere: the world reloads its own page
 * whenever the server restarts, and an avatar that reappears somewhere else (or
 * standing up from the chair it was sitting in) reads as being teleported for no
 * reason. So the same three facts the renderer draws a player from — tile,
 * facing, and which InteractionPoint they hold — are what gets persisted and
 * restored. Nothing here is authority: the point is re-claimed through the same
 * one-occupant rule as any other claim, and a tile that is no longer walkable
 * (the map changed) simply is not restored.
 */
export interface PlayerSpot {
  col: number;
  row: number;
  dir: Direction;
  /** The point they were holding: a seat (sitting) or an appliance's stand tile
   *  (the ☕ pose). Absent when they were standing on open floor. */
  pointId?: string;
  /** Sitting where they stood, with no chair involved (the sit toggle). */
  sit?: boolean;
  afk?: boolean;
}
