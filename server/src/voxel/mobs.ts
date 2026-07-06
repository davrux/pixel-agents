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

// Animals (day, flee when punched) + hostile monsters (night, chase + hit). The FSM
// in VoxelRoom drives both from these defs. Art is still a placeholder player skin per
// mob (real mob models = a later asset-conversion step).
const animal = (kind: string, skin: string, hp: number, walkVel: number, runVel: number): MobDef => ({
  kind, type: 'animal', skin, hp, viewRange: 8, walkVel, runVel, damage: 0, reach: 1.5, runaway: true, fearHeight: 3, spawnByDay: true,
});
const monster = (kind: string, skin: string, hp: number, viewRange: number, walkVel: number, runVel: number, damage: number, reach: number): MobDef => ({
  kind, type: 'monster', skin, hp, viewRange, walkVel, runVel, damage, reach, runaway: false, fearHeight: 0, spawnByDay: false,
});
export const MOB_DEFS: Record<string, MobDef> = {
  // Peaceful animals — spawn in daylight, wander, flee when hit.
  sheep: animal('sheep', 'character_3', 8, 1.0, 2.4),
  cow: animal('cow', 'character_5', 10, 1.0, 2.2),
  chicken: animal('chicken', 'character_6', 4, 1.2, 2.6),
  pig: animal('pig', 'character_7', 10, 1.1, 2.4),
  bunny: animal('bunny', 'character_3', 4, 1.3, 3.0), // fast hopper
  panda: animal('panda', 'character_5', 15, 0.8, 1.6), // slow + tanky
  penguin: animal('penguin', 'character_6', 6, 0.9, 1.8),
  // Hostile monsters — spawn at night, chase + attack the player.
  zombie: monster('zombie', 'character_8', 20, 12, 1.5, 3.0, 2, 2.4),
  skeleton: monster('skeleton', 'character_9', 20, 14, 1.6, 3.2, 3, 2.6),
  spider: monster('spider', 'character_10', 12, 12, 2.2, 3.6, 2, 2.2),
};

export const MOB_DEFS_LIST = Object.values(MOB_DEFS);
