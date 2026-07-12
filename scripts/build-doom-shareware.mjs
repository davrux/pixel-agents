#!/usr/bin/env node
/**
 * Build the DOOM shareware `.jsdos` bundle — the LEGAL, freely-distributable
 * shareware release (id Software): DOOM.EXE + DOOM1.WAD (Episode 1) + IPXSETUP.EXE
 * for later multiplayer. This is the *vanilla* engine (v1.9) with correct mouse
 * turning — unlike the GPL MBF386 build, whose mouse only turned one way, so we use
 * shareware Doom instead of Freedoom+MBF for the working cabinet.
 *
 * Output (gitignored, regenerable): client/public/jsdos/bundles/doom.jsdos + the
 * cache-bust entry in manifest.json. Big binaries are cached in tmp/arcade-assets.
 *
 *   node scripts/build-doom-shareware.mjs
 */
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, readdir, mkdtemp } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { crc32 } from 'node:zlib';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
const CACHE = resolve(REPO, 'tmp/arcade-assets');
const OUT = resolve(REPO, 'client/public/jsdos/bundles');
const SRC_ZIP = resolve(CACHE, 'doom19s.zip');
const SRC_URL = 'https://www.gamers.org/pub/idgames/idstuff/doom/doom19s.zip';

/** The proven dosbox.conf (from the js-dos Doom bundle); ipx on for later multiplayer. */
function dosboxConf() {
  return [
    '[sdl]', 'autolock=true', 'usescancodes=true',
    '[dosbox]', 'machine=svga_s3', 'memsize=16',
    '[cpu]', 'core=auto', 'cputype=auto', 'cycles=auto',
    '[mixer]', 'nosound=false', 'rate=44100', 'blocksize=1024', 'prebuffer=20',
    '[render]', 'frameskip=0', 'aspect=false', 'scaler=none',
    '[ipx]', 'ipx=true',
    '[autoexec]', 'echo off', 'mount c .', 'c:', 'DOOM.EXE', '',
  ].join('\n');
}

/** Minimal store-only ZIP writer (js-dos/libzip reads this fine). */
function makeZip(entries) {
  const chunks = [], central = [];
  let offset = 0;
  const DOS_TIME = 0, DOS_DATE = ((1997 - 1980) << 9) | (1 << 5) | 1;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data) >>> 0;
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0); lfh.writeUInt16LE(20, 4); lfh.writeUInt16LE(0, 6);
    lfh.writeUInt16LE(0, 8); lfh.writeUInt16LE(DOS_TIME, 10); lfh.writeUInt16LE(DOS_DATE, 12);
    lfh.writeUInt32LE(crc, 14); lfh.writeUInt32LE(data.length, 18); lfh.writeUInt32LE(data.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26); lfh.writeUInt16LE(0, 28);
    chunks.push(lfh, nameBuf, data);
    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0); cdh.writeUInt16LE(20, 4); cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(0, 8); cdh.writeUInt16LE(0, 10); cdh.writeUInt16LE(DOS_TIME, 12); cdh.writeUInt16LE(DOS_DATE, 14);
    cdh.writeUInt32LE(crc, 16); cdh.writeUInt32LE(data.length, 20); cdh.writeUInt32LE(data.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28); cdh.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cdh, nameBuf]));
    offset += lfh.length + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cd, eocd]);
}

async function main() {
  await mkdir(CACHE, { recursive: true });
  await mkdir(OUT, { recursive: true });
  if (!existsSync(SRC_ZIP)) {
    console.log(`  fetch   ${SRC_URL}`);
    const res = await fetch(SRC_URL, { redirect: 'follow' });
    if (!res.ok) throw new Error(`download failed ${res.status}`);
    await writeFile(SRC_ZIP, Buffer.from(await res.arrayBuffer()));
  }
  // Extract the shareware files (python3 zipfile — same approach as the other builder).
  const dir = await mkdtemp(resolve(tmpdir(), 'doomsw-'));
  await promisify(execFile)('python3', ['-c', 'import sys,zipfile;zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', SRC_ZIP, dir]);
  const files = await readdir(dir);
  const entries = await Promise.all(files.map(async (f) => ({ name: f.toUpperCase(), data: await readFile(resolve(dir, f)) })));
  entries.push({ name: '.jsdos/dosbox.conf', data: Buffer.from(dosboxConf(), 'utf8') });
  entries.push({ name: '.jsdos/jsdos.json', data: Buffer.from(JSON.stringify({ version: 8 }), 'utf8') });

  const zip = makeZip(entries);
  const dest = resolve(OUT, 'doom.jsdos');
  await new Promise((res, rej) => {
    const ws = createWriteStream(dest);
    ws.on('error', rej).on('finish', res);
    ws.end(zip);
  });
  const hash = createHash('sha1').update(zip).digest('hex').slice(0, 10);

  // Merge into the manifest (only bundles that still exist on disk stay listed).
  const manPath = resolve(OUT, 'manifest.json');
  let man = {};
  if (existsSync(manPath)) try { man = JSON.parse(await readFile(manPath, 'utf8')); } catch { /* rebuild */ }
  for (const id of Object.keys(man)) if (!existsSync(resolve(OUT, `${id}.jsdos`))) delete man[id];
  man.doom = hash;
  await writeFile(manPath, JSON.stringify(man));
  console.log(`  wrote   ${dest}  (${(zip.length / 1e6).toFixed(1)} MB, v=${hash})`);
  console.log(`  wrote   ${manPath}  ${JSON.stringify(man)}`);
  console.log('done. (shareware DOOM — legal, vanilla engine, correct mouse)');
}

main().catch((e) => { console.error(e); process.exit(1); });
