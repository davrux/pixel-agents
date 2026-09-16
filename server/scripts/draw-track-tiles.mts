#!/usr/bin/env -S node --import tsx
/**
 * The race track's own ground: asphalt, kerbs, a chequered line and painted edges.
 *
 * Until this existed the circuit was painted with flat palette colours — a grey ring with red and
 * white blocks round it — which reads as a diagram rather than as a track. These eight tiles are
 * what makes it look like somewhere you drive.
 *
 * Generated rather than drawn, for the reason every art script here is: it is committed, so a
 * second run must produce the same bytes or `--check` means nothing. The speckle in the asphalt
 * comes from a seeded LCG keyed per tile, so the two asphalt variants differ from each other and
 * are stable across runs.
 *
 * Layout follows the house tileset convention — 16 px tiles, 1 px margin, 2 px spacing, with each
 * tile EXTRUDED one pixel into the gap. Without that a camera at a fractional zoom samples the
 * neighbouring tile along a seam and every cell gets a bright edge.
 *
 * Run: scripts/draw-track-tiles.sh [--check]
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { PNG } from 'pngjs';

const WRITE_OPTIONS = { filterType: 0, deflateLevel: 9, deflateStrategy: 0 } as const;
const REPO = path.join(import.meta.dirname, '..', '..');
const OUT = path.join(REPO, 'assets', 'tiled', 'png', 'src', 'track.png');
const TSJ = path.join(REPO, 'assets', 'tiled', 'track.tsj');
const CHECK = process.argv.includes('--check');

const TW = 16;
const MARGIN = 1;
const SPACING = 2;

type RGB = readonly [number, number, number];
const ASPHALT: RGB = [0x3c, 0x3c, 0x40];
const ASPHALT_DARK: RGB = [0x33, 0x33, 0x37];
const ASPHALT_LIGHT: RGB = [0x46, 0x46, 0x4a];
const KERB_RED: RGB = [0xc5, 0x1a, 0x1b];
const KERB_RED_LIT: RGB = [0xe2, 0x58, 0x5a];
const KERB_RED_DARK: RGB = [0x5c, 0x0f, 0x10];
const KERB_PALE: RGB = [0xf1, 0xef, 0xec];
const KERB_PALE_LIT: RGB = [0xff, 0xff, 0xff];
const KERB_PALE_DARK: RGB = [0x9a, 0x94, 0x8c];
const LINE: RGB = [0xe8, 0xe4, 0xdc];
const BOOST: RGB = [0xe7, 0xda, 0x00];
const BOOST_LIT: RGB = [0xff, 0xf6, 0x66];
const DARK: RGB = [0x14, 0x13, 0x12];

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** One tile as a 16×16 grid of colours. */
/** A tile's pixels. `null` is TRANSPARENT, which only the shore tiles use — everything else here
 *  is a ground tile and a ground tile with a hole in it would show the canvas through the map. */
type Tile = (RGB | null)[][];
const fill = (rgb: RGB | null): Tile => Array.from({ length: TW }, () => Array.from({ length: TW }, () => rgb));

/** Asphalt with a little grain — flat grey at this size reads as a floor, not a road surface. */
function asphalt(seed: number): Tile {
  const t = fill(ASPHALT);
  const rnd = lcg(seed);
  for (let y = 0; y < TW; y++) {
    for (let x = 0; x < TW; x++) {
      const r = rnd();
      if (r < 0.1) t[y][x] = ASPHALT_DARK;
      else if (r < 0.17) t[y][x] = ASPHALT_LIGHT;
    }
  }
  return t;
}

/** A kerb block: lit along the top, shadowed along the bottom, so it reads as raised. */
function kerb(base: RGB, lit: RGB, dark: RGB): Tile {
  const t = fill(base);
  for (let x = 0; x < TW; x++) {
    t[0][x] = lit;
    t[1][x] = lit;
    t[TW - 2][x] = dark;
    t[TW - 1][x] = dark;
  }
  for (let y = 0; y < TW; y++) {
    t[y][0] = dark;
    t[y][TW - 1] = dark;
  }
  return t;
}

/** Half the chequered band: four squares, so two of these alternating make the pattern. */
/**
 * A BOOST pad: chevrons pointing the way the road goes.
 *
 * Four of them rather than one, because an arrow has to point somewhere and a pad that boosts you
 * forwards while pointing sideways is a lie about what it does. The generator picks the one
 * nearest the road's own direction at that cell.
 *
 * Drawn on the asphalt rather than over it, so a pad is one ground cell and not a decal that could
 * drift away from the surface it names.
 */
function boostPad(dir: 'N' | 'E' | 'S' | 'W'): Tile {
  const t = asphalt(0x5eed07);
  // Two chevrons, drawn in a space where x runs along the road and y across it, then mapped.
  const put = (along: number, across: number, rgb: RGB): void => {
    if (along < 0 || along >= TW || across < 0 || across >= TW) return;
    const [x, y] =
      dir === 'E' ? [along, across]
      : dir === 'W' ? [TW - 1 - along, across]
      : dir === 'S' ? [across, along]
      : [across, TW - 1 - along];
    t[y][x] = rgb;
  };
  for (const base of [1, 9]) {
    for (let k = 0; k < 7; k++) {
      // A "greater than" made of two diagonals meeting at the middle of the cell.
      for (const w of [0, 1, 2]) {
        put(base + k + w, 1 + k, k === 6 ? BOOST_LIT : BOOST);
        put(base + k + w, TW - 2 - k, k === 6 ? BOOST_LIT : BOOST);
      }
    }
  }
  return t;
}

function chequer(flip: boolean): Tile {
  const t = fill(DARK);
  const half = TW / 2;
  for (let y = 0; y < TW; y++) {
    for (let x = 0; x < TW; x++) {
      const cell = (x < half ? 0 : 1) ^ (y < half ? 0 : 1);
      t[y][x] = (cell === 1) === flip ? KERB_PALE : DARK;
    }
  }
  return t;
}

/** Asphalt with a painted line along one edge. */
function edgeLine(seed: number, side: 'top' | 'bottom' | 'left' | 'right'): Tile {
  const t = asphalt(seed);
  for (let i = 0; i < TW; i++) {
    if (side === 'top') t[0][i] = t[1][i] = LINE;
    else if (side === 'bottom') t[TW - 1][i] = t[TW - 2][i] = LINE;
    else if (side === 'left') t[i][0] = t[i][1] = LINE;
    else t[i][TW - 1] = t[i][TW - 2] = LINE;
  }
  return t;
}

/**
 * THE SHORE: a waterline drawn into a land cell, so a river stops having a staircase for a bank.
 *
 * The gorge under a bridge is VOID cells with a water decal in them, and land is the cells beside
 * it — so the waterline was exactly the cell grid, a run of 16 px steps down a diagonal. Reported
 * as hard staircase edges against the grass.
 *
 * These are DECALS over the land, not ground: the water side is drawn and the land side is left
 * transparent, so the grass (or sand, or whatever a map put there) shows through and one set of
 * tiles works on any ground. Nothing about where a kart may drive changes — the cell is still the
 * ground it was, which is the whole reason the fix is a picture and not a shape.
 *
 * One tile per MASK of which neighbours are water, so the waterline runs continuously from cell to
 * cell. The shape comes from the standard box distance field over the half-planes the mask names:
 * `length(max(q, 0)) + min(max(q), 0)`, which is worth writing down because the rounding is what
 * it buys — at a corner where two sides are water the boundary is `hypot(q1, q2) = 0`, a quarter
 * circle, so a bend in the bank is a bend and not a right angle. The wave on top of it is two
 * sines of the pixel coordinate: deterministic, so `--check` still means something, and enough to
 * stop sixteen identical cells reading as a ruled line.
 */
const WATER: RGB = [0x20, 0x7e, 0xba];
const WATER_DEEP: RGB = [0x1a, 0x68, 0x9b];
const FOAM: RGB = [0xd6, 0xee, 0xf7];
/** How far into the land cell the water reaches, in pixels — a bank a third of a cell deep. */
const SHORE_DEPTH = 6;
/** The neighbours a shore tile can have water in, in the order their bits are read. */
const SIDES = ['N', 'E', 'S', 'W'] as const;
type Side = (typeof SIDES)[number];

const wave = (t: number, phase: number): number =>
  1.3 * Math.sin(t * 0.55 + phase) + 0.7 * Math.sin(t * 1.9 + phase * 2.1);

/**
 * A shore tile for a set of water sides, or for a single water DIAGONAL when `sides` is empty.
 *
 * `corner` names the diagonal in the second case — a cell whose only wet neighbour is across a
 * corner gets a nub there, because without it the bank has a nick in it exactly where two runs of
 * cells meet.
 */
function shore(sides: readonly Side[], corner: '' | 'NE' | 'SE' | 'SW' | 'NW' = ''): Tile {
  const t = fill(null);
  for (let y = 0; y < TW; y++) {
    for (let x = 0; x < TW; x++) {
      let sd: number;
      if (sides.length === 0) {
        const cx = corner === 'NE' || corner === 'SE' ? TW - 1 : 0;
        const cy = corner === 'NE' || corner === 'NW' ? 0 : TW - 1;
        sd = SHORE_DEPTH + wave(x + y, corner.length) - Math.hypot(x - cx, y - cy);
      } else {
        // `q` is how far OUTSIDE the land each named half-plane this pixel is.
        const q = sides.map((side) => {
          const edge = SHORE_DEPTH + wave(side === 'N' || side === 'S' ? x : y, SIDES.indexOf(side));
          return side === 'N' ? edge - y
            : side === 'S' ? y - (TW - 1 - edge)
            : side === 'W' ? edge - x
            : x - (TW - 1 - edge);
        });
        const outside = Math.hypot(...q.map((v) => Math.max(v, 0)));
        sd = outside + Math.min(Math.max(...q), 0);
      }
      if (sd <= 0) continue;                       // land: left transparent
      // The foam sits just inside the water, which is where a wave actually breaks — and it is
      // what makes the line read as a shore rather than as a blue tile butted against a green one.
      t[y][x] = sd < 1 ? FOAM : sd < 4 ? WATER : WATER_DEEP;
    }
  }
  return t;
}

/** Every mask that can occur, in a fixed order — the index IS the tile id. */
const SHORE_TILES: ReadonlyArray<{ name: string; tile: Tile }> = [
  ...Array.from({ length: 15 }, (_, k) => {
    const sides = SIDES.filter((_s, bit) => (k + 1) & (1 << bit));
    return { name: `shore-${sides.join('').toLowerCase()}`, tile: shore(sides) };
  }),
  ...(['NE', 'SE', 'SW', 'NW'] as const).map((c) => ({
    name: `shore-c${c.toLowerCase()}`,
    tile: shore([], c),
  })),
];

/** Index order IS the tile id, so this list is append-only — see AGENTS.md on tilesets. */
const TILES: ReadonlyArray<{ name: string; tile: Tile }> = [
  { name: 'asphalt', tile: asphalt(0x5eed01) },
  { name: 'asphalt-b', tile: asphalt(0x5eed02) },
  { name: 'kerb-red', tile: kerb(KERB_RED, KERB_RED_LIT, KERB_RED_DARK) },
  { name: 'kerb-pale', tile: kerb(KERB_PALE, KERB_PALE_LIT, KERB_PALE_DARK) },
  { name: 'chequer-a', tile: chequer(false) },
  { name: 'chequer-b', tile: chequer(true) },
  { name: 'edge-top', tile: edgeLine(0x5eed03, 'top') },
  { name: 'edge-bottom', tile: edgeLine(0x5eed04, 'bottom') },
  { name: 'edge-left', tile: edgeLine(0x5eed05, 'left') },
  { name: 'edge-right', tile: edgeLine(0x5eed06, 'right') },
  { name: 'boost-n', tile: boostPad('N') },
  { name: 'boost-e', tile: boostPad('E') },
  { name: 'boost-s', tile: boostPad('S') },
  { name: 'boost-w', tile: boostPad('W') },
  ...SHORE_TILES,
];

const COLUMNS = TILES.length;
const WIDTH = MARGIN * 2 + COLUMNS * TW + (COLUMNS - 1) * SPACING;
const HEIGHT = MARGIN * 2 + TW;
const png = new PNG({ width: WIDTH, height: HEIGHT });
png.data.fill(0);

const put = (x: number, y: number, rgb: RGB | null): void => {
  if (x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT) return;
  if (rgb === null) return; // left at the zeroed alpha the sheet starts with
  const i = (y * WIDTH + x) * 4;
  png.data[i] = rgb[0];
  png.data[i + 1] = rgb[1];
  png.data[i + 2] = rgb[2];
  png.data[i + 3] = 255;
};

TILES.forEach(({ tile }, k) => {
  const ox = MARGIN + k * (TW + SPACING);
  const oy = MARGIN;
  for (let y = 0; y < TW; y++) for (let x = 0; x < TW; x++) put(ox + x, oy + y, tile[y][x]);
  // Extrude one pixel all round, into the margin/spacing, so a fractional zoom cannot sample the
  // neighbour across the seam.
  for (let y = 0; y < TW; y++) {
    put(ox - 1, oy + y, tile[y][0]);
    put(ox + TW, oy + y, tile[y][TW - 1]);
  }
  for (let x = 0; x < TW; x++) {
    put(ox + x, oy - 1, tile[0][x]);
    put(ox + x, oy + TW, tile[TW - 1][x]);
  }
  put(ox - 1, oy - 1, tile[0][0]);
  put(ox + TW, oy - 1, tile[0][TW - 1]);
  put(ox - 1, oy + TW, tile[TW - 1][0]);
  put(ox + TW, oy + TW, tile[TW - 1][TW - 1]);
});

const bytes = PNG.sync.write(png, WRITE_OPTIONS);
/**
 * The shore tiles declare themselves as DECALS, and the rest of the sheet does not.
 *
 * A cell painted on a DecalLayer is imported only if its tile carries the `DecalTile` class and an
 * `id` property — without them the importer drops it silently, which is exactly what happened the
 * first time these were painted: the map had them, the generator's own render showed them, and the
 * game had nothing. Everything else in this sheet is GROUND, where the layer decides and the tile
 * says nothing, so the declaration is per tile rather than per sheet.
 */
const decalTiles = TILES.map(({ name }, id) => ({ name, id }))
  .filter(({ name }) => name.startsWith('shore-'))
  .map(({ name, id }) => ({
    id,
    type: 'DecalTile',
    properties: [
      { name: 'id', type: 'string', value: `TRACK_${name.toUpperCase().replace(/-/g, '_')}` },
      { name: 'label', type: 'string', value: `Shore ${name.slice('shore-'.length)}` },
    ],
  }));

const tsj =
  JSON.stringify(
    {
      columns: COLUMNS,
      image: 'png/src/track.png',
      imageheight: HEIGHT,
      imagewidth: WIDTH,
      margin: MARGIN,
      name: 'track',
      spacing: SPACING,
      tilecount: COLUMNS,
      tiledversion: '1.11.0',
      tileheight: TW,
      tiles: decalTiles,
      tilewidth: TW,
      type: 'tileset',
      version: '1.10',
    },
    null,
    2,
  ) + '\n';

if (CHECK) {
  const havePng = fs.existsSync(OUT) ? fs.readFileSync(OUT) : null;
  const haveTsj = fs.existsSync(TSJ) ? fs.readFileSync(TSJ, 'utf8') : null;
  if (havePng?.equals(bytes) && haveTsj === tsj) {
    console.log(`✓ ${path.relative(REPO, OUT)} and its tileset are up to date`);
    process.exit(0);
  }
  console.error(`✗ the track tileset differs — run scripts/draw-track-tiles.sh`);
  process.exit(1);
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, bytes);
fs.writeFileSync(TSJ, tsj);
console.log(`wrote ${path.relative(REPO, OUT)} (${COLUMNS} tiles, ${bytes.length} bytes) and track.tsj`);
