/**
 * Voxel sound manager — plays the CC-licensed Luanti (minetest_game `default`) sound
 * effects: footsteps per material, block dig/place, glass shatter, lava hiss, player
 * hurt. Each named event maps to one or more .ogg variants; a small per-file pool of
 * HTMLAudioElements lets overlapping plays work (footsteps fire fast) and keeps it
 * simple + cross-browser (Chrome/Firefox), no Web Audio graph. Autoplay policies block
 * sound until the first user gesture, so nothing is heard until the player clicks in.
 *
 * Attribution for every file is recorded in client/public/textures/CREDITS.md.
 */
const DIR = new URL('sounds/', document.baseURI).href;

/** Event → sound-file variants (without dir/extension). A random variant plays. */
const BANK: Record<string, string[]> = {
  // Footsteps per material (all Luanti variants).
  foot_grass: ['default_grass_footstep.1', 'default_grass_footstep.2', 'default_grass_footstep.3'],
  foot_dirt: ['default_dirt_footstep.1', 'default_dirt_footstep.2'],
  foot_hard: ['default_hard_footstep.1', 'default_hard_footstep.2', 'default_hard_footstep.3'],
  foot_sand: ['default_sand_footstep.1', 'default_sand_footstep.2', 'default_sand_footstep.3'],
  foot_gravel: ['default_gravel_footstep.1', 'default_gravel_footstep.2', 'default_gravel_footstep.3', 'default_gravel_footstep.4'],
  foot_snow: ['default_snow_footstep.1', 'default_snow_footstep.2', 'default_snow_footstep.3', 'default_snow_footstep.4', 'default_snow_footstep.5'],
  foot_ice: ['default_ice_footstep.1', 'default_ice_footstep.2', 'default_ice_footstep.3'],
  foot_glass: ['default_glass_footstep'],
  foot_wood: ['default_wood_footstep.1', 'default_wood_footstep.2'],
  foot_water: ['default_water_footstep.1', 'default_water_footstep.2', 'default_water_footstep.3'],
  foot_metal: ['default_metal_footstep.1', 'default_metal_footstep.2', 'default_metal_footstep.3'],
  // Digging (while mining) — per Luanti dig group + material specials.
  dig_cracky: ['default_dig_cracky.1', 'default_dig_cracky.2', 'default_dig_cracky.3'],
  dig_choppy: ['default_dig_choppy.1', 'default_dig_choppy.2', 'default_dig_choppy.3'],
  dig_crumbly: ['default_dig_crumbly'],
  dig_snappy: ['default_dig_snappy'],
  dig_metal: ['default_dig_metal'],
  dig_hand: ['default_dig_oddly_breakable_by_hand'],
  dig_immediate: ['default_dig_dig_immediate'],
  dig_gravel: ['default_gravel_dig.1', 'default_gravel_dig.2'],
  dig_ice: ['default_ice_dig.1', 'default_ice_dig.2', 'default_ice_dig.3'],
  // Dug (block removed) — material-specific.
  dug: ['default_dug_node.1', 'default_dug_node.2'],
  dug_metal: ['default_dug_metal.1', 'default_dug_metal.2'],
  dug_gravel: ['default_gravel_dug.1', 'default_gravel_dug.2', 'default_gravel_dug.3'],
  dug_ice: ['default_ice_dug'],
  glass_break: ['default_break_glass.1', 'default_break_glass.2', 'default_break_glass.3'],
  // Placing.
  place: ['default_place_node.1', 'default_place_node.2', 'default_place_node.3'],
  place_hard: ['default_place_node_hard.1', 'default_place_node_hard.2'],
  place_metal: ['default_place_node_metal.1', 'default_place_node_metal.2'],
  // Effects / feedback.
  cool_lava: ['default_cool_lava.1', 'default_cool_lava.2', 'default_cool_lava.3'],
  tool_breaks: ['default_tool_breaks.1', 'default_tool_breaks.2', 'default_tool_breaks.3'],
  furnace: ['default_furnace_active'],
  smoke: ['default_item_smoke'],
  hurt: ['player_damage'],
  // Chests / doors / gates.
  chest_open: ['default_chest_open'],
  chest_close: ['default_chest_close'],
  door_open: ['doors_door_open'],
  door_close: ['doors_door_close'],
  gate_open: ['doors_fencegate_open'],
  gate_close: ['doors_fencegate_close'],
  steel_door_open: ['doors_steel_door_open'],
  steel_door_close: ['doors_steel_door_close'],
  glass_door_open: ['doors_glass_door_open'],
  glass_door_close: ['doors_glass_door_close'],
  bar_door_open: ['xpanes_steel_bar_door_open'],
  bar_door_close: ['xpanes_steel_bar_door_close'],
  // Fire / flint & steel.
  flint: ['fire_flint_and_steel'],
  fire: ['fire_fire.1', 'fire_fire.2', 'fire_fire.3'],
  fire_small: ['fire_small'],
  fire_large: ['fire_large'],
  fire_out: ['fire_extinguish_flame.1', 'fire_extinguish_flame.2', 'fire_extinguish_flame.3'],
  // TNT.
  tnt_ignite: ['tnt_ignite'],
  tnt_burn: ['tnt_gunpowder_burning'],
  boom: ['tnt_explode'],
  // Ambient (registered; positional looping is a follow-up — played as one-shots for now).
  env_water: ['env_sounds_water.1', 'env_sounds_water.2', 'env_sounds_water.3', 'env_sounds_water.4'],
  env_lava: ['env_sounds_lava.1', 'env_sounds_lava.2'],
  cart: ['carts_cart_moving.1', 'carts_cart_moving.2', 'carts_cart_moving.3'],
};

const POOL = 3; // HTMLAudioElements kept per file so quick repeats overlap

class SoundManager {
  enabled = true;
  volume = 0.7;
  private readonly pools = new Map<string, HTMLAudioElement[]>();
  private readonly cursor = new Map<string, number>();

  /** Get (lazily creating) the pool of audio clones for one file variant. */
  private poolFor(v: string): HTMLAudioElement[] {
    let pool = this.pools.get(v);
    if (!pool) {
      const url = `${DIR}${v}.ogg`;
      pool = [];
      for (let i = 0; i < POOL; i++) {
        const a = new Audio(url);
        a.preload = 'auto';
        pool.push(a);
      }
      this.pools.set(v, pool);
      this.cursor.set(v, 0);
    }
    return pool;
  }

  /** Preload only the COMMON events at startup (footsteps/dig/dug/place); the ~100 total
   *  Luanti sounds otherwise load lazily on first play, so we don't fetch them all upfront. */
  preload(): void {
    const common = ['foot_grass', 'foot_dirt', 'foot_hard', 'foot_wood', 'foot_sand', 'dig_cracky', 'dig_crumbly', 'dig_choppy', 'dug', 'place', 'place_hard', 'hurt'];
    for (const name of common) for (const v of BANK[name] ?? []) this.poolFor(v);
  }

  private readonly ambients = new Map<string, HTMLAudioElement>();
  /** Positional AMBIENCE (Luanti env_sounds): a single looping element per event whose
   *  volume tracks proximity (gain 0..1). Call every scan with the current gain; 0 pauses
   *  it. Autoplay policies mean it only actually starts after the first user gesture. */
  setAmbient(name: string, gain: number): void {
    const variants = BANK[name];
    if (!variants || !variants.length) return;
    let a = this.ambients.get(name);
    if (!a) {
      a = new Audio(`${DIR}${variants[0]}.ogg`);
      a.loop = true;
      a.preload = 'auto';
      this.ambients.set(name, a);
    }
    const vol = this.enabled ? Math.max(0, Math.min(1, this.volume * gain)) : 0;
    a.volume = vol;
    if (vol > 0.001) {
      if (a.paused) void a.play().catch(() => {});
    } else if (!a.paused) {
      a.pause();
    }
  }

  /** Immediately silence all looping ambience (e.g. when sound is toggled off). */
  stopAmbients(): void {
    for (const a of this.ambients.values()) if (!a.paused) a.pause();
  }

  /** Play a named event. gain scales this event's volume; rate perturbs playbackRate. */
  play(name: string, gain = 1, rate = 1): void {
    if (!this.enabled) return;
    const variants = BANK[name];
    if (!variants || !variants.length) return;
    const v = variants[(Math.random() * variants.length) | 0];
    const pool = this.poolFor(v); // lazily loads rarely-used sounds on first play
    const i = this.cursor.get(v)! % pool.length;
    this.cursor.set(v, i + 1);
    const a = pool[i];
    try {
      a.currentTime = 0;
      a.volume = Math.max(0, Math.min(1, this.volume * gain));
      a.playbackRate = rate;
      void a.play().catch(() => {}); // ignore autoplay-blocked / interrupted
    } catch {
      /* element busy — skip this hit */
    }
  }
}

export const sound = new SoundManager();

/** Map a block id to its footstep event (material family), Luanti-style. */
export function footstepFor(id: number): string {
  switch (id) {
    case 1: // grass
    case 21: // leaves
      return 'foot_grass';
    case 2: // dirt
    case 11: // clay
      return 'foot_dirt';
    case 7: // sand
    case 8: // desert sand
    case 9: // sandstone
      return 'foot_sand';
    case 6: // gravel
      return 'foot_gravel';
    case 12: // snow
      return 'foot_snow';
    case 13: // ice
      return 'foot_ice';
    case 14: // glass
    case 16: // obsidian glass
      return 'foot_glass';
    case 17: // wood
    case 18:
    case 19:
    case 20: // planks
      return 'foot_wood';
    case 27: // water
      return 'foot_water';
    case 26: // diamond block
    case 70: // steel block
    case 77: // gold block
    case 78: // tin block
    case 96: // mese block
      return 'foot_metal';
    default: // stone/cobble/brick/ore/portal/… → hard
      return 'foot_hard';
  }
}

const METAL_BLOCKS = new Set<number>([26, 70, 77, 78, 96]); // diamond/steel/gold/tin/mese blocks
const CHOPPY = new Set<number>([17, 18, 19, 20, 21, 53, 54, 55, 61, 69]); // wood/planks/leaves/plant/straw/bookshelf
const CRUMBLY = new Set<number>([1, 2, 7, 8, 11, 12, 64, 65]); // grass/dirt/sand/clay/snow/soil

/** Sound while DIGGING a block (Luanti dig-group), by material family. */
export function digSoundFor(id: number): string {
  if (METAL_BLOCKS.has(id)) return 'dig_metal';
  if (id === 6) return 'dig_gravel';
  if (id === 13) return 'dig_ice';
  if (CHOPPY.has(id)) return 'dig_choppy';
  if (CRUMBLY.has(id)) return 'dig_crumbly';
  return 'dig_cracky'; // stone/cobble/brick/ore/glass default
}

/** Sound when a block is REMOVED (dug), by material family. */
export function dugSoundFor(id: number): string {
  if (METAL_BLOCKS.has(id)) return 'dug_metal';
  if (id === 6) return 'dug_gravel';
  if (id === 13) return 'dug_ice';
  if (id === 14 || id === 16) return 'glass_break';
  return 'dug';
}

/** Sound when a block is PLACED, by material family (Luanti place_node variants). */
export function placeSoundFor(id: number): string {
  if (METAL_BLOCKS.has(id)) return 'place_metal';
  if (!CHOPPY.has(id) && !CRUMBLY.has(id) && id !== 14 && id !== 16) return 'place_hard'; // stone/cobble/brick/ore
  return 'place';
}
