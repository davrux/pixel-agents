import { ArraySchema, MapSchema, Schema, type } from '@colyseus/schema';

/**
 * Authoritative, synced render-state. The server runs the office simulation and
 * writes these every tick; clients read them (via colyseus.js reflection) and
 * render — so every viewer sees the exact same world. Field names/encodings are
 * chosen so the client can rebuild a render-only Character/Pet cheaply.
 */
export class CharacterSync extends Schema {
  @type('int32') id = 0;
  @type('number') x = 0;
  @type('number') y = 0;
  @type('uint8') dir = 0;
  /** 'idle' | 'walk' | 'type' (CharacterState). */
  @type('string') state = 'idle';
  /** Animation pose (CharacterPose): idle|walk|typing|reading|coffee. The
   *  animation *frame phase* is cosmetic and timed client-side from this pose +
   *  dir, so it is intentionally NOT synced (see AGENTS.md). */
  @type('string') pose = 'idle';
  @type('uint8') palette = 0;
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
  // Identity + tooltip
  @type('string') folderName = '';
  @type('string') teamName = '';
  @type('string') agentName = '';
  @type('boolean') isTeamLead = false;
  /** Latest human-readable activity (tool status / 'Needs approval' / ''). */
  @type('string') activity = '';
  @type('uint32') inputTokens = 0;
  @type('uint32') outputTokens = 0;
}

export class PetSync extends Schema {
  @type('int32') id = 0;
  @type('uint8') kind = 0; // 0 dog, 1 cat
  @type('uint8') variant = 0;
  @type('number') x = 0;
  @type('number') y = 0;
  @type('uint8') dir = 0;
  /** PetState string. */
  @type('string') state = 'idle';
  @type('uint8') frame = 0;
  /** '' | 'spawn' | 'despawn'. */
  @type('string') effect = '';
  @type('number') effectTimer = 0;
}

/** A placed furniture tile after auto-on/animation has been applied. */
export class FurnitureSync extends Schema {
  @type('string') type = '';
  @type('uint8') col = 0;
  @type('uint8') row = 0;
}

export class RoomState extends Schema {
  @type({ map: CharacterSync }) characters = new MapSchema<CharacterSync>();
  @type({ map: PetSync }) pets = new MapSchema<PetSync>();
  @type([FurnitureSync]) furniture = new ArraySchema<FurnitureSync>();
}
