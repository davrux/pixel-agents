import type { Action, OfficeLayout, TileAction } from '../types.js';

/** "col,row" key, shared by every lookup/index in this file. */
function key(col: number, row: number): string {
  return `${col},${row}`;
}

/** One-off lookup — fine for occasional reads (a handful of calls per player
 *  action). A hot per-tick path should build {@link buildTileActionIndex}
 *  once per layout (re)build instead of calling this repeatedly. */
export function getTileActionAt(list: TileAction[] | undefined, col: number, row: number): Action | null {
  if (!list) return null;
  for (const t of list) if (t.col === col && t.row === row) return t.action;
  return null;
}

/** Build a "col,row" → Action map once, for callers that look up many tiles
 *  (or the same tile repeatedly) against the same layout — see
 *  OfficeState.actionByTile. */
export function buildTileActionIndex(list: TileAction[] | undefined): Map<string, Action> {
  const index = new Map<string, Action>();
  if (list) for (const t of list) index.set(key(t.col, t.row), t.action);
  return index;
}

/** Set (or, with `action: null`, clear) the action at one tile — the
 *  editor's Action tool paint. Pure: returns a new array, replacing any
 *  existing entry at (col,row) rather than appending a duplicate. */
export function setTileActionAt(list: TileAction[] | undefined, col: number, row: number, action: Action | null): TileAction[] {
  const next = (list ?? []).filter((t) => t.col !== col || t.row !== row);
  if (action) next.push({ col, row, action });
  return next;
}

/** "col,row" keys of every tile carrying an action, of any kind — used to
 *  route plain click-to-move walks around them (see OfficeState.walkPlayer)
 *  rather than cutting through a meeting room/kiosk/etc. on the way
 *  somewhere else. */
export function tileActionKeys(layout: OfficeLayout): Set<string> {
  const keys = new Set<string>();
  if (layout.tileActions) for (const t of layout.tileActions) keys.add(key(t.col, t.row));
  return keys;
}
