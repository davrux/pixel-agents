#!/usr/bin/env -S node --import tsx
/**
 * Write the first race track, `assets/tiled/zones/raceway.tmj`.
 *
 * A generated map, which is unusual here — maps are authored in Tiled and pushed (AGENTS.md
 * § Content pipeline) — and the reason is narrow: an oval is geometry, not design, and the point
 * of this one is to have something to drive on while the movement model is being built. It is a
 * real `.tmj`: committed, diffable, and openable in Tiled, so the moment somebody wants to shape
 * a proper circuit they edit it there and this script stops being run.
 *
 * What it lays down, and why each part is where it is:
 *
 *  - **Ground** is the ring only. The infield and everything outside the barrier are VOID, and
 *    that is what makes falling work: only ground makes a cell drivable, so a pit costs no new
 *    concept and a bridge over one is free (paint ground across it).
 *  - **Collision** is a one-tile barrier around the outside. A blocked tile stops a kart; open
 *    air drops it — the two edges of a track are two different rules and a map needs both, or
 *    every kerb is a cliff.
 *  - **Actions** carry four gates and a starting grid. Gate 0 is the finish line, and the
 *    direction of travel is implied by where the next gate is, so nothing states a heading.
 *
 * Tilesets and gids are copied from uponu, because a map's own tileset table is what its gids
 * resolve against (see resolveFromTmjTilesets) and inventing one would need a bake.
 *
 * TWO tracks come out of it, from one description each: a racing game with one circuit is a
 * demo. They differ in the things that decide how a lap feels — how long the straights are, how
 * wide the road is, how many laps, and whether there is a bridge to be shoved off — and share
 * everything else, because the second track is meant to be another track and not another engine.
 *
 * Run: scripts/make-tracks.sh [--check]
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/** The same ceiling a pushed map is refused against — read from the shared table rather than
 *  written here, so a generator cannot produce a map the server would turn away. */
import { MAX_COLS, MAX_ROWS } from '@pixel/shared/office/constants.js';

const REPO = path.join(import.meta.dirname, '..', '..');
const SRC = path.join(REPO, 'assets', 'tiled', 'zones', 'uponu.tmj');
const ZONES = path.join(REPO, 'assets', 'tiled', 'zones');
const CHECK = process.argv.includes('--check');

/**
 * The track's own tileset, appended after everything uponu carries.
 *
 * A tileset of our own rather than palette colours: the first circuit was painted with two solid
 * floor tiles and read as a diagram of a track rather than as one. The gids are resolved at
 * generation time from the tileset table this map copies, so appending a set to that table cannot
 * silently shift what the road is painted with — see AGENTS.md on gid ranges (append only, never
 * insert, never renumber).
 */
const TRACK_TILES = [
  'asphalt', 'asphaltB', 'kerbRed', 'kerbPale', 'chequerA', 'chequerB',
  'edgeTop', 'edgeBottom', 'edgeLeft', 'edgeRight',
  'boostN', 'boostE', 'boostS', 'boostW',
  // The shore: one per mask of which neighbours are water, in the order `draw-track-tiles.mts`
  // emits them. Fifteen for the four sides and four more for a diagonal-only touch.
  'shoreN', 'shoreE', 'shoreNE', 'shoreS', 'shoreNS', 'shoreES', 'shoreNES',
  'shoreW', 'shoreNW', 'shoreEW', 'shoreNEW', 'shoreSW', 'shoreNSW', 'shoreESW', 'shoreNESW',
  'shoreCNE', 'shoreCSE', 'shoreCSW', 'shoreCNW',
  'itemBox',
] as const;
type TrackTile = (typeof TRACK_TILES)[number];
/**
 * The landscape a circuit sits in — Dust Racing's ground, under CC BY-SA 3.0.
 *
 * Its own tileset rather than more rows in ours, because the two carry different licences and a
 * file is the smallest thing a licence can attach to. See assets/third-party/dust-racing/README.md.
 */
const SCENERY_TILES = [
  'grassA', 'grassB', 'grassC', 'grassD',
  'sandA', 'sandB', 'sandC', 'sandD',
  'asphaltA', 'asphaltB', 'asphaltC', 'asphaltD',
] as const;
type SceneryTile = (typeof SCENERY_TILES)[number];
/**
 * What STANDS in that landscape — a tree, a rock, a tuft — in the order `decal-race.tsj` carries
 * them. Grass alone is still a flat green rectangle; what makes a circuit read as a place is
 * something with a height in it.
 */
const DECAL_TILES = ['RACE_TREE', 'RACE_ROCK', 'RACE_PLANT', 'RACE_TYRE', 'RACE_BRAKE_SIGN', 'RACE_BUSH'] as const;
type DecalTile = (typeof DECAL_TILES)[number];
const COLLISION_GID = 7021;

const src = JSON.parse(fs.readFileSync(SRC, 'utf8')) as Record<string, unknown>;
/**
 * Where the track tileset starts: after the LAST set uponu carries, which is found rather than
 * written down. A hardcoded number here would be wrong the first time anybody appends art.
 */
const srcSets = (src.tilesets as Array<{ firstgid: number; source: string }>).slice();
const last = srcSets.reduce((a, b) => (b.firstgid > a.firstgid ? b : a));
const lastCount = (JSON.parse(
  fs.readFileSync(path.join(REPO, 'assets', 'tiled', path.basename(last.source)), 'utf8'),
) as { tilecount: number }).tilecount;
const TRACK_FIRSTGID = last.firstgid + lastCount;
/**
 * A furniture piece's gid, resolved from its NAME through the tilesets this map carries.
 *
 * Never written down as a number, and the reason is the append-only rule: a gid is a position in a
 * table that grows, so a hardcoded 7401 is a leaderboard today and somebody else's flag the first
 * time a set gains a tile. This asks the same question the importer asks — which tile declares
 * `id = LEADERBOARD` — and answers it from the files on disk.
 */
const furnGid = (id: string): number => {
  for (const set of srcSets) {
    const file = path.join(REPO, 'assets', 'tiled', path.basename(set.source));
    if (!fs.existsSync(file)) continue;
    const sheet = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      tiles?: Array<{ id: number; properties?: Array<{ name: string; value: unknown }> }>;
    };
    for (const tile of sheet.tiles ?? []) {
      if ((tile.properties ?? []).some((prop) => prop.name === 'id' && prop.value === id)) {
        return set.firstgid + tile.id;
      }
    }
  }
  throw new Error(`no tileset offers a piece called ${id} — has it been renamed?`);
};
/** Everything the paddock is built from. Named here so the block that places them reads as a
 *  list of things rather than a list of numbers. */
const FURN = {
  LEADERBOARD: furnGid('LEADERBOARD'),
  DRINKING_FOUNTAIN: furnGid('DRINKING_FOUNTAIN'),
  BEAM_PAD: furnGid('BEAM_PAD'),
  FLAG_1: furnGid('FLAG_1'),
  CAR_RACE_29: furnGid('CAR_RACE_29'),
  FOUNTAIN_1: furnGid('FOUNTAIN_1'),
  TREE: furnGid('TREE'),
  PINE_TREE: furnGid('PINE_TREE'),
  LARGE_PLANT: furnGid('LARGE_PLANT'),
};
/**
 * A cell of a GRID tileset by name and position — the other half of `furnGid`, for sheets that are
 * a grid of pictures rather than a collection of files.
 *
 * Same rule and same reason: the first gid is looked up from the map's own tileset table and the
 * column count from the file on disk, because both are positions in tables that grow.
 */
const sheetGid = (file: string, col: number, row: number): number => {
  const set = srcSets.find((x) => x.source.endsWith(file));
  if (!set) throw new Error(`this map carries no tileset called ${file}`);
  const sheet = JSON.parse(
    fs.readFileSync(path.join(REPO, 'assets', 'tiled', file), 'utf8'),
  ) as { columns: number };
  return set.firstgid + row * sheet.columns + col;
};
/**
 * WATER under the bridge.
 *
 * "Die Brücke im raceway sollte über Wasser gehen, findest du nicht?" — yes, and it costs nothing
 * that matters: the cells stay VOID, so only ground makes a cell drivable and the drop is exactly
 * as real as it was. What changes is that a decal is drawn whether or not there is ground beneath
 * it, so the hole can have something at the bottom of it. A black gap reads as missing map; water
 * reads as a reason for a bridge.
 *
 * Four cells from the overworld pack rather than one, for the same reason the grass has four.
 */
const WATER: ReadonlyArray<readonly [number, number]> = [[16, 0], [19, 1], [21, 2], [17, 3]];
const waterAt = (col: number, row: number): number => {
  const [c, r] = WATER[variant(col + 313, row + 977, WATER.length)];
  return sheetGid('decal-overworld.tsj', c, r);
};
/** The images tileset's own first gid — a picture is a tile object like any other. */
const IMAGE_FIRSTGID = (srcSets.find((set) => set.source.endsWith('images.tsj')) ?? { firstgid: 0 }).firstgid;
const gidOf = (name: TrackTile): number => TRACK_FIRSTGID + TRACK_TILES.indexOf(name);
const SCENERY_FIRSTGID = TRACK_FIRSTGID + TRACK_TILES.length;
const sceneryGid = (name: SceneryTile): number => SCENERY_FIRSTGID + SCENERY_TILES.indexOf(name);
const DECAL_FIRSTGID = SCENERY_FIRSTGID + SCENERY_TILES.length;
const decalGid = (name: DecalTile): number => DECAL_FIRSTGID + DECAL_TILES.indexOf(name);
/** A stable scatter, so a field of grass is not one tile repeated and `--check` still means
 *  something: the cell's own coordinates pick the variant. */
const variant = (col: number, row: number, of: number): number =>
  Math.abs(Math.imul(col * 73856093 ^ row * 19349663, 2654435761)) % of;
const grassAt = (col: number, row: number): number =>
  sceneryGid(SCENERY_TILES[variant(col, row, 4)] as SceneryTile);
const sandAt = (col: number, row: number): number =>
  sceneryGid(SCENERY_TILES[4 + variant(col, row, 4)] as SceneryTile);

/** Alternating pairs, along whichever axis the stripe runs — a real kerb, red and white. */
const kerbAt = (col: number, row: number): number =>
  Math.floor((col + row) / 2) % 2 === 0 ? gidOf('kerbRed') : gidOf('kerbPale');
/** FOUR asphalt cells in a coarse patchwork, so a long straight is not one flat grey field — and
 *  they are the pack's, not ours: see the asphalt entry in `make-scenery.mts` for why that is the
 *  single biggest difference between a road and a grey rectangle. */
const roadAt = (col: number, row: number): number =>
  sceneryGid((['asphaltA', 'asphaltB', 'asphaltC', 'asphaltD'] as const)[variant(col + 41, row + 17, 4)]);


interface Pt {
  x: number;
  y: number;
}

/**
 * MONZA, and any other of Dust Racing's sixteen tracks: their layout, our everything else.
 *
 * Asked for directly — "importier monza" — and it is the honest answer to "orient yourself on
 * available race maps", because these ARE race maps: `data/levels/*.trk` is a grid of road pieces
 * with an orientation each, and sixteen circuits including Monza, Suzuka and a figure of eight.
 * What comes across is only the SHAPE. The road's width, its kerbs, the sand, the barrier, the
 * gates, the grid, the landscape and the paddock are all still derived here, so an imported track
 * is the same kind of thing as a hand-drawn one and not a second code path.
 *
 * Their pieces are 45° and 90° segments on a grid, which is why this is worth importing at all: a
 * lap has the character somebody designed into it, including corners tighter than anything a
 * spline through ten hand-placed points would produce.
 *
 * Three steps, and the middle one is the only interesting one:
 *
 *  1. Read the road cells — the piece types that are road rather than sand or grass.
 *  2. WALK them into a loop, starting at the finish tile and preferring the straightest
 *     continuation at every step. The connectivity is not taken from the art (their 45° pieces are
 *     drawn 2×2 tiles and overlap their neighbours, so the tile's own edges say nothing) and not
 *     from a table of piece semantics either. A ribbon one or two cells wide has exactly one
 *     straightest way on, and the walk closes on the finish: 75 of Monza's 109 road cells, the
 *     rest being the second cell of each diagonal pair.
 *  3. Smooth the staircase out of the diagonals, scale to our grid, and hand the result over as
 *     control points like any other track's.
 */
interface DustTrack {
  cols: number;
  rows: number;
  line: Pt[];
}
function fromDust(file: string, opts: { scale: number; pad: number; smooth: number; every: number }): DustTrack {
  const ROAD = new Set(['straight', 'corner45Left', 'corner45Right', 'corner90', 'straight45Female', 'straight45Male', 'finish', 'grid']);
  const text = fs.readFileSync(path.join(REPO, 'assets', 'third-party', 'dust-racing', file), 'utf8');
  const cells = new Map<string, { i: number; j: number; t: string }>();
  for (const m of text.matchAll(/<t\s+([^/>]*)\/>/g)) {
    const a = Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map((x) => [x[1], x[2]]));
    cells.set(`${a.i},${a.j}`, { i: Number(a.i), j: Number(a.j), t: a.t });
  }
  const road = [...cells.values()].filter((c) => ROAD.has(c.t));
  const isRoad = (i: number, j: number): boolean => ROAD.has(cells.get(`${i},${j}`)?.t ?? '');
  const finish = road.find((c) => c.t === 'finish');
  if (!finish) throw new Error(`${file} has no finish tile, so there is nowhere to start the lap`);
  const N8 = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]] as const;
  let best: Array<{ i: number; j: number }> = [];
  for (const seed of N8) {
    if (!isRoad(finish.i + seed[0], finish.j + seed[1])) continue;
    const seen = new Set([`${finish.i},${finish.j}`]);
    const walk: Array<{ i: number; j: number }> = [finish];
    let cur = { i: finish.i + seed[0], j: finish.j + seed[1] };
    let dir: readonly [number, number] = seed;
    for (;;) {
      seen.add(`${cur.i},${cur.j}`);
      walk.push(cur);
      const here = cur;
      const at = dir;
      // Straightest first. Turns beyond about a right angle are refused, or the walk cuts across
      // the ribbon at a hairpin and comes back on itself.
      const cands = N8.map((d) => ({ d, dot: (d[0] * at[0] + d[1] * at[1]) / (Math.hypot(...d) * Math.hypot(...at)) }))
        .sort((a, b) => b.dot - a.dot)
        .filter((c) => c.dot > -0.2)
        .map((c) => ({ ...c, i: here.i + c.d[0], j: here.j + c.d[1] }))
        .filter((c) => isRoad(c.i, c.j));
      if (walk.length > 20 && cands.some((c) => c.i === finish.i && c.j === finish.j)) break;
      const next = cands.find((c) => !seen.has(`${c.i},${c.j}`));
      if (!next) break;
      dir = next.d;
      cur = { i: next.i, j: next.j };
    }
    if (walk.length > best.length) best = walk;
  }
  const minI = Math.min(...road.map((c) => c.i));
  const minJ = Math.min(...road.map((c) => c.j));
  let pts = best.map((c) => ({ x: (c.i - minI) * opts.scale + opts.pad, y: (c.j - minJ) * opts.scale + opts.pad }));
  // A diagonal run is a staircase of cells, so its centres zigzag by half a cell. Averaging each
  // point with its neighbours takes that out without moving the shape: measured over Monza, the
  // tightest corner goes from 3.6 to 4.3 tiles of radius and the lap from 385 to 371.
  for (let k = 0; k < opts.smooth; k++) {
    const from = pts;
    pts = from.map((p, i) => {
      const a = from[(i - 1 + from.length) % from.length];
      const b = from[(i + 1) % from.length];
      return { x: (a.x + 2 * p.x + b.x) / 4, y: (a.y + 2 * p.y + b.y) / 4 };
    });
  }
  const line = pts.filter((_, i) => i % opts.every === 0);
  const cols = Math.ceil(Math.max(...line.map((p) => p.x)) + opts.pad);
  const rows = Math.ceil(Math.max(...line.map((p) => p.y)) + opts.pad);

  /**
   * Four refusals, because the walk is a HEURISTIC and a bad answer must not become a map.
   *
   * It is greedy — straightest continuation, close when the finish comes back round — and on some
   * of their sixteen layouts that is simply not enough: a crossing sends it down the wrong branch,
   * a wide paddock lets it cut a corner, a lobe that doubles back gets missed. Surveyed over all
   * of them, four pass and twelve do not, and each of the four checks below is what catches a
   * specific kind of wrong answer:
   *
   *  - **COVERAGE.** Suzuka's walk reaches 38 % of its road cells and closes a tidy little loop
   *    that is not Suzuka. Shipping that under the name would be the worst outcome here — a map
   *    that claims to be a famous circuit and is not. Monza's 69 % is the honest floor: what it
   *    misses is the second cell of each diagonal pair, which is the ribbon's other side and not a
   *    piece of the lap.
   *  - **CLEARANCE.** Two parts of the lap closer than twice the road's half-width plus its verge
   *    and barrier means the road runs into itself, and the distance field cannot express that.
   *  - **RADIUS.** Below about three and a half tiles the corner is tighter than a kart can take
   *    even using the full width of the road.
   *  - **WINDING.** A clean lap turns once. Desert Storm's walk turns 4.7 times — it is zigzagging
   *    across the ribbon, which the radius and clearance checks both miss because a small wobble
   *    has a large radius and hits nothing.
   *
   * Four of their sixteen pass all four, and ONE of those four is kept: Monza. Figure 8, Ring and
   * Western Valley were all imported and raced, and were dropped on 2026-09-16 because two
   * circuits are enough to have — "lass mal nur raceway und monza drin". Their `.trk` files went
   * with them, so bringing one back means fetching it again (see the third-party README for
   * where from).
   *
   * What they paid for is worth keeping, because the diagnosis was wrong in an instructive way and
   * the fix outlives the maps. Ring and Western Valley had been dropped once before with "the
   * driver cannot brake for a tight corner at the end of a long straight" written against them.
   * Re-measured: **Western Valley raced cleanly with no change at all** (55.6 / 43.7 / 37.5 s
   * across the skill range, never off the road) — it had simply been tarred with the Ring's
   * problem. And the Ring's problem was not braking: this car stops from flat out in 4.8 tiles, so
   * every braking-distance rule tried against it measured as an exact no-op, which is precisely
   * what "it can always stop in time" looks like from inside such a rule. What it could not do was
   * HOLD a bend it had entered too fast. The fix is a speed cap taken from the road's own
   * curvature (`CORNER_PACE` in racerDriver.ts), and with it the Ring went from 55.3 s to 39.4.
   */
  const closed = Math.hypot(line[0].x - line[line.length - 1].x, line[0].y - line[line.length - 1].y) < opts.scale * 3;
  const coverage = best.length / road.length;
  let minR = Infinity;
  let turn = 0;
  const n = line.length;
  for (let i = 0; i < n; i++) {
    const a = line[(i - 1 + n) % n];
    const b = line[i];
    const c = line[(i + 1) % n];
    const area = Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2;
    if (area > 1e-9) {
      minR = Math.min(minR, (Math.hypot(b.x - a.x, b.y - a.y) * Math.hypot(c.x - b.x, c.y - b.y) * Math.hypot(c.x - a.x, c.y - a.y)) / (4 * area));
    }
    let da = Math.atan2(c.y - b.y, c.x - b.x) - Math.atan2(b.y - a.y, b.x - a.x);
    while (da > Math.PI) da -= Math.PI * 2;
    while (da < -Math.PI) da += Math.PI * 2;
    turn += Math.abs(da);
  }
  const winding = turn / (Math.PI * 2);
  const refuse = (why: string): never => {
    throw new Error(
      `${file} cannot be imported: ${why}. ` +
        `(covered ${(coverage * 100).toFixed(0)}% of its road, closed=${closed}, ` +
        `${cols}x${rows}, tightest corner ${minR.toFixed(1)} tiles, winding ${winding.toFixed(2)})`,
    );
  };
  if (!closed) refuse('the walk never came back to the finish');
  if (coverage < 0.6) refuse('the walk missed most of the road, so this would not be that track');
  if (cols > MAX_COLS || rows > MAX_ROWS) refuse(`it does not fit in ${MAX_COLS}x${MAX_ROWS}`);
  if (minR < 3.5) refuse('it has a corner no kart could take');
  if (winding > 2.5) refuse('the line zigzags rather than laps');
  return { cols, rows, line };
}

/** What makes one circuit different from another. Everything else is the same generator. */
interface TrackSpec {
  /** The zone id and the file name. */
  id: string;
  label: string;
  cols: number;
  rows: number;
  /**
   * How wide the road is, in tiles.
   *
   * Read against the VEHICLE, never on its own. A kart is two tiles wide across its tyres, so
   * seven tiles is three and a half kart widths — two abreast with room to move, and the same
   * road-per-vehicle the five-tile original had when a kart was smaller still.
   *
   * The number moved three times in a day and the ratio never did, which is the lesson: it went
   * 5 → 9 when the karts became four-tile cars, 9 → 11 and 13 when those needed room, and back
   * to 7 when the cars became karts again. A road is wide enough when two vehicles fit side by
   * side and narrow enough that a corner has to be braked for, and `raceway.int.test.ts` holds
   * the second half — at eight tiles a kart could be driven flat out from flag to flag, which is
   * the complaint this circuit was rebuilt for in the first place.
   */
  width: number;
  laps: number;
  /**
   * The circuit's centreline, as control points for a closed spline.
   *
   * Hand-placed rather than generated, because the SHAPE of a lap is the design: where the long
   * straight is, which corner is the quick one, which is the one you have to brake for. What the
   * generator derives from it is everything else — the road, the kerbs, the sand, the barrier, the
   * gates, the grid and the landscape.
   *
   * Two constraints, both checked and reported by the script rather than left to the eye: the
   * curve must stay `HALF + sand + barrier + 1` tiles inside the map, and no two parts of it may
   * come closer than twice that, or the road runs into itself.
   */
  line?: readonly Pt[];
  /** Where the start-finish line sits, as a fraction of the lap. */
  startAt?: number;
  /** A stretch of the lap with no barrier and a drop either side, as fractions of the lap. */
  bridge: { from: number; to: number } | null;
}

const TRACKS: readonly TrackSpec[] = [
  {
    id: 'raceway',
    label: 'Raceway',
    cols: 116,
    rows: 74,
    width: 7,
    // Three, and the number follows the lap rather than taste: a lap of this circuit is about
    // twenty seconds, so three is a minute of racing — long enough to have a shape, short enough
    // that a grid of twelve gets round it before anybody puts the kettle on. The panel can still
    // set anything.
    laps: 3,
    /**
     * A lap with a shape: a long start-finish straight along the bottom, a fast sweep up the
     * right, a tighter pair at the top and a long left-hander home. Ten points, unevenly spaced on
     * purpose — evenly spaced ones give a lap of four identical bends, which is the rectangle
     * again with the corners filed off.
     *
     * Measured by the script: 246 tiles of centreline, tightest corner 5.6 tiles of radius, which
     * at 320 px/s asks 1139 px/s² of 1212 — right on the limit, so it is a corner a quick driver
     * takes flat and a clumsy one does not.
     */
    line: [
      { x: 14, y: 58 },
      { x: 45, y: 64 },
      { x: 80, y: 63 },
      { x: 102, y: 52 },
      { x: 104, y: 34 },
      { x: 86, y: 22 },
      { x: 60, y: 12 },
      { x: 30, y: 14 },
      { x: 12, y: 28 },
      { x: 10, y: 46 },
    ],
    /**
     * On the STRAIGHT between the two corner sequences, half a lap from the grid.
     *
     * A straight, because a bridge on a bend is a wedge rather than a span: the cells whose
     * nearest stretch of road is the bend are the ones on the INSIDE of it, so the gap they make
     * is a gash cut into the infield. Half a lap away, because a hazard on the run to the first
     * corner punishes the start rather than the driving. The script prints the lap's curvature
     * per 2 %, which is how this stretch was picked rather than guessed.
     */
    bridge: { from: 0.47, to: 0.55 },
    /** Where the start-finish line goes, as a fraction of the lap — chosen so the thirty tiles
     *  BEHIND it are the long bottom straight, which is what a grid of six rows needs. */
    startAt: 0.22,
  },
  {
    /**
     * MONZA — Dust Racing's own layout, driven at our scale.
     *
     * Five of our cells per one of their tiles is the largest that fits: their grid is 35×19 with
     * the road spanning 31×16 of it, so six would put the map past `MAX_COLS`. What that gives is
     * a lap of 371 tiles against the raceway's 246 — two and a half times the raceway's ROAD on a
     * map only half again as big, because a designed circuit folds back on itself where a spline
     * through ten points cannot.
     *
     * Its tightest corner is 4.3 tiles of centreline radius, which is tighter than a kart's own
     * turning circle of 82 px — so it can only be taken by using the width of the road, which is
     * what a chicane IS. Three laps, because a lap here is about half a minute.
     */
    id: 'monza',
    label: 'Monza',
    ...fromDust('monza.trk', { scale: 5, pad: 9, smooth: 6, every: 2 }),
    width: 7,
    laps: 3,
    // Run 0 of the walk is the finish tile itself, and the walk sets off down the start-finish
    // straight — so the grid, which is laid out BACKWARDS from the line, lands on the straight
    // that leads up to it. That is not luck: the line is where a lap starts in their file too.
    startAt: 0,
    bridge: null,
  },
];

function buildTrack(spec: TrackSpec): { bytes: string; painted: number; scenery: number; markers: number; furniture: number } {
/**
 * The ring: a road FIVE tiles wide, and that number is the whole difficulty of the track.
 *
 * The first version was a nine-tile road round a small infield, and it could be driven flat out
 * from flag to flag — reported in those words. A corner is only a corner if the line it needs is
 * tighter than the road is wide: at 240 px/s a kart traces about five tiles of radius even when
 * the tyres hold, so five tiles of road means the outside of a corner has to be given up for the
 * inside, and carrying full throttle in runs out of tarmac. The handling model was never the
 * problem; there was nowhere on the map to feel it.
 *
 * **That is no longer true of these three, and this is where the fact belongs.** The roads were
 * widened to seven, nine and five for a car the size of a car, and at 320 px/s with the grip that
 * goes with it a driver that steers well holds full throttle all the way round: measured over
 * 45 s, pinned against the driver's own choice, 9 gates against 9 on the raceway and 12 against 12
 * on the speedway, with 0.0 s of sliding either way. Tyre wear used to be what that cost you and
 * it is gone (measured to do nothing — see PROTOCOL_VERSION 25), so what is left as the price of
 * overdriving is falling off the bridge and being shoved. **If flat-out should cost something
 * again, the lever is a corner tighter than the road is wide — this paragraph's own first rule —
 * and not another number in the tyre model.**
 */
const COLS = spec.cols;
const ROWS = spec.rows;
/**
 * THE CENTRELINE — the one thing every other answer in this file is measured from.
 *
 * A lap used to be stated as two rectangles, and the price was written on the map: four corners
 * of exactly 90°, which is not a corner any road has ever had. It is a closed CURVE now — a
 * Catmull-Rom spline through the control points in the spec — and every cell is classified by how
 * far it is from that curve. Road, kerb, sand, barrier and grass are the same five bands measured
 * from the same number.
 *
 * What that buys beyond the look: corners of DIFFERENT radii, because the control points are not
 * evenly spaced, so a lap has a shape instead of four identical bends. `scripts/make-tracks.sh`
 * prints the tightest one, and it is the number that decides whether a circuit asks anything of a
 * driver: at 320 px/s a corner of radius r demands `v²/r` against 1212 px/s² of grip, so 5.6 tiles
 * is on the limit and anything tighter has to be braked for.
 */
const HALF = spec.width / 2;
/** How wide the sand verge is either side of the road. A circuit is a road with a wall round it,
 *  so it can afford two. */
const SAND = 2;

/**
 * The centreline, as a closed Catmull-Rom spline through the spec's control points.
 *
 * This generator built two SHAPES until 2026-09-17 — a circuit and a point-to-point stage, the
 * second a set of straight runs joined by hairpins, with `CLOSED` branching the geometry, the
 * barrier derivation, the gates and the grid. Nothing has asked for a stage since speedway and
 * hillroad were deleted, so the branch went: about 112 lines of it, and nine forks through code
 * every circuit also walks.
 *
 * The ENGINE still races a stage — a map with a `raceFinish` runs its gates once and the line ends
 * it — so the shape is still a thing this world can have; it is drawn in Tiled now rather than
 * derived from a spline (see the README's race section). Bringing the derivation back means this
 * file's history, not a rewrite from nothing.
 */
const linePts: Array<{ x: number; y: number }> = [];
{
  // One segment per pair of control points, sampled densely enough that the distance field never
  // sees a gap: the field is built by walking the LINE and touching the cells near each sample.
  const cp = spec.line ?? [];
  const seg = (p0: Pt, p1: Pt, p2: Pt, p3: Pt, t: number): Pt => {
    const t2 = t * t;
    const t3 = t2 * t;
    return {
      x: 0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
      y: 0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
    };
  };
  const PER = 48;
  for (let i = 0; i < cp.length; i++) {
    const n = cp.length;
    for (let s = 0; s < PER; s++) {
      linePts.push(seg(cp[(i - 1 + n) % n], cp[i], cp[(i + 1) % n], cp[(i + 2) % n], s / PER));
    }
  }
}
/** Distance along the line to each sample, so a gate can be placed at "so many tiles in" rather
 *  than at a fraction of an index — the samples are denser through the tighter corners. */
const lineRun: number[] = [0];
for (let i = 1; i < linePts.length; i++) {
  lineRun.push(lineRun[i - 1] + Math.hypot(linePts[i].x - linePts[i - 1].x, linePts[i].y - linePts[i - 1].y));
}
{
  // The closing leg, back from the last sample to the first: a lap is the whole way round.
  const a = linePts[linePts.length - 1];
  const b = linePts[0];
  lineRun.push(lineRun[lineRun.length - 1] + Math.hypot(b.x - a.x, b.y - a.y));
}
const LINE_LENGTH = lineRun[lineRun.length - 1];
/** The point this far along the road, and which way it points there. A closed line WRAPS, so a
 *  gate at 95 % of the lap is a gate, not the end of the world. */
const lineAt = (run: number): { x: number; y: number; dir: number } => {
  const n = linePts.length;
  const want = ((run % LINE_LENGTH) + LINE_LENGTH) % LINE_LENGTH;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (lineRun[mid] < want) lo = mid + 1;
    else hi = mid;
  }
  const at = (i: number): Pt => linePts[((i % n) + n) % n];
  const p = at(lo);
  const a = at(lo - 3);
  const b = at(lo + 3);
  return { x: p.x, y: p.y, dir: Math.atan2(b.y - a.y, b.x - a.x) };
};
/** Distance from every cell centre to the centreline, in tiles, and HOW FAR ALONG the road the
 *  nearest point of it was. Built by walking the LINE and touching the cells near it, not by asking
 *  every cell about every sample. */
const lineDist = new Float64Array(COLS * ROWS).fill(Infinity);
const lineNear = new Float64Array(COLS * ROWS).fill(-1);
{
  const reach = Math.ceil(HALF + SAND + 5);
  const touch = (fn: (cell: number, d: number, run: number) => void): void => {
    for (let i = 0; i < linePts.length; i++) {
      const p = linePts[i];
      for (let r = Math.max(0, Math.floor(p.y) - reach); r <= Math.min(ROWS - 1, Math.ceil(p.y) + reach); r++) {
        for (let c = Math.max(0, Math.floor(p.x) - reach); c <= Math.min(COLS - 1, Math.ceil(p.x) + reach); c++) {
          fn(r * COLS + c, Math.hypot(p.x - c, p.y - r), lineRun[i]);
        }
      }
    }
  };
  touch((cell, d, run) => {
    if (d < lineDist[cell]) {
      lineDist[cell] = d;
      lineNear[cell] = run;
    }
  });
}
/**
 * How tight the road is at each sample, as a radius in tiles — and therefore where the KERBS go.
 *
 * A real circuit does not have red and white kerbing down both sides of its straights; it has it
 * where cars run wide, which is the corners. Painted everywhere it turns the whole map into a
 * candy stripe, which is what the first drawing of the curved track looked like. The curve knows
 * the answer, so nothing has to be authored: the circumradius of three samples either side of a
 * point IS how tight the road is there.
 */
const lineRadius = new Float64Array(linePts.length);
for (let i = 0; i < linePts.length; i++) {
  const n = linePts.length;
  const at = (k: number): Pt => linePts[((k % n) + n) % n];
  const a = at(i - 6);
  const b = at(i);
  const c = at(i + 6);
  const A = Math.hypot(b.x - a.x, b.y - a.y);
  const B = Math.hypot(c.x - b.x, c.y - b.y);
  const C = Math.hypot(c.x - a.x, c.y - a.y);
  const area = Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2;
  lineRadius[i] = area < 1e-9 ? Infinity : (A * B * C) / (4 * area);
}
/** Below this radius, in tiles, a stretch counts as a corner and gets kerbs. 22 is about where a
 *  driver starts using the width of the road, measured against the lap's own profile: the raceway
 *  reads as four corner sequences and three straights at this threshold. */
const KERB_RADIUS_TILES = 22;
/**
 * BOOST PADS: three per lap, on the fastest stretches, across the middle of the road.
 *
 * On the STRAIGHTS and not in the corners, which is both the fun and the honest reading of the
 * physics: the pad raises the speed ceiling while you are on it and the drag takes the excess back
 * over the next second, so one before a corner is a gift you cannot use and one onto a straight is
 * a place to aim for. Found by walking the lap for its straightest stretches rather than placed,
 * so they follow the shape of whatever circuit this is.
 *
 * Two cells wide of the road's middle, leaving a lane either side: a pad you cannot avoid is not a
 * choice, and a choice is what makes somebody steer.
 */
const BOOST_PADS = 3;
const BOOST_LENGTH_TILES = 4;
/**
 * How many ROWS of item boxes a lap gets, and how far apart the boxes in a row sit.
 *
 * A row across the road rather than a single box, because what makes picking one up interesting is
 * choosing a LANE for it — a lone box on the racing line is something the road does to you, and a
 * row nobody can miss is the same thing with extra steps. Two rows a lap, so an item is a regular
 * part of a lap without the field driving round permanently armed.
 */
const ITEM_ROWS = 2;
const ITEM_BOX_SPACING_TILES = 2.5;
/** How much road there is between checkpoints, in tiles. Twenty is about six seconds at racing
 *  speed — near enough that "how far to the next gate" still means something on a bend. */
const GATE_EVERY_TILES = 20;
const radiusAtRun = (run: number): number => {
  if (run < 0) return Infinity;
  let lo = 0;
  let hi = linePts.length - 1;
  const want = ((run % LINE_LENGTH) + LINE_LENGTH) % LINE_LENGTH;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (lineRun[mid] < want) lo = mid + 1;
    else hi = mid;
  }
  return lineRadius[Math.min(lo, lineRadius.length - 1)];
};
const distAt = (col: number, row: number): number =>
  col < 0 || row < 0 || col >= COLS || row >= ROWS ? Infinity : lineDist[row * COLS + col];
const nearAt = (col: number, row: number): number =>
  col < 0 || row < 0 || col >= COLS || row >= ROWS ? -1 : lineNear[row * COLS + col];

/**
 * The bridge: a stretch of the lap with nothing beside it at all.
 *
 * Asked for at the very start — "Brücken über Abgründen, da könnte man dann jemanden von der
 * Brücke bumpen" — and it needs no new concept, which is the point: only GROUND makes a cell
 * drivable, so a bridge is road with the sand, the barrier and the ground either side taken away.
 * Narrower than the rest of the lap, so a shove has somewhere to send you, and stated as a RANGE
 * OF THE LAP rather than a range of columns: the road is a curve now, and a column says nothing
 * about where you are on it.
 *
 * It is not a shortcut and cannot become one: the gates are a ring walked in order, so leaving the
 * road never advances a lap.
 */
const BRIDGE = spec.bridge;
/** How much narrower the road is over the span, and how long it takes to get that way. */
const BRIDGE_NARROW = 1.5;
const BRIDGE_TAPER = 6;
/**
 * How much the road has narrowed at this point of the lap: nothing, all of it, or part way.
 *
 * The TAPER is not decoration. Without it the width steps from 3.5 tiles to 2 between one run and
 * the next, and because a cell belongs to its own nearest stretch, the cells at that step do not
 * agree about which side of it they are on — measured on the diagonal span, that left a void cell
 * in the middle of the racing line with road all round it, which is a hole a car falls into at
 * speed. Ramped over six tiles, the edge of the road is a line rather than a staircase, and the
 * chasm opens as the road narrows instead of appearing beside a full-width road.
 */
const bridgeNarrowAt = (run: number): number => {
  if (BRIDGE === null || run < 0) return 0;
  const a = BRIDGE.from * LINE_LENGTH;
  const b = BRIDGE.to * LINE_LENGTH;
  if (run < a - BRIDGE_TAPER || run > b + BRIDGE_TAPER) return 0;
  const t = run < a ? (run - (a - BRIDGE_TAPER)) / BRIDGE_TAPER : run > b ? (b + BRIDGE_TAPER - run) / BRIDGE_TAPER : 1;
  return BRIDGE_NARROW * Math.max(0, Math.min(1, t));
};
/** How much road there is at this cell: less over the bridge. */
const roadHalfAt = (col: number, row: number): number => HALF - bridgeNarrowAt(nearAt(col, row));
/** The air either side of the bridge: off the road, and out as far as the grass would have
 *  started — the bridge is a gap in the circuit, not a hole in the map. It opens and closes with
 *  the taper, so the chasm has ends rather than walls. */
const inBridgeAir = (col: number, row: number): boolean => {
  const narrow = bridgeNarrowAt(nearAt(col, row));
  if (narrow <= 0) return false;
  const half = HALF - narrow;
  const reach = half + (HALF + SAND + 1 - half) * (narrow / BRIDGE_NARROW);
  const d = distAt(col, row);
  return d > half && d <= reach;
};

const onRoad = (col: number, row: number): boolean =>
  col >= 0 && row >= 0 && col < COLS && row < ROWS && distAt(col, row) <= roadHalfAt(col, row);
/**
 * The five bands, measured from the line: road, sand, barrier, and then whatever is left.
 *
 * BOTH sides of a circuit get a barrier. The infield used to be left open as a drop, and that was
 * wrong twice over: it made half the map black (1571 void cells of 3344 on the old raceway — the
 * thing that was reported as "everything except the track is black"), and a hole you can only fall
 * into at its rim is a wall that ends your race instead of one you bounce off. The drop that was
 * actually asked for is the BRIDGE, and the bridge still has none.
 */
const onRunOff = (col: number, row: number): boolean => {
  if (onRoad(col, row) || inBridgeAir(col, row)) return false;
  const d = distAt(col, row);
  return d > HALF && d <= HALF + SAND;
};
const onBarrier = (col: number, row: number): boolean => {
  if (inBridgeAir(col, row)) return false;
  const d = distAt(col, row);
  return d > HALF + SAND && d <= HALF + SAND + 1;
};
const onOutfield = (col: number, row: number): boolean => {
  // OFF THE MAP IS NOT OUTFIELD. The edge case used to answer "is it a barrier?" for cells that
  // are not cells at all, and a barrier they are not — so `roomFor` happily found six clear cells
  // past the bottom edge and put three grandstands where there is no map. They were in the file
  // and nowhere on the screen.
  if (col < 0 || row < 0 || col >= COLS || row >= ROWS) return false;
  if (onRoad(col, row) || onBarrier(col, row) || onRunOff(col, row) || inBridgeAir(col, row)) return false;
  return true;
};
/**
 * The four bands. Everything below this line paints, plants and emits from these questions and
 * nothing else — which is why taking the second shape out (see the centreline's note) touched
 * nothing below here at all.
 */
const isRoad = onRoad;
const isBarrier = onBarrier;
const isRunOff = onRunOff;
const isOutfield = onOutfield;
/** Six rows of two behind the line. Twelve is the field Dust Racing runs. */
const GRID_ROWS = 6;

/** Gates, grid, arrival marker and chequered paint — all of it read off the centreline. */
const gateCells: Array<Array<{ col: number; row: number }>> = [];
const chequered = new Set<string>();
/** Boost cells, and which way the road runs at each — the chevrons have to point somewhere. */
const boostCells = new Map<string, { col: number; row: number; dir: number }>();
const itemCells = new Set<string>();
const grid: Array<{ col: number; row: number; slot: number; dir?: number }> = [];
const spawns: Array<{ col: number; row: number }> = [];
/**
 * The cells a gate covers: the perpendicular across the road at one point of the curve.
 *
 * There is one way to draw one, because a gate is a LINE ACROSS THE ROAD and the road is a curve.
 * The four used to be hand-placed spans of a rectangle's edges, which is why they could only ever
 * be horizontal or vertical.
 */
const gateCellsAt = (run: number): Array<{ col: number; row: number }> => {
  const p = lineAt(run);
  const nx = -Math.sin(p.dir);
  const ny = Math.cos(p.dir);
  const cells = new Map<string, { col: number; row: number }>();
  const add = (col: number, row: number): void => {
    // The whole DRIVABLE corridor, verge included — not just the racing surface.
    //
    // This is the difference between a checkpoint and a trap. A gate that stops at the edge of the
    // tarmac is a gate you miss by running wide, and missing one is not a small thing: the leg you
    // are on then points at a gate BEHIND you, so every metre of correct driving reads as going
    // backwards and the warning stays up until you turn round and fetch it. Reported as "wenn man
    // nicht genau die Strecke erwischt, steht da oft wrong way", and measured: not one of the 575
    // gate cells across the three circuits was on the verge, while 190 drivable verge cells sat
    // directly beside a gate without being part of it.
    //
    // Cutting is still impossible — that is what the ORDER of the ring is for, and the infield is
    // behind a barrier either way. What this allows is running wide, which is a mistake the road
    // already punishes with sand.
    if (onRoad(col, row) || onRunOff(col, row)) cells.set(`${col},${row}`, { col, row });
  };
  /**
   * ONE cell thick, and 4-connected — the two properties a checkpoint needs and no more.
   *
   * A line across the road rounds to a STAIRCASE of cells, and a staircase touches only at its
   * corners, so a kart travelling diagonally can slip between two of them without ever standing on
   * one. The first fix for that sampled half a tile along the road as well as across it, which
   * closed the corners by making the whole band TWO cells thick — visible in Tiled as every gate
   * drawn twice, and reported as exactly that.
   *
   * Closing the corner where there IS one is the smaller answer: when a step moves diagonally, the
   * cell that shares the old row and the new column is added as well. On a straight that never
   * fires and a gate is one cell wide; on a diagonal it adds one cell per step, which is the least
   * that can make the band continuous.
   */
  let prev: { col: number; row: number } | null = null;
  const span = HALF + SAND + 1;
  for (let u = -span; u <= span; u += 0.25) {
    const col = Math.round(p.x + nx * u);
    const row = Math.round(p.y + ny * u);
    if (prev && prev.col !== col && prev.row !== row) add(col, prev.row);
    add(col, row);
    prev = { col, row };
  }
  return [...cells.values()];
};
/** Six rows of two behind the line, and the beacon on slot 0 pointing the way the road goes
 *  there. Five tiles between rows, because a kart is two and a half long: at three they
 *  overlapped the moment the art grew, and a starting grid where the cars intersect is not a
 *  grid. */
const layOutGrid = (startRun: number): void => {
  /**
   * Which way the field sets off, in whole degrees — stated ONCE, on pole.
   *
   * Only one slot carries it and the rest say nothing, which the importer reads as -1: "work it
   * out from the gates". That asymmetry is the point rather than an oversight — the beacon exists
   * because the direction of a lap used to live in the NUMBERING of the gates, which is invisible
   * in Tiled, and twelve copies of one fact is eleven chances for a map to contradict itself.
   *
   * Measured over the WHOLE grid — from its back row to the line — and not as the spline's tangent
   * at pole. Reported as "ich habe raceStart mit actionDir 358": the raceway's start straight is a
   * spline through hand-placed points, so the tangent at one cell of it came out two degrees off
   * east and the number looked like noise, because it was. A baseline nearly thirty tiles long is
   * the direction the field actually leaves in, and on a straight it is the straight.
   */
  const front = lineAt(startRun - 3);
  const back = lineAt(startRun - 3 - (GRID_ROWS - 1) * 5);
  // A COMPASS bearing: 0 is north. The centreline's own angle is measured from east like every
  // heading in the model, so +90 turns it into the thing the property says it is (see Action's
  // `raceStart`) — the number a mapper would type if they were placing the beacon themselves.
  const beacon =
    ((Math.round((Math.atan2(front.y - back.y, front.x - back.x) * 180) / Math.PI) + 90) % 360 + 360) % 360;
  let slot = 0;
  for (let i = 0; i < GRID_ROWS; i++) {
    const p = lineAt(startRun - 3 - i * 5);
    const nx = -Math.sin(p.dir);
    const ny = Math.cos(p.dir);
    for (const u of [-2, 2]) {
      grid.push({
        col: Math.round(p.x + nx * u),
        row: Math.round(p.y + ny * u),
        slot,
        ...(slot++ === 0 ? { dir: beacon } : {}),
      });
    }
    // Arrive IN the grid, down the lane between its two rows — not wherever the free-tile search
    // happens to land. On a lap this long that is the difference between getting in a kart and
    // walking half of it to find one.
    //
    // ONE of them, at the front of the grid. There were six — one per row — because a marker does
    // two jobs: the first becomes the zone's arrival tile, and the SET of them is the pool an
    // automatic placement draws from when that tile is taken. The second job was what kept a busy
    // arrival out of the middle of the circuit, since landscaping the infield made every cell of it
    // spawnable.
    //
    // It is not needed any more, and one marker is now strictly better than six: the search rings
    // outward from the arrival tile first (`SPAWN_SPREAD_TILES`, 168 cells of it), so a crowd
    // spreads into the grid lane instead of being scattered up to 25 tiles down it — and with one
    // declared marker the last-resort pool IS that tile, so the infield can never be drawn at all.
    // Asked for on 2026-09-16: "ein spawn punkt reicht dann, man kann zum auto laufen" — and the
    // kart will arrive with its driver soon enough, which leaves a marker even less to do.
    if (spawns.length === 0) spawns.push({ col: Math.round(p.x), row: Math.round(p.y) });
  }
};
/**
 * Gates evenly spaced round the lap, with gate 0 on the start line — one roughly every
 * `GATE_EVERY_TILES`, never fewer than four.
 *
 * Evenly spaced by RUN rather than placed at the ends of straights: a curve has no ends to name.
 * The COUNT used to be four full stop, which is a number from when a circuit was a rectangle and
 * four was one per side. On Monza that leaves legs ninety tiles long, and a leg that long is a
 * leg that bends — which the wrong-way warning read as a car losing ground, twice a lap, on a
 * clean lap. The rule was fixed to ask about both ends of the leg, and this is the other half:
 * a checkpoint every twenty tiles is about six seconds of driving, which is the granularity the
 * standings, the respawn and the warning all quietly assumed they had.
 */
const startRun = (spec.startAt ?? 0.07) * LINE_LENGTH;
const gates = Math.max(4, Math.round(LINE_LENGTH / GATE_EVERY_TILES));
for (let g = 0; g < gates; g++) gateCells.push(gateCellsAt(startRun + (LINE_LENGTH * g) / gates));
// Painted on the ROAD only, even though the gate is wider: a chequered band across the sand
// would make the verge look like somewhere to drive.
for (const c of gateCells[0]) if (onRoad(c.col, c.row)) chequered.add(`${c.col},${c.row}`);
layOutGrid(startRun);

/**
 * The straightest stretches of the lap, as far apart from each other as they can be — that is
 * where the pads go. Straightest, because the ceiling a pad raises is taken back by drag within
 * a second or so and a corner is where you cannot spend it; spread out, because three in a row
 * is one long pad.
 */
const spots: Array<{ run: number; radius: number }> = [];
for (let run = 0; run < LINE_LENGTH; run += 2) spots.push({ run, radius: radiusAtRun(run) });
spots.sort((a, b) => b.radius - a.radius);
const chosen: number[] = [];
for (const spot of spots) {
  if (chosen.length >= BOOST_PADS) break;
  // Clear of the START, and not on top of another pad. Clear of the start means clear of the
  // GRID as well, which stretches nearly thirty tiles back from the line — a pad under the grid
  // is a free launch for whoever drew that column, which is the opposite of a choice.
  const gap = (a: number, b: number): number => {
    const d = Math.abs(a - b) % LINE_LENGTH;
    return Math.min(d, LINE_LENGTH - d);
  };
  if (gap(spot.run, startRun) < GRID_ROWS * 5 + 12) continue;
  if (chosen.some((c) => gap(spot.run, c) < LINE_LENGTH / (BOOST_PADS + 1))) continue;
  chosen.push(spot.run);
}
for (const at of chosen) {
  for (let k = 0; k < BOOST_LENGTH_TILES; k++) {
    const p = lineAt(at + k);
    const nx = -Math.sin(p.dir);
    const ny = Math.cos(p.dir);
    // Two cells either side of the centreline: a lane is left free on both sides, so driving
    // over a pad is a decision rather than something the road does to you.
    for (let u = -1; u <= 1; u += 0.5) {
      const col = Math.round(p.x + nx * u);
      const row = Math.round(p.y + ny * u);
      if (onRoad(col, row)) boostCells.set(`${col},${row}`, { col, row, dir: p.dir });
    }
  }
}

/**
 * The item boxes: a row across the road, twice a lap.
 *
 * Placed by RUN at even spacing rather than at the straightest points, unlike the pads — a box
 * is something you aim for, so a corner is a perfectly good place for one and spreading them
 * evenly is what makes them part of the lap. Offset from the start so the first row is not under
 * the grid, and nudged off the pads' own runs so a row is never painted on top of a chevron.
 */
for (let r = 0; r < ITEM_ROWS; r++) {
  let at = startRun + (LINE_LENGTH * (r + 0.5)) / ITEM_ROWS;
  for (const pad of chosen) {
    const d = Math.abs(((at - pad) % LINE_LENGTH + LINE_LENGTH) % LINE_LENGTH);
    if (Math.min(d, LINE_LENGTH - d) < BOOST_LENGTH_TILES + 2) at += BOOST_LENGTH_TILES + 4;
  }
  const p = lineAt(at);
  const nx = -Math.sin(p.dir);
  const ny = Math.cos(p.dir);
  for (let u = -HALF + 1; u <= HALF - 1; u += ITEM_BOX_SPACING_TILES) {
    const col = Math.round(p.x + nx * u);
    const row = Math.round(p.y + ny * u);
    if (onRoad(col, row)) itemCells.add(`${col},${row}`);
  }
}

const ground = new Array(COLS * ROWS).fill(0);
const collision = new Array(COLS * ROWS).fill(0);
const roughLayer = new Array(COLS * ROWS).fill(0);
/** The second SURFACE layer. Two layers rather than two values on one, because a SurfaceLayer
 *  carries ONE kind in its own property — which is what lets a mapper stack them and have the
 *  topmost win. */
const boostLayer = new Array(COLS * ROWS).fill(0);
/** The third one. An item box is a fact about a CELL of the road, like the other two — see
 *  `RaceTrack.itemBox` for why it needs no state of its own. */
const itemLayer = new Array(COLS * ROWS).fill(0);
/** The FLAT decal layer: things that lie on the ground and never sort against anybody — the water
 *  under the bridge, tyres, tufts on the verge. The standing layer is for things you see the side
 *  of. Declared up here because the ground pass writes the water into it. */
const flat = new Array(COLS * ROWS).fill(0);
for (let row = 0; row < ROWS; row++) {
  for (let col = 0; col < COLS; col++) {
    const i = row * COLS + col;
    if (isRoad(col, row)) {
      // A kerb on the outermost tile of the road, either side, IN THE CORNERS — the edge is
      // visible before you are over it, and where a car runs wide there is something to feel. One
      // rule for both shapes now that both are a distance from a line; a circuit used to get a
      // stripe on its inner lane only, because a rectangle has an inside.
      const inner = distAt(col, row) > roadHalfAt(col, row) - 1 && radiusAtRun(nearAt(col, row)) < KERB_RADIUS_TILES;
      // The start-finish band: a chequered line on the same tiles a gate covers, so what the eye
      // reads and what the engine counts are the same line.
      const pad = boostCells.get(`${col},${row}`);
      if (pad) boostLayer[i] = COLLISION_GID;
      if (itemCells.has(`${col},${row}`)) {
        itemLayer[i] = COLLISION_GID;
        // The picture is a DECAL on the road, so the asphalt underneath is still asphalt and the
        // surface layer and the art cannot drift apart: both are written here, from one set.
        flat[i] = gidOf('itemBox');
      }
      const onStartLine = chequered.has(`${col},${row}`);
      ground[i] = pad
        ? gidOf((['boostE', 'boostS', 'boostW', 'boostN'] as const)[
            ((Math.round(pad.dir / (Math.PI / 2)) % 4) + 4) % 4
          ])
        : onStartLine
        ? (col + row) % 2 === 0
          ? gidOf('chequerA')
          : gidOf('chequerB')
        : inner
          ? kerbAt(col, row)
          : roadAt(col, row);
    } else if (isBarrier(col, row)) {
      // Ground under the barrier as well: it is a wall, not a hole.
      ground[i] = kerbAt(col, row);
      collision[i] = COLLISION_GID;
    } else if (isRunOff(col, row)) {
      // Sand: off the racing surface and slow — but you can drive out of it.
      ground[i] = sandAt(col, row);
      roughLayer[i] = COLLISION_GID;
    } else if (isOutfield(col, row)) {
      // Grass, past the barrier. Nothing can reach it, so it is landscape — and landscape is the
      // whole point: a circuit in a black square reads as a diagram of a circuit.
      ground[i] = grassAt(col, row);
      roughLayer[i] = COLLISION_GID;
    } else if (inBridgeAir(col, row)) {
      // The one place that is still a hole: the air either side of the bridge. It stays VOID —
      // nothing is written to `ground`, so nothing is drivable — and the water goes on the FLAT
      // decal layer, which is drawn whether or not there is ground under it.
      flat[i] = waterAt(col, row);
    }
  }
}

/**
 * What stands where, on the grass past the barrier.
 *
 * Two rules, and both are about never letting scenery become a lie:
 *
 *  - **Only the outfield.** Nothing is planted on the sand run-off or anywhere else a kart can
 *    reach. A decal never blocks (the CollisionLayer does that, see AGENTS.md), so a tree in the
 *    run-off would be something you drive straight through — and a run-off you have to slalom
 *    through is not a run-off. Past the barrier the question cannot come up.
 *  - **A tree needs its own room.** The art is 32×32 and Tiled anchors an oversized tile at the
 *    BOTTOM-LEFT of its cell, so it reaches one cell up and one cell right; both of those have to
 *    be outfield too, or the crown hangs over the barrier and into the road.
 *
 * The scatter is the same coordinate hash the grass uses with a different salt, so it is stable —
 * `--check` compares bytes, and a random layout would fail it every run.
 */
const decal = new Array(COLS * ROWS).fill(0);
/** Room for a piece this many cells wide and tall, anchored bottom-left the way Tiled anchors an
 *  oversized tile: it reaches UP and to the RIGHT, so those are the cells that must be free. */
const roomFor = (col: number, row: number, w: number, h: number): boolean => {
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) if (!isOutfield(col + dx, row - dy)) return false;
  }
  return true;
};
const roomForTree = (col: number, row: number): boolean => roomFor(col, row, 2, 2);
for (let row = 0; row < ROWS; row++) {
  for (let col = 0; col < COLS; col++) {
    if (!isOutfield(col, row)) continue;
    // 0-31 from the cell's own coordinates. The bands below are the density: about one cell in
    // eight is a tree, one in sixteen a rock, one in eight a tuft — enough to read as a meadow
    // with things in it, sparse enough that the circuit stays the thing you look at.
    const roll = variant(col + 911, row + 733, 32);
    if (roll < 4 && roomForTree(col, row)) decal[row * COLS + col] = decalGid('RACE_TREE');
    else if (roll >= 4 && roll < 6) decal[row * COLS + col] = decalGid('RACE_ROCK');
    else if (roll >= 6 && roll < 10) decal[row * COLS + col] = decalGid('RACE_PLANT');
    else if (roll >= 10 && roll < 13 && roomForTree(col, row)) decal[row * COLS + col] = decalGid('RACE_BUSH');
  }
}

/**
 * A TYRE WALL on the outside of every corner, and grandstands to watch from.
 *
 * What a circuit has where ours had a stripe of kerb pretending to be a barrier. Both are placed
 * from the curve rather than by hand: tyres go on the barrier cells whose stretch of road is a
 * corner (the same radius test the kerbs use, so the two agree by construction), and only on the
 * OUTSIDE, because that is the side a car leaves the road on.
 *
 * The tyres lie on the FLAT decal layer — they are on the ground, not standing up — which is also
 * the layer that had nothing on it but a few tufts.
 */
{
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      if (!isBarrier(col, row)) continue;
      if (radiusAtRun(nearAt(col, row)) >= KERB_RADIUS_TILES) continue;
      // Outside only: the cell is further from the middle of the map than the road it guards.
      const p = lineAt(nearAt(col, row));
      const outward = (col - COLS / 2) ** 2 + (row - ROWS / 2) ** 2 > (p.x - COLS / 2) ** 2 + (p.y - ROWS / 2) ** 2;
      if (!outward) continue;
      flat[row * COLS + col] = decalGid('RACE_TYRE');
    }
  }
}

const TILE = 16;
let objectId = 1;
/** A point object carrying an action, the shape mapBridge reads: position IS the data. */
/**
 * Which of the project's enums types each property — and why writing it matters.
 *
 * Tiled shows a DROPDOWN for a property only when the property itself carries `propertytype` in
 * the map file. Declaring the member on the class in `Pixels.tiled-project` is not enough: a
 * property written as a bare string SHADOWS the class member by name, and the editor then offers
 * a free text box for a value that has exactly seventeen legal spellings. That is what made
 * `actionKind` a text field on every generated race map while the same field was a dropdown on
 * the hand-authored ones, which is where the difference was finally visible — Tiled writes the
 * key itself when a human sets the value.
 *
 * Applied in `marker` rather than at the call sites, because a table every emitter has to
 * remember is a table the next emitter forgets. `tiledActionKinds.int.test.ts` reads the committed
 * maps back and fails on a property that has an enum in the project and no `propertytype` here.
 */
const ENUM_PROPS: Record<string, string> = {
  actionKind: 'ActionKind',
  actionPose: 'ApplianceKind',
  sitFacing: 'SitFacing',
  surface: 'SurfaceKind',
};

const typed = (props: Array<{ name: string; type: string; value: unknown }>) =>
  props.map((p) => (ENUM_PROPS[p.name] ? { ...p, propertytype: ENUM_PROPS[p.name] } : p));

const marker = (col: number, row: number, props: Array<{ name: string; type: string; value: unknown }>) => ({
  id: objectId++,
  name: '',
  point: true,
  rotation: 0,
  type: 'ActionArea',
  visible: true,
  width: 0,
  height: 0,
  x: col * TILE + TILE / 2,
  y: row * TILE + TILE / 2,
  properties: typed(props),
});
const spawn = (col: number, row: number) =>
  marker(col, row, [{ name: 'actionKind', type: 'string', value: 'spawnPoint' }]);
const gate = (col: number, row: number, index: number) =>
  marker(col, row, [
    { name: 'actionKind', type: 'string', value: 'raceGate' },
    { name: 'actionGate', type: 'int', value: index },
  ]);
/**
 * A grid slot — and on slot 0, the BEACON that says which way the race sets off.
 *
 * Only the first slot carries a direction, because one answer is what the question has: the whole
 * grid faces the same way. Before beacons the direction lived in the NUMBERING of the gates, which
 * is invisible to whoever is placing them in Tiled — a circuit that runs north is exactly as valid
 * as one that runs east, and the map should be able to SAY which.
 */
const start = (col: number, row: number, slot: number, dir?: number) =>
  marker(col, row, [
    { name: 'actionKind', type: 'string', value: 'raceStart' },
    { name: 'actionSlot', type: 'int', value: slot },
    ...(dir === undefined ? [] : [{ name: 'actionDir', type: 'int', value: dir }]),
  ]);

const objects: ReturnType<typeof marker>[] = [];
/**
 * Everything placed along the line: the gates, then the grid, the arrival marker and the timing
 * board, all read off `layOutGrid` and the curve rather than written per track.
 *
 * A `raceFinish` marker is what makes `raceTrack` call a map a SPRINT rather than a lap, and no
 * generated track emits one: the two circuits here are closed, and a point-to-point course is
 * drawn in Tiled. The engine races one either way — see the note at the head of the geometry.
 */
for (let g = 0; g < gateCells.length; g++) {
  for (const c of gateCells[g]) objects.push(gate(c.col, c.row, g));
}
for (const g of grid) objects.push(start(g.col, g.row, g.slot, g.dir));
for (const sp of spawns) objects.push(spawn(sp.col, sp.row));
/**
 * A point so many tiles to the side of the road at this point of the lap.
 *
 * Positive is AWAY from the middle of the map, which on a closed circuit is the outside of the
 * loop. Everything trackside is placed
 * through this rather than at a column, because the road is a curve: a column says nothing about
 * where you are on it, and a piece placed by one ends up in the scenery the moment the shape
 * changes.
 */
const beside = (run: number, off: number): { col: number; row: number } => {
  const p = lineAt(run);
  const nx = -Math.sin(p.dir);
  const ny = Math.cos(p.dir);
  const outward = (p.x - COLS / 2) * nx + (p.y - ROWS / 2) * ny >= 0 ? 1 : -1;
  return { col: Math.round(p.x + nx * off * outward), row: Math.round(p.y + ny * off * outward) };
};

/**
 * A placed piece of FURNITURE — art with behaviour, anchored by the cell its BOTTOM-LEFT sits in.
 *
 * Tiled anchors a tile object at the bottom-left corner of its box, which is why this takes the
 * bottom row rather than the top: written the other way round every piece taller than one cell
 * would be placed a cell or three out, and a 48x64 board would be standing in the road.
 */
const furn = (
  gid: number,
  col: number,
  bottomRow: number,
  w: number,
  h: number,
  props: Array<{ name: string; type: string; value: unknown }> = [],
) => ({
  gid,
  height: h,
  id: objectId++,
  name: '',
  opacity: 1,
  rotation: 0,
  type: 'FurnitureObject',
  visible: true,
  width: w,
  x: col * TILE,
  y: (bottomRow + 1) * TILE,
  ...(props.length > 0 ? { properties: typed(props) } : {}),
});
/** A text label — the same objects a mapper draws with Tiled's text tool. */
const label = (col: number, row: number, text: string, cells = 8) => ({
  height: TILE,
  id: objectId++,
  name: '',
  opacity: 1,
  rotation: 0,
  text: { color: '#f5f3f0', fontfamily: 'FS Pixel Sans Unicode Regular', pixelsize: 16, text, wrap: true },
  type: '',
  visible: true,
  width: cells * TILE,
  x: col * TILE,
  y: row * TILE,
});

/**
 * THE PADDOCK — one of everything this world can put on a map, on the circuit that is meant to
 * show what a map can hold.
 *
 * Asked for in those words: "bau von allen Teilen mal was auf raceway, so dass man weiß was es
 * alles gibt". The empty layers say which KINDS exist; this says what they look like when
 * somebody uses them. Everything here is ordinary content — no generator concept of its own — so
 * deleting the block leaves a plain circuit and nothing else breaks.
 *
 * Where things go follows one rule: anything you have to REACH stands on the sand verge, which is
 * walkable, and anything that is only to look at goes in the infield, which is not. A board you
 * cannot walk up to is a board nobody can read, and that was the actual complaint — the timing
 * screen was an Action on a bare tile, so it was somewhere on the track and you had to guess
 * where. It is a LEADERBOARD now, 48x64 of it, standing where you walk past it on the way to the
 * grid.
 */
const furniture: Array<ReturnType<typeof furn>> = [];
const texts: Array<ReturnType<typeof label>> = [];
const images: Array<Record<string, unknown>> = [];
/**
 * Where a piece stands, measured OUTWARD from the road in tiles, and why each number is that one.
 *
 * A tile object is anchored at its BOTTOM-LEFT and grows up and to the right, so a piece put down
 * on the verge grows INTO the road — the taller it is, the further in. Everything trackside is
 * therefore placed by its bottom edge, far enough out that its top lands on the sand: that is
 * what makes it reachable (the walkable cell beside its footprint is its approach tile) without
 * standing in front of the cars.
 */
const VERGE = HALF + 1.5;
/**
 * A cell of SAND at this point of the lap, found by trying outwards — not a fixed offset.
 *
 * An offset is a perpendicular distance and a cell is a square, so the two only line up where the
 * road runs along an axis. On a curve they drift, and a piece placed at "two tiles past the road
 * edge" lands on the barrier — which is exactly where the drinking fountain ended up, unreachable,
 * caught by the test that asks the engine to walk to it rather than by the eye.
 */
const onVerge = (run: number): { col: number; row: number } => {
  for (let off = HALF + 0.7; off <= HALF + SAND; off += 0.3) {
    const cell = beside(run, off);
    if (isRunOff(cell.col, cell.row)) return cell;
  }
  return beside(run, VERGE);
};
{
  const startRun = (spec.startAt ?? 0.07) * LINE_LENGTH;
  // BEHIND the start line, along the grid, because that is where you walk: the spawn points are
  // in the grid lane and this is what you pass on the way to a kart.
  const board = beside(startRun - 12, HALF + 4.5);
  furniture.push(furn(FURN.LEADERBOARD, board.col, board.row, 48, 64, [
    { name: 'actionKind', type: 'string', value: 'raceRecords' },
  ]));
}
{
  const startRun = (spec.startAt ?? 0.07) * LINE_LENGTH;
  const tap = onVerge(startRun - 18);
  furniture.push(furn(FURN.DRINKING_FOUNTAIN, tap.col, tap.row, 16, 32, [
    { name: 'actionKind', type: 'string', value: 'appliance' },
    { name: 'actionPose', type: 'string', value: 'drink' },
  ]));
  const pad = onVerge(startRun - 22);
  // A way home that is not the menu: travel is placed furniture with a portal action, never a
  // hard-coded jump (AGENTS.md invariant 8).
  furniture.push(furn(FURN.BEAM_PAD, pad.col, pad.row, 16, 16, [
    { name: 'actionKind', type: 'string', value: 'portal' },
  ]));
  // Flags either side of the line — animated furniture, which is the other thing a placement can
  // be: the frames are the client's business and only ON/OFF ever travels.
  for (const off of [-(HALF + 3.5), HALF + 3.5]) {
    const f = beside(startRun + 1, off);
    furniture.push(furn(FURN.FLAG_1, f.col, f.row, 32, 32));
  }
  /**
   * And the infield, which is purely to look at: nothing can reach it, so nothing there needs an
   * approach tile and everything there can be as big as it likes. This is the half of the map a
   * circuit usually wastes.
   */
  const IN = -(HALF + 6);
  const car = beside(startRun - 26, IN);
  furniture.push(furn(FURN.CAR_RACE_29, car.col, car.row, 96, 48));
  const fountain = beside(startRun - 38, IN - 3);
  furniture.push(furn(FURN.FOUNTAIN_1, fountain.col, fountain.row, 48, 48));
  for (const [at, into, gid, w, h] of [
    [startRun - 8, IN - 2, FURN.TREE, 32, 48],
    [startRun - 15, IN - 6, FURN.PINE_TREE, 32, 48],
    [startRun - 32, IN - 1, FURN.LARGE_PLANT, 32, 48],
  ] as const) {
    const t = beside(at, into);
    furniture.push(furn(gid, t.col, t.row, w, h));
  }
  // Labels, so the parts name themselves.
  const paddock = beside(startRun - 30, HALF + 4);
  texts.push(label(paddock.col - 3, paddock.row, 'PADDOCK'));
  const bridgeLabel = BRIDGE ? beside(((BRIDGE.from + BRIDGE.to) / 2) * LINE_LENGTH, HALF + 4) : null;
  if (bridgeLabel) texts.push(label(bridgeLabel.col - 4, bridgeLabel.row, 'BRIDGE', 6));
  // A picture: a real file under assets/tiled, fetched over HTTP like any other sheet. Hung in
  // the infield where it reads as a trackside hoarding.
  const hoarding = beside(startRun - 44, IN - 2);
  images.push({
    gid: IMAGE_FIRSTGID + 1,
    height: 37,
    id: objectId++,
    name: '',
    opacity: 1,
    rotation: 0,
    // `Image` is the OBJECT class the importer looks for. `ImageTile` is the class the TILE
    // carries, and only one of the two pictures in that set has it — an object typed after the
    // tile was silently dropped on import, with nothing to see and no notice printed.
    type: 'Image',
    visible: true,
    width: 200,
    x: hoarding.col * TILE,
    y: (hoarding.row + 1) * TILE,
  });
  /**
   * A brake board before the tightest corner.
   *
   * The GRANDSTANDS that stood here are gone: Dust's crowd art is drawn for a world whose road is
   * 256 px wide, and at the scale that puts a kart at forty pixels a stand came out as a
   * six-cell rectangle of confetti — "viel zu klein für unser Setting, Maßstab stimmt nicht".
   * Scaling the picture up would only make the people bigger than the karts. The art is in the
   * pack and can come back the day the trackside has something to hang it on.
   */
  // The brake board goes where the lap is tightest — found by walking the curve rather than
  // written down, so it follows the shape if the shape changes.
  let tightest = 0;
  for (let run = 0; run < LINE_LENGTH; run += 2) {
    if (radiusAtRun(run) < radiusAtRun(tightest)) tightest = run;
  }
  for (let tryOut = 0; tryOut < 6; tryOut++) {
    const sign = beside(tightest - 16, HALF + 2.5 + tryOut);
    if (roomFor(sign.col, sign.row, 2, 1)) {
      flat[sign.row * COLS + sign.col] = decalGid('RACE_BRAKE_SIGN');
      break;
    }
  }
  // And a flat decal field on the verge by the paddock — the layer that lies UNDER everybody, as
  // opposed to the scenery layer, which sorts against them.
  for (let k = 6; k < 34; k += 2) {
    const g = beside(startRun - k, HALF + 1.2);
    if (g.col > 0 && g.row > 0 && g.col < COLS && g.row < ROWS && isRunOff(g.col, g.row)) {
      flat[g.row * COLS + g.col] = decalGid('RACE_PLANT');
    }
  }
}

/**
 * THE SHORE: a waterline drawn into the land cells beside the gorge.
 *
 * The bank used to be the cell grid itself — the water is a decal in VOID cells and the land is
 * the cells next to them, so the waterline was a run of 16 px steps down a diagonal. Reported as
 * hard staircase edges against the grass.
 *
 * Three things make this a picture and nothing more, which is the point:
 *
 *  - **It is written to the FLAT decal layer, over ground that stays exactly what it was.** No
 *    cell changes from ground to void or back, so where a kart may drive is untouched and the
 *    bridge is as necessary as it ever was.
 *  - **The tile is chosen by a MASK of the wet neighbours**, so the line runs on from cell to cell
 *    instead of each cell deciding on its own. The four-sided masks are tried first and the
 *    diagonal-only nubs are the fallback, because a cell touching water across a corner is the one
 *    that leaves a nick where two runs meet.
 *  - **It goes on LAST**, so where a tuft or a plant landed on the bank the water wins. A plant
 *    standing in the river is worse than one fewer plant.
 */
for (let row = 0; row < ROWS; row++) {
  for (let col = 0; col < COLS; col++) {
    const i = row * COLS + col;
    // Land only. The BRIDGE is the other thing next to the gorge, and a waterline lapping over its
    // deck and its barrier reads as a river running across the road rather than under it — which
    // is the one picture this whole feature exists to avoid.
    if (!ground[i] || isRoad(col, row) || isBarrier(col, row)) continue;
    const wet = (c: number, r: number): boolean => inBridgeAir(c, r);
    const sides = (['N', 'E', 'S', 'W'] as const).filter((side, bit) =>
      wet(col + (bit === 1 ? 1 : bit === 3 ? -1 : 0), row + (bit === 0 ? -1 : bit === 2 ? 1 : 0)) && side,
    );
    if (sides.length > 0) {
      flat[i] = gidOf(`shore${sides.join('')}` as TrackTile);
      continue;
    }
    const corner = (['NE', 'SE', 'SW', 'NW'] as const).find((c) =>
      wet(col + (c[1] === 'E' ? 1 : -1), row + (c[0] === 'N' ? -1 : 1)),
    );
    if (corner) flat[i] = gidOf(`shoreC${corner}` as TrackTile);
  }
}

/** An unpainted tile layer's data: one zero per cell, which is what "nothing here" looks like in
 *  a .tmj. */
const empty = (): number[] => new Array<number>(COLS * ROWS).fill(0);

const objectLayer = (id: number, name: string, objs: unknown[]) => ({
  draworder: 'topdown',
  id,
  name,
  objects: objs,
  opacity: 1,
  type: 'objectgroup',
  visible: true,
  x: 0,
  y: 0,
});

const tileLayer = (id: number, name: string, cls: string, data: number[]) => ({
  data,
  height: ROWS,
  id,
  name,
  opacity: 1,
  type: 'tilelayer',
  visible: true,
  width: COLS,
  x: 0,
  y: 0,
  class: cls,
});

const map = {
  // The map's own class, so Tiled offers `mapName` where a mapper would look for it rather than
  // as a property they have to know to add. Same reason the empty layers are there.
  class: 'Map',
  compressionlevel: -1,
  height: ROWS,
  infinite: false,
  /**
   * EVERY layer kind this world has, in draw order, whether or not this map paints on it.
   *
   * Asked for in those words — "jede Rennkarte sollte alle möglichen Layer enthalten, auch wenn
   * sie leer sind, damit man weiß welche es gibt" — and it is the right answer for a generated
   * map: what a layer IS lives in its class, the class is what the importer reads, and a mapper
   * opening a track in Tiled otherwise has to know that `WallLatticeLayer` exists before they can
   * find out that it exists. An empty layer is a menu.
   *
   * The cost is honest and small: an unpainted tile layer is `cols × rows` zeros, about 17 KB of
   * JSON on the raceway, and it contributes nothing at all to the layout — the importer reads
   * painted cells, so an empty layer produces no cells, no bytes on the wire and no work per tick.
   */
  layers: [
    tileLayer(1, 'Ground', 'GroundLayer', ground),
    // FLAT decoration: lies under everybody, never sorts. Empty here — a racing surface is the
    // ground itself — and present so that "paint a puddle on the apex" is a thing you can see is
    // possible.
    {
      ...tileLayer(6, 'Decal', 'DecalLayer', flat),
      properties: [{ name: 'occludes', type: 'bool', value: false }],
    },
    // One decal layer, and it occludes: these are standing things, so they sort against whoever is
    // beside them rather than lying under. That only ever matters where somebody can stand, and
    // nobody can stand out here — so the honest reason to set it is that a tree IS an upright
    // object, not that anything today can tell.
    {
      ...tileLayer(4, 'Scenery', 'DecalLayer', decal),
      properties: [{ name: 'occludes', type: 'bool', value: true }],
    },
    // Walls, both halves — and the two layers this generator deliberately leaves EMPTY. A circuit
    // fences itself with the CollisionLayer, because a barrier round a track is a boundary and not
    // a building; and a wall in this world is a Wang set, which Tiled paints by picking the corner
    // pieces from the neighbours. Generating one means reimplementing that, and a wall drawn
    // wrongly is worse than a wall not drawn. So they are here as the place to draw a pit garage
    // or a tunnel, in Tiled, by hand — which is where walls are authored anyway.
    tileLayer(7, 'WallLattice', 'WallLatticeLayer', empty()),
    tileLayer(8, 'WallFace', 'WallFaceLayer', empty()),
    tileLayer(2, 'Collision', 'CollisionLayer', collision),
    // What the ground DOES: every sand and grass cell is off the racing surface, so the physics
    // and the computer drivers both know the road from the scenery. One painted layer rather than
    // one Action object per cell — the same fact, and on the raceway it is 1945 objects against a
    // list of numbers.
    {
      ...tileLayer(5, 'Rough', 'SurfaceLayer', roughLayer),
      visible: false,
      properties: [{ name: 'surface', type: 'string', propertytype: 'SurfaceKind', value: 'rough' }],
    },
    {
      ...tileLayer(12, 'Boost', 'SurfaceLayer', boostLayer),
      visible: false,
      properties: [{ name: 'surface', type: 'string', propertytype: 'SurfaceKind', value: 'boost' }],
    },
    {
      ...tileLayer(13, 'Items', 'SurfaceLayer', itemLayer),
      visible: false,
      properties: [{ name: 'surface', type: 'string', propertytype: 'SurfaceKind', value: 'item' }],
    },
    objectLayer(9, 'Furniture', furniture),
    objectLayer(3, 'Actions', objects),
    objectLayer(10, 'Text', texts),
    objectLayer(11, 'Images', images),
  ],
  nextlayerid: 13,
  nextobjectid: objectId,
  orientation: 'orthogonal',
  properties: [
    { name: 'mapName', type: 'string', value: spec.id },
    { name: 'laps', type: 'int', value: spec.laps },
  ],
  renderorder: 'right-down',
  tiledversion: (src.tiledversion as string) ?? '1.11.0',
  tileheight: TILE,
  tilesets: [
    ...srcSets,
    { firstgid: TRACK_FIRSTGID, source: '../track.tsj' },
    { firstgid: SCENERY_FIRSTGID, source: '../scenery.tsj' },
    { firstgid: DECAL_FIRSTGID, source: '../decal-race.tsj' },
  ],
  tilewidth: TILE,
  type: 'map',
  version: (src.version as string) ?? '1.10',
  width: COLS,
};

  return {
    /**
     * A tile layer's `data` goes on ONE line, which is how Tiled itself writes it.
     *
     * Two reasons, and the second is the one that matters. It is four times smaller — 8 584 cells
     * at one number per line is 86 KB of layer, and with every layer kind present whether painted
     * or not the raceway came to 494 KB against 128. And a map opened in Tiled and saved is
     * rewritten in Tiled's format: a generator that pretty-prints differently turns the next human
     * save into a diff of every cell on the map, which is exactly the trap AGENTS.md names for
     * `sync-furniture-properties`.
     */
    bytes: JSON.stringify(map, null, 1).replace(/"data": \[[^\]]*\]/g, (m) => m.replace(/\s+/g, ' ')) + '\n',
    painted: ground.filter((g) => g).length,
    furniture: furniture.length,
    scenery: decal.filter((g) => g).length,
    markers: objects.length,
  };
}

let differs = false;
for (const spec of TRACKS) {
  const out = path.join(ZONES, `${spec.id}.tmj`);
  const { bytes, painted, scenery, markers, furniture } = buildTrack(spec);
  if (CHECK) {
    const onDisk = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '';
    if (onDisk !== bytes) {
      console.error(`${path.relative(REPO, out)} differs from the generator`);
      differs = true;
    }
    continue;
  }
  fs.writeFileSync(out, bytes);
  console.log(
    `wrote ${path.relative(REPO, out)} (${spec.cols}x${spec.rows}, ${painted} painted cells, ` +
      `${scenery} scenery, ${markers} markers, ${furniture} placed, ${spec.laps} laps)`,
  );
}
if (CHECK) {
  if (differs) {
    console.error('run scripts/make-tracks.sh');
    process.exit(1);
  }
  console.log(`all ${TRACKS.length} tracks match the generator`);
}
