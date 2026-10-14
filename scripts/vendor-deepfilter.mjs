#!/usr/bin/env node
/**
 * Vendor the DeepFilterNet3 MODEL the desktop Mumble client's noise filter needs
 * into client/public/deepfilter — with NO external fetch at runtime, the same
 * self-hosting stance as vendor-mediapipe.mjs.
 *
 *   node scripts/vendor-deepfilter.mjs        # (pnpm run vendor:deepfilter)
 *   FORCE=1 node scripts/vendor-deepfilter.mjs
 *
 * Only the model is fetched here (8 MB, from the upstream repository at the same
 * pinned commit the runtime was built from, and checked against a pinned hash so
 * a moved or rewritten file is refused rather than shipped). The runtime itself —
 * df_bg.wasm and its glue — is committed and rebuilt from source by
 * scripts/build-deepfilter-wasm.sh, which is why the commit is pinned in both.
 *
 * Output is gitignored + regenerable. Without it the client greys out the
 * "Noise filter" toggle and says how to install it (see
 * client/src/voice/deepFilter.ts), so a build that skipped this still runs.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '..', 'client/public/deepfilter');

/** Keep equal to DF_COMMIT in scripts/build-deepfilter-wasm.sh. */
const DF_COMMIT = 'd375b2d8309e0935d165700c91da9de862a99c31';
const MODEL = 'DeepFilterNet3_onnx.tar.gz';
const MODEL_URL = `https://raw.githubusercontent.com/Rikorose/DeepFilterNet/${DF_COMMIT}/models/${MODEL}`;
const MODEL_SHA256 = 'c94d91f70911001c946e0fabb4aa9adc37045f45a03b56008cb0c8244cb63616';

const sha256 = (b) => createHash('sha256').update(b).digest('hex');

async function main() {
  const dest = resolve(OUT, MODEL);
  if (existsSync(dest) && !process.env.FORCE && sha256(await readFile(dest)) === MODEL_SHA256) {
    console.log(`  skip   ${dest}`);
    return;
  }
  const r = await fetch(MODEL_URL);
  if (!r.ok) throw new Error(`download failed ${r.status}: ${MODEL_URL}`);
  const bytes = Buffer.from(await r.arrayBuffer());
  const got = sha256(bytes);
  if (got !== MODEL_SHA256) throw new Error(`${MODEL}: sha256 ${got}, expected ${MODEL_SHA256} — refusing`);
  await mkdir(OUT, { recursive: true });
  await writeFile(dest, bytes);
  console.log(`  wrote  ${dest}  (${(bytes.length / 1e6).toFixed(1)} MB)`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
