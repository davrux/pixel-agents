import { MapSchema, Schema, type, view } from '@colyseus/schema';
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
  @type('uint8') armor = 0; // total defence points from equipped armour
  @type('uint8') food = 20; // hunger (0 → starve; ≥18 → regen HP); own client shows the bar
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

/**
 * A dropped item lying in the world — spawned when a block is broken, collected when a
 * player walks over it (Luanti-style). Server-authoritative: the server spawns, moves
 * (none for now — it rests where it dropped), and removes it on pickup/despawn. `block`
 * is the block id it represents; `count` how many (stacks merge on the client HUD).
 */
export class VoxelItemSync extends EntitySync {
  @type('number') z = 0;
  @type('uint8') block = 0;
  @type('uint8') count = 1;
}

export class VoxelRoomState extends Schema {
  // @view(): players + NPCs + item drops are area-of-interest filtered — each client only
  // receives the entities its StateView has added (nearby ones), not the whole world.
  @view() @type({ map: VoxelPlayerSync }) players = new MapSchema<VoxelPlayerSync>();
  @view() @type({ map: VoxelNpcSync }) npcs = new MapSchema<VoxelNpcSync>();
  @view() @type({ map: VoxelItemSync }) items = new MapSchema<VoxelItemSync>();
  @type('string') worldId = '';
}
