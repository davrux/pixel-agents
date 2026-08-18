#!/usr/bin/env -S node --import tsx
/**
 * One-time importer for the "Zelda-like tilesets and sprites" pack's
 * Overworld.png sheet (ArMM1998, public domain / CC0 — see the README credit).
 *
 * The sheet mixes three kinds of thing on one canvas, and which is which
 * cannot be derived from the pixels — it takes eyes. The tables below are that
 * judgement, written down:
 *
 *   - **Terrain** (grass, water, sand, cliffs, dirt paths, garden beds) becomes
 *     floor patterns: FLOOR_RECTS lists the fully-opaque 16x16 cells that are
 *     ground, each written to assets/floors/overworld_<i>.png for
 *     bake-floor-wall-tiled.mts to bake into the natural-only (one column, no
 *     palette swatches) floor-overworld set. Cells whose pixels exactly repeat
 *     an earlier pattern are skipped — big terrain blocks tile the same art.
 *   - **Animation frames** are DROPPED (DROP_RECTS): the sheet carries its
 *     water, its big fountain and half its open-water block as 2-4 near-copies
 *     that only make sense animated, and floors don't animate. One frame of
 *     each survives as the pattern; the rest would be identical-looking clutter.
 *   - **Everything else** — houses, trees, bushes, fences, wells, statues,
 *     market stands, and every other item sitting on transparent background —
 *     is sliced by 8-connected alpha components (lib/sheetSlice.mts, shared
 *     with the metro importers) into furniture-overworld.tsj, except the flat
 *     ground patches (lilypads, sparkles, dirt spots, grass fringes) listed in
 *     DECAL_ITEMS, which are pictures and nothing else and therefore append to
 *     decal.tsj — same split, and same appending rules, as gen-metro-outdoor.mts.
 *
 * Every behaviour property arrives at its DEFAULT: a sliced sheet is a catalog
 * of sprites, and which of them block, seat or act is set by hand in Tiled
 * afterwards. Like gen-metro-furniture.mts, this refuses to overwrite an
 * existing furniture-overworld.tsj without --force, because those hand-set
 * values live there.
 *
 * The pack itself lives outside the repo (tmp/zelda-like, gitignored); only
 * the derived PNGs + tilesets are committed.
 *
 * Run (from server/): node --import tsx scripts/gen-overworld.mts [--force]
 * then: node --import tsx scripts/bake-floor-wall-tiled.mts
 */
import { PNG } from 'pngjs';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { DECAL_TILE_PROPS } from '../src/tiled/decalProps.js';
import { FURNITURE_TILE_PROPS } from '../src/tiled/furnitureProps.js';
import { DECAL_TILE_CLASS, FURNITURE_TILE_CLASS } from '../src/tiled/tiledRegistry.js';
import { componentsMasked, cropToTiles } from './lib/sheetSlice.mjs';

const ROOT = new URL('../..', import.meta.url).pathname;
const SHEET = path.join(ROOT, 'tmp', 'zelda-like', 'Overworld.png');
const FLOOR_DIR = path.join(ROOT, 'assets', 'floors');
const TILED = path.join(ROOT, 'assets', 'tiled');
const FURNITURE_TSJ = path.join(TILED, 'furniture-overworld.tsj');
const FURNITURE_PNG_DIR = 'png/furniture/overworld';
const DECAL_TSJ = path.join(TILED, 'decal.tsj');
const DECAL_PNG_DIR = 'png/decal';
const T = 16;
const FORCE = process.argv.includes('--force');

interface Rect {
  tx: number;
  ty: number;
  w: number;
  h: number;
  note: string;
}
const r = (tx: number, ty: number, w: number, h: number, note: string): Rect => ({ tx, ty, w, h, note });

/**
 * The ground, in reading order. Only fully-opaque cells become patterns — a
 * partially transparent cell would render as a hole down to the canvas
 * background, since a zone has exactly one ground layer (the same rule that
 * limited the Sprout floors to the packs' fill tiles). A rect here may still
 * brush a see-through edge cell; those are skipped with a note rather than
 * failing the run, so a rect can honestly cover "the grass block" without
 * per-cell bookkeeping of its ragged fringe (the fringe cells stay in the
 * sheet and come out as decals below).
 */
const FLOOR_RECTS: Rect[] = [
  // ── top-left meadows and waters ──
  r(0, 0, 1, 1, 'grass, plain'),
  r(0, 1, 1, 1, 'water, high waves'),
  r(0, 2, 1, 1, 'water, low waves'),
  r(0, 3, 3, 3, 'grass with sand patch'),
  r(3, 3, 3, 2, 'deep water, ripple ring'),
  r(16, 0, 2, 4, 'open water'),
  // The grass square around the small pond, bush fill included; the pond's
  // own water centre (3,7) is opaque water and comes along.
  r(0, 6, 5, 2, 'bushes / grass around pond'),
  r(2, 8, 3, 1, 'grass below pond'),
  r(0, 9, 9, 2, 'meadow'),
  // ── the lake: sand shore, streaked water, island ──
  r(11, 5, 2, 2, 'tall grass'),
  r(15, 6, 3, 3, 'sand shore around lake hole'),
  r(18, 6, 3, 1, 'lake, streaked water'),
  r(18, 7, 3, 2, 'lake, streaked water lower'),
  r(15, 9, 2, 2, 'lake island'),
  r(17, 9, 3, 2, 'lake, ripple shore'),
  r(18, 11, 3, 1, 'lake, foam edge'),
  // ── cliffs, rivers and paths (lower-left quarter) ──
  r(4, 11, 4, 1, 'cliff, grass top'),
  r(4, 12, 3, 2, 'cliff face'),
  r(8, 13, 5, 2, 'grass to dirt'),
  r(12, 13, 1, 2, 'dirt path'),
  r(13, 15, 2, 1, 'dirt path, lower'),
  r(11, 16, 4, 1, 'dirt path, bottom'),
  r(2, 16, 3, 1, 'bright grass'),
  r(9, 17, 2, 1, 'grass, river inlet'),
  r(9, 18, 2, 1, 'cliff with waterfall top'),
  r(14, 11, 1, 1, 'stone slab'),
  r(16, 12, 1, 1, 'stone slab, cracked'),
  r(19, 13, 1, 1, 'cobble'),
  r(0, 20, 8, 1, 'soil and cliff-shore row'),
  r(9, 20, 2, 2, 'cliff and grass, waterfall run'),
  // ── gardens and hedges (bottom-left quarter) ──
  r(0, 29, 3, 3, 'grass with dirt patch'),
  r(0, 32, 3, 1, 'grass to soil edge'),
  r(0, 33, 2, 1, 'grass to soil edge, lower'),
  r(0, 34, 2, 2, 'garden beds'),
  r(9, 27, 2, 2, 'hedge mass'),
  r(11, 28, 3, 1, 'hedge, sparse'),
  r(14, 29, 5, 2, 'hedge field'),
  r(14, 31, 3, 1, 'hedge field, middle'),
  r(14, 32, 5, 2, 'hedge field, lower'),
];

/**
 * Animation frames, dropped entirely: near-copies of a pattern or item taken
 * above, differing only in wave/splash phase (verified by pixel diff — the
 * water frames differ by 8-20%, all of it moving foam). Floors don't animate
 * and a catalog of four identical-looking fountains helps nobody.
 */
const DROP_RECTS: Rect[] = [
  r(1, 1, 3, 2, 'water wave frames 2-4'),
  r(18, 0, 4, 4, 'open water frames 2-3'),
  r(24, 9, 4, 3, 'fountain frames 2-3'),
];

/**
 * Structures cut out by explicit cell rect, ahead of the component pass. The
 * component slicer is right for everything sitting free on transparent
 * background, but the sheet is a packed collage: distinct props lean on each
 * other pixel-to-pixel (the cave arches touch the brick wall touch the keep
 * wall; the prop shelf rows sit flush), and 8-connectivity fuses each such
 * group into one unplaceable mega-item. The pack aligns its art to the 16px
 * grid, so cell rects cut cleanly. Extraction trims each rect to its actual
 * content, blanks it, and runs in list order — so where two items share a
 * cell edge the earlier rect takes its pixels first. `decal: true` routes a
 * flat picture (a shadow) to decal.tsj instead of the furniture set.
 */
const ITEM_RECTS: Array<Rect & { id: string; decal?: boolean }> = [
  // the lake's arch wall and the walls leaning on it
  { ...r(16, 4, 5, 2, 'Stone arches'), id: 'OW_ARCHES' },
  { ...r(22, 0, 3, 3, 'Keep wall, white'), id: 'OW_KEEP_WALL' },
  { ...r(22, 3, 3, 4, 'Brick wall'), id: 'OW_BRICK_WALL' },
  { ...r(21, 4, 1, 3, 'Stone blocks'), id: 'OW_STONE_BLOCKS' },
  { ...r(21, 7, 1, 2, 'Window, small'), id: 'OW_WINDOW_SMALL' },
  { ...r(22, 7, 3, 2, 'Window, wide'), id: 'OW_WINDOW_WIDE' },
  // the prop shelf (top right): slabs, crates, bones, benches
  { ...r(27, 0, 1, 1, 'Cage, small'), id: 'OW_CAGE_SMALL' },
  { ...r(28, 0, 2, 2, 'Slab, crest'), id: 'OW_SLAB_CREST' },
  { ...r(30, 0, 1, 2, 'Crate stack'), id: 'OW_CRATES' },
  { ...r(31, 0, 1, 3, 'Crate stack, tall'), id: 'OW_CRATES_TALL' },
  { ...r(32, 0, 1, 1, 'Sack'), id: 'OW_SACK' },
  { ...r(32, 1, 1, 2, 'Flowering plant'), id: 'OW_PLANT_FLOWERING' },
  { ...r(27, 1, 1, 1, 'Bone pile'), id: 'OW_BONE_PILE' },
  { ...r(27, 2, 1, 1, 'Bones, crossed'), id: 'OW_BONES_CROSSED' },
  { ...r(27, 3, 1, 1, 'Skull'), id: 'OW_SKULL' },
  { ...r(28, 2, 1, 1, 'Skull, small'), id: 'OW_SKULL_SMALL' },
  { ...r(28, 3, 1, 1, 'Bone'), id: 'OW_BONE' },
  { ...r(29, 2, 1, 1, 'Bone, small'), id: 'OW_BONE_SMALL' },
  { ...r(29, 3, 1, 1, 'Bone, large'), id: 'OW_BONE_LARGE' },
  { ...r(30, 2, 1, 2, 'Slab, cracked'), id: 'OW_SLAB_CRACKED' },
  { ...r(28, 4, 3, 2, 'Bench, long'), id: 'OW_BENCH_LONG' },
  { ...r(31, 4, 2, 2, 'Table, round straw'), id: 'OW_TABLE_STRAW' },
  // window row + the small fountain under it
  { ...r(27, 8, 3, 1, 'Window sill, wide'), id: 'OW_WINDOW_SILL' },
  { ...r(28, 9, 3, 3, 'Fountain, small'), id: 'OW_FOUNTAIN_SMALL' },
  // the roofs-and-market strip (right middle)
  { ...r(23, 17, 2, 3, 'Roof, folded'), id: 'OW_ROOF_FOLDED' },
  { ...r(25, 17, 1, 3, 'Chimney, stone'), id: 'OW_CHIMNEY_STONE' },
  { ...r(23, 20, 1, 2, 'Stand, lantern'), id: 'OW_STAND_LANTERN' },
  { ...r(24, 20, 1, 2, 'Produce crate, greens'), id: 'OW_PRODUCE_GREENS' },
  { ...r(25, 20, 1, 2, 'Produce crate, red'), id: 'OW_PRODUCE_RED' },
  { ...r(23, 22, 2, 2, 'Cupboard'), id: 'OW_CUPBOARD' },
  { ...r(29, 20, 1, 2, 'Produce crate'), id: 'OW_PRODUCE_CRATE' },
  { ...r(29, 16, 11, 5, 'Roof, long'), id: 'OW_ROOF_LONG' },
  { ...r(17, 18, 3, 2, 'Tree shadow'), id: 'OW_TREE_SHADOW', decal: true },
  { ...r(16, 25, 2, 2, 'Counter, dairy'), id: 'OW_COUNTER_DAIRY' },
  // the garden quarter's leaning structures
  { ...r(0, 13, 5, 3, 'Hedge ring'), id: 'OW_HEDGE_RING' },
  { ...r(0, 21, 3, 8, 'Well tower'), id: 'OW_WELL_TOWER' },
  { ...r(3, 21, 1, 1, 'Vent, grated'), id: 'OW_VENT' },
  { ...r(3, 22, 3, 5, 'Tower, cone roof'), id: 'OW_TOWER_CONE' },
  { ...r(6, 22, 2, 2, 'Shrine, grated'), id: 'OW_SHRINE' },
  // the riverbank chain: fences, tree, bushes, then the flat cliff/pit edges
  { ...r(2, 17, 1, 2, 'Fence, corner'), id: 'OW_FENCE_CORNER' },
  { ...r(3, 17, 1, 2, 'Fence, rail'), id: 'OW_FENCE_RAIL' },
  { ...r(4, 17, 1, 2, 'Fence, post'), id: 'OW_FENCE_POST' },
  { ...r(5, 16, 3, 3, 'Tree, large'), id: 'OW_TREE_LARGE' },
  { ...r(2, 19, 2, 1, 'Bushes'), id: 'OW_BUSHES' },
  { ...r(4, 18, 2, 2, 'Bush cluster'), id: 'OW_BUSH_CLUSTER' },
  { ...r(8, 15, 2, 2, 'Cliff lip, waterfall'), id: 'OW_CLIFF_LIP', decal: true },
  { ...r(7, 18, 4, 2, 'Cliff face, waterfalls'), id: 'OW_CLIFF_FACE', decal: true },
  { ...r(12, 18, 2, 4, 'Cliff, tall waterfall'), id: 'OW_CLIFF_TALL', decal: true },
  { ...r(13, 20, 2, 2, 'Pit ring, clay'), id: 'OW_PIT_CLAY', decal: true },
  { ...r(9, 11, 2, 2, 'Rocks, mossy'), id: 'OW_ROCKS_MOSSY', decal: true },
  { ...r(11, 11, 2, 2, 'Rocks'), id: 'OW_ROCKS', decal: true },
  { ...r(13, 11, 2, 2, 'Rocks, shore'), id: 'OW_ROCKS_SHORE', decal: true },
  { ...r(15, 12, 1, 1, 'Slab, broken'), id: 'OW_SLAB_BROKEN', decal: true },
  { ...r(13, 13, 3, 2, 'Dirt slope'), id: 'OW_DIRT_SLOPE', decal: true },
  { ...r(11, 15, 2, 2, 'Cliff foot, pools'), id: 'OW_CLIFF_FOOT', decal: true },
  { ...r(16, 14, 3, 3, 'Pit ring, stone'), id: 'OW_PIT_STONE', decal: true },
  { ...r(15, 20, 2, 3, 'Dirt mound'), id: 'OW_DIRT_MOUND', decal: true },
  { ...r(14, 23, 3, 2, 'Pit ring, dirt'), id: 'OW_PIT_DIRT', decal: true },
  { ...r(14, 25, 2, 2, 'Burrow'), id: 'OW_BURROW', decal: true },
  // the castle quarter: monolith, statues, flags, gate
  { ...r(10, 22, 1, 3, 'Statue, urn'), id: 'OW_STATUE_URN' },
  { ...r(8, 22, 2, 4, 'Monolith'), id: 'OW_MONOLITH' },
  { ...r(6, 26, 4, 1, 'Wall, curved'), id: 'OW_WALL_CURVED' },
  { ...r(7, 27, 2, 2, 'Doorway, arch'), id: 'OW_DOORWAY_ARCH' },
  { ...r(4, 27, 1, 2, 'Spade'), id: 'OW_SPADE' },
  { ...r(5, 27, 1, 2, 'Banner, pennant'), id: 'OW_BANNER_A' },
  { ...r(6, 27, 1, 2, 'Banner, pennant 2'), id: 'OW_BANNER_B' },
  { ...r(3, 29, 2, 2, 'Flag'), id: 'OW_FLAG_A' },
  { ...r(5, 29, 2, 2, 'Flag 2'), id: 'OW_FLAG_B' },
  { ...r(7, 29, 2, 2, 'Flag 3'), id: 'OW_FLAG_C' },
  { ...r(9, 29, 2, 2, 'Flag 4'), id: 'OW_FLAG_D' },
  { ...r(11, 29, 2, 2, 'Flag 5'), id: 'OW_FLAG_E' },
  { ...r(3, 31, 4, 4, 'Castle gate'), id: 'OW_CASTLE_GATE' },
  { ...r(7, 31, 3, 4, 'Statue'), id: 'OW_STATUE' },
];

/** Flat ground patches among the sliced items — a picture painted under
 *  everyone's feet, not a thing with height — routed to decal.tsj. Judged one
 *  by one from the slicer's output; the ids are the slicer's reading-order
 *  numbering, so this list is only meaningful together with the rects above
 *  (the run prints each component's id and cell range to check against). */
const DECAL_ITEMS = new Set<string>([
  'OW_01', // lily pads
  'OW_06', // dirt spot
  'OW_08', // lily pad, large
  'OW_10', // lily pad
  'OW_15', // sprout
  'OW_47', // bush tuft
  'OW_48', // bush tuft 2
  'OW_57', // cliff with cave hole
  'OW_58', // grass fringe
  'OW_59', // sparkles
  'OW_60', // sparkles 2
  'OW_61', // pit ring, white
  'OW_63', // grit
  'OW_64', // sparkle
  'OW_67', // grit 2
  'OW_68', // pit ring, ember
  'OW_70', // cliff foot, rubble
  'OW_72', // pit ring corner
  'OW_78', // dirt patch, bordered
  'OW_79', // dirt patch, bordered 2
  'OW_80', // waterfall run
  'OW_82', // pit edge, clay
  'OW_89', // shore edge
]);

/** Hand labels for the recognizable items, by id; everything else gets
 *  "Overworld <n>". Purely a convenience for the Tiled palette — behaviour
 *  still lives in the per-tile properties. */
const LABELS: Record<string, string> = {
  OW_01: 'Lily pads',
  OW_02: 'House',
  OW_03: 'House, shuttered',
  OW_04: 'Barrels',
  OW_05: 'Potted flower, white',
  OW_06: 'Dirt spot',
  OW_07: 'Portcullis',
  OW_08: 'Lily pad, large',
  OW_09: 'Pot',
  OW_10: 'Lily pad',
  OW_11: 'Sign, hanging',
  OW_12: 'Clover',
  OW_13: 'Chain',
  OW_14: 'Boulders',
  OW_15: 'Sprout',
  OW_16: 'Flower, potted',
  OW_17: 'Door, dark',
  OW_18: 'Rocks, flowered',
  OW_19: 'Rock, flowered',
  OW_20: 'Trapdoor',
  OW_21: 'Trapdoor, open',
  OW_22: 'Straw heap',
  OW_23: 'Doorpost',
  OW_24: 'Door, tall',
  OW_25: 'Door, tall 2',
  OW_26: 'Log',
  OW_27: 'Cellar hatch',
  OW_28: 'Rock, mossy',
  OW_29: 'Rock, mossy 2',
  OW_30: 'Rock, mossy 3',
  OW_31: 'Stone cap',
  OW_32: 'Stone cap 2',
  OW_33: 'Stone cap 3',
  OW_34: 'Pebble',
  OW_35: 'Shed',
  OW_36: 'Pebbles',
  OW_38: 'Bush, large',
  OW_39: 'Boulder, shore',
  OW_40: 'Bench',
  OW_41: 'Stone cap, small',
  OW_42: 'Stone caps',
  OW_43: 'Boulder, shore 2',
  OW_45: 'Wall, rounded',
  OW_46: 'Crate',
  OW_47: 'Bush tuft',
  OW_48: 'Bush tuft 2',
  OW_49: 'Boulder, water',
  OW_50: 'Boulders, water',
  OW_51: 'Rock, flat',
  OW_52: 'Fountain',
  OW_53: 'Gate, tall wooden',
  OW_54: 'Boulder row, water',
  OW_55: 'Rock, water',
  OW_56: 'Table, pedestal',
  OW_57: 'Cliff, cave hole',
  OW_58: 'Grass fringe',
  OW_59: 'Sparkles',
  OW_60: 'Sparkles 2',
  OW_61: 'Pit ring, white',
  OW_62: 'Planks',
  OW_63: 'Grit',
  OW_64: 'Sparkle',
  OW_65: 'Rock, small',
  OW_66: 'Roof, gable',
  OW_67: 'Grit 2',
  OW_68: 'Pit ring, ember',
  OW_69: 'Pillar, wood',
  OW_70: 'Cliff foot, rubble',
  OW_71: 'Planks, worn',
  OW_72: 'Pit ring corner',
  OW_73: 'Bushes, low',
  OW_74: 'Pillar, narrow',
  OW_75: 'Pillar, footed',
  OW_76: 'Fence, end post',
  OW_77: 'Tree, dark',
  OW_78: 'Dirt patch, bordered',
  OW_79: 'Dirt patch, bordered 2',
  OW_80: 'Waterfall run',
  OW_81: 'Fence, short',
  OW_82: 'Pit edge, clay',
  OW_83: 'Crate frame',
  OW_84: 'Crate, open',
  OW_85: 'Produce crate, yellow',
  OW_86: 'Produce crate, sprouts',
  OW_87: 'Produce crate, radishes',
  OW_88: 'Pole',
  OW_89: 'Shore edge',
  OW_90: 'Coal pile',
  OW_91: 'Coal pile 2',
  OW_92: 'Coals',
  OW_93: 'Market stall',
  OW_94: 'Castle gatehouse',
  OW_95: 'Coal pile 3',
  OW_96: 'Coal heap',
  OW_98: 'Heap, dark',
  OW_100: 'Cannon',
  OW_101: 'Cannon 2',
  OW_103: 'Keep platform',
  OW_104: 'Tunnel',
  OW_105: 'Rail arch',
};

// ── read the sheet, blank what is consumed or dropped ──
if (!fs.existsSync(SHEET)) {
  console.error(`✗ sheet missing: ${SHEET} — put the pack's PNGs in tmp/zelda-like/ first`);
  process.exit(1);
}
const src = PNG.sync.read(fs.readFileSync(SHEET));

function cellFullyOpaque(tx: number, ty: number): boolean {
  for (let y = 0; y < T; y++)
    for (let x = 0; x < T; x++) {
      if (src.data[((ty * T + y) * src.width + tx * T + x) * 4 + 3] !== 255) return false;
    }
  return true;
}

function blankCell(tx: number, ty: number): void {
  for (let y = 0; y < T; y++)
    for (let x = 0; x < T; x++) {
      src.data.fill(0, ((ty * T + y) * src.width + tx * T + x) * 4, ((ty * T + y) * src.width + tx * T + x) * 4 + 4);
    }
}

function cellPng(tx: number, ty: number): PNG {
  const out = new PNG({ width: T, height: T });
  for (let y = 0; y < T; y++) {
    const srcStart = ((ty * T + y) * src.width + tx * T) * 4;
    src.data.copy(out.data, y * T * 4, srcStart, srcStart + T * 4);
  }
  return out;
}

// ── floors ──
for (const f of fs.readdirSync(FLOOR_DIR)) {
  if (/^overworld_\d+\.png$/.test(f)) fs.unlinkSync(path.join(FLOOR_DIR, f));
}
const seenPatterns = new Map<string, string>(); // pixel bytes → note of first occurrence
let floorIndex = 0;
let dupes = 0;
const skippedPartial: string[] = [];
for (const rect of FLOOR_RECTS) {
  for (let dy = 0; dy < rect.h; dy++) {
    for (let dx = 0; dx < rect.w; dx++) {
      const tx = rect.tx + dx;
      const ty = rect.ty + dy;
      if (!cellFullyOpaque(tx, ty)) {
        skippedPartial.push(`(${tx},${ty}) ${rect.note}`);
        continue;
      }
      const png = cellPng(tx, ty);
      const key = png.data.toString('base64');
      blankCell(tx, ty);
      const first = seenPatterns.get(key);
      if (first !== undefined) {
        dupes++;
        continue;
      }
      seenPatterns.set(key, rect.note);
      fs.writeFileSync(path.join(FLOOR_DIR, `overworld_${floorIndex}.png`), PNG.sync.write(png));
      floorIndex++;
    }
  }
}
console.log(`✓ ${floorIndex} floor patterns → assets/floors/overworld_*.png (${dupes} repeated cells folded)`);
if (skippedPartial.length > 0) {
  console.log(`  ${skippedPartial.length} see-through cell(s) skipped (stay in the sheet as items/decals):`);
  for (const s of skippedPartial) console.log(`    ${s}`);
}

for (const rect of DROP_RECTS) {
  for (let dy = 0; dy < rect.h; dy++) for (let dx = 0; dx < rect.w; dx++) blankCell(rect.tx + dx, rect.ty + dy);
}

interface TileEntry {
  id: number;
  type: string;
  image: string;
  imagewidth: number;
  imageheight: number;
  properties: Array<{ name: string; type: string; value: string | number | boolean; propertytype?: string }>;
}

function propsFor(
  itemId: string,
  label: string,
  specs: ReadonlyArray<{ name: string; default: string | number | boolean; propertyType?: string }>,
): TileEntry['properties'] {
  return [
    { name: 'id', type: 'string', value: itemId },
    ...specs.map((spec) => {
      const value = spec.name === 'label' ? label : spec.default;
      return {
        name: spec.name,
        type: typeof value === 'boolean' ? 'bool' : typeof value === 'number' ? 'int' : 'string',
        value,
        ...(spec.propertyType ? { propertytype: spec.propertyType } : {}),
      };
    }),
  ];
}

if (fs.existsSync(FURNITURE_TSJ) && !FORCE) {
  console.error('✗ furniture-overworld.tsj already exists and is hand-maintained in Tiled.');
  console.error('  Rewriting discards every property set there since. Pass --force if that is really what you want.');
  process.exit(1);
}

// decal.tsj is appended to, never rewritten — existing tiles (metro's ground
// patches, with whatever a mapper set on them) are copied through byte for
// byte, and an item id already present is skipped so a re-run cannot duplicate.
const decalTileset = JSON.parse(fs.readFileSync(DECAL_TSJ, 'utf-8')) as {
  tilecount: number;
  tiles: TileEntry[];
  [k: string]: unknown;
};
const decalExisting = new Set(
  decalTileset.tiles.map((t) => t.properties?.find((p) => p.name === 'id')?.value).filter((v) => typeof v === 'string'),
);
let nextDecalId = Math.max(-1, ...decalTileset.tiles.map((t) => t.id)) + 1;

const furnitureTiles: TileEntry[] = [];
const decalAdds: TileEntry[] = [];
fs.mkdirSync(path.join(TILED, FURNITURE_PNG_DIR), { recursive: true });
fs.mkdirSync(path.join(TILED, DECAL_PNG_DIR), { recursive: true });
if (FORCE) {
  for (const f of fs.readdirSync(path.join(TILED, FURNITURE_PNG_DIR))) {
    // Every OW_* PNG, the named rect items included — a rect removed from
    // ITEM_RECTS must not leave its PNG behind as an orphan.
    if (/^OW_[A-Z0-9_]+\.png$/i.test(f)) fs.unlinkSync(path.join(TILED, FURNITURE_PNG_DIR, f));
  }
}

function emit(itemId: string, label: string, out: PNG, decal = false): void {
  if (decal || DECAL_ITEMS.has(itemId)) {
    if (decalExisting.has(itemId)) return;
    fs.writeFileSync(path.join(TILED, DECAL_PNG_DIR, `${itemId}.png`), PNG.sync.write(out));
    decalAdds.push({
      id: nextDecalId++,
      type: DECAL_TILE_CLASS,
      image: `${DECAL_PNG_DIR}/${itemId}.png`,
      imagewidth: out.width,
      imageheight: out.height,
      properties: propsFor(itemId, label, DECAL_TILE_PROPS),
    });
  } else {
    fs.writeFileSync(path.join(TILED, FURNITURE_PNG_DIR, `${itemId}.png`), PNG.sync.write(out));
    furnitureTiles.push({
      id: furnitureTiles.length,
      type: FURNITURE_TILE_CLASS,
      image: `${FURNITURE_PNG_DIR}/${itemId}.png`,
      imagewidth: out.width,
      imageheight: out.height,
      properties: propsFor(itemId, label, FURNITURE_TILE_PROPS),
    });
  }
}

// The leaned-on structures first, by explicit rect, trimmed to the pixels
// actually inside (a rect may be generous around a slanted roof) …
for (const item of ITEM_RECTS) {
  let x0 = (item.tx + item.w) * T;
  let y0 = (item.ty + item.h) * T;
  let x1 = item.tx * T - 1;
  let y1 = item.ty * T - 1;
  for (let y = item.ty * T; y < (item.ty + item.h) * T; y++) {
    for (let x = item.tx * T; x < (item.tx + item.w) * T; x++) {
      if (src.data[(y * src.width + x) * 4 + 3] === 0) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < x0) {
    console.error(`✗ item rect "${item.note}" (${item.tx},${item.ty}) is empty — the tables above disagree`);
    process.exit(1);
  }
  emit(item.id, item.note, cropToTiles(src, { x0, y0, x1, y1 }), item.decal);
  for (let dy = 0; dy < item.h; dy++) for (let dx = 0; dx < item.w; dx++) blankCell(item.tx + dx, item.ty + dy);
}

// … then everything still in the sheet, by alpha component — mask-exact, so
// two components whose boxes overlap don't copy each other's pixels. The cell
// ranges are printed because the OW_<n> numbering is positional: DECAL_ITEMS/
// LABELS above are judgements about THIS numbering, and the printout is how a
// re-run after editing the tables is checked against them.
const comps = componentsMasked(src);
console.log(`  ${comps.length} item components in the remainder:`);
comps.forEach(({ box, mask }, i) => {
  const itemId = `OW_${String(i + 1).padStart(2, '0')}`;
  const cells = `(${Math.floor(box.x0 / T)},${Math.floor(box.y0 / T)})..(${Math.floor(box.x1 / T)},${Math.floor(box.y1 / T)})`;
  console.log(`    ${itemId} ${cells} ${box.x1 - box.x0 + 1}x${box.y1 - box.y0 + 1}px${DECAL_ITEMS.has(itemId) ? ' → decal' : ''}`);
  emit(itemId, LABELS[itemId] ?? `Overworld ${i + 1}`, cropToTiles(src, box, mask));
});

fs.writeFileSync(
  FURNITURE_TSJ,
  JSON.stringify(
    {
      columns: 0,
      grid: { height: T, orientation: 'orthogonal', width: T },
      name: 'furniture-overworld',
      tilecount: furnitureTiles.length,
      tiledversion: '1.11.0',
      tileheight: Math.max(...furnitureTiles.map((t) => t.imageheight)),
      tilewidth: Math.max(...furnitureTiles.map((t) => t.imagewidth)),
      tiles: furnitureTiles,
      type: 'tileset',
      version: '1.10',
    },
    null,
    2,
  ) + '\n',
);
console.log(`✓ furniture-overworld.tsj (${furnitureTiles.length} items)`);
if (decalAdds.length > 0) {
  decalTileset.tiles = [...decalTileset.tiles, ...decalAdds];
  decalTileset.tilecount = decalTileset.tiles.length;
  fs.writeFileSync(DECAL_TSJ, `${JSON.stringify(decalTileset, null, 2)}\n`);
  console.log(`✓ ${decalAdds.length} flat patch(es) appended to decal.tsj`);
}
console.log('  Now: node --import tsx scripts/bake-floor-wall-tiled.mts');
console.log('  Then in Tiled: label the items; set what blocks and what sits. Then scripts/sync-furniture-properties.sh --check');
