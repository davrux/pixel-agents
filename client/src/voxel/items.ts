/**
 * Item registry — everything that can sit in a hotbar slot / be held. Two kinds
 * so far: placeable blocks (from blocks.ts) and tools (dig, from luanti.ts caps).
 * Minecraft/Luanti-style: the SELECTED slot is what the avatar holds and what
 * drives digging (tool → its dig speed; block → hand speed) and placing (blocks
 * only). More kinds (food, buckets, …) can be added here as their behaviour lands.
 */
import {
  MATERIAL_BASE, TOOL_BASE, TOOL_IDS, COAL_LUMP, IRON_LUMP, STEEL_INGOT, STICK,
  COPPER_LUMP, TIN_LUMP, GOLD_LUMP, COPPER_INGOT, TIN_INGOT, GOLD_INGOT, BRONZE_INGOT, WHEAT, BREAD,
} from '@pixel/shared';

import { BLOCKS, ALL_BLOCK_IDS } from './blocks.js';

export type ArmorSlot = 'head' | 'torso' | 'legs' | 'feet';

export interface Item {
  id: string; // unique; also the per-item wield-transform localStorage key
  name: string;
  texUrl: string; // relative under textures/ (hotbar thumb + held mesh sprite)
  pivot: [number, number]; // sprite pivot for the held mesh (grip point)
  block?: number; // placeable block id (undefined for tools)
  tool?: string; // luanti TOOLS key (drives dig time; undefined for blocks)
  toolId?: number; // numeric inventory id for a craftable tool (≥TOOL_BASE)
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

// Tools we have art + tool_capabilities for (wood → stone → steel tiers). Pivot at the
// handle end so the fist grips it (see buildItemMesh / DEFAULT_WIELD). `toolId` is the
// numeric inventory id (craftable/owned); `tool` is the luanti dig-cap key.
type ToolKind = 'pick' | 'axe' | 'shovel' | 'sword' | 'hoe';
// default_tool_<tier>{pick|axe|shovel|sword} but farming_tool_<tier>hoe for hoes.
const toolTex = (kind: ToolKind, tier: string): string =>
  kind === 'hoe' ? `items/farming_tool_${tier}hoe` : `items/default_tool_${tier}${kind}`;
const toolItem = (kind: ToolKind, tier: 'wood' | 'stone' | 'steel', label: string): Item => {
  const key = `${kind}_${tier}`;
  return {
    id: key,
    name: `${tier[0].toUpperCase()}${tier.slice(1)} ${label}`,
    texUrl: toolTex(kind, tier),
    pivot: [0.1, 0.85],
    tool: key,
    toolId: TOOL_IDS[key],
  };
};
export const TOOL_ITEMS: Item[] = [
  toolItem('pick', 'wood', 'Pickaxe'), toolItem('pick', 'stone', 'Pickaxe'), toolItem('pick', 'steel', 'Pickaxe'),
  toolItem('axe', 'wood', 'Axe'), toolItem('axe', 'stone', 'Axe'), toolItem('axe', 'steel', 'Axe'),
  toolItem('shovel', 'wood', 'Shovel'), toolItem('shovel', 'stone', 'Shovel'), toolItem('shovel', 'steel', 'Shovel'),
  toolItem('sword', 'wood', 'Sword'), toolItem('sword', 'stone', 'Sword'), toolItem('sword', 'steel', 'Sword'),
  toolItem('hoe', 'wood', 'Hoe'), toolItem('hoe', 'stone', 'Hoe'), toolItem('hoe', 'steel', 'Hoe'),
];
/** Numeric tool id → its Item (for invItem / ownership checks). */
const toolByNum = new Map<number, Item>(TOOL_ITEMS.map((t) => [t.toolId!, t]));
/** A tool's numeric inventory id from its string id (e.g. 'pick_steel' → 202). */
export const toolNum = (stringId: string): number | undefined => TOOL_IDS[stringId];

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
  materialItem(STICK, 'Stick', 'default_stick'),
  materialItem(COPPER_LUMP, 'Copper Lump', 'default_copper_lump'),
  materialItem(TIN_LUMP, 'Tin Lump', 'default_tin_lump'),
  materialItem(GOLD_LUMP, 'Gold Lump', 'default_gold_lump'),
  materialItem(COPPER_INGOT, 'Copper Ingot', 'default_copper_ingot'),
  materialItem(TIN_INGOT, 'Tin Ingot', 'default_tin_ingot'),
  materialItem(GOLD_INGOT, 'Gold Ingot', 'default_gold_ingot'),
  materialItem(BRONZE_INGOT, 'Bronze Ingot', 'default_bronze_ingot'),
  materialItem(WHEAT, 'Wheat', 'default_wheat'),
  materialItem(BREAD, 'Bread', 'farming_bread'),
];

/** Everything selectable for the hotbar (tools first, then every block). */
export const ALL_ITEMS: Item[] = [...TOOL_ITEMS, ...BLOCK_ITEMS];

// Full lookup registry (hotbar palette + armour + materials). itemById resolves any of them.
const REGISTRY: Item[] = [...ALL_ITEMS, ...ARMOR_ITEMS, ...MATERIAL_ITEMS];
export const itemById = (id: string): Item => REGISTRY.find((i) => i.id === id) ?? ALL_ITEMS[0];

/** Resolve a numeric inventory id (as stored in invCounts / dropped items) to its Item:
 *  ids ≥ TOOL_BASE are tools, ≥ MATERIAL_BASE are materials, everything else is a block. */
export const invItem = (n: number): Item =>
  n >= TOOL_BASE
    ? toolByNum.get(n) ?? TOOL_ITEMS[0]
    : n >= MATERIAL_BASE
      ? MATERIAL_ITEMS.find((m) => m.material === n) ?? MATERIAL_ITEMS[0]
      : blockItem(n);
/** An item's HUD thumbnail URL (ready-made icon, else the textures/ sprite). */
export const iconUrl = (it: Item): string => it.icon ?? new URL(`textures/${it.texUrl}.png`, document.baseURI).href;

// The hotbar is split into two independent tracks: tools (used when breaking) and
// blocks (used when placing). Each has its own default set + its own selection.
// Full tool set shown in the hotbar (dimmed until crafted/owned). One pick/axe/shovel/
// sword per tier so the progression is visible: wood → stone → steel.
export const DEFAULT_TOOLS: string[] = [
  'pick_wood', 'pick_stone', 'pick_steel',
  'axe_wood', 'axe_stone', 'axe_steel',
  'shovel_wood', 'shovel_stone', 'shovel_steel',
  'sword_wood', 'sword_stone', 'sword_steel',
  'hoe_wood', 'hoe_stone', 'hoe_steel',
];
export const DEFAULT_BLOCKS: string[] = ['block:1', 'block:3', 'block:4', 'block:17', 'block:15'];
/** Kept for anything that still wants the flat list (tools then blocks). */
export const DEFAULT_HOTBAR: string[] = [...DEFAULT_TOOLS, ...DEFAULT_BLOCKS];
