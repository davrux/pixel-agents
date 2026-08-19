/**
 * Stored asset rows whose id no tileset carries any more — finding them, and
 * deleting them when told to.
 *
 * Where they come from: furniture used to be uploaded into the database as pixels.
 * Art moved into Tiled tilesets, packages came and went, and the rows of a removed
 * one stayed behind — ids nothing can place, since a mapper only ever paints what a
 * tileset offers. They are not inert either: a row without a file has no image to
 * point at, so each one is sent as SpriteData in `furnitureAssetsLoaded` on every
 * join. In this repo's database that was 695 rows, 1.33 MB of a 1.79 MB message.
 *
 * The classification is a pure function (see classifyAssets) so the interesting part
 * is testable without a database, and so the CLI and the startup task cannot drift
 * apart — both call it.
 */
import { db } from '../db.js';
import { loadTiledRegistry } from '../tiled/tiledRegistry.js';

export interface StoredAsset {
  name: string;
  bytes: number;
  /** Epoch ms of the last write — what the grace period below is measured against. */
  updatedAt: number;
}

export interface AssetClassification {
  /** Carried by a tileset: art in use, whatever its age. */
  kept: StoredAsset[];
  /** Carried by nothing and placed nowhere — deletable. */
  orphans: StoredAsset[];
  /** Carried by nothing but PLACED somewhere: a map to repair, never a row to
   *  delete. Maps to where each was found. */
  inUse: Array<{ asset: StoredAsset; where: string[] }>;
}

/**
 * Split stored rows into kept / orphaned / in-use.
 *
 * Deliberately pure and deliberately conservative in one direction only: anything
 * either half of the evidence claims is a false positive keeps a row, which costs
 * bytes. A false negative would delete art, which cannot be undone.
 */
export function classifyAssets(rows: StoredAsset[], knownIds: Set<string>, placedIds: Map<string, string[]>): AssetClassification {
  const kept: StoredAsset[] = [];
  const orphans: StoredAsset[] = [];
  const inUse: AssetClassification['inUse'] = [];
  for (const row of rows) {
    if (knownIds.has(row.name)) kept.push(row);
    else if (placedIds.has(row.name)) inUse.push({ asset: row, where: placedIds.get(row.name)! });
    else orphans.push(row);
  }
  return { kept, orphans, inUse };
}

/** Every id any tileset offers — the definition of "not an orphan". */
export function knownAssetIds(assetsRoot: string): Set<string> {
  const out = new Set<string>();
  for (const ts of loadTiledRegistry(assetsRoot).tilesets) {
    for (const tile of ts.tiles) {
      const id = tile?.props?.id;
      if (typeof id === 'string' && id) out.add(id);
    }
  }
  return out;
}

/**
 * Where each id is placed, from the STORED layouts — the authoritative answer, since
 * that is what a room actually simulates.
 *
 * The committed `.tmj` files are deliberately not scanned: they refer to art by gid,
 * so answering from them means guessing at strings, and a zone's stored layout is
 * already the imported truth of every map that matters. A map that exists only as a
 * file and was never pushed cannot be broken by this — nothing reads it yet.
 */
export function placedAssetIds(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const note = (id: string, where: string) => {
    const list = out.get(id) ?? [];
    if (!list.includes(where)) list.push(where);
    out.set(id, list);
  };
  for (const row of db.prepare('SELECT name, data FROM layouts').all() as Array<{ name: string; data: string }>) {
    let layout: { furniture?: Array<{ id?: string }>; decals?: Array<{ id?: string }> };
    try {
      layout = JSON.parse(row.data) as typeof layout;
    } catch {
      continue; // an unreadable layout is not evidence either way
    }
    for (const f of layout.furniture ?? []) if (f.id) note(f.id, `zone ${row.name}`);
    for (const d of layout.decals ?? []) if (d.id) note(d.id, `zone ${row.name}`);
  }
  return out;
}

/** Read the stored rows of one asset type, with their sizes. */
export function storedAssets(type: string): StoredAsset[] {
  return db.prepare('SELECT name, length(data) AS bytes, updatedAt FROM assets WHERE type = ?').all(type) as unknown as StoredAsset[];
}

/** Look, without touching anything. */
export function inspectOrphanAssets(assetsRoot: string, type: string): AssetClassification {
  return classifyAssets(storedAssets(type), knownAssetIds(assetsRoot), placedAssetIds());
}

/**
 * Delete the given rows.
 *
 * No backup: these rows are unreferenced by construction — no tileset offers the id
 * and no stored layout places it — so there is nothing here that a restore could give
 * back that the tilesets cannot. The protection that matters is upstream, in
 * decidePrune: a broken registry, a placed id or recent work each stop the delete
 * before it starts. (A `VACUUM INTO` snapshot used to be taken here; it was 5.6 MB
 * per boot that changed anything, guarding data nobody can reach.)
 */
export function deleteAssets(type: string, names: string[]): { deleted: number } {
  if (names.length === 0) return { deleted: 0 };
  const stmt = db.prepare('DELETE FROM assets WHERE type = ? AND name = ?');
  let deleted = 0;
  for (const name of names) deleted += stmt.run(type, name).changes as number;
  return { deleted };
}

export function totalBytes(rows: StoredAsset[]): number {
  return rows.reduce((n, r) => n + r.bytes, 0);
}

/**
 * A row must have been dead for this long before it is deleted unattended.
 *
 * The startup task runs on every boot with nobody watching, so it needs a reason to
 * believe a row is junk rather than work in progress. Age is that reason: the rows
 * this was written for were nine days old, while anything a person is doing right now
 * — an import mid-flight, an upload if that path ever returns — is minutes old. Seven
 * days costs nothing (the junk is not going anywhere) and takes the whole class of
 * "deleted something someone had just made" off the table.
 */
export const ORPHAN_GRACE_DAYS = 7;

/**
 * How many ids a healthy registry has, below which this refuses to act.
 *
 * The dangerous failure is not a wrong row, it is a registry that did not load: with
 * no ids, EVERY row looks orphaned and an unattended delete would empty the table.
 * This world has ~1770 ids; a few hundred means several tilesets failed to parse, and
 * that is a broken deployment to fix, not a licence to delete.
 */
export const MIN_HEALTHY_IDS = 500;

export interface PruneDecision {
  /** Rows to delete — empty whenever anything looks off. */
  deletable: StoredAsset[];
  /** Orphans held back by the grace period. */
  tooYoung: StoredAsset[];
  /** Set when the whole run is refused, with the reason for the log. */
  refused?: string;
}

/**
 * Turn a classification into a decision. Pure, so every guard is testable without a
 * database — which is the point: this function is what stands between an unattended
 * boot and irreversible deletion.
 */
export function decidePrune(
  classification: AssetClassification,
  knownIdCount: number,
  now = Date.now(),
  graceDays = ORPHAN_GRACE_DAYS,
): PruneDecision {
  const { orphans } = classification;
  if (orphans.length === 0) return { deletable: [], tooYoung: [] };
  if (knownIdCount < MIN_HEALTHY_IDS) {
    return {
      deletable: [],
      tooYoung: [],
      refused: `the tileset registry offers only ${knownIdCount} ids (healthy is ${MIN_HEALTHY_IDS}+) — assets look unreadable, so nothing is deleted`,
    };
  }
  const cutoff = now - graceDays * 86_400_000;
  const deletable = orphans.filter((r) => r.updatedAt > 0 && r.updatedAt < cutoff);
  const tooYoung = orphans.filter((r) => !(r.updatedAt > 0 && r.updatedAt < cutoff));
  return { deletable, tooYoung };
}
