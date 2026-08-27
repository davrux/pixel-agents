import { ArraySchema, MapSchema, Schema, type } from '@colyseus/schema';
import type { DefinitionType } from '@colyseus/schema';

/**
 * Authoritative, synced render-state. The server runs the office simulation and
 * writes these every tick; clients read them (via @colyseus/sdk reflection) and
 * render — so every viewer sees the exact same world. Field names/encodings are
 * chosen so the client can rebuild a render-only Character/Pet cheaply.
 */
/**
 * Fields every synced entity shares: id + transform + coarse FSM state. Kind-
 * specific schemas (characters, pets, later players/monsters) extend this, so a
 * new entity kind reuses the transform sync instead of redeclaring it.
 */
export class EntitySync extends Schema {
  @type('int32') id = 0;
  @type('number') x = 0;
  @type('number') y = 0;
  @type('uint8') dir = 0;
  /** Coarse FSM state string (CharacterState / PetState / …). */
  @type('string') state = 'idle';
}

export class CharacterSync extends EntitySync {
  /** Animation pose (CharacterPose): idle|walk|typing|reading|coffee. The
   *  animation *frame phase* is cosmetic and timed client-side from this pose +
   *  dir, so it is intentionally NOT synced (see AGENTS.md). */
  @type('string') pose = 'idle';
  /** Stable skin id (e.g. char_3) — which character template this avatar uses. */
  @type('string') skin = 'char_0';
  @type('boolean') isActive = false;
  /** Current tool is a reading tool → reading vs typing animation. */
  @type('boolean') reading = false;
  /** '' | 'permission' | 'waiting'. */
  @type('string') bubble = '';
  @type('number') bubbleTimer = 0;
  /** '' | 'spawn' | 'despawn' (matrix effect). */
  @type('string') matrixEffect = '';
  @type('number') matrixEffectTimer = 0;
  @type('boolean') isSubagent = false;
  @type('boolean') isPlayer = false;
  // Identity + tooltip
  @type('string') folderName = '';
  @type('string') teamName = '';
  @type('string') agentName = '';
  @type('boolean') isTeamLead = false;
  /** Latest human-readable activity (tool status / 'Needs approval' / ''). */
  @type('string') activity = '';
  @type('uint32') inputTokens = 0;
  @type('uint32') outputTokens = 0;
  /** Player set themselves away (/afk) — shows an "afk" marker; clears on move.
   *  Appended last (schema-evolution safe: never shift existing field indices). */
  @type('boolean') afk = false;
  /** WorkStatus from the player's TimeTracking account ('' = none configured,
   *  or a status that has gone stale), mirrored here by the room so every
   *  viewer's hover overlay shows the same glyph. Appended last — see the afk
   *  comment above. */
  @type('string') workStatus = '';
}

export class PetSync extends EntitySync {
  @type('uint8') kind = 0; // 0 dog, 1 cat, 2 duck
  @type('uint8') variant = 0;
  @type('uint8') frame = 0;
  /** '' | 'spawn' | 'despawn'. */
  @type('string') effect = '';
  @type('number') effectTimer = 0;
  /** Vertical render lift (px) while resting on a desk surface (0 otherwise). */
  @type('uint16') restLift = 0;
}

/** A placed furniture tile after auto-on/animation has been applied. */
export class FurnitureSync extends Schema {
  @type('string') id = '';
  @type('uint8') col = 0;
  @type('uint8') row = 0;
  /** Optional instance name (e.g. a conference monitor's stable room name). */
  @type('string') name = '';
  /** JSON-serialized Action override, or '' — see PlacedFurniture.action.
   *  Appended last (schema-evolution safe, see the afk field's comment on
   *  CharacterSync). */
  @type('string') action = '';
  /** See PlacedFurniture.flippedHorizontally/flippedVertically. Appended
   *  last, same schema-evolution reasoning as `action` above. */
  @type('boolean') flippedHorizontally = false;
  @type('boolean') flippedVertically = false;
  /**
   * Per-instance behaviour overrides (see PlacedFurniture) — the client has to
   * receive these, not just the server: whether a tile is a seat you can click
   * is decided in OfficeScene, so a placement the server considers sittable is
   * unclickable if the override never crosses the wire.
   *
   * `-1` means "no override, use the catalog default" — a plain `boolean` can't
   * express it, since "this one specific chair is NOT sittable" and "this one
   * says nothing" are different answers. Appended last, same schema-evolution
   * reasoning as `action` above.
   */
  @type('int8') canSitOn = -1;
  @type('int8') petCanSitOn = -1;
  /** Direction (0..3), or -1 for no override. */
  @type('int8') sitFacing = -1;
  /** Row count, or -1 for no override. */
  @type('int8') backgroundTiles = -1;
  /** Catalog id to switch to, or '' for no override. */
  @type('string') onState = '';
  /** Walk-over decal (rug/doormat) — 1 yes, 0 no, -1 no override. The client
   *  needs it for the same reason as canSitOn: it decides depth and clickability
   *  on its side too, so a placement the server treats as scenery must not look
   *  like an obstacle there. Appended last, same schema-evolution reasoning as
   *  `action` above. */
  @type('int8') canWalkOver = -1;
  /** Render alpha as 0..255 (255 = opaque), from Tiled's per-object opacity —
   *  see PlacedFurniture.opacity. A uint8 rather than a float: this is a display
   *  nudge, and 1/255 steps are finer than anyone can author or see. Appended
   *  last, same schema-evolution reasoning as `action` above. */
  @type('uint8') opacity = 255;
  /**
   * Stacking order among OVERLAPPING items — the object's position in Tiled's
   * own Furniture object list (see mapBridge.ts).
   *
   * It has to be synced: depth sorting happens on the client, and without this
   * every stacked item fell back to a purely positional sort, which puts a bowl
   * standing on a table behind the table because the table's sprite is taller.
   * That used to be papered over by a per-catalog `occupiesSurface` flag lifting
   * such items; this is the same fix without needing to declare which things can
   * stand on which. Appended last, same schema-evolution reasoning as `action`.
   */
  @type('int16') zOffset = 0;
  /**
   * Drawn size in px when the placement is not the art's own size — see
   * PlacedFurniture.width. 0 means "the art's size", which is the normal case, so an
   * ordinary placement pays two zeroes rather than a decision. Appended last, same
   * schema-evolution reasoning as `action` and `zOffset`.
   */
  @type('uint16') width = 0;
  @type('uint16') height = 0;
  /**
   * Quarter turns clockwise in degrees (0, 90, 180, 270) — see PlacedFurniture.angle.
   *
   * It has to be synced for the same reason `width` does: the client decides depth,
   * clickability and what a seat tile is, and it draws the piece. A turn that stayed on the
   * server would leave the client drawing a sofa across the wrong cells and refusing clicks
   * on the seats the server offers. 0 is upright, which is every placement today, so an
   * ordinary map pays one zero. Appended last, same schema-evolution reasoning as `action`.
   */
  @type('uint16') angle = 0;
}

/**
 * Hands a collection definition to `@type` without the compiler type-checking the
 * argument. Purely type-level — `type` receives exactly the object literal written at
 * the call site, so the wire layout is still decided by the same code as before.
 *
 * Needed because @colyseus/schema 5 widened `DefinitionType` into a six-member union
 * whose collection members carry `default?: MapSchema<InferValueType<T>>`, and
 * resolving that for a Schema class walks the class's fields. Checking a collection of
 * something the size of `CharacterSync` against it overruns the compiler's
 * instantiation budget (TS2589, "excessively deep"). A plain `as DefinitionType` does
 * not help: the assertion still has to prove assignability, which is the expensive
 * part — the budget is shared across the file, so asserting one annotation only moved
 * the error to the next. Going through `unknown` is what actually stops the check.
 *
 * Primitive fields (every other annotation in this file) are unaffected and stay
 * plain. Drop this the moment the upstream typings stop recursing.
 */
const collection = (definition: unknown): DefinitionType => definition as DefinitionType;

export class RoomState extends Schema {
  @type(collection({ map: CharacterSync })) characters = new MapSchema<CharacterSync>();
  @type(collection({ map: PetSync })) pets = new MapSchema<PetSync>();
  @type(collection([FurnitureSync])) furniture = new ArraySchema<FurnitureSync>();
}
