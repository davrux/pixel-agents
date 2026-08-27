/**
 * Where the app's per-user state lives, and the one-time move of the directory
 * the old app name produced.
 *
 * Deliberately free of any `electron` import: this is the half that decides and
 * moves files, so it is a pure function of a parent directory and what is on
 * disk, and `userDataDir.test.ts` drives it against scratch directories. See
 * appPaths.ts for why the move exists at all.
 *
 * The directory it returns holds the bearer token and the trusted-cert store, so
 * the rule throughout is: never point at empty state while real state exists,
 * and never delete anything that has not been proven to hold nothing.
 */
import { cpSync, readdirSync, renameSync, rmdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** The pinned directory name. Deliberately NOT derived from the app's display
 *  name: renaming the app must never relocate the user's credentials. */
export const DATA_DIR = 'pixel-agents';

/** Where `@pixel/desktop` used to put it, as path segments — the slash in that
 *  name made this two levels deep instead of one. */
export const LEGACY_DIR = ['@pixel', 'desktop'];

export type ResolveOutcome =
  /** Nothing to move; the pinned directory is in use. */
  | 'pinned'
  /** The legacy directory was moved onto the pinned one. */
  | 'migrated'
  /** The move failed, so the legacy directory stays in use and keeps its data. */
  | 'legacy';

export interface ResolvedUserData {
  dir: string;
  outcome: ResolveOutcome;
}

/** What is at a path, to the precision the decisions below actually need.
 *  `unreadable` is its own answer and never folded into `empty`: a directory we
 *  cannot list is the one case where "it looks empty" would license a delete. */
type Entry = 'absent' | 'empty-dir' | 'nonempty-dir' | 'not-a-dir' | 'unreadable';

function inspect(path: string): Entry {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return 'absent';
  }
  if (!stat.isDirectory()) return 'not-a-dir';
  try {
    return readdirSync(path).length > 0 ? 'nonempty-dir' : 'empty-dir';
  } catch {
    return 'unreadable';
  }
}

/**
 * Decide the userData directory under `appData`, migrating the legacy one if
 * this is the first run to see it.
 *
 * Never throws. A move that cannot be completed returns the LEGACY directory
 * rather than an empty pinned one, because the alternative presents to the user
 * as "you have been logged out and your trusted certificates are gone" — the
 * data is there, and pointing away from it is the one outcome worth avoiding.
 */
export function resolveUserDataDir(appData: string): ResolvedUserData {
  const target = join(appData, DATA_DIR);
  const legacy = join(appData, ...LEGACY_DIR);

  // Only a legacy directory that actually holds something is worth moving.
  if (inspect(legacy) !== 'nonempty-dir') return { dir: target, outcome: 'pinned' };

  const at = inspect(target);
  // Real state already at the pinned path wins: it is the newer of the two, and
  // overwriting it would destroy the current session to restore an old one. An
  // unreadable target counts here too — it cannot be shown to be empty, so it is
  // not something to delete. The legacy directory is left on disk either way;
  // this function moves state, it does not decide what to throw away.
  if (at === 'nonempty-dir' || at === 'unreadable') return { dir: target, outcome: 'pinned' };

  try {
    // Clear whatever is in the way, now known to hold nothing: an empty
    // directory (an earlier aborted launch — Electron creates userData eagerly)
    // or a stray file. `rmdirSync` for the directory rather than a recursive
    // `rmSync`, so a mistake in the check above cannot cascade into a wipe.
    if (at === 'empty-dir') rmdirSync(target);
    else if (at === 'not-a-dir') rmSync(target, { force: true });

    moveDir(legacy, target);
    pruneEmptyLegacyParent(appData);
    return { dir: target, outcome: 'migrated' };
  } catch {
    // A half-finished copy at the target would look like real state to the next
    // run, which would then adopt it and silently drop the rest. Safe to clear
    // because the target was proven to hold nothing above, and the legacy
    // directory is still intact — moveDir deletes it only once the copy landed.
    try {
      rmSync(target, { recursive: true, force: true });
    } catch {
      // Then the next run finds a partial target and treats it as pinned. Worth
      // no more than a try: there is nothing else this can do.
    }
    return { dir: legacy, outcome: 'legacy' };
  }
}

/** Rename, falling back to copy-then-delete. The rename is one atomic step and
 *  is what happens in practice (same filesystem); the copy covers a userData
 *  directory symlinked onto another volume, where rename gives EXDEV. */
function moveDir(from: string, to: string): void {
  try {
    renameSync(from, to);
    return;
  } catch {
    // Copy first, delete only once it has arrived: a failure midway then leaves
    // the original intact for the caller to fall back to.
    cpSync(from, to, { recursive: true });
    rmSync(from, { recursive: true, force: true });
  }
}

/** The now-empty `@pixel` parent is an artifact of the old name. `rmdirSync`
 *  because it removes a directory only while it is empty — a sibling entry would
 *  be somebody else's data, and this refuses rather than judges. */
function pruneEmptyLegacyParent(appData: string): void {
  try {
    rmdirSync(join(appData, LEGACY_DIR[0]));
  } catch {
    // Not empty, or not there. A leftover empty directory is cosmetic anyway.
  }
}
