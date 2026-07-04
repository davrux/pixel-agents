/**
 * Luanti (minetest_game) dig data + the real dig-time formula — imported as data
 * instead of hand-tuned. Node `groups` and tool `tool_capabilities` are taken
 * verbatim from minetest_game `mods/default/nodes.lua` + `tools.lua`; the hand is
 * the game's default. Our block ids (see blocks.ts) are mapped to the equivalent
 * default node groups.
 *
 * Dig time (Luanti): for each *dig group* a node has (cracky/crumbly/choppy/
 * snappy/oddly_breakable_by_hand), if the tool has a groupcap for it AND the
 * node's `level` ≤ that groupcap's maxlevel, the time is `groupcap.times[rating]`
 * where `rating` is the node's group value. The shortest such time wins; if no
 * group qualifies, the tool can't dig the node.
 */

type Groups = Partial<Record<'cracky' | 'crumbly' | 'choppy' | 'snappy' | 'oddly_breakable_by_hand' | 'level', number>>;
interface GroupCap {
  times: Partial<Record<1 | 2 | 3, number>>;
  maxlevel: number;
}
interface ToolCaps {
  full_punch_interval: number;
  groupcaps: Partial<Record<'cracky' | 'crumbly' | 'choppy' | 'snappy' | 'oddly_breakable_by_hand', GroupCap>>;
}

const DIG_GROUPS = ['cracky', 'crumbly', 'choppy', 'snappy', 'oddly_breakable_by_hand'] as const;

// Our block ids (blocks.ts) → minetest_game default node groups (verbatim ratings).
export const BLOCK_GROUPS: Record<number, Groups> = {
  1: { crumbly: 3 }, // grass (dirt_with_grass)
  2: { crumbly: 3 }, // dirt
  3: { cracky: 3 }, // stone
  4: { cracky: 3 }, // cobble
  5: { cracky: 3 }, // mossy cobble
  6: { crumbly: 2 }, // gravel
  7: { crumbly: 3 }, // sand
  8: { crumbly: 3 }, // desert sand
  9: { crumbly: 1, cracky: 3 }, // sandstone
  10: { cracky: 3 }, // desert stone
  11: { crumbly: 3 }, // clay
  12: { crumbly: 3 }, // snow block
  13: { cracky: 3 }, // ice
  14: { cracky: 3, oddly_breakable_by_hand: 3 }, // glass
  15: { cracky: 1, level: 2 }, // obsidian
  16: { cracky: 3 }, // obsidian glass
  17: { choppy: 2, oddly_breakable_by_hand: 1 }, // wood (tree log)
  18: { choppy: 2, oddly_breakable_by_hand: 2 }, // planks
  19: { choppy: 2, oddly_breakable_by_hand: 2 }, // jungle planks
  20: { choppy: 3, oddly_breakable_by_hand: 2 }, // pine planks
  21: { snappy: 3 }, // leaves
  22: { cracky: 3 }, // brick
  23: { cracky: 3 }, // coal block
  24: { cracky: 1, level: 2 }, // copper block
  25: { cracky: 1, level: 2 }, // bronze block
  26: { cracky: 1, level: 3 }, // diamond block
  28: { cracky: 3, oddly_breakable_by_hand: 3 }, // portal marker (glass cube)
  30: { cracky: 3 }, // coal ore (wood pick ok)
  31: { cracky: 2 }, // iron ore (needs a stone pick or better)
  37: { cracky: 2 }, // copper ore (stone pick+)
  38: { cracky: 2 }, // tin ore (stone pick+)
  39: { cracky: 2 }, // gold ore (stone pick+)
  51: { snappy: 3, oddly_breakable_by_hand: 3 }, // tall grass
  52: { snappy: 3, oddly_breakable_by_hand: 3 }, // fern
  53: { snappy: 3, oddly_breakable_by_hand: 3 }, // rose
  54: { snappy: 3, oddly_breakable_by_hand: 3 }, // dandelion
  55: { snappy: 3, oddly_breakable_by_hand: 3 }, // dry shrub
  56: { choppy: 3, oddly_breakable_by_hand: 3 }, // cactus
  57: { snappy: 3, oddly_breakable_by_hand: 3 }, // wheat (seedling)
  58: { snappy: 3, oddly_breakable_by_hand: 3 }, // wheat stage 2
  59: { snappy: 3, oddly_breakable_by_hand: 3 }, // wheat stage 3
  60: { snappy: 3, oddly_breakable_by_hand: 3 }, // wheat (mature)
  61: { crumbly: 3, oddly_breakable_by_hand: 3 }, // straw
  63: { snappy: 3, oddly_breakable_by_hand: 3 }, // sapling
  64: { crumbly: 3, oddly_breakable_by_hand: 3 }, // soil (farmland)
  65: { crumbly: 3, oddly_breakable_by_hand: 3 }, // desert soil
};

// tool_capabilities verbatim from minetest_game tools.lua (+ the default hand).
export const TOOLS: Record<string, ToolCaps> = {
  hand: {
    full_punch_interval: 0.9,
    groupcaps: {
      crumbly: { times: { 2: 3.0, 3: 0.7 }, maxlevel: 1 },
      snappy: { times: { 3: 0.4 }, maxlevel: 1 },
      oddly_breakable_by_hand: { times: { 1: 3.5, 2: 2.0, 3: 0.7 }, maxlevel: 3 },
    },
  },
  pick_wood: { full_punch_interval: 1.2, groupcaps: { cracky: { times: { 3: 1.6 }, maxlevel: 1 } } },
  pick_stone: { full_punch_interval: 1.3, groupcaps: { cracky: { times: { 2: 2.0, 3: 1.0 }, maxlevel: 1 } } },
  pick_steel: { full_punch_interval: 1.0, groupcaps: { cracky: { times: { 1: 4.0, 2: 1.6, 3: 0.8 }, maxlevel: 2 } } },
  pick_bronze: { full_punch_interval: 1.0, groupcaps: { cracky: { times: { 1: 4.5, 2: 1.8, 3: 0.9 }, maxlevel: 2 } } },
  pick_mese: { full_punch_interval: 0.9, groupcaps: { cracky: { times: { 1: 2.4, 2: 1.2, 3: 0.6 }, maxlevel: 3 } } },
  pick_diamond: { full_punch_interval: 0.9, groupcaps: { cracky: { times: { 1: 2.0, 2: 1.0, 3: 0.5 }, maxlevel: 3 } } },
  axe_wood: { full_punch_interval: 1.0, groupcaps: { choppy: { times: { 2: 3.0, 3: 1.6 }, maxlevel: 1 } } },
  axe_stone: { full_punch_interval: 1.2, groupcaps: { choppy: { times: { 1: 3.0, 2: 2.0, 3: 1.3 }, maxlevel: 1 } } },
  axe_steel: { full_punch_interval: 1.0, groupcaps: { choppy: { times: { 1: 2.5, 2: 1.4, 3: 1.0 }, maxlevel: 2 } } },
  shovel_wood: { full_punch_interval: 1.2, groupcaps: { crumbly: { times: { 1: 3.0, 2: 1.6, 3: 0.6 }, maxlevel: 1 } } },
  shovel_stone: { full_punch_interval: 1.4, groupcaps: { crumbly: { times: { 1: 1.8, 2: 1.2, 3: 0.5 }, maxlevel: 1 } } },
  shovel_steel: { full_punch_interval: 1.1, groupcaps: { crumbly: { times: { 1: 1.5, 2: 0.9, 3: 0.4 }, maxlevel: 2 } } },
  sword_wood: { full_punch_interval: 1.0, groupcaps: { snappy: { times: { 2: 1.6, 3: 0.4 }, maxlevel: 1 } } },
  sword_stone: { full_punch_interval: 1.2, groupcaps: { snappy: { times: { 2: 1.4, 3: 0.4 }, maxlevel: 1 } } },
  sword_steel: { full_punch_interval: 0.8, groupcaps: { snappy: { times: { 1: 2.5, 2: 1.2, 3: 0.35 }, maxlevel: 2 } } },
  // Hoes don't dig blocks (used via the use-action to till soil) → no groupcaps (hand digs).
  hoe_wood: { full_punch_interval: 1.0, groupcaps: {} },
  hoe_stone: { full_punch_interval: 1.0, groupcaps: {} },
  hoe_steel: { full_punch_interval: 1.0, groupcaps: {} },
};

/** Dig time (s) of a block with one tool, or null if that tool can't dig it. */
function timeWithTool(groups: Groups, tool: ToolCaps): number | null {
  const level = groups.level ?? 1;
  let best = Infinity;
  for (const g of DIG_GROUPS) {
    const rating = groups[g];
    const cap = tool.groupcaps[g];
    if (rating === undefined || !cap) continue;
    if (level > cap.maxlevel) continue;
    const t = cap.times[rating as 1 | 2 | 3];
    if (t !== undefined) best = Math.min(best, t);
  }
  return best === Infinity ? null : best;
}

/**
 * Dig time (s) for a block, using the fastest of the given tools plus the hand,
 * exactly as Luanti resolves it. Returns null if nothing can dig it (e.g. a
 * steel pick on a diamond block — level 3 > the pick's maxlevel 2).
 */
export function digTime(blockId: number, tools: string[] = ['hand']): number | null {
  const groups = BLOCK_GROUPS[blockId];
  if (!groups) return 0.7; // unknown block → a sane default
  let best = Infinity;
  for (const name of [...tools, 'hand']) {
    const caps = TOOLS[name];
    if (!caps) continue;
    const t = timeWithTool(groups, caps);
    if (t !== null) best = Math.min(best, t);
  }
  return best === Infinity ? null : best;
}
