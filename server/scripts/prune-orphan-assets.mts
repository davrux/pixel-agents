#!/usr/bin/env -S node --import tsx
/**
 * Report — or delete — stored asset rows whose id no tileset carries any more.
 *
 * The server does this itself on every boot (see src/maintenance/startupCleanup.ts),
 * so this is the way to LOOK: what would go, what is held back by the grace period,
 * and which placed assets no tileset offers any more (a map to repair, and the one
 * thing here nobody can fix automatically).
 *
 * `--apply` runs the same decision the boot takes, immediately and without waiting
 * for the grace period, for when you know exactly what you are removing. Both paths
 * go through the same pure decision and the same backup, so the command and the boot
 * cannot drift apart.
 *
 * Run: scripts/prune-orphan-assets.sh [--apply] [--type furniture]
 */
import { ASSETS_ROOT } from '../src/assets.js';
import {
  decidePrune,
  deleteAssets,
  inspectOrphanAssets,
  knownAssetIds,
  ORPHAN_GRACE_DAYS,
  totalBytes,
} from '../src/maintenance/orphanAssets.js';

const APPLY = process.argv.includes('--apply');
const typeArg = process.argv.indexOf('--type');
const TYPE = typeArg >= 0 ? process.argv[typeArg + 1] : 'furniture';
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(2)} MB`;

const known = knownAssetIds(ASSETS_ROOT);
const c = inspectOrphanAssets(ASSETS_ROOT, TYPE);
const decision = decidePrune(c, known.size);
const all = [...c.kept, ...c.orphans, ...c.inUse.map((e) => e.asset)];

console.log(`${all.length} stored '${TYPE}' asset(s), ${mb(totalBytes(all))} — ${known.size} ids offered by tilesets`);
console.log(`  ${c.kept.length} carried by a tileset — kept`);
if (c.inUse.length > 0) {
  console.log(`  ${c.inUse.length} PLACED but carried by nothing — kept, and worth repairing:`);
  for (const e of c.inUse.slice(0, 10)) console.log(`      ${e.asset.name} in ${e.where.join(', ')}`);
}
console.log(`  ${c.orphans.length} orphaned, ${mb(totalBytes(c.orphans))}`);
if (decision.refused) {
  console.error(`\n✗ refusing to delete: ${decision.refused}`);
  process.exit(1);
}
if (decision.tooYoung.length > 0) {
  console.log(`      ${decision.tooYoung.length} of them touched within ${ORPHAN_GRACE_DAYS} days — the boot leaves those alone`);
}
if (c.orphans.length === 0) {
  console.log('\nnothing to prune');
  process.exit(0);
}

if (!APPLY) {
  console.log(`\nexamples: ${c.orphans.slice(0, 8).map((r) => r.name).join(', ')}`);
  console.log(`(dry run) --apply deletes all ${c.orphans.length}, backing the database up first`);
  process.exit(0);
}
// By hand, the grace period is not the point — you are looking at the list.
const { deleted, backup } = deleteAssets(TYPE, c.orphans.map((r) => r.name));
console.log(`\nbackup: ${backup}`);
console.log(`deleted ${deleted} row(s), ${mb(totalBytes(c.orphans))} of asset data`);
console.log('A running server keeps serving its cached bundle until it restarts.');
