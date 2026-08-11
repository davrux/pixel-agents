import { ArraySchema, MapSchema, Schema, type } from '@colyseus/schema';

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
  @type('number') hueShift = 0;
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
}

export class RoomState extends Schema {
  @type({ map: CharacterSync }) characters = new MapSchema<CharacterSync>();
  @type({ map: PetSync }) pets = new MapSchema<PetSync>();
  @type([FurnitureSync]) furniture = new ArraySchema<FurnitureSync>();
}
