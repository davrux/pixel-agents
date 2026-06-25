import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Writable data directory for persisted state (the SQLite layout DB).
 *  Override with PIXEL_STREAM_DATA_DIR (e.g. a mounted volume); defaults to
 *  ~/.pixel-agents2. */
export function dataDir(): string {
  const fromEnv = process.env.PIXEL_STREAM_DATA_DIR?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : path.join(os.homedir(), '.pixel-agents2');
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
