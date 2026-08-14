#!/usr/bin/env -S node --import tsx
import * as path from 'node:path';
import { loadAssetBundle } from '../src/assets.js';
import { getMergedBundle, initAssetDefaults } from '../src/assetOverrides.js';
import { ZoneMapStore } from '../src/zoneMapStore.js';
import { OfficeState } from '@pixel/shared/office/engine/officeState.js';
import { buildDynamicCatalog } from '@pixel/shared/office/layout/furnitureCatalog.js';
const ROOT = path.resolve(import.meta.dirname, '..', '..');
initAssetDefaults(await loadAssetBundle(ROOT));
const b = getMergedBundle();
buildDynamicCatalog({ catalog: b.raw.furnitureCatalog as never, sprites: b.raw.furnitureSprites as never });
for (const zone of ['office', 'uponu']) {
  const map = new ZoneMapStore().get(zone);
  process.stdout.write(`\n${zone}: Karte ${map ? 'vorhanden' : 'FEHLT'}`);
  if (!map) continue;
  const m = map as unknown as { cols: number; rows: number; furniture: unknown[] };
  process.stdout.write(` ${m.cols}×${m.rows}, ${m.furniture.length} Möbel — OfficeState: `);
  try {
    const os = new OfficeState(map as never);
    for (let i = 0; i < 40; i++) os.update(0.05);
    console.log(`ok (${(os as unknown as { points: Map<string, unknown> }).points.size} Punkte)`);
  } catch (e) {
    console.log('FEHLER');
    console.log(String((e as Error).stack ?? e).split('\n').slice(0, 6).join('\n'));
  }
}
