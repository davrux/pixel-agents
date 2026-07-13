#!/usr/bin/env node
/**
 * Build `.jsdos` bundles for freely-distributable DOS SHAREWARE classics (Apogee /
 * id first episodes): Wolfenstein 3D, Commander Keen, Duke Nukem. These ship as an
 * Apogee "DEICE" self-extractor (INSTALL.BAT + DEICE.EXE + a packed data file); the
 * data file is a ZIP (sometimes with a prefixed stub), so we fetch the shareware
 * zip, pull out the data file, unpack it (7z — handles the prefixed case), and
 * repackage the ready-to-run files into a js-dos bundle that boots the game exe.
 *
 * Output (gitignored, regenerable): client/public/jsdos/bundles/<id>.jsdos + the
 * cache-bust entries in manifest.json. Cache in tmp/arcade-assets. Requires `unzip`.
 *
 *   node scripts/build-shareware-bundles.mjs
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

const execFileP = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
const CACHE = resolve(REPO, 'tmp/arcade-assets');
const OUT = resolve(REPO, 'client/public/jsdos/bundles');
const MIRROR = 'https://image.dosgamesarchive.com/games';

// zip: shareware archive on the mirror; data: the DEICE-packed member(s) inside it
// (an array = a split archive whose volumes are concatenated); exe: the autoexec
// program. All are freely-distributable shareware first episodes.
const GAMES = [
  { id: 'wolf3d', title: 'Wolfenstein 3D', zip: '1wolf14.zip', data: 'W3D1_BBS._1', exe: 'WOLF3D.EXE' },
  { id: 'keen', title: 'Commander Keen', zip: '1keen.zip', data: 'KEEN.1', exe: 'KEEN1.EXE' },
  { id: 'duke', title: 'Duke Nukem', zip: '1duke.zip', data: 'DUKE.1', exe: 'DN1.EXE' },
  // Duke3D refuses to launch without a DUKE3D.CFG ("run setup.exe"); ship a default
  // one (from scripts/assets, screen forced to fast 320x200) so it boots straight in.
  { id: 'duke3d', title: 'Duke Nukem 3D', zip: '3dduke13.zip', data: ['DUKE3DS._1', 'DUKE3DS._2', 'DUKE3DS._3', 'DUKE3DS._4', 'DUKE3DS._5'], exe: 'DUKE3D.EXE', extras: ['duke3d.cfg'] },
];

function dosboxConf(exe) {
  return [
    '[sdl]', 'autolock=true', 'usescancodes=true',
    '[dosbox]', 'machine=svga_s3', 'memsize=16',
    '[cpu]', 'core=auto', 'cputype=auto', 'cycles=auto',
    '[mixer]', 'nosound=false', 'rate=44100', 'blocksize=1024', 'prebuffer=20',
    '[render]', 'frameskip=0', 'aspect=false', 'scaler=none',
    '[ipx]', 'ipx=true',
    '[autoexec]', 'echo off', 'mount c .', 'c:', exe, '',
  ].join('\n');
}

/** Minimal store-only ZIP writer (js-dos/libzip reads this fine). */
function makeZip(entries) {
  const chunks = [], central = [];
  let offset = 0;
  const DT = 0, DD = ((1997 - 1980) << 9) | (1 << 5) | 1;
  for (const { name, data } of entries) {
    const nb = Buffer.from(name, 'utf8');
    const crc = crc32(data) >>> 0;
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0); lfh.writeUInt16LE(20, 4); lfh.writeUInt16LE(0, 6);
    lfh.writeUInt16LE(0, 8); lfh.writeUInt16LE(DT, 10); lfh.writeUInt16LE(DD, 12);
    lfh.writeUInt32LE(crc, 14); lfh.writeUInt32LE(data.length, 18); lfh.writeUInt32LE(data.length, 22);
    lfh.writeUInt16LE(nb.length, 26); lfh.writeUInt16LE(0, 28);
    chunks.push(lfh, nb, data);
    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0); cdh.writeUInt16LE(20, 4); cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(0, 8); cdh.writeUInt16LE(0, 10); cdh.writeUInt16LE(DT, 12); cdh.writeUInt16LE(DD, 14);
    cdh.writeUInt32LE(crc, 16); cdh.writeUInt32LE(data.length, 20); cdh.writeUInt32LE(data.length, 24);
    cdh.writeUInt16LE(nb.length, 28); cdh.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cdh, nb]));
    offset += lfh.length + nb.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cd, eocd]);
}

async function download(url, dest) {
  if (existsSync(dest)) return;
  console.log(`  fetch   ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`download failed ${res.status}: ${url}`);
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
}

async function main() {
  await mkdir(CACHE, { recursive: true });
  await mkdir(OUT, { recursive: true });
  const manPath = resolve(OUT, 'manifest.json');
  let man = {};
  if (existsSync(manPath)) try { man = JSON.parse(await readFile(manPath, 'utf8')); } catch { /* rebuild */ }

  for (const g of GAMES) {
    const zipPath = resolve(CACHE, g.zip);
    await download(`${MIRROR}/${g.zip}`, zipPath);
    // Pull the DEICE-packed data member out of the shareware zip…
    const work = await mkdtemp(resolve(tmpdir(), `sw-${g.id}-`));
    // Pull the DEICE-packed member(s) and concatenate split volumes into one archive.
    const parts = Array.isArray(g.data) ? g.data : [g.data];
    await execFileP('python3', [
      '-c',
      "import sys,zipfile\nz=zipfile.ZipFile(sys.argv[1])\nopen(sys.argv[-1],'wb').write(b''.join(z.read(m) for m in sys.argv[2:-1]))",
      zipPath,
      ...parts,
      resolve(work, 'data'),
    ]);
    // …and unpack it → loose game files. Use `unzip`, NOT 7z: 7z mis-restores old DOS
    // file attributes as bogus symlinks (unreadable); unzip extracts them as regular
    // files and tolerates a prefixed self-extractor stub (Wolf3D) with just a warning.
    const dir = resolve(work, 'game');
    await mkdir(dir, { recursive: true });
    await execFileP('unzip', ['-o', '-q', resolve(work, 'data'), '-d', dir]).catch(() => {}); // exit 1 on prefix warning
    const files = await readdir(dir);
    if (!files.length) throw new Error(`extraction produced no files for ${g.id}`);
    const entries = await Promise.all(files.map(async (f) => ({ name: f.toUpperCase(), data: await readFile(resolve(dir, f)) })));
    // Inject shipped extras (e.g. a default DUKE3D.CFG) from scripts/assets/.
    for (const ex of g.extras ?? []) {
      entries.push({ name: ex.toUpperCase(), data: await readFile(resolve(REPO, 'scripts/assets', ex)) });
    }
    entries.push({ name: '.jsdos/dosbox.conf', data: Buffer.from(dosboxConf(g.exe), 'utf8') });
    entries.push({ name: '.jsdos/jsdos.json', data: Buffer.from(JSON.stringify({ version: 8 }), 'utf8') });

    const zip = makeZip(entries);
    man[g.id] = createHash('sha1').update(zip).digest('hex').slice(0, 10);
    const dest = resolve(OUT, `${g.id}.jsdos`);
    await new Promise((res, rej) => {
      const ws = createWriteStream(dest);
      ws.on('error', rej).on('finish', res);
      ws.end(zip);
    });
    console.log(`  wrote   ${dest}  (${(zip.length / 1e6).toFixed(1)} MB, v=${man[g.id]}, exe=${g.exe})`);
  }
  await writeFile(manPath, JSON.stringify(man));
  console.log(`  wrote   ${manPath}  ${JSON.stringify(man)}`);
  console.log('done. (Apogee/id shareware — freely distributable)');
}

main().catch((e) => { console.error(e); process.exit(1); });
