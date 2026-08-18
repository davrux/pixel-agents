#!/usr/bin/env -S node --import tsx
/**
 * Import the MetroCity **Road** sheet as a grid decal tileset.
 *
 * Unlike every other importer here, this one does not slice anything: the sheet
 * is copied through byte for byte and the tileset points at it as one image, a
 * tile's local id being its position in the grid (see TiledTilesetJson.image).
 *
 * Why a sheet and not 305 sliced files, which the loader would have taken with no
 * change at all: because the arrangement IS the content. Road pieces only make
 * sense next to each other — a junction is a 3×3 block of them, a kerb is a run —
 * and in Tiled a grid tileset shows them exactly as the artist laid them out, so
 * you mark a block and stamp it. An image collection reorders them by tile id and
 * wraps by panel width, which turns "stamp a junction" into "find nine images".
 * One PNG in git instead of 305 files is a welcome side effect, not the reason.
 *
 * Roads are DECALS, not furniture: a road is ground you walk on, so it has no
 * behaviour, no occupancy, and nothing to sync. Where a road should block (a
 * central barrier, say), the mapper paints the CollisionLayer over it — same as
 * every other decal. Which is why this needed no engine change: only the asset
 * reader had to learn that a tileset can be one sheet.
 *
 * Cells that are entirely transparent get no tile entry, so they carry no id and
 * nothing can resolve there; Tiled still shows the full grid, blanks included.
 *
 * Ids are position-derived (ROAD_R03C07 = row 3, column 7), which keeps them
 * stable as long as the sheet's layout is, exactly the assumption the baked floor
 * and wall sheets already make. They are also readable in a diff, which a running
 * index would not be.
 *
 * The pack itself lives outside the repo (tmp/metro, gitignored); only the copied
 * PNG and the tileset are committed.
 *
 * Run (from server/): node --import tsx scripts/gen-decal-roads.mts [--dry-run]
 */
import { PNG } from 'pngjs';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { DECAL_TILE_PROPS } from '../src/tiled/decalProps.js';
import { DECAL_TILE_CLASS } from '../src/tiled/tiledRegistry.js';
import { composeWithGaps, SHEET_GAP, TILE } from './lib/sheetSlice.mjs';

const ROOT = new URL('../..', import.meta.url).pathname;
const SRC = path.join(ROOT, 'tmp', 'metro', 'MetroCity Outdoor 2.0', 'MetroCity 2.0', 'Road.png');
const TILED = path.join(ROOT, 'assets', 'tiled');
/** Relative to the tileset's own directory — what the loader resolves against
 *  (and refuses to escape). */
const PNG_REL = 'png/decal-roads.png';
const TARGET_TSJ = path.join(TILED, 'decal-roads.tsj');
const DRY = process.argv.includes('--dry-run');

if (!fs.existsSync(SRC)) {
  console.error(`✗ sheet missing: ${SRC}`);
  process.exit(1);
}

const buf = fs.readFileSync(SRC);
const png = PNG.sync.read(buf);
const columns = Math.floor(png.width / TILE);
const rows = Math.floor(png.height / TILE);
if (columns === 0 || rows === 0) {
  console.error(`✗ ${png.width}×${png.height} is smaller than one ${TILE}px tile`);
  process.exit(1);
}

/** Does this cell hold anything at all? A blank one gets no entry. */
function used(index: number): boolean {
  const ox = (index % columns) * TILE;
  const oy = Math.floor(index / columns) * TILE;
  for (let y = oy; y < oy + TILE; y++) {
    for (let x = ox; x < ox + TILE; x++) {
      if (png.data[(y * png.width + x) * 4 + 3] !== 0) return true;
    }
  }
  return false;
}

/** Keep whatever a mapper has already labelled, so a re-run is not a reset. */
const existingLabels = new Map<string, string>();
if (fs.existsSync(TARGET_TSJ)) {
  const old = JSON.parse(fs.readFileSync(TARGET_TSJ, 'utf-8')) as {
    tiles?: Array<{ properties?: Array<{ name: string; value: string | number | boolean }> }>;
  };
  for (const t of old.tiles ?? []) {
    const props = Object.fromEntries((t.properties ?? []).map((p) => [p.name, p.value]));
    const label = props.label;
    if (typeof props.id === 'string' && typeof label === 'string' && label) existingLabels.set(props.id, label);
  }
}

const tiles: Array<Record<string, unknown>> = [];
for (let index = 0; index < columns * rows; index++) {
  if (!used(index)) continue;
  const r = Math.floor(index / columns);
  const c = index % columns;
  const id = `ROAD_R${String(r).padStart(2, '0')}C${String(c).padStart(2, '0')}`;
  tiles.push({
    id: index,
    type: DECAL_TILE_CLASS,
    properties: [
      { name: 'id', type: 'string', value: id },
      ...DECAL_TILE_PROPS.map((spec) => ({
        name: spec.name,
        type: typeof spec.default === 'boolean' ? 'bool' : typeof spec.default === 'number' ? 'int' : 'string',
        value: spec.name === 'label' ? (existingLabels.get(id) ?? '') : spec.default,
        ...(spec.propertyType ? { propertytype: spec.propertyType } : {}),
      })),
    ],
  });
}

// With a gap between cells and their borders extruded into it — a cell is drawn as a
// frame of this sheet, and touching cells bleed into each other at fractional zoom
// (see composeWithGaps). The cell count is unchanged, so saved gids still hold.
const spaced = composeWithGaps(png, TILE, SHEET_GAP);

const tileset = {
  columns,
  image: PNG_REL,
  imagewidth: spaced.width,
  imageheight: spaced.height,
  margin: 0,
  name: path.basename(TARGET_TSJ, '.tsj'),
  spacing: SHEET_GAP,
  // The FULL grid, blanks included: Tiled numbers cells by position, so shrinking
  // the count to the used ones would renumber every tile after the first gap.
  tilecount: columns * rows,
  tiledversion: '1.11.0',
  tileheight: TILE,
  tilewidth: TILE,
  type: 'tileset',
  version: '1.10',
  tiles,
};

const blanks = columns * rows - tiles.length;
if (DRY) {
  console.log(
    `(dry run) ${path.basename(SRC)} → ${path.basename(TARGET_TSJ)}: ${columns}×${rows} cells, ` +
      `${tiles.length} named, ${blanks} blank; would copy the sheet to ${PNG_REL}`,
  );
  process.exit(0);
}

fs.mkdirSync(path.join(TILED, path.dirname(PNG_REL)), { recursive: true });
fs.writeFileSync(path.join(TILED, PNG_REL), PNG.sync.write(spaced));
fs.writeFileSync(TARGET_TSJ, `${JSON.stringify(tileset, null, 2)}\n`);
console.log(`✓ ${PNG_REL} written (${spaced.width}×${spaced.height}, ${SHEET_GAP}px gaps), ${path.basename(TARGET_TSJ)}`);
console.log(`  ${columns}×${rows} cells, ${tiles.length} named, ${blanks} blank (left unnamed on purpose)`);
console.log(`  ${existingLabels.size} existing label(s) kept`);
console.log('  Now in Tiled: add decal-roads.tsj to the map, paint on a DecalLayer.');
console.log('  Roads are ground, so leave that layer flat (no `occludes`); where a road blocks, paint Collision.');
