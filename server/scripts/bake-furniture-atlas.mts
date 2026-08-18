#!/usr/bin/env -S node --import tsx
/**
 * Pack every collection-of-images tile — furniture and decals — into ONE atlas
 * PNG plus a manifest saying where each id sits.
 *
 * Why: those pixels currently reach the client as SpriteData inside the
 * `furnitureAssetsLoaded` message, which is 5.3 MB per join and grows with the
 * art. Content that never changes belongs on HTTP, where it is fetched once,
 * cached with an ETag and decoded natively — the route floor and wall sheets
 * already take. This script produces the artifact for that; nothing consumes it
 * yet (see docs/design.md's known gaps for the remaining steps).
 *
 * Why one atlas rather than the 563 files themselves, which HTTP would serve
 * happily: one request instead of 563, one cache entry instead of 563, and one
 * texture in the client instead of hundreds — the same reason the runtime atlas
 * exists (client/src/render/sprites.ts).
 *
 * Not for the bytes, and it is worth being exact about that: measured, the atlas
 * is 396 KB against 419 KB of separate files. pngjs picks PNG filters poorly, and
 * an optimiser does far better on the very same pixels — `magick atlas.png -define
 * png:compression-level=9 -define png:compression-filter=5 -define
 * png:compression-strategy=1 out.png` gave 202 KB, byte-for-byte the same image.
 * It is deliberately NOT run here: this artifact is committed, and making its size
 * depend on which tools the person baking happens to have installed is how a file
 * starts flip-flopping between contributors. Run it before a release if the bytes
 * matter.
 *
 * The bytes are not what B is about anyway: this replaces pixels that travel on
 * the WEBSOCKET, uncompressed, on every single join. 396 KB fetched once and then
 * revalidated with an ETag beats ~120 KB re-sent per join after about four joins,
 * and it also removes the 8 MB frame ceiling, the 5 MB JSON.parse and 6.7 MB of
 * heap.
 *
 * Which tiles: whatever the loader would take, asked the same way — a tileset
 * holds furniture or decals if its TILES say so (isFurnitureTileset /
 * isDecalTileset), never because of its filename. So a new tileset is included
 * without touching this script.
 *
 * Layout: shelf packing, 2 px between cells, and each cell's border extruded 1 px
 * into that gap. The extrusion is not optional — a decal can be full-bleed ground
 * art (paving, grass), and a frame whose neighbour touches it bleeds a stripe at
 * fractional zoom, which is exactly the seam the floor sheets had to be re-baked
 * for. Order is deterministic (tallest first, then by id) so a re-run with
 * unchanged art produces a byte-identical atlas and no git churn.
 *
 * Run (from server/): node --import tsx scripts/bake-furniture-atlas.mts [--dry-run]
 */
import { PNG } from 'pngjs';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { isDecalTileset, isFurnitureTileset } from '../src/tiled/tiledRegistry.js';

const ROOT = new URL('../..', import.meta.url).pathname;
const TILED = path.join(ROOT, 'assets', 'tiled');
const OUT_PNG = path.join(TILED, 'png', 'atlas-furniture.png');
/** Beside the PNG, so the one static route that already serves sheets serves this
 *  too — no new endpoint, and nothing newly exposed. */
const OUT_MANIFEST = path.join(TILED, 'png', 'atlas-furniture.json');
const DRY = process.argv.includes('--dry-run');

/** Same numbers as the floor sheets, for the same reason — see FLOOR_TILE_SPACING. */
const GAP = 2;
const EXTRUDE = 1;
/** Atlas width. Height grows with the art; nothing here is close to a texture-size
 *  limit, and a fixed width keeps the packing (and therefore the file) stable. */
const WIDTH = 1024;

interface Item {
  id: string;
  file: string;
  png: PNG;
}

const items: Item[] = [];
const seen = new Set<string>();
for (const file of fs.readdirSync(TILED).filter((f) => f.endsWith('.tsj')).sort()) {
  const json = JSON.parse(fs.readFileSync(path.join(TILED, file), 'utf-8')) as {
    image?: string;
    tiles?: Array<{ image?: string; properties?: Array<{ name: string; value: string | number | boolean }> }>;
  };
  if (!isFurnitureTileset(json) && !isDecalTileset(json)) continue;
  // A grid tileset (one image for the whole set, e.g. decal-roads) is already an
  // atlas and stays one — packing it again would only cost a copy.
  if (json.image) continue;
  for (const tile of json.tiles ?? []) {
    const id = tile.properties?.find((p) => p.name === 'id')?.value;
    if (typeof id !== 'string' || !id || !tile.image) continue;
    if (seen.has(id)) continue; // an animation's frames are separate ids; duplicates are not
    const abs = path.join(TILED, tile.image);
    if (!fs.existsSync(abs)) {
      console.warn(`  ⚠️  ${id}: ${tile.image} missing — skipped`);
      continue;
    }
    seen.add(id);
    items.push({ id, file: tile.image, png: PNG.sync.read(fs.readFileSync(abs)) });
  }
}

if (items.length === 0) {
  console.error('✗ no collection tiles found — is assets/tiled populated?');
  process.exit(1);
}

// Tallest first packs shelves tightly; the id breaks ties so the order — and thus
// the output bytes — never depend on directory order.
items.sort((a, b) => b.png.height - a.png.height || a.id.localeCompare(b.id));

interface Placed extends Item {
  x: number;
  y: number;
}
const placed: Placed[] = [];
let cx = EXTRUDE;
let cy = EXTRUDE;
let shelfH = 0;
for (const item of items) {
  if (cx + item.png.width + EXTRUDE > WIDTH) {
    cx = EXTRUDE;
    cy += shelfH + GAP;
    shelfH = 0;
  }
  placed.push({ ...item, x: cx, y: cy });
  cx += item.png.width + GAP;
  if (item.png.height > shelfH) shelfH = item.png.height;
}
const HEIGHT = cy + shelfH + EXTRUDE;

const atlas = new PNG({ width: WIDTH, height: HEIGHT });
atlas.data.fill(0);
for (const item of placed) {
  const { png, x, y } = item;
  const w = png.width;
  const h = png.height;
  PNG.bitblt(png, atlas, 0, 0, w, h, x, y);
  // The one-pixel skirt: edges, then corners. Same as the sheet bake — a sample
  // one texel outside the frame has to land on this cell's own colour.
  PNG.bitblt(png, atlas, 0, 0, 1, h, x - 1, y);
  PNG.bitblt(png, atlas, w - 1, 0, 1, h, x + w, y);
  PNG.bitblt(png, atlas, 0, 0, w, 1, x, y - 1);
  PNG.bitblt(png, atlas, 0, h - 1, w, 1, x, y + h);
  PNG.bitblt(png, atlas, 0, 0, 1, 1, x - 1, y - 1);
  PNG.bitblt(png, atlas, w - 1, 0, 1, 1, x + w, y - 1);
  PNG.bitblt(png, atlas, 0, h - 1, 1, 1, x - 1, y + h);
  PNG.bitblt(png, atlas, w - 1, h - 1, 1, 1, x + w, y + h);
}

const manifest = {
  /** Relative to assets/tiled, like a tileset's own `image`. */
  image: 'png/atlas-furniture.png',
  width: WIDTH,
  height: HEIGHT,
  /** Recorded rather than assumed, so a reader never takes the layout on faith —
   *  the same reason a sheet's `spacing` travels in sets.json. */
  gap: GAP,
  extrude: EXTRUDE,
  frames: Object.fromEntries(
    [...placed]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((p) => [p.id, { x: p.x, y: p.y, w: p.png.width, h: p.png.height }]),
  ),
};

const bytes = PNG.sync.write(atlas);
const sources = placed.reduce((n, p) => n + fs.statSync(path.join(TILED, p.file)).size, 0);
if (DRY) {
  console.log(
    `(dry run) ${placed.length} tiles → ${WIDTH}×${HEIGHT}, ${(bytes.length / 1024).toFixed(0)} KB packed ` +
      `vs ${(sources / 1024).toFixed(0)} KB in ${placed.length} files`,
  );
  process.exit(0);
}
fs.writeFileSync(OUT_PNG, bytes);
fs.writeFileSync(OUT_MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`✓ png/atlas-furniture.png ${WIDTH}×${HEIGHT} (${(bytes.length / 1024).toFixed(0)} KB) — ${placed.length} tiles`);
console.log(`  was ${(sources / 1024).toFixed(0)} KB across ${placed.length} files, so ${(sources / bytes.length).toFixed(1)}× smaller and one request`);
console.log('  png/atlas-furniture.json lists every id\'s rect');
