#!/usr/bin/env -S node --import tsx
/** Throwaway check for the furniture-property refactor: load the real catalog,
 *  import the real maps, and assert the behaviour the retired properties used to
 *  produce is still produced — seats where chairs are, pet perches where desks
 *  are, the PC pair still switchable, and an instance override actually winning. */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { loadAssetBundle } from '../src/assets.js';
import { loadTiledRegistry } from '../src/tiled/tiledRegistry.js';
import { importTmjToLayout, exportLayoutToTmj } from '../src/tiled/mapBridge.js';
import { buildDynamicCatalog, getCatalogEntry, resolveOnState, resolveCanSitOn, resolveSitFacing, resolvePetCanSitOn } from '@pixel/shared/office/layout/furnitureCatalog.js';
import { layoutToSeats, createDefaultLayout } from '@pixel/shared/office/layout/layoutSerializer.js';
import { Direction } from '@pixel/shared/office/types.js';
import type { PlacedFurniture } from '@pixel/shared/office/types.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const bundle = await loadAssetBundle(ROOT);
const catalogRaw = bundle.raw.furnitureCatalog as Array<{ id: string }>;
if (!buildDynamicCatalog({ catalog: catalogRaw as never, sprites: bundle.raw.furnitureSprites as never })) {
  throw new Error('catalog failed to build');
}

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

const DIR = ['S', 'W', 'E', 'N'][0] && new Map<number, string>([
  [Direction.UP, 'N'],
  [Direction.RIGHT, 'E'],
  [Direction.DOWN, 'S'],
  [Direction.LEFT, 'W'],
]);

console.log('\n── Katalog ──');
const sittable = ['CUSHIONED_CHAIR_BACK', 'CUSHIONED_CHAIR_FRONT', 'CUSHIONED_CHAIR_SIDE', 'SOFA_BACK', 'SOFA_FRONT', 'SOFA_SIDE', 'WOODEN_CHAIR_BACK', 'WOODEN_CHAIR_FRONT', 'WOODEN_CHAIR_SIDE', 'CUSHIONED_BENCH', 'WOODEN_BENCH'];
check(`alle ${sittable.length} vormaligen 'chairs' sind sitzbar`, sittable.every((id) => getCatalogEntry(id)?.canSitOn === true));
const perches = ['COFFEE_TABLE', 'DESK_FRONT', 'DESK_SIDE', 'SMALL_TABLE_FRONT', 'SMALL_TABLE_SIDE', 'TABLE_FRONT'];
check(`alle ${perches.length} vormaligen 'desks' sind Haustier-Ablage`, perches.every((id) => getCatalogEntry(id)?.petCanSitOn === true));
// Deliberately NOT an allow-list: making a metro item sittable is ordinary
// content work, so a new one here is expected, not a regression. What must not
// happen is one of the originals losing it, which the two checks above cover.
const alsoSittable = catalogRaw.filter((a) => !sittable.includes(a.id) && getCatalogEntry(a.id)?.canSitOn).map((a) => a.id);
const alsoPerch = catalogRaw.filter((a) => !perches.includes(a.id) && getCatalogEntry(a.id)?.petCanSitOn).map((a) => a.id);
console.log(`  · zusätzlich sitzbar: ${alsoSittable.join(', ') || '—'}`);
console.log(`  · zusätzlich Ablage:  ${alsoPerch.join(', ') || '—'}`);
const asPlaced = (id: string, over: Record<string, unknown> = {}): PlacedFurniture => ({ uid: 'z', id, col: 0, row: 0, ...over });
const onOf = (id: string, over?: Record<string, unknown>): string => resolveOnState(asPlaced(id, over), getCatalogEntry(id));
check('PC-Zustandspaar auflösbar', onOf('PC_FRONT_OFF') === 'PC_FRONT_ON_1', `PC_FRONT_OFF → ${onOf('PC_FRONT_OFF')}`);
check('LAPTOP-Zustandspaar auflösbar', onOf('LAPTOP_FRONT_OFF') === 'LAPTOP_FRONT_ON_1');
check('ein Nicht-Paar bleibt es selbst', onOf('WOODEN_BENCH') === 'WOODEN_BENCH');
check('Instanz kann onState setzen', onOf('WOODEN_BENCH', { onState: 'PC_FRONT_ON_1' }) === 'PC_FRONT_ON_1');

console.log('\n── Blickrichtung: Instanz schlägt Katalog, Flip spiegelt nur den Default ──');
const chair = getCatalogEntry('WOODEN_CHAIR_SIDE')!;
const base = (over: Partial<PlacedFurniture> = {}): PlacedFurniture => ({ uid: 'x', id: 'WOODEN_CHAIR_SIDE', col: 0, row: 0, ...over });
check('Katalog-Default E', resolveSitFacing(base(), chair) === Direction.RIGHT, DIR!.get(resolveSitFacing(base(), chair)));
check('gespiegelt → W', resolveSitFacing(base({ flippedHorizontally: true }), chair) === Direction.LEFT, DIR!.get(resolveSitFacing(base({ flippedHorizontally: true }), chair)));
check('expliziter Wert wörtlich, trotz Flip', resolveSitFacing(base({ flippedHorizontally: true, sitFacing: Direction.RIGHT }), chair) === Direction.RIGHT);
check('Direction.DOWN (=0) überlebt als Override', resolveSitFacing(base({ sitFacing: Direction.DOWN }), chair) === Direction.DOWN);
const plant = getCatalogEntry('PLANT')!;
check('Default ohne Angabe ist N', resolveSitFacing({ uid: 'y', id: 'PLANT', col: 0, row: 0 }, plant) === Direction.UP);
check('Instanz kann Unsitzbares sitzbar machen', resolveCanSitOn({ uid: 'y', id: 'PLANT', col: 0, row: 0, canSitOn: true }, plant));
check('Instanz kann Sitzbares sperren', !resolveCanSitOn(base({ canSitOn: false }), chair));
check('Instanz kann Haustier-Ablage setzen', resolvePetCanSitOn({ uid: 'y', id: 'PLANT', col: 0, row: 0, petCanSitOn: true }, plant));

console.log('\n── Karten ──');
const registry = loadTiledRegistry(ROOT);
for (const file of fs.readdirSync(path.join(ROOT, 'assets', 'tiled', 'zones')).sort()) {
  if (!file.endsWith('.tmj')) continue;
  const tmj = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets', 'tiled', 'zones', file), 'utf-8'));
  const { layout } = importTmjToLayout(tmj, registry, () => null);
  const seats = layoutToSeats(layout.furniture);
  const facings = new Map<string, number>();
  for (const s of seats.values()) facings.set(DIR!.get(s.facingDir)!, (facings.get(DIR!.get(s.facingDir)!) ?? 0) + 1);
  const perch = layout.furniture.filter((f) => resolvePetCanSitOn(f, getCatalogEntry(f.id))).length;
  const unknown = layout.furniture.filter((f) => !getCatalogEntry(f.id));
  console.log(`  ${file}: ${layout.furniture.length} Möbel, ${seats.size} Sitzplätze (${[...facings].map(([d, n]) => `${d}:${n}`).join(' ')}), ${perch} Haustier-Ablagen`);
  check(`  ${file}: jede Platzierung hat eine Katalog-Kachel`, unknown.length === 0, unknown.map((f) => f.id).join(', '));
}

console.log('\n── Round-Trip: Export → Import ──');
{
  const layout = createDefaultLayout();
  layout.furniture = [
    { uid: 'a', id: 'WOODEN_CHAIR_SIDE', col: 2, row: 2 },                                // erbt alles
    { uid: 'b', id: 'WOODEN_CHAIR_SIDE', col: 4, row: 2, canSitOn: false },               // sperrt Sitzen
    { uid: 'c', id: 'PLANT', col: 6, row: 2, canSitOn: true, sitFacing: Direction.DOWN },  // macht sitzbar
    { uid: 'd', id: 'PLANT', col: 8, row: 2, petCanSitOn: true, backgroundTiles: 1 },
  ];
  const { tmj } = exportLayoutToTmj(layout, registry);
  const objs = (tmj.layers as Array<{ name: string; objects?: Array<{ properties: Array<{ name: string; value: unknown }> }> }>).find((l) => l.name === 'Furniture')!.objects!;
  const over = (i: number): string => objs[i].properties.filter((p) => ['canSitOn', 'sitFacing', 'petCanSitOn', 'backgroundTiles'].includes(p.name)).map((p) => `${p.name}=${p.value}`).join(' ');
  check('erbende Platzierung schreibt keine Overrides', over(0) === '', over(0) || '(keine)');
  check('gesperrte schreibt canSitOn=false', over(1) === 'canSitOn=false', over(1));
  check('sitzbar gemachte schreibt beide', over(2) === 'canSitOn=true sitFacing=S', over(2));
  check('Ablage schreibt beide', over(3) === 'petCanSitOn=true backgroundTiles=1', over(3));

  const back = importTmjToLayout(tmj as never, registry, () => null).layout.furniture;
  const byCol = new Map(back.map((f) => [f.col, f]));
  const woodChair = getCatalogEntry('WOODEN_CHAIR_SIDE');
  check('Import: erbende bleibt ohne Override', byCol.get(2)!.canSitOn === undefined && byCol.get(2)!.sitFacing === undefined);
  check('Import: erbende ist trotzdem sitzbar', resolveCanSitOn(byCol.get(2)!, woodChair));
  check('Import: Sperre überlebt', byCol.get(4)!.canSitOn === false && !resolveCanSitOn(byCol.get(4)!, woodChair));
  check('Import: Pflanze sitzbar nach S', resolveCanSitOn(byCol.get(6)!, plant) && resolveSitFacing(byCol.get(6)!, plant) === Direction.DOWN);
  check('Import: Ablage + backgroundTiles überleben', byCol.get(8)!.petCanSitOn === true && byCol.get(8)!.backgroundTiles === 1);
  check('Sitzplätze: nur Stuhl A und Pflanze C', layoutToSeats(back).size === 2, `${layoutToSeats(back).size}`);
}

console.log(failures === 0 ? '\nAlles grün.' : `\n${failures} Prüfung(en) fehlgeschlagen.`);
process.exit(failures === 0 ? 0 : 1);
