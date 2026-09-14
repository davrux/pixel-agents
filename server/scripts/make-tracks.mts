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
const TRACK_TILES = ['asphalt', 'asphaltB', 'kerbRed', 'kerbPale', 'chequerA', 'chequerB', 'edgeTop', 'edgeBottom', 'edgeLeft', 'edgeRight'] as const;
type TrackTile = (typeof TRACK_TILES)[number];
/**
 * The landscape a circuit sits in — Dust Racing's ground, under CC BY-SA 3.0.
 *
 * Its own tileset rather than more rows in ours, because the two carry different licences and a
 * file is the smallest thing a licence can attach to. See assets/third-party/dust-racing/README.md.
 */
const SCENERY_TILES = ['grassA', 'grassB', 'grassC', 'grassD', 'sandA', 'sandB', 'sandC', 'sandD'] as const;
type SceneryTile = (typeof SCENERY_TILES)[number];
/**
 * What STANDS in that landscape — a tree, a rock, a tuft — in the order `decal-race.tsj` carries
 * them. Grass alone is still a flat green rectangle; what makes a circuit read as a place is
 * something with a height in it.
 */
const DECAL_TILES = ['RACE_TREE', 'RACE_ROCK', 'RACE_PLANT'] as const;
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
/** Two asphalt tiles in a coarse patchwork, so a long straight is not one flat grey field. */
const roadAt = (col: number, row: number): number =>
  (Math.floor(col / 3) + Math.floor(row / 3)) % 2 === 0 ? gidOf('asphalt') : gidOf('asphaltB');


interface Pt {
  x: number;
  y: number;
}

/** What makes one circuit different from another. Everything else is the same generator. */
interface TrackSpec {
  /** The zone id and the file name. */
  id: string;
  label: string;
  /**
   * A closed circuit driven N times, or a stage driven once from one end to the other.
   *
   * The two share everything below this line — the same road, kerbs, run-off, barrier, landscape
   * and grid — and differ only in the SHAPE that decides which cell is which. That is the whole
   * reason a point-to-point race needed no new engine concept: gates are a ring walked in order,
   * and a stage is that ring with a finish line at the far end instead of a lap counter.
   */
  kind: 'ring' | 'sprint';
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
   * The circuit's centreline, as control points for a closed spline. Rings only.
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
  /** Where the start-finish line sits, as a fraction of the lap. Rings only. */
  startAt?: number;
  /** A stretch of the lap with no barrier and a drop either side, as fractions of the lap. */
  bridge: { from: number; to: number } | null;
  /** How many straight runs a stage is folded into. One more run is one more hairpin and about a
   *  quarter more road; the runs get closer together, so the hairpins get tighter. Sprints only. */
  bands?: number;
}

const TRACKS: readonly TrackSpec[] = [
  {
    id: 'raceway',
    label: 'Raceway',
    kind: 'ring',
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
    // Shorter and wider: a circuit you can actually race side by side on, where the raceway is
    // the one with a bridge to be shoved off. No bridge here — one hazard shared by every track
    // would make them the same track with different numbers.
    id: 'speedway',
    label: 'Speedway',
    kind: 'ring',
    cols: 90,
    rows: 62,
    width: 9,
    laps: 3,
    /** Shorter and rounder than the raceway, and every corner is a sweep: nine tiles of road with
     *  a 7.7-tile tightest radius is the circuit you race side by side on. */
    startAt: 0.24,
    line: [
      { x: 13, y: 47 },
      { x: 44, y: 51 },
      { x: 73, y: 45 },
      { x: 78, y: 30 },
      { x: 68, y: 15 },
      { x: 42, y: 10 },
      { x: 18, y: 15 },
      { x: 10, y: 30 },
    ],
    bridge: null,
  },
  {
    /**
     * A STAGE, not a circuit: one run from the west end to the east, and the line at the far end
     * is the whole race.
     *
     * Asked for in as many words — "es müssen nicht unbedingt Runden sein" — and the engine has
     * been able to express it since gates became a ring walked in order; what was missing was a
     * map that used it. Narrow (five tiles), so the road itself is what a stage has instead of a
     * circuit's room to overtake.
     */
    id: 'hillroad',
    label: 'Hill Road',
    kind: 'sprint',
    cols: 116,
    rows: 88,
    width: 6,
    laps: 1,
    bridge: null,
    /**
     * FOUR runs, and the count is a racing decision rather than a spacing one. Three leaves the
     * runs eighteen tiles apart, so the hairpins that join them have a nine-tile radius — wider
     * than a kart's own turning circle at full speed, which means nothing on the stage ever has to
     * be braked for: measured, the whole field came home within two seconds of each other in
     * fourteen. Four puts the runs twelve apart, and a
     * six-tile hairpin is tighter than the tyres hold. The shoulders are what used to make four
     * unreadable, and STAGE_SAND is what fixed that.
     */
    bands: 5,
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
 * THE CENTRELINE — one for both shapes, which is what finally made a circuit and a stage the same
 * generator rather than two that agree by hand.
 *
 * A ring used to be stated as two rectangles, and the price was written on the map: four corners
 * of exactly 90°, which is not a corner any road has ever had. It is a closed CURVE now — a
 * Catmull-Rom spline through the control points in the spec — and every cell is classified by how
 * far it is from that curve, which is precisely how the stage already worked. Road, kerb, sand,
 * barrier and grass are the same five bands measured from the same number.
 *
 * What that buys beyond the look: corners of DIFFERENT radii, because the control points are not
 * evenly spaced, so a lap has a shape instead of four identical bends. `scripts/make-tracks.sh`
 * prints the tightest one, and it is the number that decides whether a circuit asks anything of a
 * driver: at 320 px/s a corner of radius r demands `v²/r` against 1212 px/s² of grip, so 5.6 tiles
 * is on the limit and anything tighter has to be braked for.
 */
const HALF = spec.width / 2;
/** How wide the sand verge is either side of the road. A circuit is a road with a wall round it,
 *  so it can afford two; a stage is a road through a landscape and a wide verge turns the meadow
 *  between its runs into a beige field. */
const SAND = spec.kind === 'ring' ? 2 : 1.5;
const STAGE_BANDS = spec.bands ?? 4;
const STAGE_PAD = 7;
const STAGE_GAP = (ROWS - 1 - 2 * STAGE_PAD) / (STAGE_BANDS - 1);
/** A hairpin is half the band spacing, because the two runs it joins are one spacing apart. That
 *  makes the radius a consequence of the layout rather than a number to tune: pack the runs closer
 *  and the corners get tighter on their own. */
const STAGE_TURN = STAGE_GAP / 2;
/**
 * How far the runs reach — DERIVED, because every part of it is already decided elsewhere: the
 * hairpin bulges one radius past the end of the run, the road carries its half-width plus the sand
 * and one of barrier, and a tile of grass outside that keeps the circuit from being welded to the
 * edge of the world.
 */
const STAGE_EDGE = Math.ceil(STAGE_TURN + HALF + SAND + 3);
const STAGE_LEFT = STAGE_EDGE;
const STAGE_RIGHT = COLS - 1 - STAGE_EDGE;

const linePts: Array<{ x: number; y: number }> = [];
const CLOSED = spec.kind === 'ring';
if (CLOSED) {
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
} else {
  const push = (x: number, y: number): void => {
    const last = linePts[linePts.length - 1];
    if (!last || Math.hypot(x - last.x, y - last.y) > 0.02) linePts.push({ x, y });
  };
  for (let b = 0; b < STAGE_BANDS; b++) {
    const y = STAGE_PAD + b * STAGE_GAP;
    const east = b % 2 === 0;
    const from = east ? STAGE_LEFT : STAGE_RIGHT;
    const to = east ? STAGE_RIGHT : STAGE_LEFT;
    const steps = Math.round(Math.abs(to - from) * 8);
    for (let i = 0; i <= steps; i++) push(from + ((to - from) * i) / steps, y);
    if (b === STAGE_BANDS - 1) break;
    // The hairpin, as a half circle centred one radius below the end just reached: it starts at
    // the top of that circle (the run's end), bulges outwards past the map's working edge, and
    // comes back at the start of the run below. East turns sweep one way, west turns the other.
    const cx = to;
    const cy = y + STAGE_TURN;
    const arc = Math.max(24, Math.round(Math.PI * STAGE_TURN * 8));
    for (let i = 1; i <= arc; i++) {
      const a = -Math.PI / 2 + (east ? 1 : -1) * (Math.PI * i) / arc;
      push(cx + Math.cos(a) * STAGE_TURN, cy + Math.sin(a) * STAGE_TURN);
    }
  }
}
/** Distance along the line to each sample, so a gate can be placed at "so many tiles in" rather
 *  than at a fraction of an index — the samples are denser through the tighter corners. */
const lineRun: number[] = [0];
for (let i = 1; i < linePts.length; i++) {
  lineRun.push(lineRun[i - 1] + Math.hypot(linePts[i].x - linePts[i - 1].x, linePts[i].y - linePts[i - 1].y));
}
if (CLOSED) {
  const a = linePts[linePts.length - 1];
  const b = linePts[0];
  lineRun.push(lineRun[lineRun.length - 1] + Math.hypot(b.x - a.x, b.y - a.y));
}
const LINE_LENGTH = CLOSED ? lineRun[lineRun.length - 1] : (lineRun[lineRun.length - 1] ?? 0);
const STAGE_LENGTH = LINE_LENGTH;
/** The point this far along the road, and which way it points there. A closed line WRAPS, so a
 *  gate at 95 % of the lap is a gate, not the end of the world. */
const lineAt = (run: number): { x: number; y: number; dir: number } => {
  const n = linePts.length;
  const want = CLOSED
    ? ((run % LINE_LENGTH) + LINE_LENGTH) % LINE_LENGTH
    : Math.max(0, Math.min(LINE_LENGTH, run));
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (lineRun[mid] < want) lo = mid + 1;
    else hi = mid;
  }
  const at = (i: number): Pt => (CLOSED ? linePts[((i % n) + n) % n] : linePts[Math.max(0, Math.min(n - 1, i))]);
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
/**
 * Where a wall goes on a stage: between two stretches of road that are CLOSE on the map and far
 * apart along the road.
 *
 * That is the definition of a short cut, so it is the definition of where a barrier belongs — and
 * deriving it beats placing it. A barrier hugging the whole road turns a landscape into corridors;
 * no barrier at all lets the field drive straight across the meadow from one run to the next, and
 * that is not a theory: with the walls taken out the whole field came home in 27 seconds instead
 * of 47, cutting every hairpin. This walls exactly the gaps a cut would use — the strips between
 * the runs and the inside of each hairpin — and leaves the outside open to the landscape.
 */
const STAGE_CUT_RUN = 15;
const stageWall = new Uint8Array(COLS * ROWS);
{
  const reach = Math.ceil(CLOSED ? HALF + SAND + 5 : HALF + STAGE_GAP);
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
  if (!CLOSED) {
    // A second pass, once every cell knows its own nearest stretch: anything off the road that a
    // DISTANT stretch also reaches is a gap between two passes of the course.
    touch((cell, d, run) => {
      if (lineDist[cell] <= HALF + SAND) return;
      // Measured against HALF THE BAND SPACING plus a little, not against the shoulder width: the
      // midline between two runs is exactly half a spacing from each, and where that lands between
      // two integer rows neither of them is within a tighter bound — so a tighter test walled one
      // gap of three and left the others open, which is worse than walling none.
      if (d <= STAGE_GAP / 2 + 0.6 && Math.abs(run - lineNear[cell]) > STAGE_CUT_RUN) stageWall[cell] = 1;
    });
  }
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
  const at = (k: number): Pt => (CLOSED ? linePts[((k % n) + n) % n] : linePts[Math.max(0, Math.min(n - 1, k))]);
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
const radiusAtRun = (run: number): number => {
  if (run < 0) return Infinity;
  let lo = 0;
  let hi = linePts.length - 1;
  const want = CLOSED ? ((run % LINE_LENGTH) + LINE_LENGTH) % LINE_LENGTH : run;
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
  if (!CLOSED) {
    return (
      col === 0 || row === 0 || col === COLS - 1 || row === ROWS - 1 ||
      (col > 0 && row > 0 && col < COLS && row < ROWS && stageWall[row * COLS + col] === 1)
    );
  }
  const d = distAt(col, row);
  return d > HALF + SAND && d <= HALF + SAND + 1;
};
const onOutfield = (col: number, row: number): boolean => {
  if (col <= 0 || row <= 0 || col >= COLS - 1 || row >= ROWS - 1) return CLOSED && !onBarrier(col, row) && !inBridgeAir(col, row);
  if (onRoad(col, row) || onBarrier(col, row) || onRunOff(col, row) || inBridgeAir(col, row)) return false;
  if (!CLOSED && stageWall[row * COLS + col] === 1) return false;
  return true;
};
const onStageRoad = onRoad;
const onStageRunOff = onRunOff;
const onStageBarrier = onBarrier;
const onStageOutfield = onOutfield;
const onRing = onRoad;

/**
 * The five bands, whichever shape this map is. Everything below this line paints, plants and
 * emits from these four questions and nothing else — which is what makes a stage and a circuit
 * the same generator rather than two that drift apart.
 */
const RING = spec.kind === 'ring';
/** Six rows of two behind the line. Twelve is the field Dust Racing runs, and both shapes use it. */
const RING_GRID_ROWS = 6;
const isRoad = RING ? onRing : onStageRoad;
const isBarrier = RING ? onBarrier : onStageBarrier;
const isRunOff = RING ? onRunOff : onStageRunOff;
const isOutfield = RING ? onOutfield : onStageOutfield;

/**
 * A stage's gates, grid, finish and chequered paint — all of it read off the centreline.
 *
 * A gate is the perpendicular across the road at one point of the curve, which is exactly what a
 * gate is on a circuit too; the difference is that a circuit's four are hand-placed at the ends of
 * its straights and a stage's are spaced along it, because a stage has no straights to name. The
 * LAST one is also the finish: `raceFinish` is what makes `raceTrack` call the map a sprint, and
 * putting it on the final gate means the line you must cross and the line that ends the race
 * cannot drift apart.
 */
/** One checkpoint roughly every eighteen tiles of road, so a hairpin cannot be skipped by
 *  cutting from one run to the next across the grass. */
const STAGE_GATES = Math.max(6, Math.round(STAGE_LENGTH / 18));
/** The grid needs this much straight road behind the start line, and the finish line sits this
 *  far back from the very end so it is on road rather than at the point it runs out. */
const STAGE_GRID_RUN = 30;
const STAGE_FINISH_RUN = 2.5;
const gateCells: Array<Array<{ col: number; row: number }>> = [];
const chequered = new Set<string>();
const grid: Array<{ col: number; row: number; slot: number; dir?: number }> = [];
const spawns: Array<{ col: number; row: number }> = [];
/**
 * The cells a gate covers: the perpendicular across the road at one point of the curve.
 *
 * The same answer for a circuit and a stage, which it has to be — a gate is a LINE ACROSS THE
 * ROAD, and now that both shapes are a centreline there is one way to draw one. A circuit's four
 * used to be hand-placed spans of a rectangle's edges, which is why they could only ever be
 * horizontal or vertical.
 */
const gateCellsAt = (run: number): Array<{ col: number; row: number }> => {
  const p = lineAt(run);
  const nx = -Math.sin(p.dir);
  const ny = Math.cos(p.dir);
  const cells = new Map<string, { col: number; row: number }>();
  for (let u = -HALF - 1; u <= HALF + 1; u += 0.25) {
    const col = Math.round(p.x + nx * u);
    const row = Math.round(p.y + ny * u);
    if (onRoad(col, row)) cells.set(`${col},${row}`, { col, row });
  }
  return [...cells.values()];
};
/** Six rows of two behind the line, and the beacon on slot 0 pointing the way the road goes
 *  there. Five tiles between rows, because a kart is two and a half long: at three they
 *  overlapped the moment the art grew, and a starting grid where the cars intersect is not a
 *  grid. */
const layOutGrid = (startRun: number): void => {
  let slot = 0;
  for (let i = 0; i < RING_GRID_ROWS; i++) {
    const p = lineAt(startRun - 3 - i * 5);
    const nx = -Math.sin(p.dir);
    const ny = Math.cos(p.dir);
    for (const u of [-2, 2]) {
      grid.push({
        col: Math.round(p.x + nx * u),
        row: Math.round(p.y + ny * u),
        slot,
        ...(slot++ === 0 ? { dir: ((Math.round((p.dir * 180) / Math.PI) % 360) + 360) % 360 } : {}),
      });
    }
    // Arrive IN the grid, down the lane between its two rows — not wherever the free-tile search
    // happens to land. On a lap this long that is the difference between getting in a kart and
    // walking half of it to find one.
    spawns.push({ col: Math.round(p.x), row: Math.round(p.y) });
  }
};
if (CLOSED) {
  /**
   * Four gates, evenly spaced round the lap, with gate 0 on the start line.
   *
   * Evenly spaced by RUN rather than placed at the ends of straights: a curve has no ends to name,
   * and four quarters of a lap is exactly what the ring of checkpoints is for — you may only pass
   * them in order, so a quarter is as much of the lap as can be cut in one go, which is none of it.
   */
  const startRun = (spec.startAt ?? 0.07) * LINE_LENGTH;
  for (let g = 0; g < 4; g++) gateCells.push(gateCellsAt(startRun + (LINE_LENGTH * g) / 4));
  for (const c of gateCells[0]) chequered.add(`${c.col},${c.row}`);
  layOutGrid(startRun);
} else {
  // The gates stop short of the end: the finish line is a ring of cells of its own, past the last
  // gate. One cell carries one Action, so a finish painted on top of a gate simply DELETES that
  // gate — which is how the first version of this map ended up with fifteen gates and a finish
  // that could be reached without passing the fifteenth.
  const lastGateRun = LINE_LENGTH - STAGE_FINISH_RUN - 6;
  for (let g = 0; g <= STAGE_GATES; g++) {
    gateCells.push(
      gateCellsAt(
        g === STAGE_GATES
          ? LINE_LENGTH - STAGE_FINISH_RUN
          : STAGE_GRID_RUN + ((lastGateRun - STAGE_GRID_RUN) * g) / (STAGE_GATES - 1),
      ),
    );
  }
  // The line at either end is painted: the start you set off from and the one that ends it.
  for (const c of gateCells[0]) chequered.add(`${c.col},${c.row}`);
  for (const c of gateCells[STAGE_GATES]) chequered.add(`${c.col},${c.row}`);
  layOutGrid(STAGE_GRID_RUN);
}

const ground = new Array(COLS * ROWS).fill(0);
const collision = new Array(COLS * ROWS).fill(0);
const roughLayer = new Array(COLS * ROWS).fill(0);
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
      const onStartLine = chequered.has(`${col},${row}`);
      ground[i] = onStartLine
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
const roomForTree = (col: number, row: number): boolean =>
  isOutfield(col, row) && isOutfield(col, row - 1) && isOutfield(col + 1, row) && isOutfield(col + 1, row - 1);
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
const finish = (col: number, row: number) =>
  marker(col, row, [{ name: 'actionKind', type: 'string', value: 'raceFinish' }]);

/**
 * One emitter for both shapes, because both are now a line with things placed along it.
 *
 * A circuit's gates are the first four of the same list a stage's are; a stage adds a finish on
 * the last. Everything else — grid, spawns, the timing board — comes out of `layOutGrid` and the
 * curve, so neither shape has placement code of its own any more.
 */
for (let g = 0; g < gateCells.length; g++) {
  const last = !CLOSED && g === gateCells.length - 1;
  // The far end of a stage is a LINE, not a point: every one of its cells ends the race, so
  // crossing it anywhere on the road counts. A single tile would be a finish you could miss by a
  // metre.
  for (const c of gateCells[g]) objects.push(last ? finish(c.col, c.row) : gate(c.col, c.row, g));
}
for (const g of grid) objects.push(start(g.col, g.row, g.slot, g.dir));
for (const sp of spawns) objects.push(spawn(sp.col, sp.row));
/**
 * A point so many tiles to the side of the road at this point of the lap.
 *
 * Positive is AWAY from the middle of the map, which on a closed circuit is the outside of the
 * loop and on a stage is simply the side the map centre is not on. Everything trackside is placed
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
const flat = new Array(COLS * ROWS).fill(0);
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
  // The board goes on both shapes: a stage has no infield and no lap, but it has a best time.
  const startRun = CLOSED ? (spec.startAt ?? 0.07) * LINE_LENGTH : 6;
  // BEHIND the start line, along the grid, because that is where you walk: the spawn points are
  // in the grid lane and this is what you pass on the way to a kart.
  const board = beside(startRun - 12, HALF + 4.5);
  furniture.push(furn(FURN.LEADERBOARD, board.col, board.row, 48, 64, [
    { name: 'actionKind', type: 'string', value: 'raceRecords' },
  ]));
}
if (CLOSED) {
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
    type: 'ImageTile',
    visible: true,
    width: 200,
    x: hoarding.col * TILE,
    y: (hoarding.row + 1) * TILE,
  });
  // And a flat decal field on the verge by the paddock — the layer that lies UNDER everybody, as
  // opposed to the scenery layer, which sorts against them.
  for (let k = 6; k < 34; k += 2) {
    const g = beside(startRun - k, HALF + 1.2);
    if (g.col > 0 && g.row > 0 && g.col < COLS && g.row < ROWS && isRunOff(g.col, g.row)) {
      flat[g.row * COLS + g.col] = decalGid('RACE_PLANT');
    }
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
    objectLayer(9, 'Furniture', furniture),
    objectLayer(3, 'Actions', objects),
    objectLayer(10, 'Text', texts),
    objectLayer(11, 'Images', images),
  ],
  nextlayerid: 12,
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
