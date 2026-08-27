#!/usr/bin/env -S node --import tsx
/**
 * Rewrite stored character/NPC/avatar art from SpriteData into a PNG sheet.
 *
 * New saves are packed already (appStore does it), so this is only for rows written
 * before that — they keep working untouched, they are just 24× larger than they need to
 * be. Deliberately NOT a boot task: the unattended housekeeping next door only ever
 * deletes what nothing can reach, and rewriting somebody's art in place is a bigger
 * promise than a boot with nobody watching should make.
 *
 * The rewrite goes through the same pack/unpack pair the store uses, and every row is
 * verified by unpacking it again and comparing colours before the write is kept — a
 * mismatch skips that row and says so rather than replacing art with something else.
 *
 * Run: scripts/repack-art.sh [--apply]
 */
import { appStore } from '../src/appStore.js';
import { db } from '../src/db.js';
import { PACKED_ART_TYPES, packArt, packedPng, unpackArt, type PackedArtType } from '../src/art/artStore.js';

const APPLY = process.argv.includes('--apply');
const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;

/** Colours in the same places, ignoring hex case and key order — see artStore.ts. */
const fold = (v: unknown): unknown =>
  typeof v === 'string'
    ? v.toLowerCase()
    : Array.isArray(v)
      ? v.map(fold)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.entries(v as Record<string, unknown>)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, x]) => [k, fold(x)]),
          )
        : v;

let totalBefore = 0;
let totalAfter = 0;
let packed = 0;
let already = 0;
const failed: string[] = [];

for (const type of PACKED_ART_TYPES) {
  // Both columns: a packed row keeps its sheet in `assets.png`, so reading only `data` would make
  // every already-packed row look like one with no pixels and report it as a failure.
  const rows = db.prepare('SELECT name, data, png FROM assets WHERE type = ?').all(type) as Array<{
    name: string;
    data: string;
    png: Uint8Array | null;
  }>;
  for (const r of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(r.data) as unknown;
      if (r.png && parsed && typeof parsed === 'object') {
        (parsed as Record<string, unknown>).png = Buffer.from(r.png.buffer, r.png.byteOffset, r.png.byteLength);
      }
    } catch {
      failed.push(`${type}/${r.name}: unreadable JSON`);
      continue;
    }
    if (packedPng(parsed)) {
      already++;
      continue;
    }
    const repacked = packArt(type as PackedArtType, parsed);
    if (!packedPng(repacked)) {
      failed.push(`${type}/${r.name}: nothing to pack (no pixels)`);
      continue;
    }
    // Stored size after the rewrite: the metadata as JSON plus the sheet as BLOB bytes. NOT
    // `JSON.stringify(repacked)` — the sheet is a Buffer now, and JSON would turn it into
    // `{"type":"Buffer","data":[…]}` and report a size two and a half times the truth.
    const { png: afterPng, ...afterMeta } = repacked as Record<string, unknown>;
    const after = JSON.stringify(afterMeta).length + (Buffer.isBuffer(afterPng) ? afterPng.length : 0);
    // Verify before trusting: unpack again and compare what a reader would get.
    if (JSON.stringify(fold(unpackArt(repacked))) !== JSON.stringify(fold(parsed))) {
      failed.push(`${type}/${r.name}: round trip differs — left as it was`);
      continue;
    }
    totalBefore += r.data.length;
    totalAfter += after;
    packed++;
    console.log(`  ${type}/${r.name}: ${kb(r.data.length)} → ${kb(after)}`);
    if (APPLY) appStore.saveAsset(type, r.name, parsed); // packs on write, one code path
  }
}

console.log(
  `\n${packed} row(s) to pack: ${kb(totalBefore)} → ${kb(totalAfter)}` +
    (already ? `, ${already} already packed` : '') +
    (failed.length ? `, ${failed.length} skipped` : ''),
);
for (const f of failed) console.warn(`  ! ${f}`);
if (!APPLY && packed > 0) console.log('(dry run) --apply rewrites them');
if (APPLY && packed > 0) console.log('A running server keeps serving its cached bundle until it restarts.');
