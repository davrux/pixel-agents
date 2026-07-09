/**
 * Parse Veloren's humanoid .ron manifests → a single catalog.json the voxel
 * client can consume (RON isn't JSON, so we parse it here at build time rather
 * than in the browser). Emits, under client/public/models/veloren/:
 *   - species: head/hairs/beards/eyes (+ combined bone offsets) per species×gender
 *   - hairColors: real per-species hair palettes (humanoid_color_manifest.ron)
 *   - armor: chest/pants/belt/foot/back (single) + hand/shoulder (left/right),
 *            each {path, offset, color} straight from the *_manifest.ron files
 *
 * Run: node scripts/gen-veloren-catalog.mjs
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'client', 'public', 'models', 'veloren');
const MAN = join(ROOT, 'manifests');
const read = (f) => readFileSync(join(MAN, f), 'utf8');
const path2file = (p) => p.replace(/\./g, '/') + '.vox';
const exists = (p) => existsSync(join(ROOT, path2file(p)));
const num = (s) => s.split(',').map((x) => parseFloat(x.trim()));
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

// Per-asset offset tweaks: some Veloren offsets don't line up on our skeleton.
// The cloth belts share manifest z=-6, but their vox geometry differs: turq/black
// have a high z-centroid (~8.4) so -6 lands them at the waist (correct), while
// cloth_blood's centroid is low (~2.4), leaving it at the thigh — raise it to z=0
// (+6) so its centroid matches the reference `none` belt's waist height.
const OFFSET_FIX = {
  'armor/misc/belt/cloth_blood.vox': [0, 0, 6],
};

// One `( vox_spec: ("path", (x,y,z)), color: None|Some((r,g,b)) )` piece.
const PIECE = /vox_spec:\s*\("([^"]+)",\s*\(([-\d.\s,]+)\)\)\s*,?\s*color:\s*(None|Some\(\(\s*([\d\s,]+)\)\))/g;
function pieces(text) {
  const out = [];
  let m;
  PIECE.lastIndex = 0;
  while ((m = PIECE.exec(text))) {
    const path = m[1];
    if (path === 'armor.empty' || !exists(path)) continue; // skip the empty/no-op + missing files
    const color = m[3].startsWith('Some') ? num(m[4]).map(Math.round) : null;
    const file = path2file(path);
    const o = num(m[2]);
    const fix = OFFSET_FIX[file];
    if (fix) for (let i = 0; i < 3; i++) o[i] += fix[i];
    out.push({ vox: file, o, color });
  }
  return out;
}

// ── Species heads / hair / beards / eyes ─────────────────────────────────────
const headRon = read('humanoid_head_manifest.ron');
const speciesRe = /\((Human|Elf|Dwarf|Orc|Danari|Draugr),\s*(Male|Female)\):\s*\(/g;
const marks = [];
let mm;
while ((mm = speciesRe.exec(headRon))) marks.push({ sp: mm[1], ge: mm[2], i: mm.index });

const partList = (block, key) => {
  const s = block.indexOf(key + ':');
  if (s < 0) return [];
  const arrStart = block.indexOf('[', s);
  const arrEnd = block.indexOf(']', arrStart);
  const chunk = block.slice(arrStart, arrEnd);
  const out = [];
  const re = /"([^"]+)",\s*\(([-\d\s,]+)\)/g;
  let m;
  while ((m = re.exec(chunk))) if (exists(m[1])) out.push({ vox: path2file(m[1]), sub: num(m[2]) });
  return out;
};

const species = [];
for (let k = 0; k < marks.length; k++) {
  const block = headRon.slice(marks[k].i, k + 1 < marks.length ? marks[k + 1].i : headRon.length);
  const off = num(block.match(/offset:\s*\(([-\d.,\s]+)\)/)[1]);
  const headM = block.match(/head:\s*\("([^"]+)",\s*\(([-\d\s,]+)\)\)/);
  const combine = (vox, sub) => ({ vox, o: add(off, sub) });
  species.push({
    id: (marks[k].sp + '_' + marks[k].ge).toLowerCase(),
    sp: marks[k].sp.toLowerCase(),
    gender: marks[k].ge.toLowerCase(),
    head: combine(path2file(headM[1]), num(headM[2])),
    hairs: partList(block, 'hair').map((p) => combine(p.vox, p.sub)),
    beards: partList(block, 'beard').map((p) => combine(p.vox, p.sub)),
    eyes: partList(block, 'eyes').map((p) => combine(p.vox, p.sub)),
  });
}

// ── Hair colours (real per-species palettes) ─────────────────────────────────
const colRon = read('humanoid_color_manifest.ron');
const hairColors = {};
const hcBlock = colRon.slice(colRon.indexOf('hair_colors:'));
for (const sp of ['Human', 'Elf', 'Dwarf', 'Orc', 'Danari', 'Draugr']) {
  const s = hcBlock.indexOf(sp + ':');
  if (s < 0) continue;
  const chunk = hcBlock.slice(hcBlock.indexOf('[', s), hcBlock.indexOf(']', s));
  const cols = [];
  const re = /\(\s*(\d+),\s*(\d+),\s*(\d+)\s*\)/g;
  let m;
  while ((m = re.exec(chunk))) cols.push([+m[1], +m[2], +m[3]]);
  hairColors[sp.toLowerCase()] = cols;
}

// ── Armor (single-piece + left/right slots) ──────────────────────────────────
const armor = {};
for (const slot of ['chest', 'pants', 'belt', 'foot', 'back']) {
  armor[slot] = pieces(read(`humanoid_armor_${slot}_manifest.ron`));
}
for (const slot of ['hand', 'shoulder']) {
  const text = read(`humanoid_armor_${slot}_manifest.ron`);
  // Split into entries at `default: (` and each `"key": (`, then take left+right.
  const parts = text.split(/(?:"[^"]+"|default)\s*:\s*\(/).slice(1);
  const out = [];
  for (const p of parts) {
    const pcs = pieces(p);
    if (pcs.length >= 2) out.push({ left: pcs[0], right: pcs[1] });
    else if (pcs.length === 1) out.push({ left: pcs[0], right: pcs[0] });
  }
  armor[slot] = out;
}

// ── Weapons (held in the main hand) ──────────────────────────────────────────
// Curated to recognisable one-hand-ish types so held items look sensible; deduped
// by vox path (many tiers reuse the same model).
const WEAPON_TYPES = /weapon\/(sword|axe|hammer|dagger|bow|staff|sceptre|spear)\//;
const seenW = new Set();
const weapons = [];
for (const p of pieces(read('biped_weapon_manifest.ron'))) {
  if (!WEAPON_TYPES.test(p.vox) || seenW.has(p.vox)) continue;
  seenW.add(p.vox);
  weapons.push(p);
}

const catalog = { species, hairColors, armor, weapons };
writeFileSync(join(ROOT, 'catalog.json'), JSON.stringify(catalog));
console.log('species:', species.length);
for (const s of species) console.log(' ', s.id, `hair=${s.hairs.length} beard=${s.beards.length} eyes=${s.eyes.length}`);
console.log('hairColors:', Object.fromEntries(Object.entries(hairColors).map(([k, v]) => [k, v.length])));
console.log('armor:', Object.fromEntries(Object.entries(armor).map(([k, v]) => [k, v.length])));
console.log('weapons:', weapons.length);
