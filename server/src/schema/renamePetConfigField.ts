/**
 * Rename the `npc` field of a stored art row to `petConfig`, once.
 *
 * Everything this codebase called an NPC was a pet — dog, cat or duck. `NpcAction` was
 * `'wander' | 'sit' | 'chase' | 'flee' | 'drink' | 'talk'`, `NpcConfig` was a pet's spawn
 * settings, and the editor tab labelled "NPCs" listed animals. That left no name for the humanoid
 * NPCs this world is meant to grow (AGENTS.md's direction says "players and NPCs beside the
 * agents"), so 250 identifiers were renamed to say pet and the word was freed. This is the part of
 * that rename which touches DATA: a saved pet override carries its spawn config under the old key.
 *
 * Two things make it safe:
 *
 *  • It only ever renames a key. The value is copied across untouched, and a row that already has
 *    `petConfig` is left alone — so running it twice cannot merge or lose anything.
 *  • `assetOverrides.withPetConfig` reads BOTH names anyway. This migration is therefore an
 *    optimisation of clarity, not a prerequisite: a world that never runs it still works, which is
 *    what makes a restored backup a non-event.
 *
 * No `_migrations` marker, like the other schema jobs here: the question answers itself, since a
 * row either still has the old key or it does not.
 */
import type { DatabaseSync } from 'node:sqlite';

export function renamePetConfigField(db: DatabaseSync): void {
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'assets'").get();
  if (!table) return; // fresh database; appStore creates the table with nothing in it

  const rows = db
    .prepare(
      `SELECT type, name, data FROM assets
        WHERE json_valid(data) AND json_extract(data, '$.npc') IS NOT NULL`,
    )
    .all() as Array<{ type: string; name: string; data: string }>;
  if (rows.length === 0) return;

  const update = db.prepare('UPDATE assets SET data = ? WHERE type = ? AND name = ?');
  let moved = 0;
  const failed: string[] = [];
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.data) as Record<string, unknown>;
      const { npc, ...rest } = parsed;
      // Both keys present means somebody has already been here; the new one wins and the old one
      // is simply dropped rather than guessed about.
      const next = rest.petConfig !== undefined ? rest : { ...rest, petConfig: npc };
      update.run(JSON.stringify(next), row.type, row.name);
      moved++;
    } catch {
      failed.push(`${row.type}/${row.name}`);
    }
  }

  if (moved > 0) console.log(`[schema] renamed the stored 'npc' spawn config to 'petConfig' on ${moved} row(s)`);
  if (failed.length > 0) {
    console.warn(`[schema] ${failed.length} row(s) left as they were, unreadable: ${failed.slice(0, 5).join(', ')}`);
  }
}
