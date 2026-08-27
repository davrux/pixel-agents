/**
 * Every test process gets its own data directory — loaded with `--import`, so it runs in each
 * test child before any module can open a database.
 *
 * Without it, a test file that imports anything reaching `db.ts` opens the DEVELOPER's world at
 * `tmp/data/pixel.db`. Two consequences, and the second is the one that wasted an afternoon.
 * A test suite has no business touching the world somebody is working in — `db.ts` runs a
 * migration on import, and `PIXEL_RESET_WORLD` would be honoured there too. And because opening
 * takes SQLite's write lock, a dozen test children racing for one file meant roughly one run in
 * eight died with `SQLITE_BUSY` while still importing: exit code 1, no failing assertion, a
 * different file each time, and node reporting nothing but 'test failed'. The busy timeout in
 * db.ts stops that being fatal; this stops it happening at all, and keeps the runs independent.
 *
 * A file that sets `PIXEL_STREAM_DATA_DIR` itself (artStore, artSaveApi, authThrottle, …) still
 * wins: those assign it before their own dynamic imports, which is after this ran.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (!process.env.PIXEL_STREAM_DATA_DIR) {
  const dir = mkdtempSync(join(tmpdir(), 'pixel-test-data-'));
  process.env.PIXEL_STREAM_DATA_DIR = dir;
  process.on('exit', () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* a leftover temp dir is not worth failing a test run over */
    }
  });
}
