#!/usr/bin/env -S node --import tsx
/**
 * Import an art pack's sheet as a GRID decal tileset — one importer for every
 * pack, parameterised, instead of one script per pack.
 *
 * It replaced gen-overworld.mts and gen-decal-roads.mts, which did the same four
 * things (read the pack PNG, find the cells that carry art, re-compose the sheet
 * with gaps, write a tileset naming every cell) and differed only in the pack path,
 * the set name and how ids are spelled. Two copies of one procedure is how the two
 * drift: the gap-plus-extrusion fix had to be applied twice, and the second copy
 * was forgotten for a day.
 *
 * Nothing is sliced: the sheet is copied through cell by cell into a spaced-out
 * image and the tileset points at it as ONE image, a tile's local id being its
 * position in the grid. That is deliberate for pack art — the arrangement IS the
 * content (a junction is a 3x3 block of road pieces, a house is a block of wall
 * pieces), and Tiled shows a grid tileset exactly as the artist drew it, so you mark
 * a block and stamp it. An image collection would reorder everything by tile id.
 *
 * What the cells become is NOT decided here: every cell is a paintable DecalTile,
 * and the LAYER a mapper paints it on decides what it is — GroundLayer makes it
 * ground you can walk on, a DecalLayer makes it a picture (flat, or `occludes` to
 * walk behind). See .claude/skills/tiled-asset-import.
 *
 * IDS ARE IDENTITY. Every placement in every map refers to a cell by the tileset's
 * gid, and a re-run must therefore produce the same ids for the same cells: same
 * `--id-style`, same `--id-prefix`, same tile size. Changing one of those on an
 * existing set is not a rename, it is a silent reshuffle of the whole map. New pack,
 * new set — never re-style an old one.
 *
 * Run (from the repo root, via a per-pack wrapper — see scripts/import-sheet.sh):
 *   scripts/import-sheet.sh --src tmp/gfx/Overworld.png --name decal-overworld \
 *     --id-prefix OW --id-style colrow [--tile 16] [--dry-run]
 *
 *   --id-style colrow   OW_7_5        (column then row, no padding)
 *   --id-style rcpad    ROAD_R03C07   (row and column, two digits each)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { PNG } from 'pngjs';

import { DECAL_TILE_PROPS } from '../src/tiled/decalProps.js';
import { DECAL_TILE_CLASS } from '../src/tiled/tiledRegistry.js';
import { composeWithGaps, SHEET_GAP, TILE } from './lib/sheetSlice.mjs';

const ROOT = new URL('../..', import.meta.url).pathname;
const TILED = path.join(ROOT, 'assets', 'tiled');

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const DRY = process.argv.includes('--dry-run');
const src = arg('src');
const name = arg('name');
const idPrefix = arg('id-prefix');
const idStyle = (arg('id-style') ?? 'colrow') as 'colrow' | 'rcpad';
const tile = Number(arg('tile') ?? TILE);

if (!src || !name || !idPrefix) {
  console.error('✗ need --src <pack.png> --name <set-name> --id-prefix <PREFIX> [--id-style colrow|rcpad] [--tile 16]');
  process.exit(1);
}
if (idStyle !== 'colrow' && idStyle !== 'rcpad') {
  console.error(`✗ unknown --id-style "${idStyle}" — colrow (OW_7_5) or rcpad (ROAD_R03C07)`);
  process.exit(1);
}
if (!Number.isInteger(tile) || tile <= 0) {
  console.error(`✗ --tile must be a positive whole number of pixels, got "${arg('tile')}"`);
  process.exit(1);
}

const srcAbs = path.isAbsolute(src) ? src : path.join(ROOT, src);
if (!fs.existsSync(srcAbs)) {
  console.error(`✗ sheet missing: ${srcAbs}`);
  console.error('  The pack is not in this repository (see the wrapper that called this) — put its PNGs there first.');
  process.exit(1);
}
/** Where the sheet copy goes: source art, because a checkout cannot regenerate it
 *  without the pack (see AGENTS.md on png/src vs png/baked). */
const pngRel = `png/src/sheets/${name}.png`;
const tsjAbs = path.join(TILED, `${name}.tsj`);

const sheet = PNG.sync.read(fs.readFileSync(srcAbs));
const cols = Math.floor(sheet.width / tile);
const rows = Math.floor(sheet.height / tile);
if (cols === 0 || rows === 0) {
  console.error(`✗ ${sheet.width}×${sheet.height} is smaller than one ${tile}px cell`);
  process.exit(1);
}

/** Does this cell hold anything at all? A blank one gets no entry, so nothing can
 *  resolve there — while Tiled still shows the full grid, blanks included. */
function used(col: number, row: number): boolean {
  for (let y = 0; y < tile; y++) {
    for (let x = 0; x < tile; x++) {
      if (sheet.data[((row * tile + y) * sheet.width + col * tile + x) * 4 + 3] !== 0) return true;
    }
  }
  return false;
}

function idOf(col: number, row: number): string {
  return idStyle === 'colrow'
    ? `${idPrefix}_${col}_${row}`
    : `${idPrefix}_R${String(row).padStart(2, '0')}C${String(col).padStart(2, '0')}`;
}

/** Keep whatever a mapper has already labelled, so a re-run is not a reset. */
const existingLabels = new Map<string, string>();
if (fs.existsSync(tsjAbs)) {
  const old = JSON.parse(fs.readFileSync(tsjAbs, 'utf-8')) as {
    tiles?: Array<{ properties?: Array<{ name: string; value: string | number | boolean }> }>;
  };
  for (const t of old.tiles ?? []) {
    const props = Object.fromEntries((t.properties ?? []).map((p) => [p.name, p.value]));
    if (typeof props.id === 'string' && typeof props.label === 'string' && props.label) {
      existingLabels.set(props.id, props.label);
    }
  }
}

const tiles: Array<Record<string, unknown>> = [];
for (let row = 0; row < rows; row++) {
  for (let col = 0; col < cols; col++) {
    if (!used(col, row)) continue;
    const id = idOf(col, row);
    tiles.push({
      id: row * cols + col,
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
}

// Gaps between cells with their borders extruded 1px into them: a cell is drawn as
// a frame of this one texture, and touching cells bleed into each other at
// fractional zoom (see composeWithGaps). The CELL COUNT is unchanged, so every gid
// a map already saved still points at the same art.
const spaced = composeWithGaps(sheet, tile, SHEET_GAP);
const blanks = cols * rows - tiles.length;

if (DRY) {
  console.log(
    `(dry run) ${path.basename(srcAbs)} → ${name}.tsj: ${cols}×${rows} cells, ${tiles.length} named, ${blanks} blank; ` +
      `would write ${pngRel} (${spaced.width}×${spaced.height}, ${SHEET_GAP}px gaps)`,
  );
  console.log(`  ids like ${idOf(0, 0)} … ${idOf(cols - 1, rows - 1)} (--id-style ${idStyle})`);
  process.exit(0);
}

fs.mkdirSync(path.join(TILED, path.dirname(pngRel)), { recursive: true });
fs.writeFileSync(path.join(TILED, pngRel), PNG.sync.write(spaced));
fs.writeFileSync(
  tsjAbs,
  `${JSON.stringify(
    {
      columns: cols,
      image: pngRel,
      imagewidth: spaced.width,
      imageheight: spaced.height,
      margin: 0,
      name,
      spacing: SHEET_GAP,
      // The FULL grid, blanks included: Tiled numbers cells by position, so shrinking
      // the count to the used ones would renumber every tile after the first gap.
      tilecount: cols * rows,
      tiledversion: '1.11.0',
      tileheight: tile,
      tilewidth: tile,
      type: 'tileset',
      version: '1.10',
      tiles,
    },
    null,
    2,
  )}\n`,
);
console.log(`✓ ${name}.tsj + ${pngRel} (${spaced.width}×${spaced.height}, ${SHEET_GAP}px gaps)`);
console.log(`  ${cols}×${rows} cells, ${tiles.length} carry art, ${blanks} blank (left unnamed on purpose)`);
if (existingLabels.size) console.log(`  ${existingLabels.size} existing label(s) kept`);
console.log('  Now in Tiled: terrain you walk on goes on the GroundLayer (that is what makes a cell walkable);');
console.log('  anything that is only a picture goes on a DecalLayer — flat, or `occludes` to walk behind it.');
