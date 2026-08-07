import type { OfficeLayout } from '../types.js';

/** A meeting area's own room needs a name that survives a layout rebuild even
 *  though the numeric ids below don't (see ActionAreaMap.ids) — the anchor
 *  tile (this area's raster-scan-first tile, i.e. lowest row then lowest col)
 *  fills that role, mirroring how a conference monitor's room name falls back
 *  to its own anchor tile when it has no explicit name (see conferenceKey).
 *  The anchor's own tileActions entry also carries the area's effective
 *  settings (e.g. video:boolean) — a deliberate simplification if adjacent
 *  tiles were ever painted with different settings. */
export interface ActionAreaMap {
  /** Flat `cols*rows` array parallel to `layout.tiles`; -1 = not in any area,
   *  else an index into `anchors`. Recomputed on every layout build/rebuild —
   *  never authored or persisted, so two areas painted separately can never
   *  collide, and bridging them with one more tile merges them into a single
   *  id (and a single anchor/room) on the next rebuild. */
  ids: Int32Array;
  /** Stable per-area anchor tile, indexed the same as the ids above. */
  anchors: Array<{ col: number; row: number }>;
}

/** Flood-fill every maximal 4-connected group of `layout.tileActions` tiles
 *  whose action is `kind: 'meetingRoom'` into its own area — the ONLY action
 *  kind that groups into areas; every other tile action kind is a per-tile
 *  point-trigger (see OfficeState.walkPlayerToAction / SimRoom's tile-action
 *  arrival check), not something that needs a shared id at all. Use
 *  {@link actionAreaIdAt} for a bounds-checked (col,row) → area-id lookup,
 *  and {@link actionAreaAnchor} to get an area's stable anchor tile back out. */
export function computeActionAreas(layout: OfficeLayout): ActionAreaMap {
  const { cols, rows, tileActions } = layout;
  const ids = new Int32Array(cols * rows).fill(-1);
  const anchors: Array<{ col: number; row: number }> = [];
  if (!tileActions || tileActions.length === 0) return { ids, anchors };
  const meetingTiles = new Set<number>();
  for (const t of tileActions) if (t.action.kind === 'meetingRoom') meetingTiles.add(t.row * cols + t.col);
  const isMeetingTile = (i: number): boolean => meetingTiles.has(i);

  const stack: number[] = [];
  for (let start = 0; start < cols * rows; start++) {
    if (!isMeetingTile(start) || ids[start] !== -1) continue;
    // `start` is the first unvisited area tile in raster-scan order, i.e. the
    // raster-minimal (lowest row, then lowest col) tile of this component —
    // exactly the deterministic anchor this area keeps across rebuilds as
    // long as its shape doesn't change.
    const id = anchors.length;
    anchors.push({ col: start % cols, row: Math.floor(start / cols) });
    ids[start] = id;
    stack.push(start);
    while (stack.length > 0) {
      const idx = stack.pop()!;
      const c = idx % cols;
      const r = Math.floor(idx / cols);
      const neighbors = [
        r > 0 ? idx - cols : -1,
        r < rows - 1 ? idx + cols : -1,
        c > 0 ? idx - 1 : -1,
        c < cols - 1 ? idx + 1 : -1,
      ];
      for (const n of neighbors) {
        if (n >= 0 && isMeetingTile(n) && ids[n] === -1) {
          ids[n] = id;
          stack.push(n);
        }
      }
    }
  }
  return { ids, anchors };
}

/** Bounds-checked (col,row) → area-id lookup. */
export function actionAreaIdAt(map: ActionAreaMap, cols: number, rows: number, col: number, row: number): number | null {
  if (col < 0 || col >= cols || row < 0 || row >= rows) return null;
  const id = map.ids[row * cols + col];
  return id >= 0 ? id : null;
}

/** An area id's stable anchor tile (for a per-area room name/settings), or
 *  null for an out-of-range id (e.g. a stale id from before a layout rebuild). */
export function actionAreaAnchor(map: ActionAreaMap, areaId: number): { col: number; row: number } | null {
  return map.anchors[areaId] ?? null;
}
