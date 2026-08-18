#!/usr/bin/env -S node --import tsx
/**
 * Look at an art sheet and PROPOSE what each cell is, with the evidence.
 *
 * Step 0 of importing a pack (see .claude/skills/tiled-asset-import). The
 * classification of a piece — ground, flat decoration, standing decoration, a thing
 * with behaviour — cannot be derived from pixels, and pretending otherwise is how
 * a well ends up as a floor pattern. What CAN be measured is the evidence a person
 * uses when they judge it by eye, and measuring it turns "look at 1440 cells" into
 * "confirm 1440 proposals", which is a different amount of work.
 *
 * Per cell it measures:
 *
 *   opacity      how much of the cell is painted. A ground cell fills it.
 *   self-tiling  does the left edge continue into the right, and top into bottom?
 *                Terrain tiles seamlessly with ITSELF; an object does not. This is
 *                the strongest single signal for "this is ground".
 *   continues    does the cell run into its neighbour? Then it is part of a bigger
 *                picture — a house, a cliff — and wants to be stamped as a block,
 *                which is an argument for importing the sheet as a GRID tileset.
 *   duplicate    an identical cell earlier in the sheet; terrain blocks repeat.
 *   bottom-heavy where the painted mass sits. A narrow base under a wide mass reads
 *                as standing art (a tree), which is what `occludes` is for.
 *
 * And proposes: EMPTY · GROUND · BLOCK (part of a larger picture) · FLAT · STANDING.
 *
 * What it cannot know, and says so: whether a thing needs behaviour (only then is it
 * furniture), and what it depicts. Both stay with the person.
 *
 * Usage (from server/):
 *   node --import tsx scripts/inspect-sheet.mts <sheet.png> [--tile 16] [--contact out.png]
 *
 * `--contact` writes a magnified sheet with a coloured frame per cell and its
 * proposal, so the eyes get the last word.
 */
import { PNG } from 'pngjs';
import * as fs from 'node:fs';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const T = Number(args[args.indexOf('--tile') + 1]) || 16;
const contactOut = args.includes('--contact') ? args[args.indexOf('--contact') + 1] : null;
if (!file || !fs.existsSync(file)) {
  console.error('usage: inspect-sheet.mts <sheet.png> [--tile 16] [--contact out.png]');
  process.exit(1);
}

const png = PNG.sync.read(fs.readFileSync(file));
const cols = Math.floor(png.width / T);
const rows = Math.floor(png.height / T);
const at = (x: number, y: number): [number, number, number, number] => {
  const i = (y * png.width + x) * 4;
  return [png.data[i], png.data[i + 1], png.data[i + 2], png.data[i + 3]];
};
const same = (a: [number, number, number, number], b: [number, number, number, number]) =>
  (a[3] === 0 && b[3] === 0) || (a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3]);

type Kind = 'EMPTY' | 'GROUND' | 'BLOCK' | 'FLAT' | 'STANDING';
interface Cell {
  col: number;
  row: number;
  opacity: number;
  selfTiling: boolean;
  continues: boolean;
  duplicateOf: string | null;
  bottomHeavy: boolean;
  kind: Kind;
}

/** Column/row signatures, so duplicate detection is a map lookup rather than N². */
function signature(c: number, r: number): string {
  let s = '';
  for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) s += at(c * T + x, r * T + y).join(',') + ';';
  return s;
}

const seen = new Map<string, string>();
const cells: Cell[] = [];
for (let r = 0; r < rows; r++) {
  for (let c = 0; c < cols; c++) {
    const ox = c * T;
    const oy = r * T;
    let painted = 0;
    let bottomMass = 0;
    let topMass = 0;
    for (let y = 0; y < T; y++) {
      for (let x = 0; x < T; x++) {
        if (at(ox + x, oy + y)[3] === 0) continue;
        painted++;
        if (y >= T / 2) bottomMass++;
        else topMass++;
      }
    }
    const opacity = painted / (T * T);
    if (painted === 0) {
      cells.push({ col: c, row: r, opacity: 0, selfTiling: false, continues: false, duplicateOf: null, bottomHeavy: false, kind: 'EMPTY' });
      continue;
    }
    // Self-tiling: this cell's own right edge continuing into its own left edge, and
    // bottom into top — what makes a terrain cell usable as a fill.
    //
    // Tolerantly, not exactly: hand-drawn grass or water varies from pixel to pixel,
    // so demanding identical edges found almost nothing (29 of 1440 on the Overworld
    // sheet) while the sheet is visibly full of terrain. What distinguishes a lawn
    // from a house wall is that the lawn CONTINUES across its own seam — most of the
    // edge agrees — where a wall has a corner, a beam or a window there.
    const EDGE_TOLERANCE = 0.25;
    let hMismatch = 0;
    let vMismatch = 0;
    for (let y = 0; y < T; y++) if (!same(at(ox + T - 1, oy + y), at(ox, oy + y))) hMismatch++;
    for (let x = 0; x < T; x++) if (!same(at(ox + x, oy + T - 1), at(ox + x, oy))) vMismatch++;
    const hWrap = hMismatch / T <= EDGE_TOLERANCE;
    const vWrap = vMismatch / T <= EDGE_TOLERANCE;
    // Continuity into the neighbour to the right / below, if there is one.
    let contRight = c + 1 < cols;
    let contDown = r + 1 < rows;
    for (let y = 0; y < T && contRight; y++) if (at(ox + T - 1, oy + y)[3] === 0 || at(ox + T, oy + y)[3] === 0) contRight = false;
    for (let x = 0; x < T && contDown; x++) if (at(ox + x, oy + T - 1)[3] === 0 || at(ox + x, oy + T)[3] === 0) contDown = false;

    const sig = signature(c, r);
    const dup = seen.get(sig) ?? null;
    if (!dup) seen.set(sig, `${c},${r}`);

    const selfTiling = hWrap && vWrap;
    const continues = contRight || contDown;
    const bottomHeavy = bottomMass > topMass * 1.6;
    // The proposal, in the order the evidence is trustworthy.
    const kind: Kind =
      opacity > 0.98 && selfTiling ? 'GROUND'
      : opacity > 0.98 && continues ? 'BLOCK'
      : bottomHeavy && opacity < 0.9 ? 'STANDING'
      : 'FLAT';
    cells.push({ col: c, row: r, opacity, selfTiling, continues, duplicateOf: dup, bottomHeavy, kind });
  }
}

const count = (k: Kind) => cells.filter((x) => x.kind === k).length;
console.log(`${file}: ${png.width}×${png.height} = ${cols}×${rows} cells of ${T}px\n`);
console.log('proposal      cells   what it means');
console.log(`EMPTY         ${String(count('EMPTY')).padStart(5)}   nothing painted — no tile entry, nothing can resolve there`);
console.log(`GROUND        ${String(count('GROUND')).padStart(5)}   fills its cell AND tiles with itself → a floor pattern`);
console.log(`BLOCK         ${String(count('BLOCK')).padStart(5)}   fills its cell and runs into a neighbour → part of a bigger picture, stamp it`);
console.log(`FLAT          ${String(count('FLAT')).padStart(5)}   painted, not bottom-heavy → decoration lying on the ground`);
console.log(`STANDING      ${String(count('STANDING')).padStart(5)}   mass above a narrower base → decoration to walk behind (occludes)`);
const dups = cells.filter((c) => c.duplicateOf).length;
console.log(`\n${dups} cells repeat art that appears earlier in the sheet.`);
console.log('A sheet with many BLOCK cells wants to be imported as a GRID tileset:');
console.log('its arrangement is the content, and slicing it apart destroys what you paint from.\n');
console.log('NOT measurable, and yours to decide: whether a piece needs BEHAVIOUR — only');
console.log('then is it furniture — and what it depicts (a puddle is ground, a well is not).');

if (contactOut) {
  // 3× magnified, one frame per cell in the proposal's colour. Eyes get the last word.
  const S = 3;
  const out = new PNG({ width: cols * T * S, height: rows * T * S });
  out.data.fill(0);
  const colour: Record<Kind, [number, number, number]> = {
    EMPTY: [40, 40, 40],
    GROUND: [80, 200, 100],
    BLOCK: [90, 150, 240],
    FLAT: [230, 200, 80],
    STANDING: [230, 110, 90],
  };
  for (const cell of cells) {
    for (let y = 0; y < T * S; y++) {
      for (let x = 0; x < T * S; x++) {
        const [r0, g0, b0, a0] = at(cell.col * T + Math.floor(x / S), cell.row * T + Math.floor(y / S));
        const edge = x < S || y < S || x >= T * S - S || y >= T * S - S;
        const i = ((cell.row * T * S + y) * out.width + (cell.col * T * S + x)) * 4;
        const [cr, cg, cb] = colour[cell.kind];
        out.data[i] = edge ? cr : r0;
        out.data[i + 1] = edge ? cg : g0;
        out.data[i + 2] = edge ? cb : b0;
        out.data[i + 3] = edge ? 255 : a0;
      }
    }
  }
  fs.writeFileSync(contactOut, PNG.sync.write(out));
  console.log(`\ncontact sheet → ${contactOut} (green GROUND · blue BLOCK · yellow FLAT · red STANDING · grey EMPTY)`);
}
