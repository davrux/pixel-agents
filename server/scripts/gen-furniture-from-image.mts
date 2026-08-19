#!/usr/bin/env -S node --import tsx
/**
 * Turns ONE oversized picture into ONE furniture tile at this project's scale.
 *
 * The art that arrives from a generator or an artist is routinely a 1024×1024
 * render of a single object — right subject, wrong resolution by a factor of
 * thirty. Dropping it in as-is is not an option: furniture footprint is derived
 * from the PNG's size (tiledFurniture.ts's footprintOf), so a 1024px machine
 * would claim a 16×16-tile footprint and tower over the world. Somebody has to
 * decide how many TILES the thing is and resample it there, and that decision
 * plus the resampling is what this script records.
 *
 * It is not a pack importer: a pack is many pieces and the judgement is where
 * one ends and the next begins (gen-metro-furniture.mts, and the
 * tiled-asset-import skill). Here there is one piece and the judgement is its
 * SIZE, so the interesting flags are --size and --erase.
 *
 * What it does, in order:
 *   1. blanks any --erase rectangles (detached bits the sprite is better off
 *      without — a floating steam wisp, a signature, a drop shadow),
 *   2. crops to what is left,
 *   3. area-averages down to --size with PREMULTIPLIED alpha, then cuts a hard
 *      silhouette. Resampling straight RGBA blends the transparent pixels'
 *      black into every edge and rims the sprite in soot; premultiplying is
 *      what keeps the edge the object's own colour. The hard cut is because
 *      this world's sprites are opaque-or-absent, not feathered.
 *   4. quantizes, greys and accents SEPARATELY (see quantize below),
 *   5. lays the house shadow row under it — every hand-drawn piece in
 *      furniture-kitchens has one, and without it the piece floats,
 *   6. writes assets/tiled/png/src/furniture/<set>/<ID>.png and APPENDS one
 *      tile to assets/tiled/furniture-<set>.tsj, carrying every property in
 *      FURNITURE_TILE_PROPS with its default filled in.
 *
 * Appending is the only thing it will do to a tileset: a tile's local id is
 * what every saved map's gid points at, so it takes the next id after the
 * highest and refuses an --id that already exists. Growing a tileset does move
 * the tileset AFTER it in a map's own table, which is not this script's to fix
 * — run `scripts/sync-furniture-properties.sh --fix-gids` after it, and compare
 * a re-import before and after (see AGENTS.md).
 *
 * The output is deterministic: the palette search is seeded from the sorted
 * unique colours, so the same input gives the same bytes.
 *
 * Run: scripts/import-furniture-image.sh <source.png> --id ID --set SET [...]
 */
import { PNG } from 'pngjs';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { FURNITURE_TILE_PROPS } from '../src/tiled/furnitureProps.js';

const ROOT = new URL('../..', import.meta.url).pathname;
const TILE = 16;
/** Below this the resampled pixel is more background than object. */
const ALPHA_CUT = 100;
/** The soft drop shadow every hand-drawn piece in this catalog sits on. */
const SHADOW = { r: 0, g: 0, b: 0, a: 51 };

// ── arguments ───────────────────────────────────────────────────────────────

interface Args {
  source: string;
  id: string;
  set: string;
  width: number;
  height: number;
  greys: number;
  chroma: number;
  shadow: boolean;
  erase: Array<[number, number, number, number]>;
  props: Map<string, string>;
  dry: boolean;
}

function usage(msg?: string): never {
  if (msg) console.error(`✗ ${msg}`);
  console.error(`
Usage: scripts/import-furniture-image.sh <source.png> --id ID --set SET [options]

  --id ID            catalog id, and the PNG's filename. Immutable once placed.
  --set NAME         appends to assets/tiled/furniture-<NAME>.tsj and writes the
                     PNG to png/src/furniture/<NAME>/
  --size WxH         target size in PIXELS, each a multiple of 16 (default 32x32).
                     16px = one tile, so 32x32 is a 2x2-tile object.
  --label TEXT       display name (default: the id, title-cased)
  --erase X,Y,W,H    blank this rectangle of the SOURCE first; repeatable
  --greys N          palette entries for the neutral colours (default 14)
  --chroma N         palette entries for the saturated accents (default 7)
  --no-shadow        omit the shadow row (wall-mounted art, or a floating thing)
  --prop NAME=VALUE  set a FurnitureTile property; repeatable. Anything not set
                     lands on its default, e.g.
                     --prop backgroundTiles=1 --prop actionKind=appliance
  --dry-run          report only, write nothing
`);
  process.exit(msg ? 1 : 0);
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const out: Partial<Args> = { erase: [], props: new Map(), dry: false, shadow: true };
  let label: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i] ?? usage(`${a} needs a value`);
    if (a === '--help' || a === '-h') usage();
    else if (a === '--dry-run') out.dry = true;
    else if (a === '--no-shadow') out.shadow = false;
    else if (a === '--id') out.id = next();
    else if (a === '--set') out.set = next();
    else if (a === '--label') label = next();
    else if (a === '--greys') out.greys = Number(next());
    else if (a === '--chroma') out.chroma = Number(next());
    else if (a === '--size') {
      const m = /^(\d+)x(\d+)$/.exec(next());
      if (!m) usage('--size wants WxH, e.g. 32x32');
      out.width = Number(m[1]);
      out.height = Number(m[2]);
    } else if (a === '--erase') {
      const nums = next().split(',').map(Number);
      if (nums.length !== 4 || nums.some((n) => !Number.isInteger(n) || n < 0)) usage('--erase wants X,Y,W,H');
      out.erase!.push(nums as [number, number, number, number]);
    } else if (a === '--prop') {
      const raw = next();
      const eq = raw.indexOf('=');
      if (eq < 1) usage('--prop wants NAME=VALUE');
      out.props!.set(raw.slice(0, eq), raw.slice(eq + 1));
    } else if (a.startsWith('-')) usage(`unknown flag ${a}`);
    else positional.push(a);
  }
  if (positional.length !== 1) usage('exactly one source PNG, please');
  if (!out.id) usage('--id is required');
  if (!out.set) usage('--set is required');
  if (!/^[A-Z][A-Z0-9_]*$/.test(out.id)) usage('--id should be SCREAMING_SNAKE_CASE');
  const width = out.width ?? 32;
  const height = out.height ?? 32;
  if (width % TILE || height % TILE) usage(`--size must be whole tiles of ${TILE}px`);
  if (!out.props!.has('label')) out.props!.set('label', label ?? titleCase(out.id));
  return {
    source: positional[0],
    id: out.id,
    set: out.set,
    width,
    height,
    greys: out.greys ?? 14,
    chroma: out.chroma ?? 7,
    shadow: out.shadow!,
    erase: out.erase!,
    props: out.props!,
    dry: out.dry!,
  };
}

function titleCase(id: string): string {
  return id
    .toLowerCase()
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// ── pixels ──────────────────────────────────────────────────────────────────

type Px = { r: number; g: number; b: number; a: number };

const at = (png: PNG, x: number, y: number): Px => {
  const i = (y * png.width + x) * 4;
  return { r: png.data[i], g: png.data[i + 1], b: png.data[i + 2], a: png.data[i + 3] };
};
const put = (png: PNG, x: number, y: number, p: Px) => {
  const i = (y * png.width + x) * 4;
  png.data[i] = p.r;
  png.data[i + 1] = p.g;
  png.data[i + 2] = p.b;
  png.data[i + 3] = p.a;
};

function erase(png: PNG, [x, y, w, h]: [number, number, number, number]): void {
  for (let yy = y; yy < Math.min(y + h, png.height); yy++)
    for (let xx = x; xx < Math.min(x + w, png.width); xx++) put(png, xx, yy, { r: 0, g: 0, b: 0, a: 0 });
}

/** Bounding box of what is meaningfully opaque — a generator's output has a
 *  halo of alpha 1..30 around the subject, and including it shrinks the art
 *  inside its own tile for no gain. */
function bbox(png: PNG, cut = 32): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = png.width;
  let y0 = png.height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < png.height; y++)
    for (let x = 0; x < png.width; x++)
      if (at(png, x, y).a > cut) {
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
  if (x1 < 0) throw new Error('the source is entirely transparent');
  return { x0, y0, x1: x1 + 1, y1: y1 + 1 };
}

/**
 * Area-average `src`'s [box] down to w×h over PREMULTIPLIED alpha, then cut a
 * hard silhouette at ALPHA_CUT. Each destination pixel is the coverage-weighted
 * mean of the source rectangle it stands for, fractional edges included — which
 * is what keeps a 30:1 reduction from turning into a point sample of whatever
 * pixel happened to land on the grid.
 */
function shrink(src: PNG, box: { x0: number; y0: number; x1: number; y1: number }, w: number, h: number): PNG {
  const out = new PNG({ width: w, height: h });
  const sw = box.x1 - box.x0;
  const sh = box.y1 - box.y0;
  for (let dy = 0; dy < h; dy++) {
    const fy0 = box.y0 + (dy * sh) / h;
    const fy1 = box.y0 + ((dy + 1) * sh) / h;
    for (let dx = 0; dx < w; dx++) {
      const fx0 = box.x0 + (dx * sw) / w;
      const fx1 = box.x0 + ((dx + 1) * sw) / w;
      let wr = 0;
      let wg = 0;
      let wb = 0;
      let wa = 0;
      let wsum = 0;
      for (let sy = Math.floor(fy0); sy < Math.ceil(fy1); sy++) {
        const cy = Math.min(sy + 1, fy1) - Math.max(sy, fy0);
        if (cy <= 0) continue;
        for (let sx = Math.floor(fx0); sx < Math.ceil(fx1); sx++) {
          const cx = Math.min(sx + 1, fx1) - Math.max(sx, fx0);
          if (cx <= 0) continue;
          const p = at(src, sx, sy);
          const cov = cx * cy;
          const pa = cov * p.a;
          wr += p.r * pa;
          wg += p.g * pa;
          wb += p.b * pa;
          wa += pa;
          wsum += cov;
        }
      }
      const alpha = wsum > 0 ? wa / wsum : 0;
      if (alpha < ALPHA_CUT || wa === 0) {
        put(out, dx, dy, { r: 0, g: 0, b: 0, a: 0 });
        continue;
      }
      put(out, dx, dy, {
        r: Math.min(255, Math.round(wr / wa)),
        g: Math.min(255, Math.round(wg / wa)),
        b: Math.min(255, Math.round(wb / wa)),
        a: 255,
      });
    }
  }
  return out;
}

/** How colourful, 0..1. */
function saturation(p: Px): number {
  const mx = Math.max(p.r, p.g, p.b);
  const mn = Math.min(p.r, p.g, p.b);
  return mx === 0 ? 0 : (mx - mn) / mx;
}

/** An accent is saturated AND bright. The brightness test is the load-bearing
 *  half: a dark outline is technically saturated too, and letting outlines into
 *  the accent group spends the accent budget on them and turns the actual
 *  accents grey. */
function isAccent(p: Px): boolean {
  return saturation(p) > 0.22 && Math.max(p.r, p.g, p.b) > 80;
}

const key = (p: { r: number; g: number; b: number }) => (p.r << 16) | (p.g << 8) | p.b;
/** Green-weighted, the usual cheap stand-in for perceptual distance. */
const dist = (a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }) =>
  2 * (a.r - b.r) ** 2 + 4 * (a.g - b.g) ** 2 + 3 * (a.b - b.b) ** 2;

/** k-means over RGB, seeded by an even walk through the sorted unique colours
 *  so the result depends on the pixels and nothing else. */
function cluster(samples: Px[], k: number): Array<{ r: number; g: number; b: number }> {
  const uniq = [...new Map(samples.map((p) => [key(p), { r: p.r, g: p.g, b: p.b }])).values()].sort(
    (a, b) => key(a) - key(b),
  );
  if (uniq.length <= k) return uniq;
  const step = (uniq.length - 1) / (k - 1);
  let cents = Array.from({ length: k }, (_, i) => uniq[Math.round(i * step)]);
  for (let round = 0; round < 12; round++) {
    const sums = cents.map(() => ({ r: 0, g: 0, b: 0, n: 0 }));
    for (const p of samples) {
      let best = 0;
      let bd = Infinity;
      cents.forEach((c, i) => {
        const d = dist(p, c);
        if (d < bd) {
          bd = d;
          best = i;
        }
      });
      const s = sums[best];
      s.r += p.r;
      s.g += p.g;
      s.b += p.b;
      s.n++;
    }
    const moved = cents.map((c, i) => {
      const s = sums[i];
      return s.n === 0
        ? c
        : { r: Math.round(s.r / s.n), g: Math.round(s.g / s.n), b: Math.round(s.b / s.n) };
    });
    if (moved.every((m, i) => key(m) === key(cents[i]))) break;
    cents = moved;
  }
  return cents.sort((a, b) => key(a) - key(b));
}

/**
 * Reduce to a small palette — greys and accents budgeted separately.
 *
 * One median cut over the whole sprite spends every entry where the pixels are,
 * and on a stainless machine that is the greys: the red buttons and the coffee
 * come back grey-brown, which is exactly the detail that makes the sprite
 * readable at 32px. Two groups with their own budgets keeps both.
 */
function quantize(png: PNG, greys: number, chroma: number): { palette: number; accents: number } {
  const grey: Px[] = [];
  const accent: Px[] = [];
  for (let y = 0; y < png.height; y++)
    for (let x = 0; x < png.width; x++) {
      const p = at(png, x, y);
      if (p.a !== 255) continue;
      (isAccent(p) ? accent : grey).push(p);
    }
  const gp = cluster(grey, greys);
  const ap = cluster(accent, chroma);
  const nearest = (p: Px, pal: Array<{ r: number; g: number; b: number }>) =>
    pal.reduce((best, c) => (dist(p, c) < dist(p, best) ? c : best), pal[0]);
  for (let y = 0; y < png.height; y++)
    for (let x = 0; x < png.width; x++) {
      const p = at(png, x, y);
      if (p.a !== 255) continue;
      const pal = isAccent(p) ? ap : gp;
      if (pal.length === 0) continue;
      put(png, x, y, { ...nearest(p, pal), a: 255 });
    }
  return { palette: gp.length + ap.length, accents: ap.length };
}

/** The house drop shadow: the sprite's bottom row, inset two pixels from the
 *  silhouette, exactly as FRIDGE.png and friends carry it. */
function shadowRow(png: PNG): void {
  const y = png.height - 1;
  let x0 = png.width;
  let x1 = -1;
  for (let x = 0; x < png.width; x++)
    for (let yy = 0; yy < png.height; yy++)
      if (at(png, x, yy).a > 0) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        break;
      }
  if (x1 < 0) return;
  for (let x = x0 + 2; x <= x1 - 2; x++) if (at(png, x, y).a === 0) put(png, x, y, SHADOW);
}

// ── the tileset ─────────────────────────────────────────────────────────────

interface TiledProp {
  name: string;
  type: string;
  value: string | number | boolean;
  propertytype?: string;
}

/** A --prop value arrives as text; its TYPE is whatever the property's default
 *  is, so the tileset never gets a string where the readers expect a bool. */
function coerce(raw: string, sample: string | number | boolean): string | number | boolean {
  if (typeof sample === 'boolean') {
    if (raw !== 'true' && raw !== 'false') usage(`expected true or false, got "${raw}"`);
    return raw === 'true';
  }
  if (typeof sample === 'number') {
    const n = Number(raw);
    if (!Number.isInteger(n)) usage(`expected a whole number, got "${raw}"`);
    return n;
  }
  return raw;
}

function tileProps(args: Args): TiledProp[] {
  const known = new Set(['id', ...FURNITURE_TILE_PROPS.map((p) => p.name)]);
  for (const name of args.props.keys()) if (!known.has(name)) usage(`no such FurnitureTile property: ${name}`);
  return [
    { name: 'id', type: 'string', value: args.id },
    ...FURNITURE_TILE_PROPS.map((spec) => {
      const raw = args.props.get(spec.name);
      const value = raw === undefined ? spec.default : coerce(raw, spec.default);
      return {
        name: spec.name,
        type: typeof value === 'boolean' ? 'bool' : typeof value === 'number' ? 'int' : 'string',
        value,
        ...(spec.propertyType ? { propertytype: spec.propertyType } : {}),
      };
    }),
  ];
}

// ── run ─────────────────────────────────────────────────────────────────────

const args = parseArgs(process.argv.slice(2));
const tsjPath = path.join(ROOT, 'assets', 'tiled', `furniture-${args.set}.tsj`);
if (!fs.existsSync(tsjPath)) usage(`no tileset at ${path.relative(ROOT, tsjPath)}`);
const tsj = JSON.parse(fs.readFileSync(tsjPath, 'utf8')) as {
  tilecount: number;
  tiles: Array<{ id: number; type?: string; image?: string; properties?: TiledProp[] }>;
};
const taken = new Map(
  tsj.tiles.map((t) => [String(t.properties?.find((p) => p.name === 'id')?.value ?? ''), t.id]),
);
if (taken.has(args.id)) usage(`${args.id} already exists in furniture-${args.set} (tile ${taken.get(args.id)})`);

const src = PNG.sync.read(fs.readFileSync(args.source));
console.log(`  source ${path.basename(args.source)} ${src.width}x${src.height}`);
for (const rect of args.erase) {
  erase(src, rect);
  console.log(`  erased ${rect.join(',')}`);
}
const box = bbox(src);
console.log(`  subject ${box.x1 - box.x0}x${box.y1 - box.y0} at ${box.x0},${box.y0}`);
const artHeight = args.shadow ? args.height - 1 : args.height;
const art = shrink(src, box, args.width, artHeight);
const { palette, accents } = quantize(art, args.greys, args.chroma);
const out = new PNG({ width: args.width, height: args.height });
out.data.fill(0);
PNG.bitblt(art, out, 0, 0, art.width, art.height, 0, 0);
if (args.shadow) shadowRow(out);
console.log(
  `  → ${args.width}x${args.height} (${args.width / TILE}x${args.height / TILE} tiles), ${palette} colours, ${accents} of them accents`,
);

const pngRel = path.join('png', 'src', 'furniture', args.set, `${args.id}.png`);
const pngPath = path.join(ROOT, 'assets', 'tiled', pngRel);
const tile = {
  id: tsj.tiles.reduce((max, t) => Math.max(max, t.id), -1) + 1,
  type: 'FurnitureTile',
  image: pngRel.split(path.sep).join('/'),
  imagewidth: args.width,
  imageheight: args.height,
  properties: tileProps(args),
};

if (args.dry) {
  console.log(`~ dry run: would write ${path.relative(ROOT, pngPath)} and append tile ${tile.id}`);
} else {
  fs.mkdirSync(path.dirname(pngPath), { recursive: true });
  fs.writeFileSync(pngPath, PNG.sync.write(out));
  // Append only: every existing tile keeps its id, so every gid in every saved
  // map keeps pointing where its author put it.
  tsj.tiles.push(tile);
  tsj.tilecount = tsj.tiles.length;
  fs.writeFileSync(tsjPath, JSON.stringify(tsj, null, 2) + '\n');
  console.log(`✓ ${path.relative(ROOT, pngPath)}`);
  console.log(`✓ furniture-${args.set}.tsj: tile ${tile.id} = ${args.id} (${tsj.tilecount} tiles)`);
  console.log('  next: scripts/sync-furniture-properties.sh --check   (--fix-gids if it reports a stale table)');
}
