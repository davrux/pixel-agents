#!/usr/bin/env -S node --import tsx
/**
 * Import the MetroCity **Outdoor** sheets — trees, outdoor props and ground
 * patches — by APPENDING them to existing, hand-maintained tilesets.
 *
 * Two targets, because the pack's items are two different kinds of thing:
 *
 *   - **Standing** items (trees, fences, railings, vending machines, the
 *     pharmacy sign) go to `furniture-decor.tsj` as `FurnitureTile`s. They have
 *     height, they may block, they occlude a character walking behind them, and
 *     some of them will want real behaviour later.
 *   - **Flat ground patches** (paving, grass, sand, the shadow blob, the little
 *     tufts and flowers) go to `decal.tsj` as `DecalTile`s. A decal is a picture
 *     on a tile layer and nothing else: no synced object, no behaviour, no
 *     occupancy — see DecalTile in Pixels.tiled-project and OfficeLayout.decals.
 *     That is what keeps a map that paints hundreds of ground patches from
 *     growing hundreds of FurnitureSync objects.
 *
 * Which of the two an item is cannot be derived from the sheet: it takes eyes.
 * DECAL_ITEMS below is that judgement, written down.
 *
 * Why a second script instead of another entry in gen-metro-furniture.mts: that
 * one writes each tileset from scratch and refuses to touch a file that already
 * exists, because every tile in it has since been given real labels and
 * behaviour by hand in Tiled. Adding sheets to an existing tileset needs the
 * opposite of "write from scratch", so it lives here:
 *
 *   - existing tiles are copied through **byte for byte** (id, image, properties
 *     included), so nothing hand-set is lost;
 *   - new tiles get ids after the highest existing one, which leaves every gid
 *     in every saved map pointing where it did;
 *   - an item id already present in either target is skipped, so a re-run adds
 *     nothing and cannot duplicate.
 *
 * Slicing is the shared one (lib/sheetSlice.mts): 8-connected alpha components,
 * padded out to whole tiles, bottom-aligned, horizontally centred.
 *
 * Every behaviour property arrives at its DEFAULT — a sliced sheet is a catalog
 * of sprites, and no rule over a sheet name can decide which of them you may
 * walk over and which block. That is Tiled's job afterwards, exactly as with the
 * interior items. Same for a decal's `occludes`: the flat patches want the
 * default (lie flat, everyone walks over them).
 *
 * NOT imported: the pack's Building/FireStation/PoliceStation sheets (not needed
 * yet) and Road.png. A road sheet is terrain — 305 tiles of asphalt, markings
 * and kerb meant to be painted rather than placed one at a time — so it wants a
 * grid decal set of its own, which is a different generator (no slicing at all:
 * the sheet goes in as one image). Deliberately left for its own decision.
 *
 * The pack itself lives outside the repo (tmp/metro, gitignored); only the
 * derived PNGs + the tileset changes are committed.
 *
 * Run (from server/): node --import tsx scripts/gen-metro-outdoor.mts [--dry-run]
 */
import { PNG } from 'pngjs';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { DECAL_TILE_PROPS } from '../src/tiled/decalProps.js';
import { FURNITURE_TILE_PROPS } from '../src/tiled/furnitureProps.js';
import { DECAL_TILE_CLASS, FURNITURE_TILE_CLASS } from '../src/tiled/tiledRegistry.js';
import { components, cropToTiles } from './lib/sheetSlice.mjs';

const ROOT = new URL('../..', import.meta.url).pathname;
const PACK = path.join(ROOT, 'tmp', 'metro');
const TILED = path.join(ROOT, 'assets', 'tiled');
const DRY = process.argv.includes('--dry-run');

interface Sheet {
  file: string;
  /** Item ids become METRO_<id>_<nn>. */
  id: string;
  label: string;
}

const SHEETS: Sheet[] = [
  { file: 'MetroCIty-Outdoor/MetroCIty/Tree-Sheet.png', id: 'TREE', label: 'Tree' },
  { file: 'MetroCIty-Outdoor/MetroCIty/Tiles.png', id: 'OUT', label: 'Outdoor' },
];

/**
 * The flat ones — everything here becomes a DecalTile, everything else a
 * FurnitureTile. Looked at one by one; the sheet itself gives no clue, so this
 * list IS the judgement:
 *
 *   OUT_01/06        big dirt-and-grass patches (5x5)
 *   OUT_02/03        paving slabs and brickwork
 *   OUT_04/17        dirt borders around a hole
 *   OUT_07/08/11/12/14/21  grass and sand blobs
 *   OUT_18           a grass/sand edge strip
 *   OUT_22           a soft shadow blob (30% black, nothing else)
 *   OUT_10/13/15/16/19/20/23/24  ground-level tufts, flowers, pebbles
 *
 * NOT here, and why: the four trees, the fences (26/27/28/30), the railings
 * (31/32), the vending machines (25/29), the pharmacy sign (09) and OUT_05
 * (a solid white slatted panel, no ground art) all have height — they want to
 * occlude a character walking behind them, and some will want behaviour.
 */
const DECAL_ITEMS = new Set(
  [1, 2, 3, 4, 6, 7, 8, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24].map(
    (n) => `METRO_OUT_${String(n).padStart(2, '0')}`,
  ),
);

/** Where a kind of item goes, and in which shape. Both targets are appended to,
 *  never rewritten — see the header. */
interface Target {
  tsj: string;
  /** Relative to the tileset's own directory, which is what the loader resolves
   *  image paths against (and refuses to escape). */
  pngDir: string;
  tileClass: string;
  props: ReadonlyArray<{ name: string; default: string | number | boolean; propertyType?: string }>;
}

const FURNITURE_TARGET: Target = {
  tsj: path.join(TILED, 'furniture-decor.tsj'),
  pngDir: 'png/src/furniture/metro',
  tileClass: FURNITURE_TILE_CLASS,
  props: FURNITURE_TILE_PROPS,
};

const DECAL_TARGET: Target = {
  tsj: path.join(TILED, 'decal.tsj'),
  pngDir: 'png/src/decal',
  tileClass: DECAL_TILE_CLASS,
  props: DECAL_TILE_PROPS,
};

interface TileEntry {
  id: number;
  type?: string;
  image: string;
  imagewidth: number;
  imageheight: number;
  properties?: Array<{ name: string; type: string; value: string | number | boolean; propertytype?: string }>;
}

interface Tileset {
  tilecount: number;
  tiles: TileEntry[];
  [k: string]: unknown;
}

/** An existing tileset, or a fresh empty one in the exact shape Tiled writes for
 *  a collection-of-images set (`columns: 0`, every tile carrying its own size).
 *  Creating it here rather than by hand keeps the decal set reproducible from the
 *  pack. */
function openTileset(file: string): Tileset {
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf-8')) as Tileset;
  return {
    columns: 0,
    name: path.basename(file, '.tsj'),
    tilecount: 0,
    tiledversion: '1.11.0',
    tileheight: 16,
    tilewidth: 16,
    type: 'tileset',
    version: '1.10',
    tiles: [],
  };
}

/** One target's mutable state while items are being routed into it. */
interface Open {
  target: Target;
  tileset: Tileset;
  nextTileId: number;
  added: TileEntry[];
}

const open = new Map<Target, Open>();
for (const target of [FURNITURE_TARGET, DECAL_TARGET]) {
  const tileset = openTileset(target.tsj);
  open.set(target, {
    target,
    tileset,
    nextTileId: Math.max(-1, ...tileset.tiles.map((t) => t.id)) + 1,
    added: [],
  });
}

/** Every item id already present in ANY target, so a re-run cannot duplicate an
 *  item into the other file after this list was re-judged. */
const existingIds = new Set<string>();
for (const { tileset } of open.values()) {
  for (const t of tileset.tiles) {
    const id = t.properties?.find((p) => p.name === 'id')?.value;
    if (typeof id === 'string') existingIds.add(id);
  }
}

let skipped = 0;
for (const sheet of SHEETS) {
  const srcPath = path.join(PACK, sheet.file);
  if (!fs.existsSync(srcPath)) {
    console.error(`✗ sheet missing: ${srcPath}`);
    process.exit(1);
  }
  const src = PNG.sync.read(fs.readFileSync(srcPath));
  const boxes = components(src);
  const counts = new Map<Target, number>();
  boxes.forEach((box, i) => {
    const itemId = `METRO_${sheet.id}_${String(i + 1).padStart(2, '0')}`;
    if (existingIds.has(itemId)) {
      skipped++;
      return;
    }
    const target = DECAL_ITEMS.has(itemId) ? DECAL_TARGET : FURNITURE_TARGET;
    const state = open.get(target)!;
    const out = cropToTiles(src, box);
    if (!DRY) {
      fs.mkdirSync(path.join(path.dirname(target.tsj), target.pngDir), { recursive: true });
      fs.writeFileSync(path.join(path.dirname(target.tsj), target.pngDir, `${itemId}.png`), PNG.sync.write(out));
    }
    // The whole property set, defaults included, so these arrive in the shape
    // sync-furniture-properties.mts keeps every other tile in.
    const properties = [
      { name: 'id', type: 'string', value: itemId },
      ...target.props.map((spec) => {
        const value = spec.name === 'label' ? `${sheet.label} ${i + 1}` : spec.default;
        return {
          name: spec.name,
          type: typeof value === 'boolean' ? 'bool' : typeof value === 'number' ? 'int' : 'string',
          value,
          ...(spec.propertyType ? { propertytype: spec.propertyType } : {}),
        };
      }),
    ];
    state.added.push({
      id: state.nextTileId++,
      type: target.tileClass,
      image: `${target.pngDir}/${itemId}.png`,
      imagewidth: out.width,
      imageheight: out.height,
      properties,
    });
    counts.set(target, (counts.get(target) ?? 0) + 1);
  });
  const summary = [...counts.entries()].map(([t, n]) => `${n} → ${path.basename(t.tsj)}`).join(', ') || 'nothing new';
  console.log(`  ${sheet.file}: ${boxes.length} item(s), ${summary}`);
}

const touched = [...open.values()].filter((s) => s.added.length > 0);
if (touched.length === 0) {
  console.log('nothing to add — every item is already in a tileset');
  process.exit(0);
}

for (const state of touched) {
  const { target, tileset, added } = state;
  tileset.tiles = [...tileset.tiles, ...added];
  tileset.tilecount = tileset.tiles.length;
  // tilewidth/tileheight are left exactly as they were: for a collection-of-images
  // tileset they are only the panel's default grid, every tile carries its own
  // size, and touching unrelated metadata of a hand-maintained file for cosmetics
  // is not worth the diff.
  const ids = `ids ${added[0].id}..${added[added.length - 1].id}`;
  if (DRY) {
    console.log(`(dry run) would add ${added.length} tile(s) to ${path.basename(target.tsj)}: ${ids}`);
    continue;
  }
  fs.writeFileSync(target.tsj, `${JSON.stringify(tileset, null, 2)}\n`);
  console.log(`✓ ${added.length} tile(s) appended to ${path.basename(target.tsj)} (${ids})`);
}

if (!DRY) {
  if (skipped > 0) console.log(`  ${skipped} item(s) skipped as already present`);
  console.log('  Now in Tiled: label the new items; on the standing ones set what blocks and what sits.');
  console.log('  The flat ones are decals and need nothing — set `occludes` only on a decal that should hide a character behind it.');
  console.log('  Then: scripts/sync-furniture-properties.sh --check');
}
