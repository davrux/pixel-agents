import { MapSchema, Schema, type } from '@colyseus/schema';
import { EntitySync } from './officeSync.js';

/**
 * Synced voxel player. Extends the shared EntitySync (id + transform + FSM
 * state) — reusing the entity-sync invariant — and adds the 3D fields the voxel
 * world needs (z, look angles, name, held item). The server writes these from
 * client 'move' messages; clients render other players from them. Chunks are NOT
 * in the schema (streamed as binary); only entities are.
 */
export class VoxelPlayerSync extends EntitySync {
  @type('number') z = 0;
  @type('number') yaw = 0;
  @type('number') pitch = 0;
  @type('string') name = '';
  @type('string') skin = 'character_1';
  @type('string') item = 'items/default_tool_steelpick'; // held item texUrl
  @type('uint8') hp = 20; // health (0 → respawn); armour reduces incoming damage
  @type('uint8') hpMax = 20;
}

/**
 * Synced voxel NPC — server-authoritative creature driven by the server's A* +
 * behaviour FSM (idle/wander/chase). Clients render + interpolate from these; all
 * decisions (pathing, targets) are server-side, never recomputed on the client.
 */
export class VoxelNpcSync extends EntitySync {
  @type('number') z = 0;
  @type('number') yaw = 0;
  @type('string') skin = 'character_1';
  @type('string') kind = 'wanderer'; // creature type (future variety)
  @type('number') hp = 20; // current health (combat lands in a later step)
}

export class VoxelRoomState extends Schema {
  @type({ map: VoxelPlayerSync }) players = new MapSchema<VoxelPlayerSync>();
  @type({ map: VoxelNpcSync }) npcs = new MapSchema<VoxelNpcSync>();
  @type('string') worldId = '';
}
