import type { Action, ActionArea, BlockedArea, OfficeLayout, TileRect } from '../types.js';

/** "col,row" key, shared by every lookup/index in this file. */
function key(col: number, row: number): string {
  return `${col},${row}`;
}

/** Every (col,row) cell covered by a rect, clamped to the layout bounds (an
 *  area dragged/resized past the edge just loses its out-of-bounds cells,
 *  rather than being rejected outright). */
function* cellsOf(rect: TileRect, cols: number, rows: number): Generator<{ col: number; row: number }> {
  const c0 = Math.max(0, rect.col);
  const r0 = Math.max(0, rect.row);
  const c1 = Math.min(cols, rect.col + rect.w);
  const r1 = Math.min(rows, rect.row + rect.h);
  for (let r = r0; r < r1; r++) {
    for (let c = c0; c < c1; c++) yield { col: c, row: r };
  }
}

/** Whether a rect contains (col,row). */
export function rectContains(rect: TileRect, col: number, row: number): boolean {
  return col >= rect.col && col < rect.col + rect.w && row >= rect.row && row < rect.row + rect.h;
}

/** Whether two rects share at least one cell. */
export function rectsOverlap(a: TileRect, b: TileRect): boolean {
  return a.col < b.col + b.w && b.col < a.col + a.w && a.row < b.row + b.h && b.row < a.row + a.h;
}

/** "col,row" → Action, built once per layout (re)build — O(1) lookup for the
 *  per-character tile-arrival check (see OfficeState.actionByTile). Areas
 *  may overlap or nest (see ActionArea's own doc comment on zIndex): at any
 *  cell covered by more than one area, the highest zIndex wins, ties
 *  breaking toward the later-listed area (iteration order). */
export function buildActionByTile(layout: OfficeLayout): Map<string, Action> {
  const index = new Map<string, { action: Action; z: number }>();
  for (const area of layout.actionAreas ?? []) {
    const z = area.zIndex ?? 0;
    for (const { col, row } of cellsOf(area, layout.cols, layout.rows)) {
      const k = key(col, row);
      const existing = index.get(k);
      if (!existing || z >= existing.z) index.set(k, { action: area.action, z });
    }
  }
  return new Map([...index].map(([k, v]) => [k, v.action]));
}

/** "col,row" keys of every tile covered by an ActionArea, of any kind — used
 *  to route plain click-to-move walks around them (see OfficeState.walkPlayer)
 *  rather than cutting through a meeting room/kiosk/etc. on the way somewhere
 *  else. */
export function actionAreaTileKeys(layout: OfficeLayout): Set<string> {
  const keys = new Set<string>();
  for (const area of layout.actionAreas ?? []) {
    for (const { col, row } of cellsOf(area, layout.cols, layout.rows)) keys.add(key(col, row));
  }
  return keys;
}

/** Tiles covered by any BlockedArea — independent of floor pattern, merged
 *  into officeState's blockedTiles alongside furniture footprints. */
export function blockedAreaTiles(layout: OfficeLayout): Set<string> {
  const tiles = new Set<string>();
  for (const area of layout.blockedAreas ?? []) {
    for (const { col, row } of cellsOf(area, layout.cols, layout.rows)) tiles.add(key(col, row));
  }
  return tiles;
}

/** The 'meetingRoom'-kind ActionArea (if any) covering (col,row) — the ONLY
 *  action kind with membership-by-position semantics (see ActionArea); every
 *  other kind is a per-tile point-trigger via buildActionByTile, not
 *  something a caller needs to look up an *area* for. When more than one
 *  meetingRoom area covers the same cell (nested/overlapping rooms), the
 *  highest zIndex wins, same tie-break as buildActionByTile. */
export function meetingAreaAt(layout: OfficeLayout, col: number, row: number): ActionArea | null {
  let best: ActionArea | null = null;
  for (const area of layout.actionAreas ?? []) {
    if (area.action.kind !== 'meetingRoom') continue;
    if (!rectContains(area, col, row)) continue;
    if (!best || (area.zIndex ?? 0) >= (best.zIndex ?? 0)) best = area;
  }
  return best;
}

/** The BlockedArea (if any) whose rect contains (col,row) — used by the
 *  editor's erase gesture (see LayoutEditor.commitAreaDrag). */
export function blockedAreaAt(layout: OfficeLayout, col: number, row: number): BlockedArea | null {
  for (const area of layout.blockedAreas ?? []) {
    if (rectContains(area, col, row)) return area;
  }
  return null;
}
