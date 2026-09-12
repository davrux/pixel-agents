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
 * Run: scripts/make-raceway.sh [--check]
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO = path.join(import.meta.dirname, '..', '..');
const SRC = path.join(REPO, 'assets', 'tiled', 'zones', 'uponu.tmj');
const OUT = path.join(REPO, 'assets', 'tiled', 'zones', 'raceway.tmj');
const CHECK = process.argv.includes('--check');

const COLS = 76;
const ROWS = 44;
/**
 * The four tiles this track is painted with, all of them already in the tileset table copied
 * below. No new art: what makes a ring read as a CIRCUIT rather than as a grey donut is which
 * existing tiles go where.
 *
 *  - `ROAD` is plain asphalt out of the imported road sheet (decal-roads, local 100).
 *  - `KERB_RED`/`KERB_WHITE` are two solid colours out of the palette-baked floor set, laid in
 *    alternating pairs. A red-and-white kerb is what a circuit actually has, so the edge of the
 *    pit is legible from any distance — the first version painted a single flat blue and read as
 *    a bug rather than as a boundary.
 *  - `LINE_DARK` is the other half of the chequered start-finish band.
 */
const ROAD_GID = 8864 + 100;
const KERB_RED_GID = 1171 + 62;
const KERB_WHITE_GID = 1171 + 24;
const LINE_DARK_GID = 1171 + 2;
const COLLISION_GID = 7021;

/** Alternating pairs, along whichever axis the stripe runs. */
const kerbAt = (col: number, row: number): number =>
  Math.floor((col + row) / 2) % 2 === 0 ? KERB_RED_GID : KERB_WHITE_GID;

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
const OUTER = { left: 2, right: COLS - 3, top: 2, bottom: ROWS - 3 };
const INNER = { left: 7, right: COLS - 8, top: 7, bottom: ROWS - 8 };
/** Where the lap is counted, and where the chequered band is painted. One constant, so the
 *  picture and the gate cannot drift apart. */
const START_LINE_COL = 40;

const onRing = (col: number, row: number): boolean => {
  const inOuter = col >= OUTER.left && col <= OUTER.right && row >= OUTER.top && row <= OUTER.bottom;
  const inInfield = col >= INNER.left && col <= INNER.right && row >= INNER.top && row <= INNER.bottom;
  return inOuter && !inInfield;
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
  // Only the OUTSIDE gets a barrier; the infield stays a pit, which is the whole point.
  const inInfield = col >= INNER.left && col <= INNER.right && row >= INNER.top && row <= INNER.bottom;
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
          ? KERB_WHITE_GID
          : LINE_DARK_GID
        : inner || innerSide
          ? kerbAt(col, row)
          : ROAD_GID;
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
for (let row = OUTER.top; row <= INNER.top - 1; row++) objects.push(gate(midCol, row, 2));
for (let col = OUTER.left; col <= INNER.left - 1; col++) objects.push(gate(col, midRow, 3));
/** The grid: four rows of two behind the line, on the long start-finish straight. */
let slot = 0;
for (const col of [START_LINE_COL - 6, START_LINE_COL - 9, START_LINE_COL - 12, START_LINE_COL - 15]) {
  for (const row of [INNER.bottom + 2, OUTER.bottom - 1]) objects.push(start(col, row, slot++));
}

// Arrive IN the grid, down the lane between its two rows — not wherever the free-tile search
// happens to land. On a ring this long that is the difference between getting in a kart and
// walking half a lap to find one, and it was measured: a spawn seven tiles up the straight is
// already out of reach of every kart on it.
const gridCols = [START_LINE_COL - 15, START_LINE_COL - 12, START_LINE_COL - 9, START_LINE_COL - 6];
for (const col of gridCols) objects.push(spawn(col, INNER.bottom + 3));

const src = JSON.parse(fs.readFileSync(SRC, 'utf8')) as Record<string, unknown>;
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
    { name: 'mapName', type: 'string', value: 'raceway' },
    { name: 'laps', type: 'int', value: 3 },
  ],
  renderorder: 'right-down',
  tiledversion: (src.tiledversion as string) ?? '1.11.0',
  tileheight: TILE,
  tilesets: src.tilesets,
  tilewidth: TILE,
  type: 'map',
  version: (src.version as string) ?? '1.10',
  width: COLS,
};

const json = JSON.stringify(map, null, 1) + '\n';
if (CHECK) {
  const onDisk = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (onDisk !== json) {
    console.error(`${OUT} differs from the generator — run scripts/make-raceway.sh`);
    process.exit(1);
  }
  console.log(`${OUT} matches the generator`);
} else {
  fs.writeFileSync(OUT, json);
  const road = ground.filter((g) => g).length;
  console.log(`wrote ${OUT} (${COLS}x${ROWS}, ${road} painted cells, ${objects.length} markers, 3 laps)`);
}
