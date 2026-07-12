/**
 * Stable STRING names for our numeric block ids — the foundation for the schematic
 * system. We keep the compact numeric ids as the internal/wire representation, but pair
 * each with a canonical string name so imports/exports don't depend on our id numbers.
 *
 * Names are ALIGNED WITH LUANTI (minetest_game) node names wherever an equivalent exists
 * (`default:stone`, `wool:red`, …), so importing a Luanti `.mts` schematic is a near
 * identity mapping. Blocks with no Luanti counterpart use our own `pa:` namespace.
 *
 * Minecraft `.schem`/`.litematic` always need a translation table (different names +
 * blockstates) — MC_ALIASES below is the starter map (`minecraft:*` → our canonical name).
 * Orientation/param2, stairs/slabs and colour/biome tints still need per-format handling.
 */

/** id → canonical name (Luanti node name where it matches, else `pa:`). Reserved fluid-flow
 *  ids (40–50) and state-only variants are intentionally covered too so a round-trip is total. */
export const BLOCK_NAMES: Record<number, string> = {
  0: 'air',
  1: 'default:dirt_with_grass',
  2: 'default:dirt',
  3: 'default:stone',
  4: 'default:cobble',
  5: 'default:mossycobble',
  6: 'default:gravel',
  7: 'default:sand',
  8: 'default:desert_sand',
  9: 'default:sandstone',
  10: 'default:desert_stone',
  11: 'default:clay',
  12: 'default:snowblock',
  13: 'default:ice',
  14: 'default:glass',
  15: 'default:obsidian',
  16: 'default:obsidian_glass',
  17: 'default:tree',
  18: 'default:acacia_wood',
  19: 'default:junglewood',
  20: 'default:pine_wood',
  21: 'default:leaves',
  22: 'default:brick',
  23: 'default:coalblock',
  24: 'default:copperblock',
  25: 'default:bronzeblock',
  26: 'default:diamondblock',
  27: 'default:water_source',
  28: 'pa:portal',
  29: 'default:lava_source',
  30: 'default:stone_with_coal',
  31: 'default:stone_with_iron',
  32: 'default:ladder_wood',
  33: 'default:torch',
  34: 'default:chest',
  35: 'doors:door_wood_a',
  36: 'doors:door_wood_b',
  37: 'default:stone_with_copper',
  38: 'default:stone_with_tin',
  39: 'default:stone_with_gold',
  51: 'default:grass_3',
  52: 'default:fern_1',
  53: 'flowers:rose',
  54: 'flowers:dandelion_yellow',
  55: 'default:dry_shrub',
  56: 'default:cactus',
  57: 'farming:wheat_1',
  58: 'farming:wheat_3',
  59: 'farming:wheat_5',
  60: 'farming:wheat_8',
  61: 'farming:straw',
  62: 'default:furnace',
  63: 'default:sapling',
  64: 'farming:soil',
  65: 'farming:desert_sand_soil',
  66: 'default:stonebrick',
  67: 'default:sandstonebrick',
  68: 'default:obsidianbrick',
  69: 'default:bookshelf',
  70: 'default:steelblock',
  71: 'tnt:tnt',
  72: 'default:papyrus',
  73: 'flowers:mushroom_red',
  74: 'flowers:mushroom_brown',
  75: 'flowers:geranium',
  76: 'flowers:viola',
  77: 'default:goldblock',
  78: 'default:tinblock',
  79: 'default:meselamp',
  80: 'fire:basic_flame',
  81: 'default:sign_wall_wood',
  82: 'default:fence_wood',
  83: 'doors:gate_wood_closed',
  84: 'doors:gate_wood_open',
  85: 'beds:bed_bottom',
  86: 'wool:white',
  87: 'wool:red',
  88: 'wool:orange',
  89: 'wool:yellow',
  90: 'wool:green',
  91: 'wool:blue',
  92: 'wool:violet',
  93: 'wool:black',
  94: 'default:stone_with_diamond',
  95: 'default:stone_with_mese',
  96: 'default:mese',
  97: 'carts:rail',
  98: 'pa:monitor',
  99: 'pa:bedrock',
  100: 'pa:arcade',
};

/** Reverse map (canonical name → id), built from BLOCK_NAMES. */
export const NAME_TO_ID: Record<string, number> = Object.fromEntries(
  Object.entries(BLOCK_NAMES).map(([id, name]) => [name, Number(id)]),
);

/** Minecraft (namespaced) → our canonical name. Starter subset for `.schem` import; the
 *  long tail resolves to null (caller decides: skip, or a fallback block). */
export const MC_ALIASES: Record<string, string> = {
  'minecraft:air': 'air',
  'minecraft:cave_air': 'air',
  'minecraft:stone': 'default:stone',
  'minecraft:cobblestone': 'default:cobble',
  'minecraft:mossy_cobblestone': 'default:mossycobble',
  'minecraft:dirt': 'default:dirt',
  'minecraft:grass_block': 'default:dirt_with_grass',
  'minecraft:gravel': 'default:gravel',
  'minecraft:sand': 'default:sand',
  'minecraft:sandstone': 'default:sandstone',
  'minecraft:clay': 'default:clay',
  'minecraft:snow_block': 'default:snowblock',
  'minecraft:ice': 'default:ice',
  'minecraft:glass': 'default:glass',
  'minecraft:obsidian': 'default:obsidian',
  'minecraft:oak_log': 'default:tree',
  'minecraft:oak_planks': 'default:acacia_wood',
  'minecraft:jungle_planks': 'default:junglewood',
  'minecraft:spruce_planks': 'default:pine_wood',
  'minecraft:oak_leaves': 'default:leaves',
  'minecraft:bricks': 'default:brick',
  'minecraft:coal_block': 'default:coalblock',
  'minecraft:diamond_block': 'default:diamondblock',
  'minecraft:gold_block': 'default:goldblock',
  'minecraft:water': 'default:water_source',
  'minecraft:lava': 'default:lava_source',
  'minecraft:coal_ore': 'default:stone_with_coal',
  'minecraft:iron_ore': 'default:stone_with_iron',
  'minecraft:copper_ore': 'default:stone_with_copper',
  'minecraft:gold_ore': 'default:stone_with_gold',
  'minecraft:diamond_ore': 'default:stone_with_diamond',
  'minecraft:ladder': 'default:ladder_wood',
  'minecraft:torch': 'default:torch',
  'minecraft:wall_torch': 'default:torch',
  'minecraft:chest': 'default:chest',
  'minecraft:furnace': 'default:furnace',
  'minecraft:oak_door': 'doors:door_wood_a',
  'minecraft:stone_bricks': 'default:stonebrick',
  'minecraft:bookshelf': 'default:bookshelf',
  'minecraft:iron_block': 'default:steelblock',
  'minecraft:tnt': 'tnt:tnt',
  'minecraft:cactus': 'default:cactus',
  'minecraft:oak_fence': 'default:fence_wood',
  'minecraft:oak_fence_gate': 'doors:gate_wood_closed',
  'minecraft:bedrock': 'pa:bedrock',
  'minecraft:white_wool': 'wool:white',
  'minecraft:red_wool': 'wool:red',
  'minecraft:orange_wool': 'wool:orange',
  'minecraft:yellow_wool': 'wool:yellow',
  'minecraft:green_wool': 'wool:green',
  'minecraft:blue_wool': 'wool:blue',
  'minecraft:purple_wool': 'wool:violet',
  'minecraft:black_wool': 'wool:black',
};

/**
 * Resolve an external block name (Luanti node name or Minecraft `minecraft:*` id) to our
 * numeric id. Luanti names hit BLOCK_NAMES directly (near identity); Minecraft names route
 * through MC_ALIASES first. Returns undefined for unknown blocks (caller decides fallback).
 * A trailing blockstate (`minecraft:oak_log[axis=y]`) is stripped before lookup.
 */
export function blockIdForName(name: string): number | undefined {
  const n = name.trim().toLowerCase().replace(/\[.*$/, ''); // drop MC blockstate suffix
  if (n in NAME_TO_ID) return NAME_TO_ID[n];
  const alias = MC_ALIASES[n];
  return alias ? NAME_TO_ID[alias] : undefined;
}
