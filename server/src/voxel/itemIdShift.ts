/**
 * Pure item-id remap for the +100 band shift (see migrateItemIds.ts for the why).
 * No imports / side effects, so it's unit-testable without opening the database.
 *
 * Old layout: blocks 1..99, materials 100..199, tools 200..299.
 * New layout: blocks 1..199, materials 200..299, tools 300..399.
 * Rule: any id ≥ 100 (the old material/tool floor) moves up +100; blocks stay.
 */
const OLD_ITEM_FLOOR = 100;
const BAND_SHIFT = 100;

/** Shift a numeric item id: materials/tools (≥100) move up; blocks (<100) stay. */
export function shiftNumericId(id: number): number {
  return Number.isInteger(id) && id >= OLD_ITEM_FLOOR ? id + BAND_SHIFT : id;
}

/** Shift a STRING item id, remapping only the numeric-bearing material/bucket forms
 *  ('mat:<n>', 'b<n>'). Block ids ('block:<n>', n<100) and tool names are untouched. */
export function shiftStringId(sid: string): string {
  let m = /^mat:(\d+)$/.exec(sid);
  if (m) return `mat:${shiftNumericId(Number(m[1]))}`;
  m = /^b(\d+)$/.exec(sid);
  if (m) return `b${shiftNumericId(Number(m[1]))}`;
  return sid;
}

/** Rewrite a {numericId: count} JSON blob (inventory / durability / chest). */
export function shiftCountMapJson(json: string): string {
  const obj = JSON.parse(json) as Record<string, number>;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(obj)) out[shiftNumericId(Number(k))] = v;
  return JSON.stringify(out);
}

/** Rewrite a settings JSON blob: hotbar.slots values + wield keys (string ids). */
export function shiftSettingsJson(json: string): string {
  const obj = JSON.parse(json) as Record<string, unknown>;
  const hotbar = obj.hotbar as { slots?: unknown } | undefined;
  if (hotbar && Array.isArray(hotbar.slots)) {
    hotbar.slots = hotbar.slots.map((s) => (typeof s === 'string' ? shiftStringId(s) : s));
  }
  if (obj.wield && typeof obj.wield === 'object') {
    const wield = obj.wield as Record<string, unknown>;
    const next: Record<string, unknown> = {};
    for (const [k, w] of Object.entries(wield)) next[shiftStringId(k)] = w;
    obj.wield = next;
  }
  return JSON.stringify(obj);
}
