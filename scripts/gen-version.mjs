// Write the current version (git describe) to server/version.txt so the running
// server can log it. Run at release time (pnpm release / docker:build) on the
// host — the Docker build excludes .git, so the file must be generated first and
// copied into the image. Falls back to "unknown" outside a git checkout.
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let version = 'unknown';
try {
  version = execSync('git describe --tags --always --dirty', { stdio: ['ignore', 'pipe', 'ignore'] })
    .toString()
    .trim();
} catch {
  /* not a git checkout — leave "unknown" */
}

const out = fileURLToPath(new URL('../server/version.txt', import.meta.url));
writeFileSync(out, version + '\n');
console.log(`[version] wrote ${out}: ${version}`);
