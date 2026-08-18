#!/usr/bin/env -S node --import tsx
/**
 * One-time importer: slices the MetroCity Interior item sheets (plus
 * MetroCity's Cars sheet) into individual furniture PNGs under
 * assets/tiled/png/src/furniture/metro/ and writes the Tiled tilesets that make
 * them a real catalog — assets/tiled/furniture-metro-*.tsj. Nothing else has to
 * change: server/src/core/assets/tiledFurniture.ts reads the catalog straight
 * out of every furniture-*.tsj it finds, so these items show up like any other
 * furniture (see docs/design.md).
 *
 * Items are found by 8-connected alpha components rather than by a fixed grid:
 * the pack lays its sheets out on a 16px grid but items are of wildly different
 * sizes within it (a 6×60 door frame next to a 128×44 window), so a grid walk
 * would either split items or glue neighbours together. Components under
 * MIN_PIXELS are dropped as stray dust.
 *
 * Each item's PNG is padded out to a whole number of tiles, bottom-aligned and
 * horizontally centered — furniture art is bottom-anchored, and the catalog
 * derives footprint from the PNG's size (tiledFurniture.ts's footprintOf), so
 * an exact multiple of 16 is what makes that footprint unambiguous.
 *
 * NOT imported: TilesHouse.png / TilesHospital.png. Those two are the pack's
 * wall+floor tilesets, already imported as real wall/floor sets by
 * gen-metro-source-art.mts; slicing them here as well would add ~83 wall and
 * floor fragments to the furniture palette as placeable "items". Also skipped:
 * Interior/Demo, which is screenshots, not art.
 *
 * The MetroCity pack itself lives outside the repo (tmp/metro, gitignored);
 * only the derived PNGs + tilesets are committed.
 *
 * ── This runs ONCE, and then never again by accident ──
 *
 * It writes each tileset from scratch, at the defaults. The tiles it produces
 * are then maintained BY HAND in Tiled — that is where a metro sofa gets
 * `canSitOn` and a real label instead of "Living room 7", and no rule over a
 * source sheet's name could decide those for it. Re-running would throw all of
 * that away, so it refuses to overwrite a tileset that already exists.
 *
 * Which means: adding a NEW sheet to SHEETS below is not enough on its own,
 * because its items would land in an existing file. Adding a new tileset (a
 * different pack, its own furniture-*.tsj) is the easy direction and needs no
 * special handling at all.
 *
 * Run (from server/): node --import tsx scripts/gen-metro-furniture.mts [--force]
 *   --force   overwrite existing tilesets, discarding every hand-set value in
 *             them. Only with a plan for restoring them.
 */
import { PNG } from 'pngjs';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { FURNITURE_TILE_PROPS } from '../src/tiled/furnitureProps.js';
import { components, cropToTiles, TILE } from './lib/sheetSlice.mjs';

const ROOT = new URL('../..', import.meta.url).pathname;
const PACK = path.join(ROOT, 'tmp', 'metro');
const OUT_PNG_DIR = path.join(ROOT, 'assets', 'tiled', 'png', 'src', 'furniture', 'metro');
const OUT_TSJ_DIR = path.join(ROOT, 'assets', 'tiled');

/** `wallMounted` marks sheets whose items hang ON a wall rather than stand on
 *  the floor; those get backgroundTiles = their full height so the tiles they
 *  cover stay walkable, exactly like the existing wall-mounted decor.
 *
 *  Everything else a tile can do (sittable, a pet perch, an action) is left at
 *  its default here and set per item in Tiled afterwards — 274 items sliced out
 *  of an art pack automatically is a catalog of sprites, and no rule over a
 *  source sheet's name can decide which of them are chairs. */
interface Sheet {
  file: string;
  id: string;
  label: string;
  wallMounted?: boolean;
}
const SHEETS: Sheet[] = [
  { file: 'Interior/Home/Bathroom-Sheet.png', id: 'BATH', label: 'Bathroom' },
  { file: 'Interior/Home/Beds-Sheet.png', id: 'BED', label: 'Bed' },
  { file: 'Interior/Home/Beds1-Sheet.png', id: 'BED2', label: 'Bed' },
  { file: 'Interior/Home/Carpet-Sheet.png', id: 'RUG', label: 'Rug' },
  { file: 'Interior/Home/Chimney-Sheet.png', id: 'CHIMNEY', label: 'Fireplace' },
  { file: 'Interior/Home/Chimney1-Sheet.png', id: 'CHIMNEY2', label: 'Fireplace' },
  { file: 'Interior/Home/Cupboard-Sheet.png', id: 'CUPBOARD', label: 'Cupboard' },
  { file: 'Interior/Home/Doors-Sheet.png', id: 'DOOR', label: 'Door' },
  { file: 'Interior/Home/Flowers-Sheet.png', id: 'PLANT', label: 'Plant' },
  { file: 'Interior/Home/Kitchen-Sheet.png', id: 'KITCHEN', label: 'Kitchen' },
  { file: 'Interior/Home/Kitchen1-Sheet.png', id: 'KITCHEN2', label: 'Kitchen' },
  { file: 'Interior/Home/Lights-Sheet.png', id: 'LAMP', label: 'Lamp', wallMounted: true },
  { file: 'Interior/Home/LivingRoom-Sheet.png', id: 'LIVING', label: 'Living room' },
  { file: 'Interior/Home/LivingRoom1-Sheet.png', id: 'LIVING2', label: 'Living room' },
  { file: 'Interior/Home/Miscellaneous-Sheet.png', id: 'MISC', label: 'Misc' },
  { file: 'Interior/Home/Paintings-Sheet.png', id: 'PAINTING', label: 'Painting', wallMounted: true },
  { file: 'Interior/Home/Paintings1-Sheet.png', id: 'PAINTING2', label: 'Painting', wallMounted: true },
  { file: 'Interior/Home/TV-Sheet.png', id: 'TV', label: 'TV', wallMounted: true },
  { file: 'Interior/Home/Windows-Sheet.png', id: 'WINDOW', label: 'Window', wallMounted: true },
  { file: 'Interior/Hospital/BedHospital-Sheet.png', id: 'HBED', label: 'Hospital bed' },
  { file: 'Interior/Hospital/DoorsHospital-Sheet.png', id: 'HDOOR', label: 'Hospital door' },
  { file: 'Interior/Hospital/Miscellaneous-Sheet.png', id: 'HMISC', label: 'Hospital misc' },
  { file: 'MetroCity/Cars-Sheet.png', id: 'CAR', label: 'Car' },
];

/** Which tileset file each sheet's items land in — grouped, so the Tilesets
 *  panel has three browsable metro entries instead of 23 tiny ones. */
function tilesetFor(sheet: Sheet): string {
  if (sheet.file.startsWith('MetroCity/')) return 'furniture-metro-vehicles';
  if (sheet.file.includes('/Hospital/')) return 'furniture-metro-hospital';
  return 'furniture-metro-home';
}

interface TileEntry {
  id: number;
  type: string;
  image: string;
  imagewidth: number;
  imageheight: number;
  properties: Array<{ name: string; type: string; value: string | number | boolean; propertytype?: string }>;
}

// Checked before any work: the PNGs get rewritten too, and a script that does
// its job and only then refuses to save it is just confusing.
const FORCE = process.argv.includes('--force');
const clobber = [...new Set(SHEETS.map(tilesetFor))].filter((n) => fs.existsSync(path.join(OUT_TSJ_DIR, `${n}.tsj`)));
if (clobber.length > 0 && !FORCE) {
  console.error(`✗ these tilesets already exist and are hand-maintained: ${clobber.join(', ')}`);
  console.error('  Rewriting them would discard every property set in Tiled since. Pass --force if that is really what you want.');
  process.exit(1);
}

fs.mkdirSync(OUT_PNG_DIR, { recursive: true });
const bySet = new Map<string, TileEntry[]>();
let written = 0;
for (const sheet of SHEETS) {
  const srcPath = path.join(PACK, sheet.file);
  const src = PNG.sync.read(fs.readFileSync(srcPath));
  const boxes = components(src);
  const setName = tilesetFor(sheet);
  const entries = bySet.get(setName) ?? [];
  boxes.forEach((box, i) => {
    const out = cropToTiles(src, box);
    const itemId = `METRO_${sheet.id}_${String(i + 1).padStart(2, '0')}`;
    fs.writeFileSync(path.join(OUT_PNG_DIR, `${itemId}.png`), PNG.sync.write(out));
    written++;
    // The whole behaviour set, defaults included, so these arrive in the same
    // shape sync-furniture-properties.mts keeps every other tile in — a mapper
    // opening a metro item sees everything it could do, not a short list.
    const props: TileEntry['properties'] = [
      { name: 'id', type: 'string', value: itemId },
      ...FURNITURE_TILE_PROPS.map((spec) => {
        const value =
          spec.name === 'label'
            ? `${sheet.label} ${i + 1}`
            : // Hangs on a wall: every tile it covers stays walkable — same
              // meaning as the existing wall-mounted decor's backgroundTiles.
              spec.name === 'backgroundTiles' && sheet.wallMounted
              ? out.height / TILE
              : spec.default;
        return {
          name: spec.name,
          type: typeof value === 'boolean' ? 'bool' : typeof value === 'number' ? 'int' : 'string',
          value,
          ...(spec.propertyType ? { propertytype: spec.propertyType } : {}),
        };
      }),
    ];
    entries.push({
      id: entries.length,
      type: 'FurnitureTile',
      image: `png/src/furniture/metro/${itemId}.png`,
      imagewidth: out.width,
      imageheight: out.height,
      properties: props,
    });
  });
  bySet.set(setName, entries);
  console.log(`  ${sheet.file} → ${boxes.length} items${sheet.wallMounted ? ' (wall-mounted)' : ''}`);
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
