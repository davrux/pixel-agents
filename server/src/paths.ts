import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Writable data directory for persisted state — `pixel.db`, and the optional
 * `cert.pem`/`key.pem` for the built-in TLS.
 *
 * Defaults to `tmp/data` inside the repo, so a development database sits next to
 * the checkout it belongs to rather than in a hidden directory in `$HOME`: two
 * checkouts no longer share one database, deleting a clone takes its data with
 * it, and `ls tmp/data` answers "where is my world" without anyone having to
 * know a path. Its own subdirectory rather than `tmp` itself, because `tmp`
 * already collects unrelated scratch (the MetroCity pack, arcade content) and a
 * database should not be something you delete by clearing scratch.
 *
 * A deployment always sets `PIXEL_STREAM_DATA_DIR` (the image sets `/data` and
 * mounts a volume there), so this default is only ever the local one — which is
 * exactly what {@link usingDefaultDataDir} keys development-only conveniences
 * off, see dataBootstrap.ts.
 */
export function dataDir(): string {
  const fromEnv = process.env.PIXEL_STREAM_DATA_DIR?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : defaultDataDir();
}

/** The built-in `tmp/data` inside the repo. */
export function defaultDataDir(): string {
  return path.resolve(__dirname, '..', '..', 'tmp', 'data');
}

/** True when nobody configured a data directory, i.e. this is a development run
 *  out of a checkout. A deployment always sets PIXEL_STREAM_DATA_DIR, so this is
 *  the one honest signal for "may I do convenient things here". */
export function usingDefaultDataDir(): boolean {
  return !(process.env.PIXEL_STREAM_DATA_DIR?.trim());
}

/** Resolve a file path inside the data directory, creating it if needed. */
export function dataPath(fileName: string): string {
  const dir = dataDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* best-effort; callers handle their own write errors */
  }
  return path.join(dir, fileName);
}
