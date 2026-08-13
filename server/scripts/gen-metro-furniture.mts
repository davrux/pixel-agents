#!/usr/bin/env -S node --import tsx
/**
 * One-time importer: slices the MetroCity Interior item sheets (plus
 * MetroCity's Cars sheet) into individual furniture PNGs under
 * assets/tiled/png/furniture/metro/ and writes the Tiled tilesets that make
 * them a real catalog — assets/tiled/furniture-metro-*.tsj. Nothing else has to
 * change: server/src/core/assets/tiledFurniture.ts reads the catalog straight
 * out of every furniture-*.tsj it finds, so these items show up like any other
 * furniture (see docs/design/tiled-editor-integration.md).
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
 * only the derived PNGs + tilesets are committed. Re-run only to re-derive them.
 *
 * Run (from server/): node --import tsx scripts/gen-metro-furniture.mts
 */
import { PNG } from 'pngjs';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = new URL('../..', import.meta.url).pathname;
const PACK = path.join(ROOT, 'tmp', 'metro');
const OUT_PNG_DIR = path.join(ROOT, 'assets', 'tiled', 'png', 'furniture', 'metro');
const OUT_TSJ_DIR = path.join(ROOT, 'assets', 'tiled');
const TILE = 16;
/** Components smaller than this are sheet dust (stray antialiasing pixels,
 *  a lone highlight left outside an item's own silhouette), not items. */
const MIN_PIXELS = 12;

/** `category` is a pure browsing label (see tiledFurniture.ts) — one per source
 *  sheet is as fine-grained as this pack's own organisation gets.
 *  `wallMounted` marks sheets whose items hang ON a wall rather than stand on
 *  the floor; those get backgroundTiles = their full height so the tiles they
 *  cover stay walkable, exactly like the existing wall-mounted decor. */
interface Sheet {
  file: string;
  id: string;
  label: string;
  category: string;
  wallMounted?: boolean;
}
const SHEETS: Sheet[] = [
  { file: 'Interior/Home/Bathroom-Sheet.png', id: 'BATH', label: 'Bathroom', category: 'misc' },
  { file: 'Interior/Home/Beds-Sheet.png', id: 'BED', label: 'Bed', category: 'misc' },
  { file: 'Interior/Home/Beds1-Sheet.png', id: 'BED2', label: 'Bed', category: 'misc' },
  { file: 'Interior/Home/Carpet-Sheet.png', id: 'RUG', label: 'Rug', category: 'decor' },
  { file: 'Interior/Home/Chimney-Sheet.png', id: 'CHIMNEY', label: 'Fireplace', category: 'decor' },
  { file: 'Interior/Home/Chimney1-Sheet.png', id: 'CHIMNEY2', label: 'Fireplace', category: 'decor' },
  { file: 'Interior/Home/Cupboard-Sheet.png', id: 'CUPBOARD', label: 'Cupboard', category: 'storage' },
  { file: 'Interior/Home/Doors-Sheet.png', id: 'DOOR', label: 'Door', category: 'misc' },
  { file: 'Interior/Home/Flowers-Sheet.png', id: 'PLANT', label: 'Plant', category: 'decor' },
  { file: 'Interior/Home/Kitchen-Sheet.png', id: 'KITCHEN', label: 'Kitchen', category: 'kitchens' },
  { file: 'Interior/Home/Kitchen1-Sheet.png', id: 'KITCHEN2', label: 'Kitchen', category: 'kitchens' },
  { file: 'Interior/Home/Lights-Sheet.png', id: 'LAMP', label: 'Lamp', category: 'decor', wallMounted: true },
  { file: 'Interior/Home/LivingRoom-Sheet.png', id: 'LIVING', label: 'Living room', category: 'misc' },
  { file: 'Interior/Home/LivingRoom1-Sheet.png', id: 'LIVING2', label: 'Living room', category: 'misc' },
  { file: 'Interior/Home/Miscellaneous-Sheet.png', id: 'MISC', label: 'Misc', category: 'misc' },
  { file: 'Interior/Home/Paintings-Sheet.png', id: 'PAINTING', label: 'Painting', category: 'decor', wallMounted: true },
  { file: 'Interior/Home/Paintings1-Sheet.png', id: 'PAINTING2', label: 'Painting', category: 'decor', wallMounted: true },
  { file: 'Interior/Home/TV-Sheet.png', id: 'TV', label: 'TV', category: 'electronics', wallMounted: true },
  { file: 'Interior/Home/Windows-Sheet.png', id: 'WINDOW', label: 'Window', category: 'decor', wallMounted: true },
  { file: 'Interior/Hospital/BedHospital-Sheet.png', id: 'HBED', label: 'Hospital bed', category: 'misc' },
  { file: 'Interior/Hospital/DoorsHospital-Sheet.png', id: 'HDOOR', label: 'Hospital door', category: 'misc' },
  { file: 'Interior/Hospital/Miscellaneous-Sheet.png', id: 'HMISC', label: 'Hospital misc', category: 'misc' },
  { file: 'MetroCity/Cars-Sheet.png', id: 'CAR', label: 'Car', category: 'misc' },
];

/** Which tileset file each sheet's items land in — grouped, so the Tilesets
 *  panel has three browsable metro entries instead of 23 tiny ones. */
function tilesetFor(sheet: Sheet): string {
  if (sheet.file.startsWith('MetroCity/')) return 'furniture-metro-vehicles';
  if (sheet.file.includes('/Hospital/')) return 'furniture-metro-hospital';
  return 'furniture-metro-home';
}

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
  properties: Array<{ name: string; type: string; value: string | number; propertytype?: string }>;
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
    const props: TileEntry['properties'] = [
      { name: 'id', type: 'string', value: itemId },
      { name: 'label', type: 'string', value: `${sheet.label} ${i + 1}` },
      { name: 'category', type: 'string', value: sheet.category, propertytype: 'Category' },
    ];
    if (sheet.wallMounted) {
      // Hangs on a wall: every tile it covers stays walkable — same meaning as
      // the existing wall-mounted decor's backgroundTiles.
      props.push({ name: 'backgroundTiles', type: 'int', value: out.height / TILE });
    }
    entries.push({
      id: entries.length,
      type: 'FurnitureTile',
      image: `png/furniture/metro/${itemId}.png`,
      imagewidth: out.width,
      imageheight: out.height,
      properties: props,
    });
  });
  bySet.set(setName, entries);
  console.log(`  ${sheet.file} → ${boxes.length} items (${sheet.category}${sheet.wallMounted ? ', wall-mounted' : ''})`);
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
