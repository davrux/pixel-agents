#!/usr/bin/env -S node --import tsx
/**
 * Give every furniture tile every property, so a mapper never has to know that
 * a property exists in order to use it.
 *
 * The problem this solves: properties used to appear on a tile only if somebody
 * had set them. A chair drawn without `canSitOn` looked exactly like a chair
 * deliberately marked unsittable, and the only way to discover the property at
 * all was to find another tile that happened to have it. So a new blue chair
 * with the right look and the right category still could not be sat on, with
 * nothing in Tiled to point at. Now the full set is always present, defaults
 * included, and behaviour is whatever the tile visibly says.
 *
 * What it does, over assets/tiled/furniture*.tsj:
 *   - adds every property from FURNITURE_TILE_PROPS that a tile is missing,
 *     at its documented default
 *   - removes properties that are no longer part of the set (a retired one
 *     lingering in a file is worse than absent — it reads as meaningful)
 *   - leaves every existing VALUE alone, and puts them in a fixed order so
 *     re-running changes nothing
 *
 * and over assets/tiled/zones/*.tmj, for FurnitureObject objects only:
 *   - removes retired properties, and nothing else. Placements deliberately
 *     carry only the overrides they actually make — see the header of
 *     src/tiled/furnitureProps.ts, which is also where the property set itself
 *     is defined (this script is a consumer of it, not a second copy).
 *
 * Run this whenever the property set changes. That is not a nicety: the
 * catalog readers, the map bridge and these files have to agree, and a tile
 * missing a property silently behaves as if someone had chosen its default.
 *
 * Usage (from server/):
 *   node --import tsx scripts/sync-furniture-properties.mts [--check] [--fix-gids]
 *     --check      report what would change and exit 1 instead of writing (CI)
 *     --fix-gids   also renumber any map whose tileset table went stale (see
 *                  staleGidTable) — reported but never repaired without this
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { FURNITURE_TILE_PROPS } from '../src/tiled/furnitureProps.js';
import { isFurnitureTileset } from '../src/tiled/tiledRegistry.js';

const TILED_DIR = path.resolve(import.meta.dirname, '..', '..', 'assets', 'tiled');

const CHECK_ONLY = process.argv.includes('--check');
/** Renumber a map whose tileset table went stale, instead of just reporting it
 *  — a wholesale rewrite of every gid in the file, so it is asked for, never
 *  done as a side effect of a routine property sync. */
const FIX_GIDS = process.argv.includes('--fix-gids');

let staleMaps = 0;

/** Properties a FurnitureTile may carry beyond the synced set. `id` is the
 *  catalog identity (never defaulted — a tile without one is an error, not
 *  something to paper over); `generated` marks a tile baked in purely so the
 *  map bridge can draw server-generated furniture, which must not become a
 *  catalog entry (see tiledFurniture.ts). */
const EXTRA_TILE_PROPS = new Set(['id', 'generated']);

/**
 * Properties a placed FurnitureObject may carry: its per-instance overrides.
 * Anything else is a leftover.
 *
 * `name` is absent too, and for the same reason as `id`: a Tiled object already
 * HAS a name — the native field at the top of the Properties panel — so a
 * custom property beside it just gave a mapper two places to type and only one
 * of them worked.
 *
 * `id` is deliberately absent. A placement's identity is its GID — the tile
 * whose sprite it draws — so a second, hand-editable copy of the id could only
 * ever disagree with what you see; it is stripped from any object that has a
 * GID (see syncZones). The rectangle placeholder for a furniture item with no
 * tile at all is the one exception, and it keeps its `id` because nothing else
 * there says what it is.
 */
const OBJECT_PROPS = new Set([
  'approachSides',
  'approachThrough',
  'actionKind',
  'actionVideo',
  'actionUrl',
  'actionPose',
  'canSitOn',
  'sitFacing',
  'petCanSitOn',
  'backgroundTiles',
  'onState',
]);

interface TiledProperty {
  name: string;
  type: string;
  value: string | number | boolean;
  propertytype?: string;
}

function tiledType(value: string | number | boolean): string {
  return typeof value === 'boolean' ? 'bool' : typeof value === 'number' ? 'int' : 'string';
}

function makeProp(name: string, value: string | number | boolean, propertyType?: string): TiledProperty {
  const p: TiledProperty = { name, type: tiledType(value), value };
  if (propertyType) p.propertytype = propertyType;
  return p;
}

const changes: string[] = [];

/** Bring one tile's property list up to the full set, preserving values. */
function syncTile(tile: { id: number; properties?: TiledProperty[] }, file: string): boolean {
  const existing = new Map((tile.properties ?? []).map((p) => [p.name, p]));
  const kept: TiledProperty[] = [];

  // `id` first — it's the identity, and reading a diff is easier when the tile
  // says what it is on line one.
  const idProp = existing.get('id');
  if (!idProp) {
    console.warn(`[sync] ${file} tile ${tile.id}: no "id" property — skipped (nothing else can be resolved without it)`);
    return false;
  }
  kept.push(idProp);
  if (existing.has('generated')) kept.push(existing.get('generated')!);

  for (const spec of FURNITURE_TILE_PROPS) {
    const found = existing.get(spec.name);
    if (found) {
      // Keep the value; adopt the declared propertytype so a property that
      // gained an enum starts showing as a dropdown.
      const p: TiledProperty = { name: spec.name, type: found.type, value: found.value };
      if (spec.propertyType) p.propertytype = spec.propertyType;
      kept.push(p);
    } else {
      kept.push(makeProp(spec.name, spec.default, spec.propertyType));
      changes.push(`${file} ${idProp.value}: + ${spec.name} = ${JSON.stringify(spec.default)}`);
    }
  }

  for (const [name] of existing) {
    if (!EXTRA_TILE_PROPS.has(name) && !FURNITURE_TILE_PROPS.some((s) => s.name === name)) {
      changes.push(`${file} ${idProp.value}: − ${name}`);
    }
  }

  const before = JSON.stringify(tile.properties ?? []);
  tile.properties = kept;
  return JSON.stringify(kept) !== before;
}

function syncTilesets(): string[] {
  const touched: string[] = [];
  for (const file of fs.readdirSync(TILED_DIR).sort()) {
    if (!file.endsWith('.tsj') || !isFurnitureTileset(JSON.parse(fs.readFileSync(path.join(TILED_DIR, file), 'utf-8')))) continue;
    const full = path.join(TILED_DIR, file);
    const json = JSON.parse(fs.readFileSync(full, 'utf-8')) as { tiles?: Array<{ id: number; properties?: TiledProperty[] }> };
    let dirty = false;
    for (const tile of json.tiles ?? []) if (syncTile(tile, file)) dirty = true;
    if (!dirty) continue;
    touched.push(file);
    if (!CHECK_ONLY) fs.writeFileSync(full, `${JSON.stringify(json, null, 2)}\n`);
  }
  return touched;
}

/** Tiled packs horizontal/vertical/diagonal flip flags into a gid's top bits. */
const GID_FLAGS = 0x1fffffff;

/** How many tiles each tileset holds right now, by filename. */
function tileCounts(): Map<string, number> {
  const out = new Map<string, number>();
  for (const file of fs.readdirSync(TILED_DIR)) {
    if (!file.endsWith('.tsj')) continue;
    const json = JSON.parse(fs.readFileSync(path.join(TILED_DIR, file), 'utf-8')) as { tilecount?: number; tiles?: unknown[] };
    out.set(file, json.tilecount ?? (json.tiles ?? []).length);
  }
  return out;
}

/**
 * Does this map's tileset table still match the tilesets on disk?
 *
 * A `.tmj` stores one `firstgid` per tileset and every gid in the file is an
 * offset into that numbering — so growing a tileset shifts every later
 * tileset's range, and a map not re-saved since goes stale. Tiled fixes the
 * table whenever IT saves, which is why this can sit unnoticed for a long time:
 * the map keeps working as long as something other than the gid answers "what
 * is this". Since a furniture placement's identity is now the gid alone, a
 * stale table means a wall tile's range swallows the furniture gids and the
 * placements resolve to nothing. Caught here rather than at import, where it
 * would look like the map had simply lost its furniture.
 *
 * Returns the corrected table (in file order) when it differs, else null.
 */
function staleGidTable(
  tilesets: Array<{ firstgid: number; source?: string }>,
  counts: Map<string, number>,
): Array<{ source: string; from: number; to: number }> | null {
  const ordered = [...tilesets].sort((a, b) => a.firstgid - b.firstgid);
  const fixed: Array<{ source: string; from: number; to: number }> = [];
  let next = 1;
  for (const ts of ordered) {
    const src = path.basename(String(ts.source ?? ''));
    const count = counts.get(src);
    if (count === undefined) return null; // unknown tileset — not ours to judge
    fixed.push({ source: src, from: ts.firstgid, to: next });
    next += count;
  }
  return fixed.some((f) => f.from !== f.to) ? fixed : null;
}

/**
 * Renumber a stale map: the map's own table defines the OLD numbering (Tiled
 * wrote every gid against it), so a gid's local id is its offset from the
 * largest firstgid at or below it — no historical tile counts needed.
 */
function repairGidTable(
  json: { tilesets?: Array<{ firstgid: number; source?: string }>; layers?: Array<Record<string, unknown>> },
  fixed: Array<{ source: string; from: number; to: number }>,
): number {
  const FLAG_BITS = ~GID_FLAGS & 0xffffffff;
  const byOld = [...fixed].sort((a, b) => a.from - b.from);
  const remap = (gid: number): number => {
    if (!gid) return 0;
    const flags = gid & FLAG_BITS;
    const base = gid & GID_FLAGS;
    let hit: { from: number; to: number } | undefined;
    for (const f of byOld) if (f.from <= base) hit = f;
    return hit ? flags | (hit.to + base - hit.from) : gid;
  };
  let n = 0;
  for (const layer of json.layers ?? []) {
    if (Array.isArray(layer.data)) {
      layer.data = (layer.data as number[]).map(remap);
      n += (layer.data as number[]).filter(Boolean).length;
    }
    for (const obj of (layer.objects as Array<{ gid?: number }>) ?? []) {
      if (obj.gid) {
        obj.gid = remap(obj.gid);
        n++;
      }
    }
  }
  const to = new Map(fixed.map((f) => [f.source, f.to]));
  for (const ts of json.tilesets ?? []) ts.firstgid = to.get(path.basename(String(ts.source ?? ''))) ?? ts.firstgid;
  json.tilesets?.sort((a, b) => a.firstgid - b.firstgid);
  return n;
}

/**
 * gid → the class of the tile it points at, for one map's tilesets.
 *
 * Needed to tell a furniture placement from an image or a wall tile that
 * happens to sit in the same object layer — the class has to come from the
 * actual tile, never from the layer's name or the object's position in it.
 */
function tileClassByGid(mapPath: string, tilesets: Array<{ firstgid: number; source?: string }>): Map<number, string> {
  const byGid = new Map<number, string>();
  for (const ts of tilesets) {
    if (!ts.source) continue; // embedded tileset — none of ours are
    const tsPath = path.resolve(path.dirname(mapPath), ts.source);
    if (!fs.existsSync(tsPath)) continue;
    const tsj = JSON.parse(fs.readFileSync(tsPath, 'utf-8')) as { tiles?: Array<{ id: number; type?: string }> };
    for (const tile of tsj.tiles ?? []) {
      if (tile.type) byGid.set(ts.firstgid + tile.id, tile.type);
    }
  }
  return byGid;
}

/** Every catalog id that exists, across all furniture tilesets — the set
 *  `onState` has to name a member of. */
function allTileIds(): Set<string> {
  const ids = new Set<string>();
  for (const file of fs.readdirSync(TILED_DIR)) {
    if (!file.endsWith('.tsj') || !isFurnitureTileset(JSON.parse(fs.readFileSync(path.join(TILED_DIR, file), 'utf-8')))) continue;
    const json = JSON.parse(fs.readFileSync(path.join(TILED_DIR, file), 'utf-8')) as { tiles?: Array<{ properties?: TiledProperty[] }> };
    for (const tile of json.tiles ?? []) {
      const id = (tile.properties ?? []).find((p) => p.name === 'id')?.value;
      if (typeof id === 'string' && id) ids.add(id);
    }
  }
  return ids;
}

/**
 * Report any `onState` naming a catalog id that doesn't exist.
 *
 * This is the one property whose value is a hand-typed reference to another
 * tile — Tiled has no "reference to a tile" property type, so it cannot check
 * it — and a typo there produces a tile that simply never switches on, with no
 * error anywhere. Cheap to catch here, since every tileset is being read anyway.
 */
function checkOnStateTargets(): number {
  const ids = allTileIds();
  let bad = 0;
  for (const file of fs.readdirSync(TILED_DIR).sort()) {
    if (!file.endsWith('.tsj') || !isFurnitureTileset(JSON.parse(fs.readFileSync(path.join(TILED_DIR, file), 'utf-8')))) continue;
    const json = JSON.parse(fs.readFileSync(path.join(TILED_DIR, file), 'utf-8')) as { tiles?: Array<{ properties?: TiledProperty[] }> };
    for (const tile of json.tiles ?? []) {
      const props = new Map((tile.properties ?? []).map((p) => [p.name, p.value]));
      const onState = props.get('onState');
      if (typeof onState !== 'string' || !onState) continue;
      if (ids.has(onState)) continue;
      console.error(`[sync] ${file} ${props.get('id')}: onState = "${onState}" — no tile has that id, so it will never switch on`);
      bad++;
    }
  }
  return bad;
}

function syncZones(): string[] {
  const counts = tileCounts();
  const zonesDir = path.join(TILED_DIR, 'zones');
  if (!fs.existsSync(zonesDir)) return [];
  const touched: string[] = [];
  for (const file of fs.readdirSync(zonesDir).sort()) {
    if (!file.endsWith('.tmj')) continue;
    const full = path.join(zonesDir, file);
    const json = JSON.parse(fs.readFileSync(full, 'utf-8')) as {
      tilesets?: Array<{ firstgid: number; source?: string }>;
      layers?: Array<{ objects?: Array<{ id: number; type?: string; gid?: number; properties?: TiledProperty[] }> }>;
    };
    let dirty = false;
    const stale = staleGidTable(json.tilesets ?? [], counts);
    if (stale) {
      if (FIX_GIDS) {
        const n = repairGidTable(json, stale);
        for (const f of stale.filter((x) => x.from !== x.to)) {
          changes.push(`${file}: ${f.source} firstgid ${f.from} → ${f.to}`);
        }
        changes.push(`${file}: ${n} gid(s) renumbered`);
        dirty = true;
      } else {
        const worst = stale.filter((f) => f.from !== f.to);
        console.error(
          `[sync] ${file}: tileset table is stale — ${worst.length} tileset(s) have moved (e.g. ${worst[0].source}: ${worst[0].from} → ${worst[0].to}). ` +
            `Every gid in the file points at the wrong tile. Fix by opening and saving the map in Tiled, or run this script with --fix-gids.`,
        );
        staleMaps++;
        continue; // don't touch properties while the gids are meaningless
      }
    }
    const classOf = tileClassByGid(full, json.tilesets ?? []);
    for (const layer of json.layers ?? []) {
      for (const obj of layer.objects ?? []) {
        // A placement dragged or pasted straight from Tiled's Tilesets panel
        // arrives with NO class, and Tiled only offers a class's custom
        // properties to objects that carry it — so those placements show the
        // mapper nothing to set. Stamping the class is what makes the whole
        // property set appear on them. Decided by the tile the gid points at,
        // never by which layer the object is in: an ImageTile mislabelled as
        // furniture would import as a second, broken piece of furniture.
        if (!obj.type && obj.gid && classOf.get(obj.gid & GID_FLAGS) === 'FurnitureTile') {
          obj.type = 'FurnitureObject';
          changes.push(`${file} object ${obj.id}: + class FurnitureObject`);
          dirty = true;
        }
        if (obj.type !== 'FurnitureObject' || !obj.properties) continue;
        // A GID-backed placement gets its identity from the tile it draws, so a
        // stored `id` is a second answer to a question already answered — and
        // one a stray keystroke can turn into a wrong answer. Without a GID
        // (the rectangle placeholder) it is the only answer there is, so it
        // stays. See OBJECT_PROPS.
        const allowed = obj.gid ? OBJECT_PROPS : new Set([...OBJECT_PROPS, 'id']);
        const kept = obj.properties.filter((p) => allowed.has(p.name));
        if (kept.length === obj.properties.length) continue;
        for (const p of obj.properties) {
          if (!allowed.has(p.name)) changes.push(`${file} object ${obj.id}: − ${p.name}`);
        }
        obj.properties = kept;
        dirty = true;
      }
    }
    if (!dirty) continue;
    touched.push(file);
    if (!CHECK_ONLY) fs.writeFileSync(full, `${JSON.stringify(json, null, 2)}\n`);
  }
  return touched;
}

const tilesets = syncTilesets();
const zones = syncZones();
// After writing, so a broken reference is reported against the final files.
const brokenOnState = checkOnStateTargets();

for (const line of changes) console.log(`  ${line}`);
const verb = CHECK_ONLY ? 'would change' : 'updated';
console.log(`\n[sync] ${changes.length} change(s), ${verb} ${tilesets.length} tileset(s) and ${zones.length} zone map(s)`);
if (tilesets.length) console.log(`[sync] tilesets: ${tilesets.join(', ')}`);
if (zones.length) console.log(`[sync] zones: ${zones.join(', ')}`);
if (brokenOnState) console.error(`[sync] ${brokenOnState} broken onState reference(s) — see above`);
if (staleMaps) console.error(`[sync] ${staleMaps} map(s) with a stale tileset table — see above (--fix-gids repairs them)`);

if (brokenOnState || staleMaps || (CHECK_ONLY && (tilesets.length || zones.length))) {
  console.error('\n[sync] not clean — fix the above (run without --check to apply property changes).');
  process.exit(1);
}
