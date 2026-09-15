/**
 * A sheet's declared grid and its actual PNG agree, and the client is told all of it.
 *
 * The client cuts a cell out of a sheet with arithmetic — `margin + col * (w + spacing)` — so
 * every term of that has to travel. `margin` did not, and the off-by-one it caused was one PIXEL
 * rather than one cell, which is why it survived every eye that looked at a map: each cell was cut
 * one pixel to the left, and that column is the previous tile's extrusion. Between two greens it
 * is invisible. Lay asphalt next to sand in the same sheet and it is a tan stripe down black
 * tarmac, flickering as the camera moves — which is how it was finally reported.
 *
 * So this checks the geometry against the FILES rather than against itself: for every grid
 * tileset, the size its own numbers imply must be the size its PNG actually is. That catches a
 * missing margin, a wrong column count and a re-baked sheet whose reader was not updated.
 *
 * TEST BOUNDARIES:
 *   @real-dependency: the committed .tsj files and their PNGs -- Mock? NO. The claim is that those
 *       two agree; a fixture would only prove the arithmetic agrees with itself.
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { PNG } from 'pngjs';

import { gridSheets, loadTiledRegistry } from './tiled/tiledRegistry.js';

const ROOT = join(import.meta.dirname, '..', '..');

test('every grid sheet is the size its own margin, spacing and columns imply', () => {
  const sheets = gridSheets(loadTiledRegistry(ROOT));
  assert.ok(sheets.length >= 8, `only ${sheets.length} grid sheets found`);
  let withMargin = 0;
  for (const s of sheets) {
    const png = PNG.sync.read(readFileSync(join(ROOT, 'assets', 'tiled', s.img)));
    if (s.margin > 0) withMargin++;
    // Width is exact: the sheet is `columns` cells wide with a gap between each and a margin round
    // the outside.
    const wantW = s.margin * 2 + s.columns * s.tileWidth + (s.columns - 1) * s.spacing;
    assert.equal(png.width, wantW, `${s.name}: declares ${s.columns} columns of ${s.tileWidth}px ` +
      `with spacing ${s.spacing} and margin ${s.margin}, which is ${wantW}px — the PNG is ${png.width}px`);
    // Height is a whole number of rows on the same grid.
    const rows = (png.height - 2 * s.margin + s.spacing) / (s.tileHeight + s.spacing);
    assert.equal(rows, Math.round(rows), `${s.name}: ${png.height}px is not a whole number of ${s.tileHeight}px rows`);
    assert.ok(rows >= 1, `${s.name}: no rows at all`);
  }
  // The margin is not hypothetical: the race art is generated with one so its outermost cell can
  // be extruded like every other. If this ever reaches zero, the bug above cannot come back — but
  // neither can the sheets, so it is worth knowing which case a future change is in.
  assert.ok(withMargin >= 2, `no sheet declares a margin any more — this test stopped covering anything`);
});
