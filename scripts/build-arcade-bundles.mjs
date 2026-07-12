#!/usr/bin/env node
/**
 * Build the arcade `.jsdos` game bundles from FREE assets.
 *
 * A `.jsdos` bundle is just a ZIP containing the DOS game files at the root plus
 * a `.jsdos/dosbox.conf` (js-dos reads that config; see the proven layout of
 * v8.js-dos.com/bundles/doom.jsdos which this mirrors). js-dos runs it in DOSBox
 * (WASM) and tunnels the game's IPX network over WebRTC for multiplayer.
 *
 * Content licensing — everything shipped is free/libre:
 *   - IWADs: Freedoom phase 1/2 + FreeDM (modified BSD), fetched from GitHub.
 *   - ENGINE: a GPL DOS Doom source port (e.g. Boom/MBF/PrBoom-DOS) that you
 *     supply. We do NOT bundle id Software's commercial DOOM.EXE/DOOM.WAD.
 *
 * The big IWADs (~80 MB) are NOT committed — this script downloads them into a
 * cache dir and emits the bundles into client/public/jsdos/bundles/ (gitignored),
 * exactly like the model-converter scripts generate their output.
 *
 * Usage:
 *   node scripts/build-arcade-bundles.mjs --engine <dir> [--launch "%EXE% -iwad %IWAD%"]
 *
 *   --engine <dir>   Directory holding the DOS engine files to bundle (the .EXE
 *                    and any helpers like IPXSETUP.EXE). Required.
 *   --exe <name>     Engine executable name (default: auto-detect the single .EXE,
 *                    or set explicitly, e.g. BOOM.EXE).
 *   --launch <tpl>   autoexec launch line; %EXE%→engine, %IWAD%→the bundle's wad.
 *                    Default: "%EXE% -iwad %IWAD%" (source-port style).
 */
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32 } from 'node:zlib';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
const CACHE = resolve(REPO, 'tmp/arcade-assets');
const OUT = resolve(REPO, 'client/public/jsdos/bundles');

const FREEDOOM_VER = '0.13.0';
const REL = `https://github.com/freedoom/freedoom/releases/download/v${FREEDOOM_VER}`;

// id: bundle id (matches shared/src/arcade/games.ts); member: WAD inside the freedoom
// zip; iwad: filename INSIDE the bundle. Vanilla-derived engines (Boom/MBF) find the
// IWAD by RECOGNISED name — "freedoom1.wad" is ignored — so we bundle Phase 1 as
// DOOM.WAD (Ultimate-Doom-style, 4 episodes) and Phase 2 / FreeDM as DOOM2.WAD.
const BUNDLES = [
  { id: 'doom', zip: `freedoom-${FREEDOOM_VER}.zip`, member: `freedoom-${FREEDOOM_VER}/freedoom1.wad`, iwad: 'DOOM.WAD' },
  { id: 'doom2', zip: `freedoom-${FREEDOOM_VER}.zip`, member: `freedoom-${FREEDOOM_VER}/freedoom2.wad`, iwad: 'DOOM2.WAD' },
  { id: 'doom2dm', zip: `freedm-${FREEDOOM_VER}.zip`, member: `freedm-${FREEDOOM_VER}/freedm.wad`, iwad: 'DOOM2.WAD' },
];

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

/** The proven dosbox.conf (from the js-dos Doom bundle), with IPX enabled for
 *  multiplayer and an autoexec that mounts C:, optionally installs a resident DPMI
 *  host (CWSDPMI, for DJGPP engines like MBF), then launches the engine. */
function dosboxConf(launchLine, preLaunch) {
  const autoexec = ['echo off', 'mount c .', 'c:'];
  if (preLaunch) autoexec.push(preLaunch);
  autoexec.push(launchLine, '');
  return [
    '[sdl]',
    'autolock=true',
    'usescancodes=true',
    '[dosbox]',
    'machine=svga_s3',
    'memsize=16',
    '[cpu]',
    'core=auto',
    'cputype=auto',
    'cycles=auto',
    '[mixer]',
    'nosound=false',
    'rate=44100',
    'blocksize=1024',
    'prebuffer=20',
    '[render]',
    'frameskip=0',
    'aspect=false',
    'scaler=none',
    '[ipx]',
    'ipx=true',
    '[autoexec]',
    ...autoexec,
  ].join('\n');
}

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function download(url, dest) {
  if (await exists(dest)) {
    console.log(`  cached  ${basename(dest)}`);
    return;
  }
  console.log(`  fetch   ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`download failed ${res.status}: ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(dest, buf);
}

/** Extract one member from a zip using the system's unzip-free path: Node has no
 *  unzip, so we read the central directory ourselves (store or deflate). */
async function extractMember(zipPath, member) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  // Prefer python3's zipfile (always present here, dependency-free).
  const out = resolve(CACHE, basename(member));
  const py = `import sys,zipfile\nz=zipfile.ZipFile(sys.argv[1])\nopen(sys.argv[3],'wb').write(z.read(sys.argv[2]))`;
  await promisify(execFile)('python3', ['-c', py, zipPath, member, out]);
  return out;
}

/** Minimal store-only ZIP writer (js-dos/libzip reads this fine). */
function makeZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const DOS_TIME = 0;
  const DOS_DATE = ((1997 - 1980) << 9) | (1 << 5) | 1; // 1997-01-01
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data) >>> 0;
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(0, 6);
    lfh.writeUInt16LE(0, 8); // store
    lfh.writeUInt16LE(DOS_TIME, 10);
    lfh.writeUInt16LE(DOS_DATE, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(data.length, 18);
    lfh.writeUInt32LE(data.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);
    chunks.push(lfh, nameBuf, data);

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4);
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(0, 8);
    cdh.writeUInt16LE(0, 10);
    cdh.writeUInt16LE(DOS_TIME, 12);
    cdh.writeUInt16LE(DOS_DATE, 14);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(data.length, 20);
    cdh.writeUInt32LE(data.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cdh, nameBuf]));
    offset += lfh.length + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cd, eocd]);
}

async function main() {
  const engineDir = arg('engine', process.env.ARCADE_ENGINE_DIR);
  // Default: just run the engine; it auto-detects the recognised IWAD (DOOM.WAD/
  // DOOM2.WAD) in the current dir. (MBF ignores an explicit -iwad <file>.)
  const launchTpl = arg('launch', '%EXE%');
  if (!engineDir) {
    console.error(
      'ERROR: no engine supplied.\n' +
        'Pass --engine <dir> with a FREE (GPL) DOS Doom source port, e.g. Boom/MBF/PrBoom-DOS.\n' +
        'The dir should contain the engine .EXE (and IPXSETUP.EXE for multiplayer).\n' +
        'We deliberately do NOT bundle id Software’s commercial DOOM.EXE/DOOM.WAD.',
    );
    process.exit(1);
  }
  await mkdir(CACHE, { recursive: true });
  await mkdir(OUT, { recursive: true });

  // Gather engine files.
  const engFiles = await readdir(engineDir);
  let exeName = arg('exe', process.env.ARCADE_ENGINE_EXE);
  if (!exeName) {
    const exes = engFiles.filter((f) => /\.exe$/i.test(f) && !/^(ipxsetup|sersetup|setup|dm)\.exe$/i.test(f));
    if (exes.length !== 1) throw new Error(`Cannot auto-pick engine .EXE among [${exes}]; pass --exe`);
    exeName = exes[0];
  }
  console.log(`engine: ${engineDir} (exe=${exeName})`);
  const engineEntries = await Promise.all(
    engFiles.map(async (f) => ({ name: f.toUpperCase(), data: await readFile(resolve(engineDir, f)) })),
  );

  console.log('freedoom IWADs:');
  for (const b of BUNDLES) await download(`${REL}/${b.zip}`, resolve(CACHE, b.zip));

  // DJGPP engines (e.g. MBF386) need a DPMI host. If CWSDPMI.EXE is bundled, install
  // it resident before the engine so a DPMI server is guaranteed active (fixes the
  // "no DPMI" error — the stub's own CWSDPMI auto-search isn't reliable under DOSBox).
  const preLaunch = engFiles.some((f) => /^cwsdpmi\.exe$/i.test(f)) ? 'CWSDPMI.EXE -p' : null;
  if (preLaunch) console.log('  dpmi:   CWSDPMI.EXE -p (resident) prepended to autoexec');

  const manifest = {}; // gameId → content hash, so the client can cache-bust the bundle URL
  for (const b of BUNDLES) {
    const wadPath = await extractMember(resolve(CACHE, b.zip), b.member);
    const wad = await readFile(wadPath);
    const launch = launchTpl.replaceAll('%EXE%', exeName.toUpperCase()).replaceAll('%IWAD%', b.iwad);
    const entries = [
      ...engineEntries.filter((e) => e.name !== b.iwad),
      { name: b.iwad, data: wad },
      { name: '.jsdos/dosbox.conf', data: Buffer.from(dosboxConf(launch, preLaunch), 'utf8') },
      { name: '.jsdos/jsdos.json', data: Buffer.from(JSON.stringify({ version: 8 }), 'utf8') },
    ];
    const zip = makeZip(entries);
    manifest[b.id] = createHash('sha1').update(zip).digest('hex').slice(0, 10);
    const dest = resolve(OUT, `${b.id}.jsdos`);
    await new Promise((res, rej) => {
      const ws = createWriteStream(dest);
      ws.on('error', rej).on('finish', res);
      ws.end(zip);
    });
    console.log(`  wrote   ${dest}  (${(zip.length / 1e6).toFixed(1)} MB, v=${manifest[b.id]}, launch: ${launch})`);
  }
  // Content-hash manifest → the client appends ?v=<hash> so a changed bundle never
  // serves stale from any HTTP cache (and an unchanged one stays cacheable).
  await writeFile(resolve(OUT, 'manifest.json'), JSON.stringify(manifest));
  console.log(`  wrote   ${resolve(OUT, 'manifest.json')}`);
  console.log('done.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
