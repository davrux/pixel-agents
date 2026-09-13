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
   * Read against the CAR, which is four tiles long and two wide: nine is about two and a half car
   * widths and takes two abreast with room to move, eleven is generous, seven is a stage you have
   * to be tidy on. These were 5 and 7 when a car was two tiles long — the same numbers in tiles
   * meant twice as much road per car, and scaling the car without scaling these would have left a
   * circuit nobody could overtake on.
   */
  width: number;
  laps: number;
  /** Where the finish line sits, as a column. Rings only. */
  startCol: number;
  /** A stretch of the far straight with no barrier and a drop either side, or none. */
  bridge: { from: number; to: number; width: number } | null;
  /** How many straight runs a stage is folded into. One more run is one more hairpin and about a
   *  quarter more road; the runs get closer together, so the hairpins get tighter. Sprints only. */
  bands?: number;
}

const TRACKS: readonly TrackSpec[] = [
  {
    id: 'raceway',
    label: 'Raceway',
    kind: 'ring',
    cols: 100,
    rows: 62,
    width: 9,
    // Four, not three: the wider road is quicker — measured, a lap fell from about 25 seconds to
    // 11.5 when the cars and the road grew together — and three of those is a race that is over
    // before it has a shape. Not five either, and that is the tyres: a lap costs about 19 % of a
    // set, so five makes the pit stop compulsory where four leaves it the decision it is meant to
    // be. The panel can still set anything.
    laps: 4,
    startCol: 55,
    bridge: { from: 34, to: 62, width: 7 },
  },
  {
    // Shorter, wider and twice as many laps: a circuit you can actually race side by side on,
    // where the raceway is a test of whether you can keep it out of the pit. No bridge — one
    // hazard shared by every track would make them the same track with different numbers.
    id: 'speedway',
    label: 'Speedway',
    kind: 'ring',
    cols: 76,
    rows: 52,
    width: 11,
    // Five: the bigger map made the lap longer (11.3 s), and six of them costs more than a set of
    // tyres — measured, the field came home on 4 %, which makes the pit stop compulsory rather
    // than a decision.
    laps: 5,
    // Far enough round that the grid fits BEHIND it: six rows five tiles apart need thirty tiles
    // of straight, and at 26 the last two rows fell off the west end of the map — measured as a
    // field of seven on a twelve-car grid.
    startCol: 58,
    bridge: null,
  },
  {
    /**
     * A STAGE, not a circuit: one run from the west end to the east, and the line at the far end
     * is the whole race.
     *
     * Asked for in as many words — "es müssen nicht unbedingt Runden sein" — and the engine has
     * been able to express it since gates became a ring walked in order; what was missing was a
     * map that used it. Narrow (five tiles) and with no pit lane at all, so a set of tyres has to
     * last the run: that is what a stage has instead of a pit strategy.
     */
    id: 'hillroad',
    label: 'Hill Road',
    kind: 'sprint',
    cols: 100,
    rows: 72,
    width: 7,
    laps: 1,
    startCol: 0,
    bridge: null,
    /**
     * FOUR runs, and the count is a racing decision rather than a spacing one. Three leaves the
     * runs eighteen tiles apart, so the hairpins that join them have a nine-tile radius — wider
     * than a kart's own turning circle at full speed, which means nothing on the stage ever has to
     * be braked for: measured, the whole field came home within two seconds of each other in
     * fourteen, with three quarters of the tyres left. Four puts the runs twelve apart, and a
     * six-tile hairpin is tighter than the tyres hold. The shoulders are what used to make four
     * unreadable, and STAGE_SAND is what fixed that.
     */
    bands: 6,
  },
];

function buildTrack(spec: TrackSpec): { bytes: string; painted: number; scenery: number; markers: number } {
/**
 * The ring: a road FIVE tiles wide, and that number is the whole difficulty of the track.
 *
 * The first version was a nine-tile road round a small infield, and it could be driven flat out
 * from flag to flag — reported in those words. A corner is only a corner if the line it needs is
 * tighter than the road is wide: at 240 px/s a kart traces about five tiles of radius even when
 * the tyres hold, so five tiles of road means the outside of a corner has to be given up for the
 * inside, and carrying full throttle in runs out of tarmac. The handling model was never the
 * problem; there was nowhere on the map to feel it.
 */
const COLS = spec.cols;
const ROWS = spec.rows;
const START_LINE_COL = spec.startCol;
const OUTER = { left: 2, right: COLS - 3, top: 2, bottom: ROWS - 3 };
const INNER = { left: 2 + spec.width, right: COLS - 3 - spec.width, top: 2 + spec.width, bottom: ROWS - 3 - spec.width };

/**
 * The bridge: a stretch of the far straight with nothing beside it.
 *
 * Asked for at the very start — "Brücken über Abgründen, da könnte man dann jemanden von der
 * Brücke bumpen" — and it needs no new concept at all, which is the point: only GROUND makes a
 * cell drivable, so a bridge is a piece of road with the barrier left off and the ground beside
 * it removed. Narrower than the rest of the lap (four tiles against five) so that a shove has
 * somewhere to send you, and on the FAR side of the circuit rather than at the start, because a
 * hazard on the run to the first corner punishes the grid rather than the driving.
 *
 * It is not a shortcut and cannot become one: the gates are a ring walked in order, so leaving
 * the road never advances a lap.
 */
const BRIDGE = spec.bridge
  ? { from: spec.bridge.from, to: spec.bridge.to, top: INNER.top - spec.bridge.width, bottom: INNER.top - 1 }
  : { from: -1, to: -2, top: 0, bottom: -1 };
const onBridge = (col: number, row: number): boolean =>
  col >= BRIDGE.from && col <= BRIDGE.to && row >= BRIDGE.top && row <= BRIDGE.bottom;
const overBridgeSpan = (col: number): boolean => col >= BRIDGE.from && col <= BRIDGE.to;

/**
 * The STAGE: a centreline laid out as a serpentine, and a distance field around it.
 *
 * A ring is stated as two rectangles because that is what a rectangle-shaped circuit IS. A stage
 * has no inside and no outside, so it is stated the other way round — as a LINE, with every cell
 * classified by how far it is from that line. Road, kerb, sand, barrier and grass are then the
 * same five bands they are on a circuit, just measured from a curve instead of from an edge.
 *
 * Straight runs joined by HAIRPINS, rather than the sine it started as, and both reasons are
 * measured. Length: a snake inside a box is limited by how close two passes may come, and a sine
 * reaches its limit early — 140 tiles of road on this map, a seventeen-second race, which next to
 * three laps of the raceway is not a race. Laid out as four runs and three hairpins the same box
 * holds 290. And character: a sine is one corner radius repeated, so nothing on it ever has to be
 * braked for, while a hairpin at half the band spacing is tighter than the tyres can hold at
 * speed — which is the one place this handling model has anything to say.
 *
 * The first stretch is straight by construction (a run, not a bend), which is what the grid needs:
 * a starting grid laid out along a bend is a grid where the inside row is half a car length ahead
 * before anybody moves.
 */
const HALF = spec.width / 2;
const STAGE_BANDS = spec.bands ?? 4;
const STAGE_PAD = 7;
const STAGE_GAP = (ROWS - 1 - 2 * STAGE_PAD) / (STAGE_BANDS - 1);
/** A hairpin is half the band spacing, because the two runs it joins are one spacing apart. That
 *  makes the radius a consequence of the layout rather than a number to tune: pack the runs closer
 *  and the corners get tighter on their own. */
const STAGE_TURN = STAGE_GAP / 2;
/**
 * A narrow sand verge, and then the road is simply over.
 *
 * A circuit is a road with a wall round it; a stage is a road through a landscape, and the
 * difference is what the two are FOR. Two versions of this map got it wrong in opposite
 * directions: barriers between the runs made it a slab of red and white kerb, and sand wide enough
 * to meet between them made it a beige field. A tile and a half of sand and then grass leaves the
 * meadow — the thing this round exists to put on the map — visible between every pair of runs, and
 * a car that slides off gets the run-off, then the grass, then nothing worse.
 *
 * Nothing stops a car cutting straight across from one run to the next, and nothing needs to: the
 * gates are a ring walked IN ORDER, with one at every hairpin, so a cut misses them and buys a
 * slower route to the same place.
 */
const STAGE_SAND = 1.5;
/**
 * How far the runs reach — DERIVED, because every part of it is already decided elsewhere: the
 * hairpin bulges one radius past the end of the run, the road carries its half-width plus two of
 * sand and one of barrier, and a tile of grass outside that keeps the circuit from being welded to
 * the edge of the world. Written as a number instead, it is a number that silently stops being
 * right the moment the band count changes.
 */
const STAGE_EDGE = Math.ceil(STAGE_TURN + HALF + STAGE_SAND + 3);
const STAGE_LEFT = STAGE_EDGE;
const STAGE_RIGHT = COLS - 1 - STAGE_EDGE;

const stagePts: Array<{ x: number; y: number }> = [];
if (spec.kind === 'sprint') {
  const push = (x: number, y: number): void => {
    const last = stagePts[stagePts.length - 1];
    if (!last || Math.hypot(x - last.x, y - last.y) > 0.02) stagePts.push({ x, y });
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
 *  than at a fraction of an index — the samples are denser through the hairpins. */
const stageRun: number[] = [0];
for (let i = 1; i < stagePts.length; i++) {
  stageRun.push(stageRun[i - 1] + Math.hypot(stagePts[i].x - stagePts[i - 1].x, stagePts[i].y - stagePts[i - 1].y));
}
const STAGE_LENGTH = stageRun[stageRun.length - 1] ?? 0;
/** The point this far along the road, and which way it points there. */
const stageAt = (run: number): { x: number; y: number; dir: number } => {
  const want = Math.max(0, Math.min(STAGE_LENGTH, run));
  let lo = 0;
  let hi = stageRun.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (stageRun[mid] < want) lo = mid + 1;
    else hi = mid;
  }
  const p = stagePts[lo];
  const a = stagePts[Math.max(0, lo - 3)];
  const b = stagePts[Math.min(stagePts.length - 1, lo + 3)];
  return { x: p.x, y: p.y, dir: Math.atan2(b.y - a.y, b.x - a.x) };
};
/** Distance from every cell centre to the centreline, in tiles, and HOW FAR ALONG the road the
 *  nearest point of it was. Built by walking the LINE and touching the cells near it, not by asking
 *  every cell about every sample. */
const stageDist = new Float64Array(COLS * ROWS).fill(Infinity);
const stageNear = new Float64Array(COLS * ROWS).fill(-1);
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
if (spec.kind === 'sprint') {
  const reach = Math.ceil(HALF + STAGE_GAP);
  const touch = (fn: (cell: number, d: number, run: number) => void): void => {
    for (let i = 0; i < stagePts.length; i++) {
      const p = stagePts[i];
      for (let r = Math.max(0, Math.floor(p.y) - reach); r <= Math.min(ROWS - 1, Math.ceil(p.y) + reach); r++) {
        for (let c = Math.max(0, Math.floor(p.x) - reach); c <= Math.min(COLS - 1, Math.ceil(p.x) + reach); c++) {
          fn(r * COLS + c, Math.hypot(p.x - c, p.y - r), stageRun[i]);
        }
      }
    }
  };
  touch((cell, d, run) => {
    if (d < stageDist[cell]) {
      stageDist[cell] = d;
      stageNear[cell] = run;
    }
  });
  // A second pass, once every cell knows its own nearest stretch: anything off the road that a
  // DISTANT stretch also reaches is a gap between two passes of the course.
  touch((cell, d, run) => {
    if (stageDist[cell] <= HALF + STAGE_SAND) return;
    // Measured against HALF THE BAND SPACING plus a little, not against the shoulder width: the
    // midline between two runs is exactly half a spacing from each, and where that lands between
    // two integer rows neither of them is within a tighter bound — so a tighter test walled one
    // gap of three and left the others open, which is worse than walling none.
    if (d <= STAGE_GAP / 2 + 0.6 && Math.abs(run - stageNear[cell]) > STAGE_CUT_RUN) stageWall[cell] = 1;
  });
}
const distAt = (col: number, row: number): number =>
  col < 0 || row < 0 || col >= COLS || row >= ROWS ? Infinity : stageDist[row * COLS + col];
const onStageRoad = (col: number, row: number): boolean => distAt(col, row) <= HALF;
const onStageRunOff = (col: number, row: number): boolean => {
  const d = distAt(col, row);
  return d > HALF && d <= HALF + STAGE_SAND;
};
/**
 * The only wall on a stage is the edge of the world.
 *
 * A circuit's barrier follows the road, one tile outside it, because the road is the whole map. A
 * stage's landscape is the map, so a barrier hugging the road would cut it into corridors — and
 * that is exactly what it did. One frame, right around the outside, so nobody drives off into
 * nothing and everything inside it is somewhere to be.
 */
const onStageBarrier = (col: number, row: number): boolean =>
  col === 0 || row === 0 || col === COLS - 1 || row === ROWS - 1 ||
  (col > 0 && row > 0 && col < COLS && row < ROWS && stageWall[row * COLS + col] === 1);
const onStageOutfield = (col: number, row: number): boolean =>
  col > 0 && row > 0 && col < COLS - 1 && row < ROWS - 1 &&
  distAt(col, row) > HALF + STAGE_SAND && stageWall[row * COLS + col] !== 1;

const onRing = (col: number, row: number): boolean => {
  const inOuter = col >= OUTER.left && col <= OUTER.right && row >= OUTER.top && row <= OUTER.bottom;
  const inInfield = col >= INNER.left && col <= INNER.right && row >= INNER.top && row <= INNER.bottom;
  if (!(inOuter && !inInfield)) return false;
  // Along the bridge the top straight is only the three tiles of the bridge itself; the rest of
  // that stretch is open air.
  if (overBridgeSpan(col) && row < INNER.top) return onBridge(col, row);
  return true;
};
/** The barrier ring, one tile outside the road. */
const onBarrier = (col: number, row: number): boolean => {
  if (onRing(col, row)) return false;
  const touching = [
    [col + 1, row],
    [col - 1, row],
    [col, row + 1],
    [col, row - 1],
  ].some(([c, r]) => onRing(c, r));
  // BOTH sides get a barrier. The infield used to be left open as a drop, and that was wrong
  // twice over: it made half the map black (1571 void cells of 3344 on the raceway — the thing
  // that was reported as "everything except the track is black"), and a hole you can only fall
  // into at its rim is a wall that ends your race instead of one you bounce off. The drop that
  // was actually asked for is the BRIDGE, and the bridge still has none — a barrier there would
  // be exactly the wall-instead-of-a-drop this whole hazard exists not to be.
  if (overBridgeSpan(col) && row < INNER.top) return false;
  return touching;
};

/**
 * Where the landscape goes.
 *
 * The run-off is INSIDE the barrier and reachable: a two-tile apron of sand either side of the
 * road, so running wide costs time rather than the race. The outfield is everything past the
 * barrier, on BOTH sides — the frame around the circuit and the field in the middle of it — and
 * none of it can be reached, which is what lets it be planted. It exists so the circuit sits in
 * somewhere instead of in a black square.
 *
 * The one place that stays void is the air beside the BRIDGE. A hole has to look like one, and
 * that is the only hole left.
 */
const onRunOff = (col: number, row: number): boolean => {
  if (onRing(col, row) || onBarrier(col, row)) return false;
  // No run-off beside the BRIDGE — that stretch is meant to have nothing either side, and a strip
  // of sand there is a safety net under the one hazard the bridge exists for.
  if (overBridgeSpan(col) && row < INNER.top) return false;
  const inOuter = col >= OUTER.left && col <= OUTER.right && row >= OUTER.top && row <= OUTER.bottom;
  if (!inOuter) return false;
  // Inside the outer rectangle but off the road: only the two tiles nearest the road are sand,
  // and the rest of the infield stays a pit.
  for (let d = 1; d <= 2; d++) {
    for (const [c, r] of [[col + d, row], [col - d, row], [col, row + d], [col, row - d]]) {
      if (onRing(c, r)) return true;
    }
  }
  return false;
};
const onOutfield = (col: number, row: number): boolean => {
  if (onRing(col, row) || onBarrier(col, row) || onRunOff(col, row)) return false;
  // The air beside the BRIDGE stays void. Landscaping it would quietly fill in the one hazard the
  // whole bridge exists for: measured by looking at the map, the drop was gone — twice.
  if (overBridgeSpan(col) && row < INNER.top) return false;
  return true;
};

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
const stageGateCells: Array<Array<{ col: number; row: number }>> = [];
const chequered = new Set<string>();
const stageGrid: Array<{ col: number; row: number; slot: number; dir?: number }> = [];
const stageSpawns: Array<{ col: number; row: number }> = [];
if (spec.kind === 'sprint') {
  // The gates stop short of the end: the finish line is a ring of cells of its own, past the last
  // gate. One cell carries one Action, so a finish painted on top of a gate simply DELETES that
  // gate — which is how the first version of this map ended up with fifteen gates and a finish
  // that could be reached without passing the fifteenth.
  const lastGateRun = STAGE_LENGTH - STAGE_FINISH_RUN - 6;
  for (let g = 0; g <= STAGE_GATES; g++) {
    const run = g === STAGE_GATES
      ? STAGE_LENGTH - STAGE_FINISH_RUN
      : STAGE_GRID_RUN + ((lastGateRun - STAGE_GRID_RUN) * g) / (STAGE_GATES - 1);
    const p = stageAt(run);
    const nx = -Math.sin(p.dir);
    const ny = Math.cos(p.dir);
    const cells = new Map<string, { col: number; row: number }>();
    for (let u = -HALF - 1; u <= HALF + 1; u += 0.25) {
      const col = Math.round(p.x + nx * u);
      const row = Math.round(p.y + ny * u);
      if (onStageRoad(col, row)) cells.set(`${col},${row}`, { col, row });
    }
    stageGateCells.push([...cells.values()]);
  }
  // The line at either end is painted: the start you set off from and the one that ends it.
  for (const c of stageGateCells[0]) chequered.add(`${c.col},${c.row}`);
  for (const c of stageGateCells[STAGE_GATES]) chequered.add(`${c.col},${c.row}`);
  // Six rows of two on the straight that leads to the line, and the beacon on slot 0 pointing
  // east — which is the way every stage runs, because the centreline is a function of x.
  let gslot = 0;
  for (let i = 0; i < RING_GRID_ROWS; i++) {
    // Behind the line, down the first run — which is straight, so the two columns are level.
    const p = stageAt(STAGE_GRID_RUN - 3 - i * 5);
    const col = Math.round(p.x);
    for (const row of [Math.round(p.y) - 2, Math.round(p.y) + 2]) {
      stageGrid.push({ col, row, slot: gslot, ...(gslot++ === 0 ? { dir: 0 } : {}) });
    }
    stageSpawns.push({ col, row: Math.round(p.y) });
  }
}

const ground = new Array(COLS * ROWS).fill(0);
const collision = new Array(COLS * ROWS).fill(0);
const roughLayer = new Array(COLS * ROWS).fill(0);
for (let row = 0; row < ROWS; row++) {
  for (let col = 0; col < COLS; col++) {
    const i = row * COLS + col;
    if (isRoad(col, row)) {
      // A kerb stripe on the inner lane of a circuit, so the edge is visible before you are over
      // it; on a stage, the outermost tile of the road either side, which reads the same way.
      const inner = RING
        ? ((row === INNER.top - 1 || row === INNER.bottom + 1) && col >= INNER.left - 1 && col <= INNER.right + 1) ||
          ((col === INNER.left - 1 || col === INNER.right + 1) && row >= INNER.top - 1 && row <= INNER.bottom + 1)
        : distAt(col, row) > HALF - 1;
      // The start-finish band: a chequered line on the same tiles a gate covers, so what the eye
      // reads and what the engine counts are the same line.
      const onStartLine = RING
        ? col === START_LINE_COL && row >= INNER.bottom + 1 && row <= OUTER.bottom
        : chequered.has(`${col},${row}`);
      ground[i] = onStartLine
        ? (RING ? row : col) % 2 === 0
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
      // Sand: off the racing surface, slow, and it eats tyres — but you can drive out of it.
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
  properties: props,
});
const pit = (col: number, row: number) =>
  marker(col, row, [{ name: 'actionKind', type: 'string', value: 'racePit' }]);
const records = (col: number, row: number) =>
  marker(col, row, [{ name: 'actionKind', type: 'string', value: 'raceRecords' }]);
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

if (RING) {
/** Gate 0 across the bottom straight; then right, top, left — anticlockwise. */
const bottomRow = { from: INNER.bottom + 1, to: OUTER.bottom };
for (let row = bottomRow.from; row <= bottomRow.to; row++) objects.push(gate(START_LINE_COL, row, 0));
const midRow = Math.round((OUTER.top + OUTER.bottom) / 2);
const midCol = Math.round((OUTER.left + OUTER.right) / 2);
for (let col = INNER.right + 1; col <= OUTER.right; col++) objects.push(gate(col, midRow, 1));
// Gate 2 spans whatever the top straight IS at that column — which is the bridge, if the bridge
// reaches it. A gate off the road is a lap nobody can complete.
const gate2Top = overBridgeSpan(midCol) ? BRIDGE.top : OUTER.top;
for (let row = gate2Top; row <= INNER.top - 1; row++) objects.push(gate(midCol, row, 2));
for (let col = OUTER.left; col <= INNER.left - 1; col++) objects.push(gate(col, midRow, 3));
/**
 * The grid: six rows of two behind the line, on the long start-finish straight.
 *
 * Twelve, which is the field Dust Racing runs. Eight was a compromise with a shorter straight;
 * this one is seventy tiles long and there is no reason to leave four cars in the garage.
 */
let slot = 0;

// Five tiles between rows, because a car is four long: at three they overlapped the moment the
// art grew, and a starting grid where the cars intersect is not a grid.
for (let i = 0; i < RING_GRID_ROWS; i++) {
  const col = START_LINE_COL - 8 - i * 5;
  // These circuits run anticlockwise, so the grid on the bottom straight faces EAST (0°).
  for (const row of [INNER.bottom + 2, OUTER.bottom - 1]) objects.push(start(col, row, slot, slot++ === 0 ? 0 : undefined));
}

/**
 * The pit lane: boxes along the inside of the start-finish straight, just past the line.
 *
 * Inside rather than outside because the inside of that straight is the infield wall, so a car
 * that stops there is out of everybody's way — a pit box in the racing line would be a hazard
 * rather than a choice. Past the line, so a stop costs you the lap you are on and not the one you
 * have just completed, which is what makes the decision a real one.
 */
for (let col = START_LINE_COL + 3; col <= START_LINE_COL + 10; col++) {
  // One row OFF the inner barrier, not against it: a car is now wider than a tile, so a box on
  // the innermost row is a box no car can physically stand on — measured, the driver aimed at one
  // for seventy seconds, wedging and backing out, and never finished the lap.
  objects.push(pit(col, INNER.bottom + 2));
}
// The timing screen: one board at the end of the pit lane shows what this track has been lapped in.
objects.push(records(START_LINE_COL + 12, INNER.bottom + 2));

} else {
  /**
   * A stage places the same four kinds of marker and one more.
   *
   * No pit lane at all, and that is the stage's own rule rather than an omission: a run is short
   * enough that one set of tyres covers it, so what a circuit gives you as a strategic choice a
   * stage gives you as a constraint. Tyres still wear — driving it tidily is the only pit stop
   * there is.
   */
  for (let g = 0; g < STAGE_GATES; g++) {
    for (const c of stageGateCells[g]) objects.push(gate(c.col, c.row, g));
  }
  // The far end is a LINE, not a point: every one of its cells ends the race, so crossing it
  // anywhere on the road counts. A single tile would be a finish you could miss by a metre.
  for (const c of stageGateCells[STAGE_GATES]) objects.push(finish(c.col, c.row));
  for (const g of stageGrid) objects.push(start(g.col, g.row, g.slot, g.dir));
  for (const sp of stageSpawns) objects.push(spawn(sp.col, sp.row));
  // The timing screen stands on the sand beside the grid, where you walk past it on the way in.
  const board = stageAt(2);
  objects.push(records(Math.round(board.x), Math.round(board.y) - Math.ceil(HALF) - 1));
}



// Arrive IN the grid, down the lane between its two rows — not wherever the free-tile search
// happens to land. On a ring this long that is the difference between getting in a kart and
// walking half a lap to find one, and it was measured: a spawn seven tiles up the straight is
// already out of reach of every kart on it. A stage places its own, beside its own grid.
if (RING) for (let i = 0; i < RING_GRID_ROWS; i++) objects.push(spawn(START_LINE_COL - 8 - i * 5, INNER.bottom + 4));

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
  compressionlevel: -1,
  height: ROWS,
  infinite: false,
  layers: [
    tileLayer(1, 'Ground', 'GroundLayer', ground),
    // One decal layer, and it occludes: these are standing things, so they sort against whoever is
    // beside them rather than lying under. That only ever matters where somebody can stand, and
    // nobody can stand out here — so the honest reason to set it is that a tree IS an upright
    // object, not that anything today can tell.
    {
      ...tileLayer(4, 'Scenery', 'DecalLayer', decal),
      properties: [{ name: 'occludes', type: 'bool', value: true }],
    },
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
      draworder: 'topdown',
      id: 3,
      name: 'Actions',
      objects,
      opacity: 1,
      type: 'objectgroup',
      visible: true,
      x: 0,
      y: 0,
    },
  ],
  nextlayerid: 6,
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
    bytes: JSON.stringify(map, null, 1) + '\n',
    painted: ground.filter((g) => g).length,
    scenery: decal.filter((g) => g).length,
    markers: objects.length,
  };
}

let differs = false;
for (const spec of TRACKS) {
  const out = path.join(ZONES, `${spec.id}.tmj`);
  const { bytes, painted, scenery, markers } = buildTrack(spec);
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
      `${scenery} scenery, ${markers} markers, ${spec.laps} laps)`,
  );
}
if (CHECK) {
  if (differs) {
    console.error('run scripts/make-tracks.sh');
    process.exit(1);
  }
  console.log(`all ${TRACKS.length} tracks match the generator`);
}
