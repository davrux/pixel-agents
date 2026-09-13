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
  cols: number;
  rows: number;
  /** How wide the road is, in tiles. Five is quick and unforgiving; seven is friendlier. */
  width: number;
  laps: number;
  /** Where the finish line sits, as a column. */
  startCol: number;
  /** A stretch of the far straight with no barrier and a drop either side, or none. */
  bridge: { from: number; to: number; width: number } | null;
}

const TRACKS: readonly TrackSpec[] = [
  {
    id: 'raceway',
    label: 'Raceway',
    cols: 76,
    rows: 44,
    width: 5,
    laps: 3,
    startCol: 40,
    bridge: { from: 26, to: 46, width: 4 },
  },
  {
    // Shorter, wider and twice as many laps: a circuit you can actually race side by side on,
    // where the raceway is a test of whether you can keep it out of the pit. No bridge — one
    // hazard shared by every track would make them the same track with different numbers.
    id: 'speedway',
    label: 'Speedway',
    cols: 48,
    rows: 34,
    width: 7,
    laps: 6,
    startCol: 26,
    bridge: null,
  },
];

function buildTrack(spec: TrackSpec): { bytes: string; painted: number; markers: number } {
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
  // Only the OUTSIDE gets a barrier; the infield stays a pit, which is the whole point. And the
  // bridge gets none at all — a barrier there would be a wall to bounce off instead of a drop.
  const inInfield = col >= INNER.left && col <= INNER.right && row >= INNER.top && row <= INNER.bottom;
  if (overBridgeSpan(col) && row < INNER.top) return false;
  return touching && !inInfield;
};

const ground = new Array(COLS * ROWS).fill(0);
const collision = new Array(COLS * ROWS).fill(0);
for (let row = 0; row < ROWS; row++) {
  for (let col = 0; col < COLS; col++) {
    const i = row * COLS + col;
    if (onRing(col, row)) {
      // A kerb stripe on the inner lane, so the edge of the pit is visible before you are in it.
      const inner =
        (row === INNER.top - 1 || row === INNER.bottom + 1) && col >= INNER.left - 1 && col <= INNER.right + 1;
      const innerSide =
        (col === INNER.left - 1 || col === INNER.right + 1) && row >= INNER.top - 1 && row <= INNER.bottom + 1;
      // The start-finish band: a chequered column across the bottom straight, on the same tiles
      // gate 0 covers, so what the eye reads and what the engine counts are the same line.
      const onStartLine = col === START_LINE_COL && row >= INNER.bottom + 1 && row <= OUTER.bottom;
      ground[i] = onStartLine
        ? row % 2 === 0
          ? gidOf('chequerA')
          : gidOf('chequerB')
        : inner || innerSide
          ? kerbAt(col, row)
          : roadAt(col, row);
    } else if (onBarrier(col, row)) {
      // Ground under the barrier as well: it is a wall, not a hole.
      ground[i] = kerbAt(col, row);
      collision[i] = COLLISION_GID;
    }
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
const start = (col: number, row: number, slot: number) =>
  marker(col, row, [
    { name: 'actionKind', type: 'string', value: 'raceStart' },
    { name: 'actionSlot', type: 'int', value: slot },
  ]);

const objects: ReturnType<typeof marker>[] = [];
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
const GRID_ROWS = 6;
for (let i = 0; i < GRID_ROWS; i++) {
  const col = START_LINE_COL - 6 - i * 3;
  for (const row of [INNER.bottom + 2, OUTER.bottom - 1]) objects.push(start(col, row, slot++));
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
  objects.push(pit(col, INNER.bottom + 1));
}
// The timing screen: one board at the end of the pit lane shows what this track has been lapped in.
objects.push(records(START_LINE_COL + 12, INNER.bottom + 1));

// Arrive IN the grid, down the lane between its two rows — not wherever the free-tile search
// happens to land. On a ring this long that is the difference between getting in a kart and
// walking half a lap to find one, and it was measured: a spawn seven tiles up the straight is
// already out of reach of every kart on it.
for (let i = 0; i < GRID_ROWS; i++) objects.push(spawn(START_LINE_COL - 6 - i * 3, INNER.bottom + 3));

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
    tileLayer(2, 'Collision', 'CollisionLayer', collision),
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
  nextlayerid: 4,
  nextobjectid: objectId,
  orientation: 'orthogonal',
  properties: [
    { name: 'mapName', type: 'string', value: spec.id },
    { name: 'laps', type: 'int', value: spec.laps },
  ],
  renderorder: 'right-down',
  tiledversion: (src.tiledversion as string) ?? '1.11.0',
  tileheight: TILE,
  tilesets: [...srcSets, { firstgid: TRACK_FIRSTGID, source: '../track.tsj' }],
  tilewidth: TILE,
  type: 'map',
  version: (src.version as string) ?? '1.10',
  width: COLS,
};

  return {
    bytes: JSON.stringify(map, null, 1) + '\n',
    painted: ground.filter((g) => g).length,
    markers: objects.length,
  };
}

let differs = false;
for (const spec of TRACKS) {
  const out = path.join(ZONES, `${spec.id}.tmj`);
  const { bytes, painted, markers } = buildTrack(spec);
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
      `${markers} markers, ${spec.laps} laps)`,
  );
}
if (CHECK) {
  if (differs) {
    console.error('run scripts/make-tracks.sh');
    process.exit(1);
  }
  console.log(`all ${TRACKS.length} tracks match the generator`);
}
