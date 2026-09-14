#!/usr/bin/env -S node --import tsx
/**
 * Landscape the tracks: the ground beside the road, and the things growing on it.
 *
 * Everything outside the tarmac used to be VOID — not drawn and not drivable — so a circuit sat in
 * a black square. This turns that into somewhere: sand for the run-off, grass beyond it, and trees
 * and rocks scattered past the barrier.
 *
 * The art is Dust Racing 2D's under CC BY-SA 3.0; see `assets/third-party/dust-racing/README.md`,
 * which carries the attribution and the share-alike obligation that travels with everything this
 * script writes.
 *
 * Two things about the conversion are decisions rather than mechanics:
 *
 *  - **Several cells are cut from each texture, not one.** The sources are 256×256 and tile
 *    seamlessly, so four 16 px cells taken from four different parts of one look like a field,
 *    where the same cell repeated looks like wallpaper. They are cut on a fixed grid rather than
 *    at random, so `--check` means something.
 *  - **Nothing is recoloured.** The palette is theirs, and that is the point: it is what makes the
 *    surroundings look like somewhere rather than like a diagram with a green fill.
 *
 * Run: scripts/make-scenery.sh [--check]
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { PNG } from 'pngjs';

const WRITE_OPTIONS = { filterType: 0, deflateLevel: 9, deflateStrategy: 0 } as const;
const REPO = path.join(import.meta.dirname, '..', '..');
const SRC = path.join(REPO, 'assets', 'third-party', 'dust-racing');
const PNG_OUT = path.join(REPO, 'assets', 'tiled', 'png', 'src', 'scenery.png');
const TSJ_OUT = path.join(REPO, 'assets', 'tiled', 'scenery.tsj');
const DECAL_DIR = path.join(REPO, 'assets', 'tiled', 'png', 'src', 'decal');
const DECAL_TSJ = path.join(REPO, 'assets', 'tiled', 'decal-race.tsj');
const CHECK = process.argv.includes('--check');

const TW = 16;
const MARGIN = 1;
const SPACING = 2;

/**
 * The ground tiles, in order — the order IS the tile id, so append only.
 *
 * `at` is where in the 256 px source the cell is cut from, in source pixels. Four spread across
 * each texture, because what a field needs is variety and not a bigger picture.
 */
const GROUND: ReadonlyArray<{ name: string; file: string; at: [number, number] }> = [
  { name: 'grassA', file: 'grass.png', at: [0, 0] },
  { name: 'grassB', file: 'grass.png', at: [96, 32] },
  { name: 'grassC', file: 'grass.png', at: [160, 128] },
  { name: 'grassD', file: 'grass.png', at: [32, 192] },
  { name: 'sandA', file: 'sand.png', at: [0, 0] },
  { name: 'sandB', file: 'sand.png', at: [96, 32] },
  { name: 'sandC', file: 'sand.png', at: [160, 128] },
  { name: 'sandD', file: 'sand.png', at: [32, 192] },
];

/** The decals: one image each, scaled to whole cells. A tree is two cells tall so it reads as one. */
const DECALS: ReadonlyArray<{ id: string; file: string; w: number; h: number; label: string }> = [
  { id: 'RACE_TREE', file: 'tree.png', w: 32, h: 32, label: 'Race tree' },
  { id: 'RACE_ROCK', file: 'rock.png', w: 16, h: 16, label: 'Race rock' },
  { id: 'RACE_PLANT', file: 'plant.png', w: 16, h: 16, label: 'Race plant' },
];

const read = (file: string): PNG => PNG.sync.read(fs.readFileSync(path.join(SRC, file)));

/** Area-average a rectangle of `src` into `w`×`h`. Alpha-weighted, so an edge does not go grey. */
function scaleInto(src: PNG, sx: number, sy: number, sw: number, sh: number, w: number, h: number): PNG {
  const out = new PNG({ width: w, height: h });
  out.data.fill(0);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const x0 = sx + Math.floor((x * sw) / w);
      const x1 = sx + Math.max(Math.floor(((x + 1) * sw) / w), Math.floor((x * sw) / w) + 1);
      const y0 = sy + Math.floor((y * sh) / h);
      const y1 = sy + Math.max(Math.floor(((y + 1) * sh) / h), Math.floor((y * sh) / h) + 1);
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let yy = y0; yy < y1 && yy < src.height; yy++) {
        for (let xx = x0; xx < x1 && xx < src.width; xx++) {
          const i = (yy * src.width + xx) * 4;
          const pa = src.data[i + 3] / 255;
          r += src.data[i] * pa;
          g += src.data[i + 1] * pa;
          b += src.data[i + 2] * pa;
          a += pa;
          n++;
        }
      }
      if (n === 0 || a === 0) continue;
      const i = (y * w + x) * 4;
      out.data[i] = Math.round(r / a);
      out.data[i + 1] = Math.round(g / a);
      out.data[i + 2] = Math.round(b / a);
      out.data[i + 3] = Math.round((a / n) * 255);
    }
  }
  return out;
}

// ── the ground sheet ─────────────────────────────────────────────────────────
const COLUMNS = GROUND.length;
const WIDTH = MARGIN * 2 + COLUMNS * TW + (COLUMNS - 1) * SPACING;
const HEIGHT = MARGIN * 2 + TW;
const sheet = new PNG({ width: WIDTH, height: HEIGHT });
sheet.data.fill(0);
const put = (x: number, y: number, rgba: readonly number[]): void => {
  if (x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT) return;
  const i = (y * WIDTH + x) * 4;
  sheet.data[i] = rgba[0];
  sheet.data[i + 1] = rgba[1];
  sheet.data[i + 2] = rgba[2];
  sheet.data[i + 3] = 255;
};
GROUND.forEach((tile, k) => {
  const src = read(tile.file);
  // 64 source pixels down to 16: a quarter-scale cut keeps the texture's grain readable, where
  // taking 16×16 raw would give sixteen pixels of one blade of grass.
  const cell = scaleInto(src, tile.at[0], tile.at[1], 64, 64, TW, TW);
  const ox = MARGIN + k * (TW + SPACING);
  const oy = MARGIN;
  const px = (x: number, y: number): number[] => {
    const i = (y * TW + x) * 4;
    return [cell.data[i], cell.data[i + 1], cell.data[i + 2]];
  };
  for (let y = 0; y < TW; y++) for (let x = 0; x < TW; x++) put(ox + x, oy + y, px(x, y));
  // Extruded one pixel all round, like every other sheet here: without it a fractional zoom
  // samples the neighbour across the seam.
  for (let y = 0; y < TW; y++) {
    put(ox - 1, oy + y, px(0, y));
    put(ox + TW, oy + y, px(TW - 1, y));
  }
  for (let x = 0; x < TW; x++) {
    put(ox + x, oy - 1, px(x, 0));
    put(ox + x, oy + TW, px(x, TW - 1));
  }
  put(ox - 1, oy - 1, px(0, 0));
  put(ox + TW, oy - 1, px(TW - 1, 0));
  put(ox - 1, oy + TW, px(0, TW - 1));
  put(ox + TW, oy + TW, px(TW - 1, TW - 1));
});

const sheetBytes = PNG.sync.write(sheet, WRITE_OPTIONS);
const sheetTsj =
  JSON.stringify(
    {
      columns: COLUMNS,
      image: 'png/src/scenery.png',
      imageheight: HEIGHT,
      imagewidth: WIDTH,
      margin: MARGIN,
      name: 'scenery',
      spacing: SPACING,
      tilecount: COLUMNS,
      tiledversion: '1.11.0',
      tileheight: TW,
      tilewidth: TW,
      type: 'tileset',
      version: '1.10',
    },
    null,
    2,
  ) + '\n';

/**
 * Clear a solid BLACK backing, from the edges inwards.
 *
 * `rock.png` is a rock painted on an opaque black square — 2170 of its 4096 pixels — because in
 * its own engine it is laid on a ground texture and never needs an alpha channel. Scattered on
 * grass here it came out as a dark box with a stone in it, which is what it looked like in the
 * game. `tree.png` and `plant.png` carry real alpha and are left alone.
 *
 * Flooded from the border rather than keyed by colour, because a rock HAS dark pixels of its own
 * and a plain "near black is background" test punches holes in the middle of it. The edge is
 * then feathered one pixel: a hard cut at this size reads as a sticker.
 */
function clearBlackBacking(png: PNG): PNG {
  const { width: w, height: h, data } = png;
  const dark = (i: number): boolean => data[i] < 26 && data[i + 1] < 26 && data[i + 2] < 26;
  const out = new Set<number>();
  const queue: number[] = [];
  const visit = (x: number, y: number): void => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const cell = y * w + x;
    if (out.has(cell) || !dark(cell * 4)) return;
    out.add(cell);
    queue.push(cell);
  };
  for (let x = 0; x < w; x++) {
    visit(x, 0);
    visit(x, h - 1);
  }
  for (let y = 0; y < h; y++) {
    visit(0, y);
    visit(w - 1, y);
  }
  for (let head = 0; head < queue.length; head++) {
    const cell = queue[head];
    const x = cell % w;
    const y = (cell - x) / w;
    visit(x + 1, y);
    visit(x - 1, y);
    visit(x, y + 1);
    visit(x, y - 1);
  }
  for (const cell of out) data[cell * 4 + 3] = 0;
  // Feather: a kept pixel touching a cleared one goes half transparent, so the silhouette has an
  // edge rather than a staircase once it is scaled down.
  const soft = Buffer.from(data);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const cell = y * w + x;
      if (out.has(cell)) continue;
      const touches =
        out.has(cell - 1) || out.has(cell + 1) || out.has(cell - w) || out.has(cell + w);
      if (touches) soft[cell * 4 + 3] = Math.round(data[cell * 4 + 3] * 0.5);
    }
  }
  data.set(soft);
  return png;
}

// ── the decals ───────────────────────────────────────────────────────────────
const decalFiles = DECALS.map((d) => {
  const src = clearBlackBacking(read(d.file));
  return { ...d, bytes: PNG.sync.write(scaleInto(src, 0, 0, src.width, src.height, d.w, d.h), WRITE_OPTIONS) };
});
const decalTsj =
  JSON.stringify(
    {
      columns: 0,
      name: 'decal-race',
      tilecount: DECALS.length,
      tiledversion: '1.11.0',
      tileheight: TW,
      tilewidth: TW,
      type: 'tileset',
      version: '1.10',
      tiles: decalFiles.map((d, i) => ({
        id: i,
        type: 'DecalTile',
        image: `png/src/decal/${d.id}.png`,
        imagewidth: d.w,
        imageheight: d.h,
        properties: [
          { name: 'id', type: 'string', value: d.id },
          { name: 'label', type: 'string', value: d.label },
        ],
      })),
    },
    null,
    2,
  ) + '\n';

const outputs: Array<{ file: string; bytes: Buffer | string }> = [
  { file: PNG_OUT, bytes: sheetBytes },
  { file: TSJ_OUT, bytes: sheetTsj },
  { file: DECAL_TSJ, bytes: decalTsj },
  ...decalFiles.map((d) => ({ file: path.join(DECAL_DIR, `${d.id}.png`), bytes: d.bytes })),
];

let differs = false;
for (const { file, bytes } of outputs) {
  if (CHECK) {
    const have = fs.existsSync(file) ? fs.readFileSync(file) : null;
    const same = typeof bytes === 'string' ? have?.toString('utf8') === bytes : have?.equals(bytes);
    if (!same) {
      console.error(`✗ ${path.relative(REPO, file)} differs`);
      differs = true;
    }
    continue;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
}
if (CHECK) {
  if (differs) {
    console.error('run scripts/make-scenery.sh');
    process.exit(1);
  }
  console.log(`✓ scenery is up to date (${GROUND.length} ground tiles, ${DECALS.length} decals)`);
} else {
  console.log(`wrote ${GROUND.length} ground tiles and ${DECALS.length} decals`);
}
