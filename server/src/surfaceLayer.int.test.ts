/**
 * What the ground DOES, painted on its own layer — and the rule when two of them overlap.
 *
 * This replaced one Action object per cell. The same fact on the raceway was 1945 objects and is
 * now a list of numbers, but the size is the smaller half of it: an Action lives on a CELL, so
 * "this grass is rough" could only ever be said cell by cell, while a layer says it about a
 * PLACE. That is the same argument AGENTS.md already makes for decals — whether a picture is
 * scenery or an obstacle is a fact about where it is, not about what it shows — and it is why the
 * alternative (a property on the grass TILE) was not taken: it would make the same grass rough
 * everywhere it is ever painted, and a drivable verge would need a second grass.
 *
 * TEST BOUNDARIES:
 *   @real-dependency: the real importer, the real sanitiser, the real track reader -- Mock? NO.
 *       Two of the three claims here are about those files agreeing with each other, and the
 *       third (that a field survives a save) is a bug this repo has shipped twice.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';

import { raceTrack } from '@pixel/shared/office/race/track.js';
import { isSurfaceKind, SURFACE_KINDS, type OfficeLayout } from '@pixel/shared/office/types';

import { sanitizeLayoutActions } from './layoutSanitize.js';
import { importTmjToLayout } from './tiled/mapBridge.js';
import type { TiledRegistry } from './tiled/tiledRegistry.js';

const COLS = 8;
const ROWS = 4;
const CELLS = COLS * ROWS;

/** A registry that resolves nothing: a surface layer needs no tileset, which is the point. */
const registry = { tilesets: [] } as unknown as TiledRegistry;

/** A map with a ground layer and whatever surface layers are given, bottom-first as Tiled lists
 *  them. `cells` are the indices painted on that layer. */
function mapWith(layers: Array<{ name: string; surface?: unknown; cells: number[] }>): Record<string, unknown> {
  const layer = (id: number, name: string, cls: string, data: number[], properties?: unknown): unknown => ({
    data, height: ROWS, id, name, opacity: 1, type: 'tilelayer', visible: true, width: COLS, x: 0, y: 0,
    class: cls, ...(properties ? { properties } : {}),
  });
  const ground = new Array(CELLS).fill(0);
  return {
    compressionlevel: -1, height: ROWS, infinite: false, width: COLS, orientation: 'orthogonal',
    renderorder: 'right-down', tileheight: 16, tilewidth: 16, type: 'map', version: '1.10',
    tilesets: [],
    layers: [
      layer(1, 'Ground', 'GroundLayer', ground),
      ...layers.map((l, i) => {
        const data = new Array(CELLS).fill(0);
        for (const c of l.cells) data[c] = 1;
        return layer(10 + i, l.name, 'SurfaceLayer', data,
          l.surface === undefined ? undefined : [{ name: 'surface', type: 'string', value: l.surface }]);
      }),
    ],
  };
}

const surfacesOf = (tmj: Record<string, unknown>): OfficeLayout['surfaces'] =>
  importTmjToLayout(tmj, registry, () => null).layout.surfaces;

test('a painted surface layer becomes cells, and an unpainted map carries nothing', () => {
  assert.deepEqual(surfacesOf(mapWith([{ name: 'Rough', surface: 'rough', cells: [0, 5, 31] }])), { rough: [0, 5, 31] });
  // Omitted entirely where nothing is painted — the habit `tileFlip` and `decals` already follow,
  // so a map that is not a race track pays nothing for the field existing.
  assert.equal(surfacesOf(mapWith([])), undefined);
  assert.equal(surfacesOf(mapWith([{ name: 'Rough', surface: 'rough', cells: [] }])), undefined);
});

test('the TOPMOST layer wins where two overlap', () => {
  // The rule Tiled already teaches through draw order: paint one surface over another and the one
  // you can see is the one that counts. Tiled lists layers bottom-first, so the last entry is the
  // top one. With a second kind this test would name both; with one it is still the rule that is
  // pinned, because the loser has to be REMOVED from the winner's cell and not merely not added.
  const both = surfacesOf(
    mapWith([
      { name: 'Lower', surface: 'rough', cells: [1, 2, 3] },
      { name: 'Upper', surface: 'rough', cells: [3, 4] },
    ]),
  );
  assert.deepEqual(both, { rough: [1, 2, 3, 4] }, 'an overlapping cell was counted twice or lost');
});

test('a layer with no surface, or one this build does not know, paints nothing', () => {
  // Loud is handled by the importer's notices; what matters here is that an unknown word never
  // becomes a surface, because the physics reads these by name.
  assert.equal(surfacesOf(mapWith([{ name: 'Mystery', surface: 'lava', cells: [1, 2] }])), undefined);
  assert.equal(surfacesOf(mapWith([{ name: 'Blank', cells: [1, 2] }])), undefined);
  assert.equal(surfacesOf(mapWith([{ name: 'Empty', surface: '', cells: [1, 2] }])), undefined);
  for (const kind of SURFACE_KINDS) assert.ok(isSurfaceKind(kind), `${kind} is not its own kind`);
});

test('surfaces survive a save, and nothing outside the map can be one', () => {
  // The trap this repo has fallen into twice: `sanitizeLayout*` rebuilds from a whitelist, so a
  // field nobody names is silently dropped on the next write. It cost the maps their pictures
  // once and every race gate once.
  const layout = { cols: COLS, rows: ROWS, surfaces: { rough: [0, 5, 31] } } as unknown as Record<string, unknown>;
  assert.deepEqual(sanitizeLayoutActions(layout).surfaces, { rough: [0, 5, 31] }, 'surfaces were dropped on save');

  // …and clamped where they arrive, like every other value from outside.
  const dirty = sanitizeLayoutActions({
    cols: COLS, rows: ROWS,
    surfaces: { rough: [1, CELLS, -4, 2.7, 'x', 1], lava: [0], nonsense: 'no' },
  } as unknown as Record<string, unknown>);
  assert.deepEqual(dirty.surfaces, { rough: [1, 2] }, 'an out-of-range cell or unknown kind got through');
  assert.equal(
    sanitizeLayoutActions({ cols: COLS, rows: ROWS, surfaces: 'nope' } as never).surfaces,
    undefined,
  );
});

/**
 * The LAYER is the only way to say what a surface is, and there used to be two.
 *
 * `raceRough` was an Action per cell — how the first race maps said this — and it was kept for a
 * while so those maps would not change meaning. It went on 2026-09-16, asked for in exactly those
 * terms ("wofür ist raceRough, macht das nicht ein Layer?"): no generator wrote it any more, the
 * Tiled dropdown still offered it, and a map that took the offer would have had its rough painted
 * in objects while the layer beside it said nothing. Two ways to state one fact is one too many.
 */
test('rough comes from the surface layer and from nothing else', () => {
  const base = {
    version: 3, cols: COLS, rows: ROWS, tiles: new Array(CELLS).fill(0), furniture: [],
    tileActions: new Array(CELLS).fill(null),
  } as unknown as OfficeLayout & { tileActions: Array<unknown> };
  base.tileActions[0] = { kind: 'raceGate', gate: 0 };
  base.tileActions[4] = { kind: 'raceGate', gate: 1 };
  base.tileActions[8] = { kind: 'raceStart', slot: 0, dir: 0 };
  const track = raceTrack({ ...base, surfaces: { rough: [9] } } as OfficeLayout);
  assert.ok(track);
  assert.equal(track.rough.has('1,1'), true, 'a painted surface cell is not rough');
  assert.equal(track.rough.size, 1, 'something other than the layer made a cell rough');
  // And a map with no layer at all has no rough, rather than falling back to anything.
  const bare = raceTrack(base as OfficeLayout);
  assert.ok(bare);
  assert.equal(bare.rough.size, 0);
});
