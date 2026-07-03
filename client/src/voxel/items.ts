/**
 * Item registry — everything that can sit in a hotbar slot / be held. Two kinds
 * so far: placeable blocks (from blocks.ts) and tools (dig, from luanti.ts caps).
 * Minecraft/Luanti-style: the SELECTED slot is what the avatar holds and what
 * drives digging (tool → its dig speed; block → hand speed) and placing (blocks
 * only). More kinds (food, buckets, …) can be added here as their behaviour lands.
 */
import { MATERIAL_BASE, COAL_LUMP, IRON_LUMP, STEEL_INGOT } from '@pixel/shared';

import { BLOCKS, ALL_BLOCK_IDS } from './blocks.js';

export type ArmorSlot = 'head' | 'torso' | 'legs' | 'feet';

export interface Item {
  id: string; // unique; also the per-item wield-transform localStorage key
  name: string;
  texUrl: string; // relative under textures/ (hotbar thumb + held mesh sprite)
  pivot: [number, number]; // sprite pivot for the held mesh (grip point)
  block?: number; // placeable block id (undefined for tools)
  tool?: string; // luanti TOOLS key (drives dig time; undefined for blocks)
  material?: number; // non-block material item id (lump/ingot; ≥MATERIAL_BASE) — not placeable
  armor?: { slot: ArmorSlot; defense: number }; // wearable armour piece
  icon?: string; // ready-made icon URL (data:) — overrides texUrl for the HUD thumb
}

/** Draw a simple pixel armour icon (helmet/vest/legs/boots) as a data URL. */
function armorIcon(slot: ArmorSlot, color: string): string {
  const c = document.createElement('canvas');
  c.width = c.height = 16;
  const x = c.getContext('2d')!;
  x.imageSmoothingEnabled = false;
  x.fillStyle = color;
  const trim = '#00000030';
  if (slot === 'head') {
    x.fillRect(3, 2, 10, 8);
    x.fillRect(3, 9, 3, 3);
    x.fillRect(10, 9, 3, 3);
  } else if (slot === 'torso') {
    x.fillRect(2, 3, 12, 10);
    x.fillRect(0, 3, 3, 5);
    x.fillRect(13, 3, 3, 5);
  } else if (slot === 'legs') {
    x.fillRect(3, 2, 10, 5);
    x.fillRect(3, 7, 4, 7);
    x.fillRect(9, 7, 4, 7);
  } else {
    x.fillRect(2, 6, 5, 6);
    x.fillRect(9, 6, 5, 6);
    x.fillRect(2, 12, 6, 2);
    x.fillRect(8, 12, 6, 2);
  }
  x.fillStyle = trim;
  x.fillRect(0, 15, 16, 1);
  return c.toDataURL();
}

const armorPiece = (mat: string, matName: string, color: string, slot: ArmorSlot, defense: number): Item => ({
  id: `armor:${mat}_${slot}`,
  name: `${matName} ${slot[0].toUpperCase()}${slot.slice(1)}`,
  texUrl: '',
  pivot: [0.5, 0.5],
  armor: { slot, defense },
  icon: armorIcon(slot, color),
});

// Two armour sets (leather → light, steel → heavy). Defence points sum across the
// four slots; the server converts the total into damage mitigation.
export const ARMOR_ITEMS: Item[] = [
  armorPiece('leather', 'Leather', '#8a5a3a', 'head', 1),
  armorPiece('leather', 'Leather', '#8a5a3a', 'torso', 2),
  armorPiece('leather', 'Leather', '#8a5a3a', 'legs', 2),
  armorPiece('leather', 'Leather', '#8a5a3a', 'feet', 1),
  armorPiece('steel', 'Steel', '#c2c6d0', 'head', 2),
  armorPiece('steel', 'Steel', '#c2c6d0', 'torso', 3),
  armorPiece('steel', 'Steel', '#c2c6d0', 'legs', 3),
  armorPiece('steel', 'Steel', '#c2c6d0', 'feet', 2),
];

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

/** A non-block material (lump/ingot): lives in the inventory, feeds crafting/smelting,
 *  but is never placed or wielded. Drawn as a flat billboard, not a cube. */
const materialItem = (id: number, name: string, tex: string): Item => ({
  id: 'mat:' + id,
  name,
  texUrl: 'items/' + tex,
  pivot: [0.5, 0.5],
  material: id,
});
export const MATERIAL_ITEMS: Item[] = [
  materialItem(COAL_LUMP, 'Coal Lump', 'default_coal_lump'),
  materialItem(IRON_LUMP, 'Iron Lump', 'default_iron_lump'),
  materialItem(STEEL_INGOT, 'Steel Ingot', 'default_steel_ingot'),
];

/** Everything selectable for the hotbar (tools first, then every block). */
export const ALL_ITEMS: Item[] = [...TOOL_ITEMS, ...BLOCK_ITEMS];

// Full lookup registry (hotbar palette + armour + materials). itemById resolves any of them.
const REGISTRY: Item[] = [...ALL_ITEMS, ...ARMOR_ITEMS, ...MATERIAL_ITEMS];
export const itemById = (id: string): Item => REGISTRY.find((i) => i.id === id) ?? ALL_ITEMS[0];

/** Resolve a numeric inventory id (as stored in invCounts / dropped items) to its Item:
 *  ids ≥ MATERIAL_BASE are materials, everything else is a block. */
export const invItem = (n: number): Item => (n >= MATERIAL_BASE ? MATERIAL_ITEMS.find((m) => m.material === n) ?? MATERIAL_ITEMS[0] : blockItem(n));
/** An item's HUD thumbnail URL (ready-made icon, else the textures/ sprite). */
export const iconUrl = (it: Item): string => it.icon ?? new URL(`textures/${it.texUrl}.png`, document.baseURI).href;

// The hotbar is split into two independent tracks: tools (used when breaking) and
// blocks (used when placing). Each has its own default set + its own selection.
export const DEFAULT_TOOLS: string[] = ['pick_steel', 'axe_steel', 'shovel_steel', 'sword_steel'];
export const DEFAULT_BLOCKS: string[] = ['block:1', 'block:3', 'block:4', 'block:17', 'block:15'];
/** Kept for anything that still wants the flat list (tools then blocks). */
export const DEFAULT_HOTBAR: string[] = [...DEFAULT_TOOLS, ...DEFAULT_BLOCKS];
