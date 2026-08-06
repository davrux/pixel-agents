#!/usr/bin/env node
/**
 * Vendor the MediaPipe assets the conference **background filters** need (blur /
 * virtual background) into client/public/mediapipe — with NO external CDN at
 * runtime, the same self-hosting stance as js-dos and EmulatorJS.
 *
 *   node scripts/vendor-mediapipe.mjs        # (pnpm run vendor:mediapipe)
 *   FORCE=1 node scripts/vendor-mediapipe.mjs
 *
 * Two kinds of asset:
 *  - the tasks-vision WASM fileset — copied out of the installed
 *    `@mediapipe/tasks-vision` package (no download; it's a client dependency),
 *  - the selfie-segmentation model — not published on npm, so it is fetched from
 *    Google's model store once (needs network egress at build time).
 *
 * Output is gitignored + regenerable. Without it the client hides the "Filters"
 * button and says how to install them (see client/src/conference/videoFilters.ts),
 * so a build that skipped this step still runs — just without filters.
 */
import { mkdir, copyFile, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
const OUT = resolve(REPO, 'client/public/mediapipe');

/** Loaders + binaries FilesetResolver.forVisionTasks() picks between (SIMD or not). */
const WASM_FILES = [
  'vision_wasm_internal.js',
  'vision_wasm_internal.wasm',
  'vision_wasm_nosimd_internal.js',
  'vision_wasm_nosimd_internal.wasm',
];

/** float16 selfie segmenter — the model LiveKit's BackgroundProcessor defaults to. */
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite';

const mb = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`;

async function copyWasmFileset() {
  // Resolve from the client package, where @mediapipe/tasks-vision is declared —
  // pnpm's strict node_modules only exposes a package to its own dependents.
  const require = createRequire(join(REPO, 'client/package.json'));
  let pkgDir;
  try {
    // Resolve the package entry, not package.json — tasks-vision' "exports" map
    // has no "./package.json" entry, so that path is not resolvable.
    pkgDir = dirname(require.resolve('@mediapipe/tasks-vision'));
  } catch {
    throw new Error('@mediapipe/tasks-vision is not installed — run `pnpm install` first.');
  }
  await mkdir(resolve(OUT, 'wasm'), { recursive: true });
  for (const f of WASM_FILES) {
    const src = join(pkgDir, 'wasm', f);
    const dest = resolve(OUT, 'wasm', f);
    if (!existsSync(src)) throw new Error(`missing in @mediapipe/tasks-vision: wasm/${f}`);
    if (existsSync(dest) && !process.env.FORCE) {
      console.log(`  skip   ${dest}`);
      continue;
    }
    await copyFile(src, dest);
    console.log(`  wrote  ${dest}  (${mb((await stat(dest)).size)})`);
  }
}

async function fetchModel() {
  const dest = resolve(OUT, 'selfie_segmenter.tflite');
  if (existsSync(dest) && !process.env.FORCE) return console.log(`  skip   ${dest}`);
  const r = await fetch(MODEL_URL);
  if (!r.ok) throw new Error(`download failed ${r.status}: ${MODEL_URL}`);
  const bytes = Buffer.from(await r.arrayBuffer());
  await mkdir(OUT, { recursive: true });
  await writeFile(dest, bytes);
  console.log(`  wrote  ${dest}  (${mb(bytes.length)})`);
}

async function main() {
  await copyWasmFileset();
  await fetchModel();
  console.log(`done. MediaPipe segmentation assets vendored to ${OUT}`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
