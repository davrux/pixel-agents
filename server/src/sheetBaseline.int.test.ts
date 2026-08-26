/**
 * Every bundled sheet's walking frames must stand ON the ground.
 *
 * The renderer draws a character with origin (0.5, 1): the frame's BOTTOM EDGE is the tile it
 * stands on, and overlays are placed off that too — `PhaserRenderer` puts the status marker
 * "34px above the feet of a baseline (32px) character" and scales bubble offsets by
 * `frameH / CHARACTER_BASELINE_HEIGHT`. So art whose feet are drawn in the middle of its frame
 * does not look wrong in the sheet and does not fail to load; it floats, a hand's width above
 * the floor, with its name tag too high, in every zone, forever.
 *
 * Nothing enforced this. `assets/characters/PROMPT.md` states it as prose ("the walk frames'
 * feet at rows 29–30", "in cols 0-2 the feet must rest on the bottom") and no code or test
 * checked it — which matters now that art can arrive from outside: a sheet drawn in another
 * editor and exported at a different canvas height lands feet-up-in-the-air, and the first
 * symptom is a screenshot somebody has to interpret.
 *
 * The rule is deliberately about the WALK track only, measured rather than assumed. Across the
 * 12 bundled sheets the walk frames sit 0–3 px above the bottom edge (characters 1–2, pets
 * 0–3), while frames overall span rows 25–31: a seated pose legitimately sits higher, and
 * demanding ground contact from those would be wrong. The walk track is also what every pose
 * without art falls back to (`spriteData.ts`'s stand frame is `walk.start + 1`), so it is the
 * one track whose ground contact is load-bearing for the whole sheet.
 */
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';

import { PNG } from 'pngjs';

import {
  PET_SPRITE_SPEC,
  resolveCharacterSpec,
  type CharacterSpec,
} from '@pixel/shared/office/sprites/characterSpec.js';

import { ASSETS_ROOT } from './assets.js';

/** How far above the frame's bottom edge a walking frame's lowest pixel may sit. Measured
 *  worst case in the bundled roster is 3 px (cat_0), so 4 leaves one px of headroom while
 *  still catching art that floats — the failure is 6 px and up. */
const GROUND_MARGIN = 4;

interface Sheet {
  name: string;
  png: PNG;
  spec: CharacterSpec;
}

/** The bundled sheets, each with the spec the LOADER would resolve for it — read through
 *  `resolveCharacterSpec` rather than re-deriving, so this cannot disagree with what the
 *  server actually slices. */
function sheets(): Sheet[] {
  const out: Sheet[] = [];
  const charDir = path.join(ASSETS_ROOT, 'assets', 'characters');
  for (const f of fs.readdirSync(charDir).filter((f) => /^char_\d+\.png$/.test(f)).sort()) {
    const manifest = path.join(charDir, f.replace(/\.png$/, '.json'));
    const raw = fs.existsSync(manifest) ? JSON.parse(fs.readFileSync(manifest, 'utf-8')) : undefined;
    out.push({
      name: `characters/${f}`,
      png: PNG.sync.read(fs.readFileSync(path.join(charDir, f))),
      spec: resolveCharacterSpec(raw),
    });
  }
  const petDir = path.join(ASSETS_ROOT, 'assets', 'pets');
  for (const f of fs.readdirSync(petDir).filter((f) => f.endsWith('.png')).sort()) {
    out.push({
      name: `pets/${f}`,
      png: PNG.sync.read(fs.readFileSync(path.join(petDir, f))),
      spec: PET_SPRITE_SPEC,
    });
  }
  return out;
}

/** Which columns one track owns: tracks claim the flat frame list in declaration order. */
function columnsOf(spec: CharacterSpec, track: string): number[] {
  let start = 0;
  for (const t of spec.tracks) {
    if (t.name === track) return Array.from({ length: t.frames }, (_, i) => start + i);
    start += t.frames;
  }
  return [];
}

/** The lowest row holding a non-transparent pixel in one cell, or -1 for an empty cell. */
function lowestInk(png: PNG, col: number, rowIdx: number, fw: number, fh: number): number {
  let lowest = -1;
  for (let y = 0; y < fh; y++) {
    for (let x = 0; x < fw; x++) {
      if (png.data[((rowIdx * fh + y) * png.width + col * fw + x) * 4 + 3] !== 0 && y > lowest) lowest = y;
    }
  }
  return lowest;
}

test('the bundled roster is what these checks think it is', () => {
  const all = sheets();
  assert.ok(all.length >= 12, `expected the bundled roster, found ${all.length}`);
  for (const { name, png, spec } of all) {
    assert.equal(png.width % spec.frame.w, 0, `${name}: width is not a whole number of ${spec.frame.w}px cells`);
    assert.equal(png.height % spec.frame.h, 0, `${name}: height is not a whole number of ${spec.frame.h}px rows`);
    assert.ok(columnsOf(spec, 'walk').length > 0, `${name}: its spec declares no walk track`);
  }
});

test('every walking frame stands on the bottom edge of its cell', () => {
  for (const { name, png, spec } of sheets()) {
    const { w: fw, h: fh } = spec.frame;
    const rows = png.height / fh;
    const cols = png.width / fw;
    for (const col of columnsOf(spec, 'walk')) {
      assert.ok(col < cols, `${name}: the walk track claims column ${col} of ${cols}`);
      for (let dir = 0; dir < rows; dir++) {
        const lowest = lowestInk(png, col, dir, fw, fh);
        assert.notEqual(lowest, -1, `${name}: walk frame ${col}, direction ${dir} is empty`);
        assert.ok(
          fh - 1 - lowest <= GROUND_MARGIN,
          `${name}: walk frame ${col}, direction ${dir} floats — lowest pixel in row ${lowest} of ${fh}, ` +
            `${fh - 1 - lowest}px above the bottom edge (max ${GROUND_MARGIN})`,
        );
      }
    }
  }
});

test('the check can fail — art lifted off the ground is caught', () => {
  // Guard on the guard. A threshold nobody has seen reject anything is indistinguishable from
  // no threshold at all, so this lifts a real sheet by one pixel more than the margin allows
  // and requires the measurement to notice.
  const [{ png, spec }] = sheets();
  const { w: fw, h: fh } = spec.frame;
  const lift = GROUND_MARGIN + 1;
  // One cell, copied out and then drawn `lift` rows higher. A single cell rather than the
  // whole sheet on purpose: shifting a sheet pulls the NEXT direction row's head into this
  // cell's bottom rows, which would leave ink near the floor and quietly pass.
  const cell = (raise: number): PNG => {
    const out = new PNG({ width: fw, height: fh });
    out.data.fill(0);
    for (let y = 0; y < fh; y++) {
      for (let x = 0; x < fw; x++) {
        const src = y + raise;
        if (src >= fh) continue;
        const from = (src * png.width + x) * 4;
        out.data.set(png.data.subarray(from, from + 4), (y * out.width + x) * 4);
      }
    }
    return out;
  };
  const before = lowestInk(cell(0), 0, 0, fw, fh);
  const after = lowestInk(cell(lift), 0, 0, fw, fh);
  assert.equal(before, lowestInk(png, 0, 0, fw, fh), 'the copy must be the cell as it is');
  assert.equal(after, before - lift, `lifting by ${lift} must move the lowest pixel up by ${lift}`);
  assert.ok(fh - 1 - before <= GROUND_MARGIN, 'the unmodified cell stands on the ground');
  assert.ok(fh - 1 - after > GROUND_MARGIN, 'and the lifted one is refused');
});
