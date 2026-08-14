#!/usr/bin/env -S node --import tsx
/**
 * Push zone maps to a running server — the only way a `.tmj` reaches one.
 *
 * `assets/tiled/zones/*.tmj` is gitignored, so a zone edit rides along with no
 * deploy. This sends the file (plus the images it references) to
 * `POST /tiled/zone`, which imports it and makes it that zone's active layout,
 * exactly as the old on-disk import did.
 *
 * The server no longer watches its zones directory. That was convenient locally
 * and did nothing in a deploy, so the two behaved differently for no reason;
 * now `--watch` against 127.0.0.1 is the same command as a deploy push, and the
 * difference is one flag rather than a mechanism.
 *
 * Auth: PIXEL_ADMIN_TOKEN, sent as X-Pixel-Admin-Token — see zonePushApi.ts for
 * why that token and not a session.
 *
 * Usage (from server/):
 *   node --import tsx scripts/push-zones.mts [zone…] [options]
 *
 *     --server=<host:port>  default 127.0.0.1:2567
 *     --token=<t>           default $PIXEL_ADMIN_TOKEN (or read from ../.env)
 *     --watch               keep running, push each map when it changes
 *     --insecure            accept a self-signed certificate (implied for
 *                           loopback, where the dev server's cert always is)
 *
 * With no zone names, every map in assets/tiled/zones is pushed. Names may be
 * given with or without the .tmj suffix. Scratch copies (*-noimport.tmj) are
 * always skipped, on the same reasoning as the local import.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import * as https from 'node:https';

import { isNoImportMap, readMapName } from '../src/tiled/zoneImport.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const ZONES_DIR = path.join(ROOT, 'assets', 'tiled', 'zones');
const TILED_DIR = path.join(ROOT, 'assets', 'tiled');

const argv = process.argv.slice(2);
const flag = (name: string, fallback = ''): string => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const has = (name: string): boolean => argv.includes(`--${name}`);
const names = argv.filter((a) => !a.startsWith('--'));

const USAGE = `push-zones — send zone maps to a running server

  node --import tsx scripts/push-zones.mts [zone…] [options]
  scripts/push-zones.sh [zone…] [options]            (from the repo root)

  --server=<host:port>  default 127.0.0.1:2567
  --token=<t>           default $PIXEL_ADMIN_TOKEN, else read from ./.env
  --watch               keep running, push each map when it changes
  --insecure            accept a self-signed certificate (implied for loopback)
  --help                this

With no zone names, every map in assets/tiled/zones is pushed. Names may be
given with or without .tmj; scratch copies (*-noimport.tmj) are always skipped.`;

if (has('help') || argv.includes('-h')) {
  console.log(USAGE);
  process.exit(0);
}
// An unknown flag is refused rather than ignored: the default action is "push
// every zone to the default server", and a typo in --server= would otherwise
// send them somewhere the caller did not mean quietly.
const KNOWN = ['server', 'token', 'watch', 'insecure', 'help'];
const unknown = argv.filter((a) => a.startsWith('--') && !KNOWN.includes(a.replace(/^--/, '').split('=')[0]));
if (unknown.length > 0) {
  console.error(`✗ unknown option(s): ${unknown.join(' ')}\n\n${USAGE}`);
  process.exit(2);
}

const server = flag('server', '127.0.0.1:2567');
const watch = has('watch');
const isLoopback = /^(127\.|localhost|\[::1\])/.test(server);
const insecure = has('insecure') || isLoopback;

/** The token, in the order a person would expect: an explicit flag, then the
 *  environment, then the repo's own .env — which is where it lives in dev, and
 *  requiring it to be exported by hand would just invite pasting it into shell
 *  history. */
function resolveToken(): string {
  const explicit = flag('token') || process.env.PIXEL_ADMIN_TOKEN?.trim();
  if (explicit) return explicit;
  const envFile = path.join(ROOT, '.env');
  if (fs.existsSync(envFile)) {
    const line = fs
      .readFileSync(envFile, 'utf-8')
      .split('\n')
      .find((l) => l.startsWith('PIXEL_ADMIN_TOKEN='));
    if (line) return line.slice('PIXEL_ADMIN_TOKEN='.length).trim();
  }
  return '';
}
const token = resolveToken();
if (!token) {
  console.error('✗ no admin token — pass --token=… or set PIXEL_ADMIN_TOKEN');
  process.exit(1);
}

/** Every file the map points at, relative to assets/tiled, so the server can
 *  resolve them without having them on disk. Tilesets are deliberately NOT
 *  included: those are committed and deploy with the app, and shipping a copy
 *  per push would let a map quietly install its own catalog. */
function referencedFiles(tmj: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  const add = (rel: string): void => {
    if (out[rel]) return;
    const full = path.join(TILED_DIR, rel);
    if (!fs.existsSync(full)) return;
    out[rel] = fs.readFileSync(full).toString('base64');
  };
  for (const layer of (tmj.layers as Array<Record<string, unknown>>) ?? []) {
    for (const obj of (layer.objects as Array<Record<string, unknown>>) ?? []) {
      const props = (obj.properties as Array<{ name: string; value: unknown }>) ?? [];
      const imageId = props.find((p) => p.name === 'imageId')?.value;
      if (typeof imageId === 'string' && imageId) add(`png/images/${imageId}.png`);
    }
  }
  return out;
}

interface PushResult {
  ok?: boolean;
  error?: string;
  cols?: number;
  rows?: number;
  furnitureCount?: number;
  imageCount?: number;
  unresolvedCount?: number;
}

function post(body: string): Promise<{ status: number; json: PushResult }> {
  const [host, port] = server.replace(/^https?:\/\//, '').split(':');
  const useHttps = !server.startsWith('http://');
  const mod = useHttps ? https : http;
  const options = {
    host,
    port: Number(port) || (useHttps ? 443 : 80),
    path: '/tiled/zone',
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      'x-pixel-admin-token': token,
    },
    ...(useHttps && insecure ? { rejectUnauthorized: false } : {}),
  };
  return new Promise((resolve, reject) => {
    const req = mod.request(options, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode ?? 0, json: JSON.parse(data) as PushResult });
        } catch {
          resolve({ status: res.statusCode ?? 0, json: { error: data.slice(0, 200) } });
        }
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function pushOne(file: string): Promise<boolean> {
  const full = path.join(ZONES_DIR, file);
  if (!fs.existsSync(full)) {
    console.error(`   ✗ ${file}: not found`);
    return false;
  }
  if (isNoImportMap(file)) {
    console.log(`   – ${file} skipped (scratch copy)`);
    return true;
  }
  const tmj = JSON.parse(fs.readFileSync(full, 'utf-8')) as Record<string, unknown>;
  const zoneId = (readMapName(full) ?? path.basename(file, '.tmj')).toLowerCase();
  const files = referencedFiles(tmj);
  const body = JSON.stringify({ zoneId, tmj, files });
  const kb = Math.round(Buffer.byteLength(body) / 1024);
  try {
    const { status, json } = await post(body);
    if (status !== 200 || !json.ok) {
      console.error(`   ✗ ${file} → ${zoneId}: HTTP ${status} ${json.error ?? ''}`);
      return false;
    }
    const extra = json.unresolvedCount ? `  ⚠ ${json.unresolvedCount} placements did not resolve` : '';
    console.log(
      `   ✓ ${file} → ${zoneId}  ${json.cols}×${json.rows}, ${json.furnitureCount} furniture, ${json.imageCount} image(s), ${kb} KB${extra}`,
    );
    if (json.unresolvedCount) {
      console.error('     (the server\'s tilesets differ from yours — deploy the tilesets, then push again)');
    }
    return true;
  } catch (err) {
    console.error(`   ✗ ${file}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

function targets(): string[] {
  if (names.length > 0) return names.map((n) => (n.endsWith('.tmj') ? n : `${n}.tmj`));
  if (!fs.existsSync(ZONES_DIR)) return [];
  return fs.readdirSync(ZONES_DIR).filter((f) => f.endsWith('.tmj')).sort();
}

console.log(`[push] ${server}${insecure ? ' (self-signed ok)' : ''}`);
let failed = 0;
for (const file of targets()) if (!(await pushOne(file))) failed++;

if (!watch) process.exit(failed === 0 ? 0 : 1);

// Debounced per file: editors emit several fs events per save, and one zone's
// save must not delay or swallow another's — same reasoning the removed server
// watcher had.
const pending = new Map<string, NodeJS.Timeout>();
fs.watch(ZONES_DIR, (_event, filename) => {
  if (!filename || !filename.endsWith('.tmj')) return;
  if (names.length > 0 && !names.some((n) => (n.endsWith('.tmj') ? n : `${n}.tmj`) === filename)) return;
  clearTimeout(pending.get(filename));
  pending.set(
    filename,
    setTimeout(() => {
      pending.delete(filename);
      void pushOne(filename);
    }, 300),
  );
});
console.log(`[push] watching ${path.relative(ROOT, ZONES_DIR)} — Ctrl-C to stop`);
