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

const ground = new Array(COLS * ROWS).fill(0);
const collision = new Array(COLS * ROWS).fill(0);
const rough: Array<{ col: number; row: number }> = [];
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
    } else if (onRunOff(col, row)) {
      // Sand: off the racing surface, slow, and it eats tyres — but you can drive out of it.
      ground[i] = sandAt(col, row);
      rough.push({ col, row });
    } else if (onOutfield(col, row)) {
      // Grass, past the barrier. Nothing can reach it, so it is landscape — and landscape is the
      // whole point: a circuit in a black square reads as a diagram of a circuit.
      ground[i] = grassAt(col, row);
      rough.push({ col, row });
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
  onOutfield(col, row) && onOutfield(col, row - 1) && onOutfield(col + 1, row) && onOutfield(col + 1, row - 1);
for (let row = 0; row < ROWS; row++) {
  for (let col = 0; col < COLS; col++) {
    if (!onOutfield(col, row)) continue;
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
  objects.push(pit(col, INNER.bottom + 1));
}
// The timing screen: one board at the end of the pit lane shows what this track has been lapped in.
objects.push(records(START_LINE_COL + 12, INNER.bottom + 1));

// Every sand and grass cell is marked off-surface, so the physics and the computer drivers both
// know the road from the scenery.
for (const cell of rough) objects.push(marker(cell.col, cell.row, [
  { name: 'actionKind', type: 'string', value: 'raceRough' },
]));

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
    // One decal layer, and it occludes: these are standing things, so they sort against whoever is
    // beside them rather than lying under. That only ever matters where somebody can stand, and
    // nobody can stand out here — so the honest reason to set it is that a tree IS an upright
    // object, not that anything today can tell.
    {
      ...tileLayer(4, 'Scenery', 'DecalLayer', decal),
      properties: [{ name: 'occludes', type: 'bool', value: true }],
    },
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
  nextlayerid: 5,
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
