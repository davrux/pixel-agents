/**
 * Make the data directory usable on first start, so a fresh checkout runs with
 * `pnpm dev:server` and nothing else.
 *
 * Three conveniences, all idempotent and all confined to a **development** run —
 * a deployment sets `PIXEL_STREAM_DATA_DIR` and gets none of them
 * (`usingDefaultDataDir`). That gate is not cosmetic: generating a certificate in
 * a container's `/data` would flip the server to HTTPS, and the deploy topology
 * depends on it serving plain HTTP behind Caddy, which terminates TLS itself.
 *
 * 1. Create the directory (`tmp/data`).
 * 2. Adopt a database from where the default used to be, so moving the default
 *    doesn't strand somebody's world. One copy, never a move: the old file stays
 *    put as its own backup until whoever owns it deletes it.
 * 3. Generate a self-signed certificate, because the client needs a secure
 *    context for camera, microphone and screen sharing — without one, half the
 *    app is unusable locally for a reason no error message explains well.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { dataDir, usingDefaultDataDir } from './paths.js';

/** Where a database may be adopted from, newest convention first. Both are
 *  former defaults: `tmp/` was the default for a day, `~/.pixel-agents2` for
 *  much longer. */
function legacyDatabases(): string[] {
  return [
    path.resolve(dataDir(), '..', 'pixel.db'), // tmp/pixel.db
    path.join(os.homedir(), '.pixel-agents2', 'pixel.db'),
  ];
}

/**
 * Create the data directory and, on a development run with no database yet,
 * bring one over from a former default location.
 *
 * Called from db.ts before the connection is opened — that module is the single
 * door to the database and its body runs before anything can read from it, which
 * is what makes "copy it in first" possible at all.
 */
export function bootstrapDataDir(): void {
  const dir = dataDir();
  const existed = fs.existsSync(dir);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    // Nothing can work without it; say so plainly rather than failing later on a
    // confusing SQLite error.
    console.error(`[data] cannot create ${dir}: ${(err as Error)?.message}`);
    return;
  }
  if (!existed) console.log(`[data] created ${dir}`);

  const target = path.join(dir, 'pixel.db');
  if (!usingDefaultDataDir() || fs.existsSync(target)) return;
  for (const source of legacyDatabases()) {
    if (!fs.existsSync(source)) continue;
    try {
      fs.copyFileSync(source, target);
      console.log(`[data] adopted the database from ${source} (the original is left in place)`);
    } catch (err) {
      console.warn(`[data] could not adopt ${source}: ${(err as Error)?.message}`);
    }
    return;
  }
}

/**
 * Give a development run a self-signed certificate if it has none, so the client
 * gets the secure context that camera/microphone/screen-share need.
 *
 * Needs `openssl` on PATH; without it the server simply stays on HTTP and says
 * why, because a missing dev tool must not stop the app from starting. Skipped
 * entirely when the paths are configured (`PIXEL_TLS_*`) or the data directory
 * is not the built-in one — see the note at the top about why that matters.
 */
export function ensureDevTls(certPath: string, keyPath: string): void {
  if (!usingDefaultDataDir()) return;
  if (process.env.PIXEL_TLS_CERT || process.env.PIXEL_TLS_KEY) return;
  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) return;
  try {
    execFileSync(
      'openssl',
      [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256',
        '-days', '825', // beyond this, browsers reject a cert outright
        '-subj', '/CN=localhost',
        '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1',
        '-keyout', keyPath,
        '-out', certPath,
      ],
      { stdio: 'ignore' },
    );
    console.log(`[tls] generated a self-signed development certificate in ${path.dirname(certPath)}`);
  } catch (err) {
    // Clean up a half-written pair, or the next start would think it has one.
    for (const f of [certPath, keyPath]) {
      try {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      } catch {
        /* best-effort */
      }
    }
    console.warn(
      `[tls] no certificate and could not generate one (${(err as Error)?.message}) — serving plain HTTP. ` +
        'Camera, microphone and screen sharing need a secure context; install openssl or drop cert.pem/key.pem in the data dir.',
    );
  }
}
