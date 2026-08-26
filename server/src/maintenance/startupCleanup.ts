/**
 * Housekeeping that runs on every boot, before anything reads the world.
 *
 * The whole start is unattended — there is no step where a human looks at a report
 * and decides — so a task here must be safe by construction, not by supervision.
 * What that means in practice, and what every task added later has to honour:
 *
 *  • **It cannot be wrong about what is unused.** Evidence comes from two
 *    independent places (what the tilesets offer, what the stored layouts place), and
 *    anything either one claims is kept.
 *  • **It refuses when its evidence looks broken.** A registry that failed to load
 *    makes every row look unused; that is a deployment to fix, not a licence to
 *    delete. Guards live in pure functions so they are tested, not hoped for.
 *  • **It leaves recent work alone.** Anything touched in the last few days belongs
 *    to somebody who is still working; junk is weeks old and is not going anywhere.
 *  • **It destroys only what nothing can reach.** A row it deletes is offered by no
 *    tileset and placed in no layout, so there is nothing to restore it from — and
 *    nothing that wants it.
 *  • **It cannot stop the server.** A failing task logs and is skipped: housekeeping
 *    is never worth a world that will not come up.
 *
 * Order matters: this runs BEFORE loadAssetBundle, because the bundle is built from
 * these rows and is then cached process-wide. Cleaning afterwards leaves the server
 * serving exactly what it just deleted — which is how the first, manual run of this
 * behaved (the client kept reporting 2461 assets until a restart).
 */
// ASSETS_ROOT only — importing this module does not load anything (loadAssetBundle does).
import { ASSETS_ROOT } from '../assets.js';
import { deleteAssets, knownAssetIds, placedAssetIds, storedAssets, totalBytes } from './orphanAssets.js';
import { decideFurnitureRetire, dumpFurnitureAssets } from './retireFurniture.js';
import { accountIds, decideAvatarPrune } from './orphanAvatars.js';
import { migrateLeftRow } from '../art/migrateLeftRow.js';

export interface CleanupTask {
  name: string;
  /** One line, printed when the task did something. */
  run(): string | null;
}

/** Bytes for a boot line: KB below a megabyte, because "0.00 MB freed" reads as
 *  "nothing happened" when a row really was deleted. */
const mb = (bytes: number) =>
  bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(2)} MB`;

/**
 * Retire what is left of the stored furniture overrides.
 *
 * Furniture art comes from Tiled tilesets, the client has no way to save any, and the merge
 * that let a stored row replace a tileset entry went with the `furniture` asset type. So these
 * rows are unreachable by construction rather than by inference — which is why this replaced
 * the orphan prune that used to run here: that one had to reason about which rows were still
 * offered or placed, and kept the ones that were. There is nothing left to reason about.
 *
 * A copy goes next to the database first. See retireFurniture.ts for why this delete takes a
 * backup where the orphan prune deliberately does not.
 */
const retireFurnitureAssets: CleanupTask = {
  name: 'retire-furniture-overrides',
  run() {
    const rows = storedAssets('furniture');
    if (rows.length === 0) return null; // the normal case, and the one this leaves behind
    const known = knownAssetIds(ASSETS_ROOT);
    // A registry that failed to load is NOT a reason to stop here, unlike in the prune this
    // replaced: the delete does not depend on it. Only the report does — without it this cannot
    // say which rows had been overriding live art — so it degrades the sentence, not the action.
    const decision = decideFurnitureRetire(rows, known);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    let copy: string;
    try {
      copy = dumpFurnitureAssets(decision.retire.map((r) => r.name), stamp);
    } catch (err) {
      // Housekeeping may never stop the server, and deleting without the copy would break the
      // promise this task makes, so it steps back and tries again next boot.
      console.warn(`[cleanup] retire-furniture-overrides skipped: could not write the copy (${err instanceof Error ? err.message : err})`);
      return null;
    }
    const { deleted } = deleteAssets(
      'furniture',
      decision.retire.map((r) => r.name),
    );
    const shadowed = decision.shadowing.length
      ? `${decision.shadowing.length} of them had been overriding tileset art until this build`
      : 'none of them were still in use';
    const blind = known.size === 0 ? ' (tileset registry unreadable, so that split is a guess)' : '';
    return `retired ${deleted} furniture override(s), ${mb(decision.bytes)} freed — ${shadowed}${blind}; copy at ${copy}`;
  },
};

/**
 * Say when a stored map places art no tileset offers any more.
 *
 * Nothing can repair this automatically: the placement names an id, and if no tileset carries
 * that id there is no art to draw and no way to guess which piece was meant — it is a map to
 * re-author. It used to be a side effect of the furniture prune, which could only see it for
 * ids that ALSO had a stored row; asking the two sources directly covers every placement, and
 * on a healthy world it says nothing at all (measured: 1775 ids offered, 127 placed, 0 missing).
 */
const reportUnavailablePlacements: CleanupTask = {
  name: 'report-unavailable-placements',
  run() {
    const known = knownAssetIds(ASSETS_ROOT);
    if (known.size === 0) return null; // no evidence; a broken registry would accuse every map
    const missing = [...placedAssetIds()].filter(([id]) => !known.has(id));
    if (missing.length === 0) return null;
    console.warn(
      `[cleanup] ${missing.length} placed id(s) no tileset carries any more: ` +
        missing
          .slice(0, 5)
          .map(([id, where]) => `${id} (${where.join(', ')})`)
          .join('; '),
    );
    return null; // a warning about maps, not a change this task made
  },
};


/**
 * Delete personal avatars whose account no longer exists.
 *
 * Unreachable by construction — an avatar is keyed by its owner's user_id and only a
 * signed-in session renders one — and the largest per-row asset in the table (~77 KB).
 * See orphanAvatars.ts for why this is defence rather than a fix: the delete paths
 * already clean up, but a restored or hand-edited database does not.
 */
const pruneOrphanAvatars: CleanupTask = {
  name: 'prune-orphan-avatars',
  run() {
    const decision = decideAvatarPrune(storedAssets('playerAvatar'), accountIds());
    if (decision.refused) {
      console.warn(`[cleanup] prune-orphan-avatars skipped: ${decision.refused}`);
      return null;
    }
    if (decision.deletable.length === 0) return null;
    const { deleted } = deleteAssets(
      'playerAvatar',
      decision.deletable.map((r) => r.name),
    );
    const held = decision.tooYoung.length ? `, ${decision.tooYoung.length} too recent to touch` : '';
    return `pruned ${deleted} avatar(s) whose account is gone, ${mb(totalBytes(decision.deletable))} freed${held}`;
  },
};


/**
 * Convert stored art to four-row sheets, once.
 *
 * Not a cleanup — a format migration, but it belongs to the same "before anything reads
 * the world" slot, since the bundle is built from these rows. It is remembered in
 * `_migrations` and leaves a row it cannot convert exactly as it was. See
 * art/migrateLeftRow.ts.
 */
const addLeftRowToStoredArt: CleanupTask = {
  name: 'art-left-row',
  run: () => migrateLeftRow(),
};

/** Everything that runs at boot, in order. Add to this list; keep the contract. */
export const CLEANUP_TASKS: CleanupTask[] = [
  addLeftRowToStoredArt,
  retireFurnitureAssets,
  reportUnavailablePlacements,
  pruneOrphanAvatars,
];

/**
 * Run every task. Never throws: a task that fails is logged and skipped, because
 * housekeeping must not be able to keep the world down.
 */
export function runStartupCleanup(tasks: CleanupTask[] = CLEANUP_TASKS): void {
  for (const task of tasks) {
    try {
      const said = task.run();
      if (said) console.log(`[cleanup] ${task.name}: ${said}`);
    } catch (err) {
      console.warn(`[cleanup] ${task.name} failed, skipping: ${err instanceof Error ? err.message : err}`);
    }
  }
}
