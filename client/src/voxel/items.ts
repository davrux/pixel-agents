/**
 * Item registry — everything that can sit in a hotbar slot / be held. Two kinds
 * so far: placeable blocks (from blocks.ts) and tools (dig, from luanti.ts caps).
 * Minecraft/Luanti-style: the SELECTED slot is what the avatar holds and what
 * drives digging (tool → its dig speed; block → hand speed) and placing (blocks
 * only). More kinds (food, buckets, …) can be added here as their behaviour lands.
 */
import { BLOCKS, ALL_BLOCK_IDS } from './blocks.js';

export interface Item {
  id: string; // unique; also the per-item wield-transform localStorage key
  name: string;
  texUrl: string; // relative under textures/ (hotbar thumb + held mesh sprite)
  pivot: [number, number]; // sprite pivot for the held mesh (grip point)
  block?: number; // placeable block id (undefined for tools)
  tool?: string; // luanti TOOLS key (drives dig time; undefined for blocks)
}

// Tools we have art + tool_capabilities for. Pivot at the handle end so the fist
// grips it (see buildItemMesh / DEFAULT_WIELD).
export const TOOL_ITEMS: Item[] = [
  { id: 'pick_steel', name: 'Steel Pickaxe', texUrl: 'items/default_tool_steelpick', pivot: [0.1, 0.85], tool: 'pick_steel' },
  { id: 'axe_steel', name: 'Steel Axe', texUrl: 'items/default_tool_steelaxe', pivot: [0.1, 0.85], tool: 'axe_steel' },
  { id: 'shovel_steel', name: 'Steel Shovel', texUrl: 'items/default_tool_steelshovel', pivot: [0.1, 0.85], tool: 'shovel_steel' },
  { id: 'sword_steel', name: 'Steel Sword', texUrl: 'items/default_tool_steelsword', pivot: [0.1, 0.85], tool: 'sword_steel' },
  { id: 'pick_wood', name: 'Wood Pickaxe', texUrl: 'items/default_tool_woodpick', pivot: [0.1, 0.85], tool: 'pick_wood' },
];

/** A block as a held/placeable item (centre pivot). */
export const blockItem = (id: number): Item => ({
  id: 'block:' + id,
  name: BLOCKS[id].name,
  texUrl: 'blocks/' + BLOCKS[id].tex,
  pivot: [0.5, 0.5],
  block: id,
});

/** Every block as a placeable item (the "placing" side of the split hotbar). */
export const BLOCK_ITEMS: Item[] = ALL_BLOCK_IDS.map(blockItem);

/** Everything selectable in the item picker: tools first, then every block. */
export const ALL_ITEMS: Item[] = [...TOOL_ITEMS, ...BLOCK_ITEMS];

export const itemById = (id: string): Item => ALL_ITEMS.find((i) => i.id === id) ?? ALL_ITEMS[0];

// The hotbar is split into two independent tracks: tools (used when breaking) and
// blocks (used when placing). Each has its own default set + its own selection.
export const DEFAULT_TOOLS: string[] = ['pick_steel', 'axe_steel', 'shovel_steel', 'sword_steel'];
export const DEFAULT_BLOCKS: string[] = ['block:1', 'block:3', 'block:4', 'block:17', 'block:15'];
/** Kept for anything that still wants the flat list (tools then blocks). */
export const DEFAULT_HOTBAR: string[] = [...DEFAULT_TOOLS, ...DEFAULT_BLOCKS];
