/**
 * paths.ts — central resolution of the server's writable data directory.
 *
 * Everything the server persists (config.json, <namespace>-state.json and the
 * SQLite layout database) lives under a single directory. The location is
 * overridable via the PIXEL_STREAM_DATA_DIR environment variable so a container
 * can point it at a mounted volume; it defaults to ~/.pixel-agents.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { LAYOUT_FILE_DIR } from './constants.js';

/** Resolve the data directory (env override or ~/.pixel-agents). */
export function dataDir(): string {
  const fromEnv = process.env.PIXEL_STREAM_DATA_DIR?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : path.join(os.homedir(), LAYOUT_FILE_DIR);
}

/** Resolve a file path inside the data directory, creating the directory if needed. */
export function dataPath(fileName: string): string {
  const dir = dataDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* mkdir is best-effort; callers handle their own write errors */
  }
  return path.join(dir, fileName);
}
