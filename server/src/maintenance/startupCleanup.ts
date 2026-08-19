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
import { deleteAssets, decidePrune, inspectOrphanAssets, knownAssetIds, totalBytes } from './orphanAssets.js';

export interface CleanupTask {
  name: string;
  /** One line, printed when the task did something. */
  run(): string | null;
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;

/**
 * Delete stored asset rows no tileset carries any more.
 *
 * They cannot be placed (a mapper only paints what a tileset offers) but they still
 * travel to every client on every join, as pixels, because a row without a file has no
 * image to point at.
 */
const pruneOrphanAssets: CleanupTask = {
  name: 'prune-orphan-assets',
  run() {
    const type = 'furniture';
    const known = knownAssetIds(ASSETS_ROOT);
    const classification = inspectOrphanAssets(ASSETS_ROOT, type);
    const decision = decidePrune(classification, known.size);
    if (decision.refused) {
      console.warn(`[cleanup] prune-orphan-assets skipped: ${decision.refused}`);
      return null;
    }
    if (classification.inUse.length > 0) {
      // Not a warning about this task — a warning about a map. Worth saying out loud
      // once per boot, since nothing else notices.
      console.warn(
        `[cleanup] ${classification.inUse.length} placed asset(s) no tileset carries any more: ` +
          classification.inUse
            .slice(0, 5)
            .map((e) => `${e.asset.name} (${e.where.join(', ')})`)
            .join('; '),
      );
    }
    if (decision.deletable.length === 0) return null;
    const { deleted } = deleteAssets(
      type,
      decision.deletable.map((r) => r.name),
    );
    const held = decision.tooYoung.length ? `, ${decision.tooYoung.length} too recent to touch` : '';
    return `pruned ${deleted} orphaned ${type} asset(s), ${mb(totalBytes(decision.deletable))} freed${held}`;
  },
};

/** Everything that runs at boot, in order. Add to this list; keep the contract. */
export const CLEANUP_TASKS: CleanupTask[] = [pruneOrphanAssets];

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
