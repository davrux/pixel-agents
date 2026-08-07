import type { Action, ActionArea, BlockedArea, OfficeLayout, TileRect } from '../types.js';

/** "col,row" key, shared by every lookup/index in this file. */
function key(col: number, row: number): string {
  return `${col},${row}`;
}

/** Every (col,row) cell covered by a rect, clamped to the layout bounds (an
 *  area dragged/imported past the edge just loses its out-of-bounds cells,
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
 *  per-character tile-arrival check (see OfficeState.actionByTile). Every
 *  cell an ActionArea's rect covers maps to that area's own Action; areas
 *  never merge with each other (each is independently authored — see
 *  ActionArea's own doc comment), so an overlap between two areas resolves
 *  to whichever is listed first. */
export function buildActionByTile(layout: OfficeLayout): Map<string, Action> {
  const index = new Map<string, Action>();
  for (const area of layout.actionAreas ?? []) {
    for (const { col, row } of cellsOf(area, layout.cols, layout.rows)) {
      const k = key(col, row);
      if (!index.has(k)) index.set(k, area.action);
    }
  }
  return index;
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
 *  something a caller needs to look up an *area* for. First match wins if
 *  areas overlap (an authoring edge case, not a supported pattern). */
export function meetingAreaAt(layout: OfficeLayout, col: number, row: number): ActionArea | null {
  for (const area of layout.actionAreas ?? []) {
    if (area.action.kind === 'meetingRoom' && rectContains(area, col, row)) return area;
  }
  return null;
}

/** The BlockedArea (if any) whose rect contains (col,row) — used by the
 *  editor's erase gesture (see LayoutEditor.commitAreaDrag). */
export function blockedAreaAt(layout: OfficeLayout, col: number, row: number): BlockedArea | null {
  for (const area of layout.blockedAreas ?? []) {
    if (rectContains(area, col, row)) return area;
  }
  return null;
}
