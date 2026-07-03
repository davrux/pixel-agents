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
  foot_grass: ['default_grass_footstep.1', 'default_grass_footstep.2'],
  foot_dirt: ['default_dirt_footstep.1', 'default_dirt_footstep.2'],
  foot_hard: ['default_hard_footstep.1', 'default_hard_footstep.2'],
  foot_sand: ['default_sand_footstep.1', 'default_sand_footstep.2'],
  foot_gravel: ['default_gravel_footstep.1', 'default_gravel_footstep.2'],
  foot_snow: ['default_snow_footstep.1', 'default_snow_footstep.2'],
  foot_ice: ['default_ice_footstep.1', 'default_ice_footstep.2'],
  foot_glass: ['default_glass_footstep'],
  foot_wood: ['default_wood_footstep.1', 'default_wood_footstep.2'],
  foot_water: ['default_water_footstep.1', 'default_water_footstep.2'],
  dug: ['default_dug_node.1', 'default_dug_node.2'],
  place: ['default_place_node.1', 'default_place_node.2', 'default_place_node.3'],
  glass_break: ['default_break_glass.1', 'default_break_glass.2', 'default_break_glass.3'],
  cool_lava: ['default_cool_lava.1', 'default_cool_lava.2'],
  hurt: ['player_damage'],
};

const POOL = 3; // HTMLAudioElements kept per file so quick repeats overlap

class SoundManager {
  enabled = true;
  volume = 0.7;
  private readonly pools = new Map<string, HTMLAudioElement[]>();
  private readonly cursor = new Map<string, number>();

  /** Preload every variant (one pool of clones each). Safe to call once at startup. */
  preload(): void {
    for (const variants of Object.values(BANK)) {
      for (const v of variants) {
        if (this.pools.has(v)) continue;
        const url = `${DIR}${v}.ogg`;
        const pool: HTMLAudioElement[] = [];
        for (let i = 0; i < POOL; i++) {
          const a = new Audio(url);
          a.preload = 'auto';
          pool.push(a);
        }
        this.pools.set(v, pool);
        this.cursor.set(v, 0);
      }
    }
  }

  /** Play a named event. gain scales this event's volume; rate perturbs playbackRate. */
  play(name: string, gain = 1, rate = 1): void {
    if (!this.enabled) return;
    const variants = BANK[name];
    if (!variants || !variants.length) return;
    const v = variants[(Math.random() * variants.length) | 0];
    const pool = this.pools.get(v);
    if (!pool) return;
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
    default: // stone/cobble/brick/metal/portal/… → hard
      return 'foot_hard';
  }
}
