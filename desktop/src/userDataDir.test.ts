/**
 * The userData migration decides where a user's bearer token and trusted
 * certificates are read from, so its guards are tested rather than reasoned
 * about: the failure it must never produce is pointing at an empty directory
 * while the real state sits next door under the old name.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DATA_DIR, LEGACY_DIR, resolveUserDataDir } from './userDataDir.js';

/** A scratch stand-in for ~/.config, cleaned up by the caller. */
function scratchAppData(): string {
  return mkdtempSync(join(tmpdir(), 'pixel-userdata-'));
}

function legacyPath(appData: string): string {
  return join(appData, ...LEGACY_DIR);
}

function seed(dir: string, file: string, body: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), body, 'utf8');
}

test('a legacy directory is moved onto the pinned one, contents intact', () => {
  const appData = scratchAppData();
  try {
    seed(legacyPath(appData), 'pixel-token.bin', 'ciphertext');
    seed(join(legacyPath(appData), 'nested'), 'certs.json', '{}');

    const { dir, outcome } = resolveUserDataDir(appData);

    assert.equal(outcome, 'migrated');
    assert.equal(dir, join(appData, DATA_DIR));
    assert.equal(readFileSync(join(dir, 'pixel-token.bin'), 'utf8'), 'ciphertext');
    assert.equal(readFileSync(join(dir, 'nested', 'certs.json'), 'utf8'), '{}');
    // The old location is gone, so a later run cannot migrate a second time.
    assert.ok(!existsSync(legacyPath(appData)));
    // And the `@pixel` parent, which only existed because of the slash.
    assert.ok(!existsSync(join(appData, LEGACY_DIR[0])));
  } finally {
    rmSync(appData, { recursive: true, force: true });
  }
});

test('a second run is a no-op and reports pinned', () => {
  const appData = scratchAppData();
  try {
    seed(legacyPath(appData), 'pixel-token.bin', 'ciphertext');
    resolveUserDataDir(appData);

    const { dir, outcome } = resolveUserDataDir(appData);

    assert.equal(outcome, 'pinned');
    assert.equal(dir, join(appData, DATA_DIR));
    assert.equal(readFileSync(join(dir, 'pixel-token.bin'), 'utf8'), 'ciphertext');
  } finally {
    rmSync(appData, { recursive: true, force: true });
  }
});

test('a fresh install with no legacy directory just uses the pinned one', () => {
  const appData = scratchAppData();
  try {
    const { dir, outcome } = resolveUserDataDir(appData);

    assert.equal(outcome, 'pinned');
    assert.equal(dir, join(appData, DATA_DIR));
  } finally {
    rmSync(appData, { recursive: true, force: true });
  }
});

test('an existing pinned directory with content is never overwritten', () => {
  const appData = scratchAppData();
  try {
    // Both present: the pinned one is authoritative and the legacy one is
    // stale. Migrating would destroy the newer state.
    seed(join(appData, DATA_DIR), 'pixel-token.bin', 'current');
    seed(legacyPath(appData), 'pixel-token.bin', 'stale');

    const { dir, outcome } = resolveUserDataDir(appData);

    assert.equal(outcome, 'pinned');
    assert.equal(readFileSync(join(dir, 'pixel-token.bin'), 'utf8'), 'current');
    // The stale copy is left alone rather than deleted: this function moves
    // state, it does not decide what to throw away.
    assert.equal(readFileSync(join(legacyPath(appData), 'pixel-token.bin'), 'utf8'), 'stale');
  } finally {
    rmSync(appData, { recursive: true, force: true });
  }
});

test('an empty pinned directory does not block the migration', () => {
  const appData = scratchAppData();
  try {
    // What an earlier aborted launch leaves behind: Electron creates userData
    // eagerly, so the pinned directory can exist while holding nothing.
    mkdirSync(join(appData, DATA_DIR), { recursive: true });
    seed(legacyPath(appData), 'pixel-token.bin', 'ciphertext');

    const { dir, outcome } = resolveUserDataDir(appData);

    assert.equal(outcome, 'migrated');
    assert.equal(readFileSync(join(dir, 'pixel-token.bin'), 'utf8'), 'ciphertext');
  } finally {
    rmSync(appData, { recursive: true, force: true });
  }
});

test('an empty legacy directory is nothing to migrate', () => {
  const appData = scratchAppData();
  try {
    mkdirSync(legacyPath(appData), { recursive: true });

    const { dir, outcome } = resolveUserDataDir(appData);

    assert.equal(outcome, 'pinned');
    assert.equal(dir, join(appData, DATA_DIR));
  } finally {
    rmSync(appData, { recursive: true, force: true });
  }
});

test('a sibling under @pixel keeps the parent directory', () => {
  const appData = scratchAppData();
  try {
    seed(legacyPath(appData), 'pixel-token.bin', 'ciphertext');
    seed(join(appData, LEGACY_DIR[0], 'other'), 'keep.txt', 'not ours');

    const { outcome } = resolveUserDataDir(appData);

    assert.equal(outcome, 'migrated');
    assert.equal(readFileSync(join(appData, LEGACY_DIR[0], 'other', 'keep.txt'), 'utf8'), 'not ours');
  } finally {
    rmSync(appData, { recursive: true, force: true });
  }
});

test('a stray file where the directory belongs does not block the migration', () => {
  const appData = scratchAppData();
  try {
    seed(legacyPath(appData), 'pixel-token.bin', 'ciphertext');
    writeFileSync(join(appData, DATA_DIR), 'not a directory', 'utf8');

    const { dir, outcome } = resolveUserDataDir(appData);

    assert.equal(outcome, 'migrated');
    assert.equal(readFileSync(join(dir, 'pixel-token.bin'), 'utf8'), 'ciphertext');
  } finally {
    rmSync(appData, { recursive: true, force: true });
  }
});

// The two cases below turn permissions off to force the failure paths. Root
// ignores the permission bits, so there is nothing to force there.
const asRoot = process.getuid?.() === 0;

test('an unmovable legacy directory keeps using the legacy directory', { skip: asRoot }, () => {
  const appData = scratchAppData();
  try {
    seed(legacyPath(appData), 'pixel-token.bin', 'ciphertext');
    // No write permission on the parent: neither the rename nor the copy
    // fallback can create the target, which is the fallback that must never
    // leave the app pointing at empty state.
    chmodSync(appData, 0o500);

    const { dir, outcome } = resolveUserDataDir(appData);

    assert.equal(outcome, 'legacy');
    assert.equal(dir, legacyPath(appData));
    assert.equal(readFileSync(join(dir, 'pixel-token.bin'), 'utf8'), 'ciphertext');
  } finally {
    chmodSync(appData, 0o700);
    rmSync(appData, { recursive: true, force: true });
  }
});

test('an unreadable pinned directory is adopted, never deleted', { skip: asRoot }, () => {
  const appData = scratchAppData();
  const target = join(appData, DATA_DIR);
  try {
    seed(target, 'pixel-token.bin', 'current');
    seed(legacyPath(appData), 'pixel-token.bin', 'stale');
    // Cannot be listed, so it cannot be shown to be empty. Treating that as
    // "empty" is what would license deleting a real userData directory.
    chmodSync(target, 0o000);

    const { dir, outcome } = resolveUserDataDir(appData);

    assert.equal(outcome, 'pinned');
    assert.equal(dir, target);
    chmodSync(target, 0o700);
    assert.equal(readFileSync(join(target, 'pixel-token.bin'), 'utf8'), 'current');
  } finally {
    chmodSync(target, 0o700);
    rmSync(appData, { recursive: true, force: true });
  }
});
