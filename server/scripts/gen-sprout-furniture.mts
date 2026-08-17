#!/usr/bin/env -S node --import tsx
/**
 * One-time importer: slices the Sprout Lands Basic pack's object sheets into
 * individual furniture PNGs under assets/tiled/png/furniture/sprout/ and
 * writes the Tiled tilesets that make them a real catalog —
 * assets/tiled/furniture-sprout-*.tsj. Nothing else has to change:
 * server/src/core/assets/tiledFurniture.ts reads the catalog straight out of
 * every tileset whose tiles carry the FurnitureTile class, so these items show
 * up like any other furniture (see docs/design.md).
 *
 * The pack itself lives outside the repo (tmp/sprout, gitignored — same as the
 * MetroCity pack); only the derived PNGs + tilesets are committed. Its licence
 * is non-commercial, forbids redistributing the pack, and requires crediting
 * Cup Nooble — see assets/CREDITS.md.
 *
 * Items are found by 8-connected alpha components rather than by a grid walk,
 * for the same reason as gen-metro-furniture.mts: the sheets are laid out on a
 * 16px grid but the art straddles it freely (a 16x32 bed next to a 10x9
 * stool). Each item's PNG is padded out to whole tiles, bottom-aligned and
 * horizontally centred, because furniture art is bottom-anchored and the
 * catalog derives footprint from the PNG's size (tiledFurniture.ts's
 * footprintOf).
 *
 * ── Why every item is named here rather than numbered ──
 *
 * The metro import produced "Living room 7" and left every behaviour at its
 * default, because 274 items sliced out of 23 sheets is a catalog no one can
 * curate in a script. These sheets are small enough to do properly, so the
 * table below carries each item's real name and real behaviour: which chairs
 * can be sat on and which way they face, which decals characters walk over,
 * how many rows of a tree are canopy, and which chest turns into which. That
 * IS the import — a sliced sprite with default properties is a picture, not
 * furniture.
 *
 * The table is indexed by slicing order (components sorted top-to-bottom then
 * left-to-right), and the script refuses to run if a sheet stops yielding
 * exactly as many items as the table names — a silent renumber would move
 * every property onto the wrong sprite. `null` drops an item (animation frames
 * we don't keep); `split` cuts a component that glued neighbours together.
 *
 * ── This runs ONCE, and then never again by accident ──
 *
 * Same rule as the metro importer: the tilesets it writes are maintained BY
 * HAND in Tiled afterwards, so re-running would discard that. It refuses to
 * overwrite a tileset that already exists unless given --force.
 *
 * Run: scripts/import-sprout-pack.sh [--force] (this is its last step)
 */
import { PNG } from 'pngjs';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { FURNITURE_TILE_PROPS } from '../src/tiled/furnitureProps.js';

const ROOT = new URL('../..', import.meta.url).pathname;
const PACK = path.join(ROOT, 'tmp', 'sprout');
const OUT_PNG_DIR = path.join(ROOT, 'assets', 'tiled', 'png', 'furniture', 'sprout');
const OUT_TSJ_DIR = path.join(ROOT, 'assets', 'tiled');
const TILE = 16;
/** Components smaller than this are sheet dust (a stray highlight left outside
 *  an item's own silhouette), not items. */
const MIN_PIXELS = 12;

/** One catalog entry. Everything not stated stays at the FURNITURE_TILE_PROPS
 *  default, so what appears here is exactly what makes this item unlike the
 *  plainest possible object. */
interface Item {
  id: string;
  label: string;
  canSitOn?: boolean;
  /** Which way a character sitting here faces — 'N' | 'E' | 'S' | 'W'. */
  sitFacing?: string;
  petCanSitOn?: boolean;
  /** A flat decal: walkable in its entirety, and drawn under characters. */
  canWalkOver?: boolean;
  /** Rows from the top of the footprint that stay walkable — a tree's canopy,
   *  a picture hanging above head height. */
  backgroundTiles?: number;
  /** The catalog id this becomes when switched on. */
  onState?: string;
}

interface Sheet {
  file: string;
  tileset: string;
  /** Components to cut into N equal columns, keyed by index in slicing order
   *  (0-based, before any cut). Only for boxes that already sit on the 16px
   *  grid — art that touches its neighbour but is plainly two items. */
  split?: Record<number, number>;
  /** Explicit source rects (px), used INSTEAD of component detection. For
   *  sheets where the components aren't the items: an animation strip, or a
   *  doorway whose frame connects every frame into one blob. */
  boxes?: Array<{ x: number; y: number; w: number; h: number }>;
  /** One entry per sliced item, in order. `null` drops that item. */
  items: Array<Item | null>;
}

const SHEETS: Sheet[] = [
  {
    file: 'Objects/Basic_Furniture.png',
    tileset: 'furniture-sprout-home',
    // The three small mats are drawn touching along their fringes.
    split: { 25: 3 },
    items: [
      { id: 'SPROUT_POTTED_FLOWER_YELLOW', label: 'Potted flower (yellow)' },
      { id: 'SPROUT_POTTED_FLOWER_BLUE', label: 'Potted flower (blue)' },
      { id: 'SPROUT_POTTED_PLANT', label: 'Potted plant' },
      // Pictures hang above head height: the tile they cover stays walkable.
      { id: 'SPROUT_PAINTING_NIGHT', label: 'Painting (night sky)', backgroundTiles: 1 },
      { id: 'SPROUT_PAINTING_FLOWERS', label: 'Painting (flowers)', backgroundTiles: 1 },
      { id: 'SPROUT_PAINTING_MEADOW', label: 'Painting (meadow)', backgroundTiles: 1 },
      { id: 'SPROUT_LAMP_GREEN', label: 'Hanging lamp (green)', backgroundTiles: 1 },
      { id: 'SPROUT_LAMP_BLUE', label: 'Hanging lamp (blue)', backgroundTiles: 1 },
      { id: 'SPROUT_LAMP_PINK', label: 'Hanging lamp (pink)', backgroundTiles: 1 },
      // Headboard at the top, so someone on it has their back to it.
      { id: 'SPROUT_BED_GREEN', label: 'Bed (green)', canSitOn: true, sitFacing: 'S' },
      { id: 'SPROUT_BED_BLUE', label: 'Bed (blue)', canSitOn: true, sitFacing: 'S' },
      { id: 'SPROUT_BED_PINK', label: 'Bed (pink)', canSitOn: true, sitFacing: 'S' },
      { id: 'SPROUT_DRAWERS', label: 'Chest of drawers', petCanSitOn: true },
      { id: 'SPROUT_CHAIR_RIGHT', label: 'Wooden chair (facing right)', canSitOn: true, sitFacing: 'E' },
      { id: 'SPROUT_CHAIR_LEFT', label: 'Wooden chair (facing left)', canSitOn: true, sitFacing: 'W' },
      { id: 'SPROUT_CHAIR_BACK', label: 'Wooden chair (back)', canSitOn: true, sitFacing: 'N' },
      { id: 'SPROUT_STOOL', label: 'Wooden stool', canSitOn: true, sitFacing: 'S' },
      { id: 'SPROUT_CLOCK_CUCKOO', label: 'Cuckoo clock', backgroundTiles: 1 },
      { id: 'SPROUT_TABLE', label: 'Wooden table', petCanSitOn: true },
      { id: 'SPROUT_CLOCK_ROUND', label: 'Wall clock', backgroundTiles: 1 },
      { id: 'SPROUT_SIDE_TABLE', label: 'Side table', petCanSitOn: true },
      { id: 'SPROUT_CLOCK_SMALL', label: 'Small wall clock', backgroundTiles: 1 },
      // The same three beds with the pillow at the foot end.
      { id: 'SPROUT_BED_GREEN_TURNED', label: 'Bed, turned (green)', canSitOn: true, sitFacing: 'N' },
      { id: 'SPROUT_BED_BLUE_TURNED', label: 'Bed, turned (blue)', canSitOn: true, sitFacing: 'N' },
      { id: 'SPROUT_BED_PINK_TURNED', label: 'Bed, turned (pink)', canSitOn: true, sitFacing: 'N' },
      { id: 'SPROUT_MAT_GREEN', label: 'Mat (green)', canWalkOver: true },
      { id: 'SPROUT_MAT_PINK', label: 'Mat (pink)', canWalkOver: true },
      { id: 'SPROUT_MAT_BLUE', label: 'Mat (blue)', canWalkOver: true },
      { id: 'SPROUT_RUG_GREEN', label: 'Rug (green)', canWalkOver: true },
      { id: 'SPROUT_RUG_PINK', label: 'Rug (pink)', canWalkOver: true },
      { id: 'SPROUT_RUG_BLUE', label: 'Rug (blue)', canWalkOver: true },
    ],
  },
  {
    file: 'Objects/Chest.png',
    tileset: 'furniture-sprout-home',
    // The sheet is two five-frame opening animations. Only the end states come
    // across, as an on/off pair (onState, exactly like the PC in
    // furniture-electronics.tsj) — the engine switches an item's state, it
    // doesn't play a furniture animation on demand, and a chest that opened
    // and shut on a loop forever is not what this art is for. Both are cut
    // 16x32 from the same rows so the pair keeps ONE footprint: onState swaps
    // the catalog entry, and a partner of a different size would change which
    // tiles the placement blocks.
    boxes: [
      { x: 16, y: 0, w: 16, h: 32 },
      { x: 208, y: 0, w: 16, h: 32 },
    ],
    items: [
      { id: 'SPROUT_CHEST', label: 'Chest', backgroundTiles: 1, onState: 'SPROUT_CHEST_OPEN' },
      { id: 'SPROUT_CHEST_OPEN', label: 'Chest (open)', backgroundTiles: 1 },
    ],
  },
  {
    file: 'Tilesets/Doors.png',
    tileset: 'furniture-sprout-home',
    // Both doorway states share one continuous frame, so alpha components see
    // one blob; the sheet is plainly two 16x32 cells.
    boxes: [
      { x: 0, y: 0, w: 16, h: 32 },
      { x: 0, y: 32, w: 16, h: 32 },
    ],
    items: [
      // A doorway is walked through, not into — both rows stay walkable, same
      // as the existing DOOR in furniture-decor.tsj.
      { id: 'SPROUT_DOOR', label: 'Door', backgroundTiles: 2, onState: 'SPROUT_DOOR_OPEN' },
      { id: 'SPROUT_DOOR_OPEN', label: 'Door (open)', backgroundTiles: 2 },
    ],
  },
  {
    file: 'Objects/Basic_Grass_Biom_things.png',
    tileset: 'furniture-sprout-nature',
    // Two bushes drawn shoulder to shoulder.
    split: { 22: 2 },
    items: [
      { id: 'SPROUT_TREE_SMALL', label: 'Small tree', backgroundTiles: 1 },
      { id: 'SPROUT_TREE', label: 'Tree', backgroundTiles: 1 },
      { id: 'SPROUT_TREE_APPLE', label: 'Apple tree', backgroundTiles: 1 },
      { id: 'SPROUT_MUSHROOMS_PINK', label: 'Pink mushrooms' },
      { id: 'SPROUT_MUSHROOM_PURPLE', label: 'Purple mushroom' },
      { id: 'SPROUT_MUSHROOM_PURPLE_2', label: 'Purple mushroom' },
      { id: 'SPROUT_MUSHROOM_PINK', label: 'Pink mushroom' },
      { id: 'SPROUT_MUSHROOM_PURPLE_3', label: 'Purple mushroom' },
      { id: 'SPROUT_GRASS_TUFT', label: 'Grass tuft', canWalkOver: true },
      { id: 'SPROUT_PEBBLE', label: 'Pebble', canWalkOver: true },
      { id: 'SPROUT_ROCK', label: 'Rock' },
      { id: 'SPROUT_GRASS_TUFT_2', label: 'Grass tuft', canWalkOver: true },
      { id: 'SPROUT_GRASS_TUFT_3', label: 'Grass tuft', canWalkOver: true },
      { id: 'SPROUT_APPLE', label: 'Apple', canWalkOver: true },
      { id: 'SPROUT_SUNFLOWER', label: 'Sunflower', backgroundTiles: 1 },
      { id: 'SPROUT_LOG', label: 'Log' },
      { id: 'SPROUT_CHERRIES', label: 'Cherries', canWalkOver: true },
      { id: 'SPROUT_STUMP_SMALL', label: 'Small stump' },
      { id: 'SPROUT_STUMP', label: 'Tree stump' },
      { id: 'SPROUT_FLOWER_YELLOW', label: 'Yellow flower', canWalkOver: true },
      { id: 'SPROUT_FLOWER_PINK_SMALL', label: 'Small pink flower', canWalkOver: true },
      { id: 'SPROUT_FLOWER_YELLOW_SMALL', label: 'Small yellow flower', canWalkOver: true },
      { id: 'SPROUT_BUSH_FLOWERING', label: 'Flowering bush' },
      { id: 'SPROUT_BUSH', label: 'Bush' },
      { id: 'SPROUT_BERRIES', label: 'Berries', canWalkOver: true },
      { id: 'SPROUT_FLOWER_BLUE', label: 'Blue flower', canWalkOver: true },
      { id: 'SPROUT_FLOWER_PINK', label: 'Pink flower', canWalkOver: true },
      { id: 'SPROUT_BUD_RED', label: 'Red bud', canWalkOver: true },
      { id: 'SPROUT_FLOWER_PINK_2', label: 'Pink flower', canWalkOver: true },
      { id: 'SPROUT_BUD_SMALL', label: 'Small bud', canWalkOver: true },
      { id: 'SPROUT_BUSH_LOG_LARGE', label: 'Large bush with log' },
      { id: 'SPROUT_LILY_PADS', label: 'Lily pads', canWalkOver: true },
      { id: 'SPROUT_BOULDER', label: 'Boulder' },
      { id: 'SPROUT_BUSH_LOG', label: 'Bush with log' },
      { id: 'SPROUT_PEBBLE_SMALL', label: 'Small pebble', canWalkOver: true },
      { id: 'SPROUT_LILY_PAD', label: 'Lily pad', canWalkOver: true },
    ],
  },
  {
    file: 'Objects/Basic_Plants.png',
    tileset: 'furniture-sprout-farm',
    items: [
      { id: 'SPROUT_CORN', label: 'Corn' },
      { id: 'SPROUT_CORN_YOUNG', label: 'Corn (growing)' },
      { id: 'SPROUT_PARSNIP', label: 'Parsnip', canWalkOver: true },
      { id: 'SPROUT_SEEDS_PARSNIP', label: 'Parsnip seeds', canWalkOver: true },
      { id: 'SPROUT_SEEDLINGS', label: 'Seedlings', canWalkOver: true },
      { id: 'SPROUT_SPROUTS', label: 'Sprouts', canWalkOver: true },
      { id: 'SPROUT_EGGPLANT', label: 'Eggplant', canWalkOver: true },
      { id: 'SPROUT_SEEDS_EGGPLANT', label: 'Eggplant seeds', canWalkOver: true },
      { id: 'SPROUT_EGGPLANT_RIPE', label: 'Eggplant plant (ripe)' },
      { id: 'SPROUT_EGGPLANT_FLOWERING', label: 'Eggplant plant (flowering)' },
      { id: 'SPROUT_EGGPLANT_YOUNG', label: 'Eggplant seedling', canWalkOver: true },
      { id: 'SPROUT_EGGPLANT_SPROUT', label: 'Eggplant sprout', canWalkOver: true },
    ],
  },
  {
    file: 'Objects/Basic_tools_and_meterials.png',
    tileset: 'furniture-sprout-farm',
    items: [
      { id: 'SPROUT_AXE', label: 'Axe', canWalkOver: true },
      { id: 'SPROUT_HAMMER', label: 'Hammer', canWalkOver: true },
      { id: 'SPROUT_WATERING_CAN', label: 'Watering can', canWalkOver: true },
      { id: 'SPROUT_HOE', label: 'Hoe', canWalkOver: true },
      { id: 'SPROUT_WOOD', label: 'Wood', canWalkOver: true },
      { id: 'SPROUT_STONE', label: 'Stone', canWalkOver: true },
    ],
  },
  {
    file: 'Objects/Simple_Milk_and_grass_item.png',
    tileset: 'furniture-sprout-farm',
    items: [
      { id: 'SPROUT_HAY', label: 'Hay', canWalkOver: true },
      { id: 'SPROUT_MILK', label: 'Milk', canWalkOver: true },
      { id: 'SPROUT_MILK_HALF', label: 'Milk (half)', canWalkOver: true },
      { id: 'SPROUT_MILK_EMPTY', label: 'Milk (empty)', canWalkOver: true },
    ],
  },
  {
    file: 'Objects/Egg_item.png',
    tileset: 'furniture-sprout-farm',
    items: [{ id: 'SPROUT_EGG', label: 'Egg', canWalkOver: true }],
  },
  {
    file: 'Objects/Free_Chicken_House.png',
    tileset: 'furniture-sprout-farm',
    // 3x3, and only the bottom row is the coop itself — the two above are roof.
    items: [{ id: 'SPROUT_CHICKEN_COOP', label: 'Chicken coop', backgroundTiles: 2 }],
  },
  {
    file: 'Objects/Wood_Bridge.png',
    tileset: 'furniture-sprout-farm',
    items: [
      { id: 'SPROUT_BRIDGE_H', label: 'Bridge (horizontal)', canWalkOver: true },
      { id: 'SPROUT_BRIDGE_V', label: 'Bridge (vertical)', canWalkOver: true },
      { id: 'SPROUT_BRIDGE_V_PLAIN', label: 'Bridge, plain (vertical)', canWalkOver: true },
      { id: 'SPROUT_BRIDGE_H_PLAIN', label: 'Bridge, plain (horizontal)', canWalkOver: true },
    ],
  },
];

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** 8-connected components of non-transparent pixels, in reading order. */
function components(png: PNG): Box[] {
  const { width: W, height: H } = png;
  const alphaAt = (x: number, y: number) => png.data[(y * W + x) * 4 + 3];
  const seen = new Uint8Array(W * H);
  const boxes: Array<Box & { n: number }> = [];
  const stack: number[] = [];
  for (let start = 0; start < W * H; start++) {
    if (seen[start] || alphaAt(start % W, Math.floor(start / W)) === 0) continue;
    seen[start] = 1;
    stack.length = 0;
    stack.push(start);
    let x0 = start % W;
    let x1 = x0;
    let y0 = Math.floor(start / W);
    let y1 = y0;
    let n = 0;
    while (stack.length > 0) {
      const p = stack.pop()!;
      const px = p % W;
      const py = Math.floor(p / W);
      n++;
      if (px < x0) x0 = px;
      if (px > x1) x1 = px;
      if (py < y0) y0 = py;
      if (py > y1) y1 = py;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = px + dx;
          const ny = py + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const q = ny * W + nx;
          if (seen[q] || alphaAt(nx, ny) === 0) continue;
          seen[q] = 1;
          stack.push(q);
        }
      }
    }
    boxes.push({ x0, y0, x1, y1, n });
  }
  return boxes
    .filter((b) => b.n >= MIN_PIXELS)
    .sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0)
    .map(({ x0, y0, x1, y1 }) => ({ x0, y0, x1, y1 }));
}

/** The boxes a sheet contributes: its explicit rects, or its components with
 *  the `split` cuts applied in place (which keeps reading order). */
function boxesFor(sheet: Sheet, src: PNG): Box[] {
  if (sheet.boxes) {
    return sheet.boxes.map((b) => ({ x0: b.x, y0: b.y, x1: b.x + b.w - 1, y1: b.y + b.h - 1 }));
  }
  const out: Box[] = [];
  components(src).forEach((box, i) => {
    const parts = sheet.split?.[i] ?? 1;
    const width = (box.x1 - box.x0 + 1) / parts;
    if (!Number.isInteger(width)) {
      throw new Error(`${sheet.file}: component ${i} is ${box.x1 - box.x0 + 1}px wide, which does not divide into ${parts}`);
    }
    for (let p = 0; p < parts; p++) {
      out.push({ ...box, x0: box.x0 + p * width, x1: box.x0 + (p + 1) * width - 1 });
    }
  });
  return out;
}

/** Crop `box` out of `src` into a PNG padded to whole tiles, the art
 *  bottom-aligned and horizontally centered in it. */
function cropToTiles(src: PNG, box: Box): PNG {
  const w = box.x1 - box.x0 + 1;
  const h = box.y1 - box.y0 + 1;
  const outW = Math.ceil(w / TILE) * TILE;
  const outH = Math.ceil(h / TILE) * TILE;
  const offX = Math.floor((outW - w) / 2);
  const offY = outH - h;
  const out = new PNG({ width: outW, height: outH });
  out.data.fill(0);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = ((box.y0 + y) * src.width + (box.x0 + x)) * 4;
      if (src.data[si + 3] === 0) continue;
      const di = ((offY + y) * outW + (offX + x)) * 4;
      out.data[di] = src.data[si];
      out.data[di + 1] = src.data[si + 1];
      out.data[di + 2] = src.data[si + 2];
      out.data[di + 3] = src.data[si + 3];
    }
  }
  return out;
}

interface TileEntry {
  id: number;
  type: string;
  image: string;
  imagewidth: number;
  imageheight: number;
  properties: Array<{ name: string; type: string; value: string | number | boolean; propertytype?: string }>;
}

/** The whole behaviour set, defaults included, so these arrive in the shape
 *  sync-furniture-properties.mts keeps every other furniture tile in — a
 *  mapper opening one sees everything it could do, not a short list. */
function propertiesFor(item: Item): TileEntry['properties'] {
  const stated: Record<string, string | number | boolean | undefined> = {
    label: item.label,
    canSitOn: item.canSitOn,
    sitFacing: item.sitFacing,
    petCanSitOn: item.petCanSitOn,
    canWalkOver: item.canWalkOver,
    backgroundTiles: item.backgroundTiles,
    onState: item.onState,
  };
  return [
    { name: 'id', type: 'string', value: item.id },
    ...FURNITURE_TILE_PROPS.map((spec) => {
      const value = stated[spec.name] ?? spec.default;
      return {
        name: spec.name,
        type: typeof value === 'boolean' ? 'bool' : typeof value === 'number' ? 'int' : 'string',
        value,
        ...(spec.propertyType ? { propertytype: spec.propertyType } : {}),
      };
    }),
  ];
}

// Checked before any work: the PNGs get rewritten too, and a script that does
// its job and only then refuses to save it is just confusing.
const FORCE = process.argv.includes('--force');
const clobber = [...new Set(SHEETS.map((s) => s.tileset))].filter((n) => fs.existsSync(path.join(OUT_TSJ_DIR, `${n}.tsj`)));
if (clobber.length > 0 && !FORCE) {
  console.error(`✗ these tilesets already exist and are hand-maintained: ${clobber.join(', ')}`);
  console.error('  Rewriting them would discard every property set in Tiled since. Pass --force if that is really what you want.');
  process.exit(1);
}

fs.mkdirSync(OUT_PNG_DIR, { recursive: true });
const bySet = new Map<string, TileEntry[]>();
const seenIds = new Set<string>();
let written = 0;
for (const sheet of SHEETS) {
  const src = PNG.sync.read(fs.readFileSync(path.join(PACK, sheet.file)));
  const boxes = boxesFor(sheet, src);
  if (boxes.length !== sheet.items.length) {
    throw new Error(`${sheet.file}: sliced ${boxes.length} items but the table names ${sheet.items.length} — see this file's header`);
  }
  const entries = bySet.get(sheet.tileset) ?? [];
  let kept = 0;
  boxes.forEach((box, i) => {
    const item = sheet.items[i];
    if (!item) return;
    if (seenIds.has(item.id)) throw new Error(`duplicate catalog id ${item.id}`);
    seenIds.add(item.id);
    const out = cropToTiles(src, box);
    fs.writeFileSync(path.join(OUT_PNG_DIR, `${item.id}.png`), PNG.sync.write(out));
    written++;
    kept++;
    entries.push({
      id: entries.length,
      type: 'FurnitureTile',
      image: `png/furniture/sprout/${item.id}.png`,
      imagewidth: out.width,
      imageheight: out.height,
      properties: propertiesFor(item),
    });
  });
  bySet.set(sheet.tileset, entries);
  console.log(`  ${sheet.file} → ${kept} items`);
}

for (const [name, tiles] of [...bySet.entries()].sort()) {
  // An image-collection tileset: columns 0 and no shared image, each tile
  // carrying its own PNG — same shape as the existing furniture-*.tsj files.
  const tsj = {
    columns: 0,
    grid: { height: TILE, orientation: 'orthogonal', width: TILE },
    name,
    tilecount: tiles.length,
    tiledversion: '1.11.0',
    tileheight: Math.max(...tiles.map((t) => t.imageheight)),
    tilewidth: Math.max(...tiles.map((t) => t.imagewidth)),
    tiles,
    type: 'tileset',
    version: '1.10',
  };
  fs.writeFileSync(path.join(OUT_TSJ_DIR, `${name}.tsj`), JSON.stringify(tsj, null, 2) + '\n');
  console.log(`✓ ${name}.tsj (${tiles.length} items)`);
}
console.log(`✓ ${written} PNGs in ${path.relative(ROOT, OUT_PNG_DIR)}`);
