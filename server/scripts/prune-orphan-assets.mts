#!/usr/bin/env -S node --import tsx
/**
 * Report — or delete — stored asset rows nothing can reach any more.
 *
 * The server does both of these on every boot (see src/maintenance/startupCleanup.ts);
 * this is the way to LOOK first: what would go, and what is held back by the grace
 * period.
 *
 * `--apply` runs the same decision the boot takes, immediately and without waiting
 * for the grace period, for when you know exactly what you are removing. Both paths go
 * through the same pure decision, so the command and the boot cannot drift apart.
 *
 * DEFAULT is `playerAvatar`: personal avatars whose account is gone. `--type furniture`
 * still runs the old tileset-based classification, but a world that has booted this
 * build has no furniture rows left — they are retired wholesale now that `furniture` is
 * not an asset type (maintenance/retireFurniture.ts), so the mode is only useful for
 * inspecting a database from before that.
 *
 * Run: scripts/prune-orphan-assets.sh [--apply] [--type playerAvatar|furniture]
 */
import { ASSETS_ROOT } from '../src/assets.js';
import { accountIds, decideAvatarPrune } from '../src/maintenance/orphanAvatars.js';
import {
  decidePrune,
  deleteAssets,
  inspectOrphanAssets,
  knownAssetIds,
  ORPHAN_GRACE_DAYS,
  storedAssets,
  totalBytes,
} from '../src/maintenance/orphanAssets.js';

const APPLY = process.argv.includes('--apply');
const typeArg = process.argv.indexOf('--type');
const TYPE = typeArg >= 0 ? process.argv[typeArg + 1] : 'playerAvatar';
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(2)} MB`;

// ── Avatars: the same job with the other half of the evidence ────────────────
if (TYPE === 'playerAvatar') {
  const rows = storedAssets('playerAvatar');
  const ids = accountIds();
  const d = decideAvatarPrune(rows, ids);
  console.log(`${rows.length} avatar(s), ${mb(totalBytes(rows))} — ${ids.size} account(s)`);
  console.log(`  ${d.owned.length} with an account — kept`);
  const orphans = [...d.deletable, ...d.tooYoung];
  console.log(`  ${orphans.length} without one, ${mb(totalBytes(orphans))}`);
  if (d.refused) {
    console.error(`\n✗ refusing to delete: ${d.refused}`);
    process.exit(1);
  }
  if (d.tooYoung.length > 0) {
    console.log(`      ${d.tooYoung.length} of them written within ${ORPHAN_GRACE_DAYS} days — the boot leaves those alone`);
  }
  if (orphans.length === 0) {
    console.log('\nnothing to prune');
    process.exit(0);
  }
  if (!APPLY) {
    console.log(`\nexamples: ${orphans.slice(0, 8).map((r) => r.name).join(', ')}`);
    console.log(`(dry run) --apply deletes all ${orphans.length}, grace period included`);
    process.exit(0);
  }
  const { deleted } = deleteAssets('playerAvatar', orphans.map((r) => r.name));
  console.log(`\ndeleted ${deleted} avatar(s), ${mb(totalBytes(orphans))} of sprite data`);
  console.log('A running server keeps serving its cached bundle until it restarts.');
  process.exit(0);
}

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
const { deleted } = deleteAssets(TYPE, c.orphans.map((r) => r.name));
console.log(`\ndeleted ${deleted} row(s), ${mb(totalBytes(c.orphans))} of asset data`);
console.log('A running server keeps serving its cached bundle until it restarts.');
