/**
 * Mob definitions — modelled on Luanti's mobs_redo (types animal/monster, view_range,
 * walk/run velocity, runaway, fear_height, day/night spawn). This is a faithful port
 * of the *design*, implemented natively in our server FSM (see VoxelRoom). Art is the
 * luanti character model with a per-mob skin for now; real mob models are a later
 * asset-conversion step.
 */
export type MobType = 'animal' | 'monster';

export interface MobDef {
  kind: string;
  type: MobType;
  skin: string; // luanti player skin used as placeholder art
  hp: number;
  viewRange: number; // detect/aggro distance (monsters chase, animals flee, within this)
  walkVel: number; // wander speed (blocks/s)
  runVel: number; // chase/flee speed (blocks/s)
  damage: number; // melee damage per hit (monsters)
  reach: number; // melee distance
  runaway: boolean; // animals flee when punched
  fearHeight: number; // won't path off drops taller than this (cliff avoidance)
  spawnByDay: boolean; // animals spawn in daylight, monsters at night
}

// Hostile monster only (zombie), spawning at night — like Minecraft, no wandering
// humanoid NPCs. The animal/runaway path stays in the FSM for future creatures.
export const MOB_DEFS: Record<string, MobDef> = {
  zombie: {
    kind: 'zombie',
    type: 'monster',
    skin: 'character_8',
    hp: 20,
    viewRange: 12,
    walkVel: 1.5,
    runVel: 3.0,
    damage: 2,
    reach: 2.4,
    runaway: false,
    fearHeight: 0,
    spawnByDay: false,
  },
};

export const MOB_DEFS_LIST = Object.values(MOB_DEFS);
