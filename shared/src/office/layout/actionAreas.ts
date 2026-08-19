import { meetingSlug } from '../../protocol.js';
import type { OfficeLayout } from '../types.js';

/** A meeting area's own room needs a name that survives a layout rebuild even
 *  though the numeric ids below don't (see ActionAreaMap.ids) — the anchor
 *  tile (this area's raster-scan-first tile, i.e. lowest row then lowest col)
 *  fills that role, mirroring how a conference monitor's room name falls back
 *  to its own anchor tile when it has no explicit name (see conferenceKey).
 *  The anchor's own tileActions entry also carries the area's settings, which
 *  is safe because an area only ever contains tiles that agree about them —
 *  see meetingIdentity below. */
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

/**
 * What makes two neighbouring meeting tiles *the same room*: the name it is
 * called, plus whether it offers video.
 *
 * Adjacency alone is not enough. Four meeting rooms painted side by side with a
 * shared wall between them are four rooms to everybody looking at the map, but
 * one 4-connected blob to a flood fill — so they became a single call, labelled
 * with whichever name the raster-first tile happened to carry, and walking from
 * M1 into M2 changed nothing. Comparing the identity keeps them apart while
 * still merging what a mapper means to be one room: two overlapping or abutting
 * rectangles with the same name (the ordinary way to author an L-shaped room)
 * still fill as one area.
 *
 * `video` is part of it for the same reason the anchor may speak for the area:
 * tiles that disagree about it cannot be one call without one half silently
 * losing its setting. Unnamed tiles compare equal to each other — there is
 * nothing to tell them apart by, so adjacency decides, exactly as before.
 */
function meetingIdentity(action: { name?: string; video?: boolean } | null | undefined): string {
  return `${action?.name ?? ''}\u0000${action?.video === true ? 1 : 0}`;
}

/** Flood-fill every maximal 4-connected group of `layout.tileActions` tiles
 *  whose action is `kind: 'meetingRoom'` **and which agree about the room they
 *  belong to** (see meetingIdentity) into its own area — the ONLY action kind
 *  that groups into areas; every other tile action kind is a per-tile
 *  point-trigger (see OfficeState.walkPlayerToAction / SimRoom's tile-action
 *  arrival check), not something that needs a shared id at all. Use
 *  {@link actionAreaIdAt} for a bounds-checked (col,row) → area-id lookup,
 *  and {@link actionAreaAnchor} to get an area's stable anchor tile back out. */
export function computeActionAreas(layout: OfficeLayout): ActionAreaMap {
  const { cols, rows, tileActions } = layout;
  const ids = new Int32Array(cols * rows).fill(-1);
  const anchors: Array<{ col: number; row: number }> = [];
  if (!tileActions) return { ids, anchors };
  const isMeetingTile = (i: number): boolean => tileActions[i]?.kind === 'meetingRoom';
  /** The room a meeting tile belongs to, or '' for a tile that is not one. */
  const identityAt = (i: number): string => {
    const a = tileActions[i];
    return a?.kind === 'meetingRoom' ? meetingIdentity({ name: a.meetingRoomName, video: a.video }) : '';
  };

  const stack: number[] = [];
  for (let start = 0; start < cols * rows; start++) {
    if (!isMeetingTile(start) || ids[start] !== -1) continue;
    // `start` is the first unvisited area tile in raster-scan order, i.e. the
    // raster-minimal (lowest row, then lowest col) tile of this component —
    // exactly the deterministic anchor this area keeps across rebuilds as
    // long as its shape doesn't change.
    const id = anchors.length;
    const identity = identityAt(start);
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
        if (n >= 0 && ids[n] === -1 && isMeetingTile(n) && identityAt(n) === identity) {
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

/** A meeting area's identity: which call it belongs to, and where that call is addressed. */
export interface MeetingAreaIdentity {
  /** This area's own anchor — where the player standing here actually is. */
  anchor: { col: number; row: number };
  /** The anchor the CALL is addressed by: the raster-first among the areas sharing this
   *  identity. Equal to `anchor` for an unnamed area, which is a call of its own. */
  canonical: { col: number; row: number };
  /** The name as authored, for labels. */
  name: string;
  /** The name reduced to its identity — empty when the area is unnamed. */
  slug: string;
  video: boolean;
}

/** slug+video -> the canonical anchor of the areas sharing it, raster-first.
 *
 *  Pure, so a caller can cache it per layout: the scan is cheap but the question is asked
 *  from a per-tick membership check. */
export function meetingCanonicalAnchors(layout: OfficeLayout): Map<string, { col: number; row: number }> {
  const out = new Map<string, { col: number; row: number }>();
  const acts = layout.tileActions ?? [];
  for (let i = 0; i < acts.length; i++) {
    const a = acts[i];
    if (a?.kind !== 'meetingRoom') continue;
    const slug = meetingSlug(a.meetingRoomName);
    if (!slug) continue;
    const k = `${slug} ${a.video !== false ? 1 : 0}`;
    // Raster order: the first hit is the raster-first tile of the first such area.
    if (!out.has(k)) out.set(k, { col: i % layout.cols, row: Math.floor(i / layout.cols) });
  }
  return out;
}

/**
 * Which call the meeting tile at (col,row) belongs to, or null if it is not one.
 *
 * Areas that agree about name AND video share a call even when they do not touch - two
 * floors, two buildings, the smoking corner outside. Adjacency already merges what a
 * mapper draws as one room (see computeActionAreas above); this merges what they NAME as
 * one. An unnamed area keeps its own anchor: there is nothing to tell two of them apart
 * by, so each stays its own call.
 *
 * `video` is part of the identity for the same reason it is part of the adjacency rule:
 * two areas that disagree cannot be one call without one side silently losing its
 * setting.
 */
export function meetingAreaAt(
  layout: OfficeLayout,
  areas: ActionAreaMap,
  col: number,
  row: number,
  canonicals?: Map<string, { col: number; row: number }>,
): MeetingAreaIdentity | null {
  const areaId = actionAreaIdAt(areas, layout.cols, layout.rows, col, row);
  if (areaId === null) return null;
  const anchor = actionAreaAnchor(areas, areaId);
  if (!anchor) return null;
  const action = layout.tileActions?.[anchor.row * layout.cols + anchor.col];
  if (action?.kind !== 'meetingRoom') return null;
  const video = action.video !== false;
  const name = action.meetingRoomName ?? '';
  const slug = meetingSlug(name);
  if (!slug) return { anchor, canonical: anchor, name, slug, video };
  const map = canonicals ?? meetingCanonicalAnchors(layout);
  return { anchor, canonical: map.get(`${slug} ${video ? 1 : 0}`) ?? anchor, name, slug, video };
}
