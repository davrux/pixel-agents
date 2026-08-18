#!/usr/bin/env -S node --import tsx
/**
 * Bake the furniture/decal atlas by hand.
 *
 * The server does this itself when the art has changed (see
 * src/tiled/furnitureAtlas.ts's ensureFurnitureAtlas, called at startup and on a
 * tileset save), so you rarely need this. It stays for two cases: baking without
 * starting a server — a release build, or a CI check that the committed artifact
 * matches its sources — and `--dry-run`, which reports what a bake WOULD produce
 * and writes nothing.
 *
 * Everything about the packing, and why the artifact is derived-but-committed,
 * lives in that module. This file only turns it into a command.
 *
 * Run (from server/): node --import tsx scripts/bake-furniture-atlas.mts [--dry-run] [--check]
 *
 *   --dry-run  report the result, write nothing
 *   --check    exit non-zero if the committed atlas is not what the sources say
 *              (for CI and the pre-ship list; writes nothing)
 */
import * as path from 'node:path';

import { ATLAS_MANIFEST_REL, ATLAS_PNG_REL, bakeFurnitureAtlas, ensureFurnitureAtlas } from '../src/tiled/furnitureAtlas.js';

const ROOT = new URL('../..', import.meta.url).pathname;
const TILED = path.join(ROOT, 'assets', 'tiled');
const DRY = process.argv.includes('--dry-run');
const CHECK = process.argv.includes('--check');

if (CHECK) {
  // ensureFurnitureAtlas would REPAIR it, which is the opposite of a check, so
  // ask the cheap question directly: does a bake here change anything?
  const before = await import('node:fs').then((fs) => fs.readFileSync(path.join(TILED, ATLAS_MANIFEST_REL), 'utf-8')).catch(() => '');
  const r = bakeFurnitureAtlas(TILED, { dryRun: true });
  const fs = await import('node:fs');
  const manifest = JSON.parse(before || '{}') as { sourceKey?: string; frames?: Record<string, unknown> };
  const stale = !before || Object.keys(manifest.frames ?? {}).length !== r.frames || !fs.existsSync(path.join(TILED, ATLAS_PNG_REL));
  if (stale) {
    console.error(`✗ atlas is stale: sources hold ${r.frames} tiles, the committed manifest ${Object.keys(manifest.frames ?? {}).length}`);
    console.error('  run scripts/bake-furniture-atlas.sh (or just start the server, which bakes it)');
    process.exit(1);
  }
  console.log(`✓ atlas matches its sources (${r.frames} tiles)`);
  process.exit(0);
}

if (DRY) {
  const r = bakeFurnitureAtlas(TILED, { dryRun: true });
  console.log(
    `(dry run) ${r.frames} tiles → ${r.width}×${r.height}, ${(r.bytes / 1024).toFixed(0)} KB packed ` +
      `vs ${(r.sourceBytes / 1024).toFixed(0)} KB in ${r.frames} files`,
  );
  for (const s of r.skipped) console.warn(`  ⚠️  ${s}`);
  process.exit(0);
}

const { baked, reason } = ensureFurnitureAtlas(ROOT);
console.log(baked ? `✓ ${ATLAS_PNG_REL} — ${reason}` : `· nothing to do: ${reason}`);
console.log(`  ${ATLAS_MANIFEST_REL} lists every id's rect`);
