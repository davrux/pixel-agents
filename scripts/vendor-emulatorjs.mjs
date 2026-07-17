#!/usr/bin/env node
/**
 * Vendor the self-hosted EmulatorJS engine into client/public/emulatorjs/data so the
 * arcade can run libretro games (NES/SNES/GB/arcade/…) with NO external CDN — the
 * same self-hosting stance as js-dos. Downloads the small engine files + the selected
 * cores. Output is gitignored + regenerable.
 *
 *   node scripts/vendor-emulatorjs.mjs
 *   ARCADE_EJS_CORES=fceumm,fbneo,snes9x node scripts/vendor-emulatorjs.mjs   # pick cores
 *
 * Core file names are libretro core ids (EmulatorJS maps a system name → a core:
 * nes→fceumm, snes→snes9x, gb→gambatte, arcade→fbneo, mame→mame2003_plus, …).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
const BASE = 'https://cdn.emulatorjs.org/stable/data';
const OUT = resolve(REPO, 'client/public/emulatorjs/data');
const FILES = ['loader.js', 'emulator.min.js', 'emulator.min.css', 'version.json'];
const CORES = (process.env.ARCADE_EJS_CORES || 'fceumm,fbneo').split(',').map((s) => s.trim()).filter(Boolean);

async function get(url, dest) {
  if (existsSync(dest) && !process.env.FORCE) return console.log(`  skip   ${dest}`);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download failed ${r.status}: ${url}`);
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, Buffer.from(await r.arrayBuffer()));
  console.log(`  wrote  ${dest}  (${((await r.headers.get('content-length')) / 1e6 || 0).toFixed?.(1) ?? '?'} MB)`);
}

async function main() {
  await mkdir(resolve(OUT, 'cores'), { recursive: true });
  for (const f of FILES) await get(`${BASE}/${f}`, resolve(OUT, f));
  for (const c of CORES) await get(`${BASE}/cores/${c}-wasm.data`, resolve(OUT, 'cores', `${c}-wasm.data`));
  console.log(`done. EmulatorJS vendored to ${OUT} (cores: ${CORES.join(', ')})`);
}
main().catch((e) => { console.error(e); process.exit(1); });
