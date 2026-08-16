/**
 * Install the zone maps that ship in the image — but only where a zone has none.
 *
 * `assets/tiled/zones/*.tmj` is versioned, so a release carries the world with
 * it. A fresh server (or one whose world was wiped) would otherwise come up with
 * nothing but the empty default zone and stay that way until someone remembered
 * to push, which is a poor first impression for something that is right there in
 * the image.
 *
 * **Seeding never overwrites.** A zone that already has a map is left alone, so
 * whatever a mapper pushed to that server stays the truth: a push is an
 * authored, deliberate act against *that* deployment, and a deploy is not
 * allowed to undo one. Which is also why this cannot become "sync the maps on
 * every start" — that would make every release quietly revert live edits, and
 * `scripts/push-zones.sh` exists precisely so that changes travel on their own
 * schedule.
 *
 * The zone id comes from the map's own `mapName` property, falling back to the
 * filename (`resolveZoneId`) — the same rule the push and the CLI import use, so
 * a file seeds the same zone whichever way it arrives. Scratch copies
 * (`*-noimport.tmj`) are skipped here as everywhere else.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { ZoneMapStore } from '../zoneMapStore.js';
import type { ZoneStore } from '../zoneStore.js';
import { loadTiledRegistry } from './tiledRegistry.js';
import { importZoneTmjFile, isNoImportMap, resolveZoneId } from './zoneImport.js';

export interface SeedResult {
  seeded: string[];
  kept: string[];
}

export async function seedBundledZoneMaps(
  assetsRoot: string,
  mapStore: ZoneMapStore,
  zones: ZoneStore,
): Promise<SeedResult> {
  const dir = path.join(assetsRoot, 'assets', 'tiled', 'zones');
  const result: SeedResult = { seeded: [], kept: [] };
  if (!fs.existsSync(dir)) return result;

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.tmj') && !isNoImportMap(f))
    .sort();
  if (files.length === 0) return result;

  // Loaded once, and only when there is something to seed: reading every
  // tileset costs real work on a start that usually has nothing to do.
  let registry: ReturnType<typeof loadTiledRegistry> | null = null;

  for (const file of files) {
    const full = path.join(dir, file);
    let zoneId: string;
    try {
      zoneId = resolveZoneId(full, file);
    } catch {
      continue; // unreadable/!JSON — a broken file must not stop the server
    }
    if (mapStore.has(zoneId)) {
      result.kept.push(zoneId);
      continue;
    }
    try {
      registry ??= loadTiledRegistry(assetsRoot);
      await importZoneTmjFile(full, registry, zoneId, mapStore, zones);
      result.seeded.push(zoneId);
    } catch (err) {
      // A bad bundled map is a content bug, not a reason to refuse to boot: the
      // zone stays empty and says so in the log.
      console.warn(`[zones] could not seed ${file}: ${(err as Error)?.message}`);
    }
  }
  return result;
}
