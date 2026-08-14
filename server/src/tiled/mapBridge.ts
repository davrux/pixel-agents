/**
 * OfficeLayout ↔ Tiled .tmj bridge (task #157, see
 * docs/design/tiled-editor-integration.md). OfficeLayout stays the runtime
 * schema forever — .tmj is a pure edit-time export/import round-trip, not a
 * second source of truth. Written fresh; does not reuse the rejected
 * office/tiled-schema branch's scripts.
 *
 * Known, disclosed simplifications (not yet verified against a live Tiled
 * instance — same caveat as task #156's Wang sets):
 * - Tile Object Y anchor is assumed to be the tile's BOTTOM edge (Tiled's
 *   documented convention) — see tileObjectY/rowFromTileObjectY, the one
 *   place this assumption lives.
 * - Furniture types with no Tiled tileset representation (the server-
 *   generated portal/conference/arcade/meetingRoom/logo catalog entries —
 *   drawn in code, never baked into a .tsj) export as a plain (non-tile)
 *   rectangle Object carrying just a `type` property — round-trips exactly,
 *   just isn't visually a real sprite inside Tiled's own canvas.
 */
import type { Action, OfficeLayout, PlacedFurniture, PlacedImage, PlacedText } from '@pixel/shared/office/types.js';
import { TileType } from '@pixel/shared/office/types.js';
import { TILE_SIZE } from '@pixel/shared/office/constants.js';
import { getCatalogEntry } from '@pixel/shared/office/layout/furnitureCatalog.js';

import { findGid, floorSetNames, FURNITURE_TILE_CLASS, gidAt, resolveFromTmjTilesets, wallSetNames, type TiledRegistry } from './tiledRegistry.js';
import { prop, actionProps, actionFromProps, actionsEqual, type TiledProp, type PropBag } from './actionProps.js';
import { furnitureBehaviourFromObject, furnitureBehaviourProps } from './furnitureProps.js';
import { TILED_SHEET_COLUMNS, WALL_BITMASK_COUNT } from '@pixel/shared/office/tiledSheetLayout.js';
import { emptyWallEdges, hIndex, latticeIndex, latticeMask, vIndex } from '@pixel/shared/office/wallEdges.js';

export interface TmjExportResult {
  tmj: Record<string, unknown>;
}


/** Tiled's own GID flip bits (top two bits of the 32-bit GID field) — plain
 *  addition/subtraction, not a bitwise op: these GIDs are always far below
 *  2^31, and JS's bitwise operators coerce to signed Int32 first, which
 *  would turn 0x80000000/0x40000000 negative. Only H/V are used (see
 *  PlacedFurniture/PlacedImage's flippedHorizontally/flippedVertically) —
 *  Tiled's third bit (diagonal flip, 0x20000000) has no corresponding
 *  concept here and is never set or read. */
const TILED_FLIP_H = 0x80000000;
const TILED_FLIP_V = 0x40000000;

/** `flippedHorizontally`/`flippedVertically` (see PlacedFurniture) map
 *  directly onto Tiled's own GID flip bits — purely cosmetic, so Tiled's
 *  canvas shows the real (mirrored) sprite instead of drawing the unflipped
 *  one. `id` (see the export/import properties block) already carries the
 *  true identity independent of this; the GID here is only ever consulted
 *  for *display*. */
function findFurnitureGid(registry: TiledRegistry, id: string, flippedHorizontally: boolean, flippedVertically: boolean): number | null {
  const direct = findFurnitureGidExact(registry, id);
  if (direct === null) return null;
  return direct + (flippedHorizontally ? TILED_FLIP_H : 0) + (flippedVertically ? TILED_FLIP_V : 0);
}

function findFurnitureGidExact(registry: TiledRegistry, id: string): number | null {
  for (const ts of registry.tilesets) {
    // Matched on the TILE's class, not the tileset's filename: a furniture
    // tileset may be called anything (see isFurnitureTileset). Checking the
    // found tile rather than the file also rules out a same-named `id` property
    // on some other kind of tile answering for a furniture lookup.
    const localId = ts.tiles.findIndex((t) => t.class === FURNITURE_TILE_CLASS && t.props.id === id);
    if (localId >= 0) return ts.firstgid + localId;
  }
  return null;
}

/** Tiled's documented Tile Object convention: (x,y) is the BOTTOM-LEFT
 *  corner of the tile's image, not top-left like every other object type. */
function tileObjectY(row: number, footprintH: number): number {
  return (row + footprintH) * TILE_SIZE;
}
function rowFromTileObjectY(y: number, footprintH: number): number {
  return Math.round(y / TILE_SIZE) - footprintH;
}

export function exportLayoutToTmj(layout: OfficeLayout, registry: TiledRegistry, zoneId: string): TmjExportResult {
  const { cols, rows, tiles } = layout;

  // A set index is a position in THIS layout's own table (OfficeLayout.floorSets
  // / wallSets), so the filename comes from there. A layout with no table — one
  // built in code, which cannot know what is on disk — takes whatever the disk
  // offers first.
  const floorFallback = floorSetNames(registry);
  const wallFallback = wallSetNames(registry);
  const floorFile = (set: number | undefined): string => `${layout.floorSets?.[set ?? 0] ?? floorFallback[0] ?? ''}.tsj`;
  const wallFile = (set: number | undefined): string => `${layout.wallSets?.[set ?? 0] ?? wallFallback[0] ?? ''}.tsj`;

  // ── Ground + Wall layers: floor/wall GIDs, GID 0 = empty ─────────
  // GID is computed directly from position — no property search needed.
  // Column 0 = Natural, column 1+i = PALETTE_64[i] (see tiledSheetLayout.ts);
  // row = pattern-1 (floor) or bitmask (wall) — exactly how
  // bake-floor-wall-tiled.mts lays the sheet out.
  //
  // Ground is floor only. Walls are edges on their own lattice layer below.
  const floorGid = (pattern: number, set: number | undefined, swatchIdx: number | null): number => {
    const col = swatchIdx === null ? 0 : swatchIdx + 1;
    return gidAt(registry, floorFile(set), (pattern - 1) * TILED_SHEET_COLUMNS + col) ?? 0;
  };
  const ground: number[] = [];
  for (let i = 0; i < cols * rows; i++) {
    const t = tiles[i];
    ground.push(t === TileType.VOID ? 0 : floorGid(t, layout.tileFloorSet?.[i], layout.tileColors?.[i] ?? null));
  }

  // ── Wall lattice layer: edge walls (see OfficeLayout.walls) ──────
  // One tile per LATTICE POINT — the corner shared by four cells — because the
  // four edges meeting there form exactly the piece's own N/E/S/W bitmask, so
  // one painted tile states which of those edges are wall. That is also why the
  // layer carries a half-tile negative offset: the same tiles, drawn on the
  // boundaries instead of in the cells.
  //
  // Lattice point (c,r) is the top-left corner of cell (c,r), so the layer is
  // map-sized and the map's far right/bottom boundary points (c=cols, r=rows)
  // have no tile to paint. Maps keep a VOID margin, so nothing real lives out
  // there; a wall on the very last row/column has to move one cell inward.
  const wallLattice: number[] = [];
  const walls = layout.walls;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!walls) {
        wallLattice.push(0);
        continue;
      }
      const li = latticeIndex(cols, c, r);
      const derived = latticeMask(walls, cols, rows, c, r);
      const piece = walls.latticePiece?.[li] ?? (derived === 0 ? null : derived);
      if (piece == null) {
        wallLattice.push(0);
        continue;
      }
      const swatchIdx = walls.latticeColor?.[li] ?? null;
      const col = swatchIdx === null ? 0 : swatchIdx + 1;
      wallLattice.push(gidAt(registry, wallFile(walls.latticeSet?.[li]), piece * TILED_SHEET_COLUMNS + col) ?? 0);
    }
  }

  // ── Wall face layer: north-wall surface (see WallEdges.faces) ────
  // Cell-aligned and NOT offset, unlike the lattice layer above: a face fills a
  // whole tile, so it belongs on the floor grid. Painting a face on the lattice
  // layer instead would put it 8px off.
  const wallFaces: number[] = [];
  for (let i = 0; i < cols * rows; i++) {
    const piece = walls?.faces?.piece[i] ?? null;
    if (piece == null) {
      wallFaces.push(0);
      continue;
    }
    const swatchIdx = walls?.faces?.color?.[i] ?? null;
    const col = swatchIdx === null ? 0 : swatchIdx + 1;
    wallFaces.push(gidAt(registry, wallFile(walls?.faces?.set?.[i]), piece * TILED_SHEET_COLUMNS + col) ?? 0);
  }

  // ── Collision layer: tileBlocked, parameterless marker tile ──────
  const collisionGid = findGid(registry, 'collision.tsj', () => true) ?? 0;
  const collision: number[] = [];
  for (let i = 0; i < cols * rows; i++) collision.push(layout.tileBlocked?.[i] ? collisionGid : 0);

  // ── Furniture: tile objects (or a plain rect fallback), list order = stacking ──
  const orderedFurniture = [...layout.furniture]
    .map((f, i) => ({ f, i }))
    .sort((a, b) => (a.f.zOffset ?? 0) - (b.f.zOffset ?? 0) || a.i - b.i)
    .map(({ f }) => f);

  const furnitureObjects = orderedFurniture.map((item, idx) => {
    const entry = getCatalogEntry(item.id);
    const fw = entry?.footprintW ?? 1;
    const fh = entry?.footprintH ?? 1;
    const gid = findFurnitureGid(registry, item.id, !!item.flippedHorizontally, !!item.flippedVertically);
    // Every field always present (even empty/0/false) — see actionProps's
    // own note; the same "discoverable, not just whatever was set" reasoning
    // applies to approachSides/name here. No `uid` (regenerated fresh on
    // every import, see importTmjToLayout) and no `zOffset` (stacking comes
    // purely from this object's position in the list — see orderedFurniture
    // above and its import-side counterpart) — both dropped per
    // docs/design/tiled-editor-integration.md.
    //
    // `id` is written ONLY for the rectangle placeholder below, the one case
    // with no GID to derive identity from. It used to be written always, on
    // the reasoning that an object may as well say outright what it is instead
    // of making identity depend on resolving a GID through the registry. True
    // for reading a .tmj — but it also made identity a hand-editable field
    // that OVERRODE the GID, so retyping it silently swapped the item while
    // Tiled kept drawing the old sprite. Identity now comes from the sprite
    // you can see, and there is nothing on a normal placement to get wrong.
    const properties: TiledProp[] = [
      ...(gid === null ? [prop('id', item.id)] : []),
      // No `name` property: Tiled objects have a native Name field (top of the
      // Properties panel, and what its object list shows), so a custom one
      // beside it was a second field with the same meaning — and the one a
      // mapper would naturally type into was the one nothing read. See `base`
      // below, which sets the native field, and the import-side counterpart.
      prop('approachSides', item.approachSides && item.approachSides.length ? item.approachSides.join(',') : '', 'ApproachSide'),
      prop('approachThrough', !!item.approachThrough),
      ...actionProps(item.action ?? null),
      // The exception to "every field always present" above: a behaviour
      // override is written only when this placement actually has one, because
      // here absence carries meaning — see furnitureProps.ts's header. Tiled
      // shows a tile object its tile's own values regardless, so the mapper
      // still sees the full set.
      ...furnitureBehaviourProps(item),
    ];

    const base = {
      id: idx + 1,
      name: item.name ?? '',
      type: 'FurnitureObject',
      visible: true,
      x: item.col * TILE_SIZE,
      width: fw * TILE_SIZE,
      height: fh * TILE_SIZE,
      rotation: 0,
      properties,
    };
    if (gid !== null) {
      return { ...base, gid, y: tileObjectY(item.row, fh) };
    }
    // No Tiled tileset backs this id (server-generated furniture) — a
    // plain rectangle placeholder, top-left anchored like every other
    // non-tile object; round-trips via the `id` property either way.
    return { ...base, y: item.row * TILE_SIZE };
  });

  // ── Actions: one Rectangle per maximal solid same-action block, else one
  // Point per tile — a mapper filling a big area (e.g. a meeting room) gets
  // one clean shape instead of one dot per tile; an irregular/hand-painted
  // shape still round-trips exactly via individual points, exactly like
  // every ActionArea did before rectangle support existed. "Solid" means the
  // 4-connected same-action component's cell count equals its own bounding
  // box's area — i.e. there's no gap or different action anywhere inside
  // that box. Position IS the data either way — col/row (or the covered
  // range) are derived from x/y/width/height on import, never stored as
  // their own properties: Tiled doesn't update custom properties when an
  // object is dragged or resized, so a stored col/row would silently go
  // stale the moment someone moves or resizes the shape.
  const actionObjects: Array<Record<string, unknown>> = [];
  {
    const tileActions = layout.tileActions ?? [];
    const total = cols * rows;
    const visited = new Uint8Array(total);
    const stack: number[] = [];
    for (let start = 0; start < total; start++) {
      const startAction = tileActions[start];
      if (visited[start] || !startAction) continue;
      const component: number[] = [start];
      visited[start] = 1;
      stack.push(start);
      let minCol = start % cols;
      let maxCol = minCol;
      let minRow = Math.floor(start / cols);
      let maxRow = minRow;
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
          if (n >= 0 && !visited[n] && actionsEqual(tileActions[n] ?? null, startAction)) {
            visited[n] = 1;
            component.push(n);
            stack.push(n);
            const nc = n % cols;
            const nr = Math.floor(n / cols);
            if (nc < minCol) minCol = nc;
            if (nc > maxCol) maxCol = nc;
            if (nr < minRow) minRow = nr;
            if (nr > maxRow) maxRow = nr;
          }
        }
      }
      const boxCols = maxCol - minCol + 1;
      const boxRows = maxRow - minRow + 1;
      // A lone tile (1x1) stays a Point — a tiny rectangle sitting exactly on
      // the tile's own edges is harder to spot/grab in Tiled than a dot, and
      // single-tile actions (a portal, an appliance) are the common case.
      if ((boxCols > 1 || boxRows > 1) && component.length === boxCols * boxRows) {
        actionObjects.push({
          id: 0, // renumbered below
          name: '',
          type: 'ActionArea',
          x: minCol * TILE_SIZE,
          y: minRow * TILE_SIZE,
          width: boxCols * TILE_SIZE,
          height: boxRows * TILE_SIZE,
          rotation: 0,
          properties: actionProps(startAction),
        });
      } else {
        for (const idx of component) {
          const c = idx % cols;
          const r = Math.floor(idx / cols);
          actionObjects.push({
            id: 0, // renumbered below
            name: '',
            type: 'ActionArea',
            point: true,
            x: c * TILE_SIZE + TILE_SIZE / 2,
            y: r * TILE_SIZE + TILE_SIZE / 2,
            width: 0,
            height: 0,
            rotation: 0,
            properties: actionProps(startAction),
          });
        }
      }
    }
  }
  actionObjects.forEach((o, i) => (o.id = i + 1));

  // ── Text: native Tiled text objects ───────────────────────────────
  // Our own anchor is free (bottom-center of the label, see PlacedText) while
  // Tiled anchors a text object at its box's top-left — convert by centering
  // a fixed-size box under the anchor point (approximate, same as before this
  // became free-positioned: Tiled's own left/top text alignment inside that
  // box was never pixel-exact with the renderer's centered layout either).
  const TEXT_BOX_W = 8 * TILE_SIZE;
  const TEXT_BOX_H = 2 * TILE_SIZE;
  const textObjects = (layout.texts ?? []).map((t, idx) => ({
    id: idx + 1,
    name: '',
    type: '',
    x: t.x - TEXT_BOX_W / 2,
    y: t.y - TEXT_BOX_H,
    width: TEXT_BOX_W,
    height: TEXT_BOX_H,
    rotation: t.angle ?? 0,
    visible: true,
    text: {
      text: t.text,
      ...(t.fontFamily ? { fontfamily: t.fontFamily } : {}),
      ...(t.fontSize ? { pixelsize: t.fontSize } : {}),
      ...(t.color ? { color: t.color } : {}),
      wrap: true,
    },
    properties: [],
  }));

  // ── Images: real GID-backed tile objects from images.tsj (see
  // bake-images-tiled.mts) — Tiled's object format has no "standalone image
  // file" field (only gid or text), so this is the only shape Tiled itself
  // can actually create (via Insert Tile against that tileset); a bare
  // object with a custom `image` property was never a real Tiled mechanism.
  // Free pixel x/y/width/height (see PlacedImage) — Tiled anchors a
  // GID-backed tile object at its BOTTOM-left corner, not top-left, so the
  // stored top-left y needs the same +height conversion tileObjectY does for
  // furniture, just inlined here since it's not tile-quantized. No rounding
  // anywhere: whatever pixel box the mapper drew in Tiled comes back exactly
  // on import. An image whose id isn't in images.tsj (not yet baked since it
  // was uploaded) is skipped, matching the live renderer's own skip for a
  // deleted image.
  const imageObjects = (layout.images ?? []).flatMap((im, idx) => {
    const baseGid = findGid(registry, 'images.tsj', (props) => props.imageId === im.imageId);
    if (baseGid === null) return [];
    const gid = baseGid + (im.flippedHorizontally ? TILED_FLIP_H : 0) + (im.flippedVertically ? TILED_FLIP_V : 0);
    return [
      {
        id: idx + 1,
        name: '',
        type: 'Image',
        gid,
        x: im.x,
        y: im.y + im.height,
        width: im.width,
        height: im.height,
        rotation: 0,
        visible: true,
        properties: [prop('imageId', im.imageId)],
      },
    ];
  });

  const tilesetRefs = registry.tilesets.map((ts) => ({ firstgid: ts.firstgid, source: `../${ts.file}` }));

  const tmj: Record<string, unknown> = {
    compressionlevel: -1,
    width: cols,
    height: rows,
    tilewidth: TILE_SIZE,
    tileheight: TILE_SIZE,
    infinite: false,
    orientation: 'orthogonal',
    renderorder: 'right-down',
    tiledversion: '1.11.0',
    type: 'map',
    class: 'Map',
    version: '1.10',
    nextlayerid: 7,
    nextobjectid: furnitureObjects.length + actionObjects.length + textObjects.length + imageObjects.length + 1,
    // The Pixel Agents zone this map belongs to — read back on import
    // instead of trusting the .tmj's own filename (same class-not-container
    // principle as everywhere else in this bridge; see
    // docs/design/tiled-custom-properties-reference.md's Map class).
    properties: [prop('mapName', zoneId)],
    tilesets: tilesetRefs,
    layers: [
      { id: 1, name: 'Ground', class: 'GroundLayer', type: 'tilelayer', width: cols, height: rows, x: 0, y: 0, opacity: 1, visible: true, data: ground },
      // The half-tile offset is what puts these tiles on the cell boundaries
      // instead of in the cells — Tiled renders the layer shifted, so what you
      // paint is what the game draws.
      {
        id: 8,
        name: 'Walls',
        class: 'WallLatticeLayer',
        type: 'tilelayer',
        width: cols,
        height: rows,
        x: 0,
        y: 0,
        offsetx: -TILE_SIZE / 2,
        offsety: -TILE_SIZE / 2,
        opacity: 1,
        visible: true,
        data: wallLattice,
      },
      {
        id: 9,
        name: 'WallFaces',
        class: 'WallFaceLayer',
        type: 'tilelayer',
        width: cols,
        height: rows,
        x: 0,
        y: 0,
        opacity: 1,
        visible: true,
        data: wallFaces,
      },
      { id: 2, name: 'Collision', class: 'CollisionLayer', type: 'tilelayer', width: cols, height: rows, x: 0, y: 0, opacity: 0.5, visible: true, data: collision },
      { id: 3, name: 'Furniture', type: 'objectgroup', draworder: 'index', opacity: 1, visible: true, x: 0, y: 0, objects: furnitureObjects },
      { id: 4, name: 'Actions', type: 'objectgroup', draworder: 'index', opacity: 1, visible: true, x: 0, y: 0, objects: actionObjects },
      { id: 5, name: 'Text', type: 'objectgroup', draworder: 'index', opacity: 1, visible: true, x: 0, y: 0, objects: textObjects },
      { id: 6, name: 'Images', type: 'objectgroup', draworder: 'index', opacity: 1, visible: true, x: 0, y: 0, objects: imageObjects },
    ],
  };

  return { tmj };
}

/** Every imported item gets a fresh identity — `uid` is purely internal
 *  engine plumbing (station claims, on/off toggle state, editor selection;
 *  see officeState.ts/LayoutEditor.ts), never something a Tiled edit needs
 *  to preserve across a round-trip. Not exported as a property at all. */
function generateUid(): string {
  return `imported_${Math.random().toString(36).slice(2, 10)}`;
}

/** Tiled's text `color` is `#rrggbb` or `#aarrggbb` (alpha FIRST) per the
 *  JSON map format spec; a PlacedText.color is always opaque `#rrggbb` (see
 *  its own doc comment — no alpha channel modeled), so this just strips
 *  Tiled's leading alpha pair when present. Returns null for anything that
 *  isn't a well-formed hex color at all. */
function tiledColorToRgbHex(color: string): string | null {
  const hex = color.startsWith('#') ? color.slice(1) : color;
  if (/^[0-9a-fA-F]{6}$/.test(hex)) return `#${hex}`;
  if (/^[0-9a-fA-F]{8}$/.test(hex)) return `#${hex.slice(2)}`;
  return null;
}

/** Derive (row, swatch index) from a resolved tile's position within its
 *  tileset — the import-side counterpart to the export's gidAt() arithmetic.
 *  Column 0 = Natural (null), column 1+i = PALETTE_64[i]; row = pattern-1
 *  (floor) or bitmask (wall). Positional, not property-based: floor.tsj/
 *  wall-*.tsj are entirely machine-generated (bake-floor-wall-tiled.mts), so
 *  their tile order is exactly as reliable as a stored property would be,
 *  with nothing to keep in sync. */
function rowAndSwatchFromLocalId(localId: number): { row: number; swatchIndex: number | null } {
  const row = Math.floor(localId / TILED_SHEET_COLUMNS);
  const col = localId % TILED_SHEET_COLUMNS;
  return { row, swatchIndex: col === 0 ? null : col - 1 };
}

/** This tileset's position in the layout table being built, appending it if this
 *  is the first tile from it. That is how a map ends up naming its own sets (see
 *  OfficeLayout.floorSets): the table is whatever the map actually uses, in the
 *  order first encountered, rather than a slice of a global list. */
function setIndexInto(table: string[], file: string): number {
  const name = file.replace(/\.tsj$/, '');
  const idx = table.indexOf(name);
  if (idx >= 0) return idx;
  table.push(name);
  return table.length - 1;
}

export interface TmjImportResult {
  layout: OfficeLayout;
  /** imageId → PNG buffer for images the caller should persist as new/updated
   *  image assets before saving the layout (matches saveAsset's 'image' type). */
  images: Array<{ imageId: string; label: string; buffer: Buffer }>;
  /** The map's own `mapName` property (see Pixels.tiled-project's Map
   *  class), or null if absent — e.g. a .tmj predating this property, or a
   *  hand-created map that never set it. Callers decide the fallback
   *  (tiled-import-all-zones.mts falls back to the filename). */
  mapName: string | null;
}

export function importTmjToLayout(
  tmj: Record<string, unknown>,
  registry: TiledRegistry,
  readImageFile: (relPath: string) => Buffer | null,
): TmjImportResult {
  const cols = Number(tmj.width);
  const rows = Number(tmj.height);
  const layers = (tmj.layers as Array<Record<string, unknown>>) ?? [];
  const mapProps: PropBag = Object.fromEntries(((tmj.properties as TiledProp[]) ?? []).map((p) => [p.name, p.value]));
  const mapName = typeof mapProps.mapName === 'string' && mapProps.mapName ? mapProps.mapName : null;

  // Resolve GIDs against THIS map's own tileset firstgid/source list, not
  // registry.resolve's disk-order assumption — see resolveFromTmjTilesets.
  const resolveGid = resolveFromTmjTilesets(registry, (tmj.tilesets as Array<{ firstgid: number; source: string }>) ?? []);

  // Classified by the layer's own `class` (GroundLayer/WallLatticeLayer/
  // CollisionLayer — see Pixels.tiled-project), not by name — same reasoning
  // as the object classification below: a mapper renaming these tile layers
  // must not silently empty out the whole map. Tiled writes a layer's custom
  // class under `class` specifically (not `type`, which every layer already
  // uses structurally for tilelayer/objectgroup/imagelayer/group).
  const ground = (layers.find((l) => l.class === 'GroundLayer')?.data as number[]) ?? [];
  const collision = (layers.find((l) => l.class === 'CollisionLayer')?.data as number[]) ?? [];
  // Walls are edges, painted on their own half-offset lattice layer (see
  // OfficeLayout.walls). Ground is floor only — a WallTile painted there is not
  // a wall.
  const wallLatticeLayer = (layers.find((l) => l.class === 'WallLatticeLayer')?.data as number[]) ?? [];
  // North-wall face surface, cell-aligned on its own layer (see WallEdges.faces).
  const wallFaceLayer = (layers.find((l) => l.class === 'WallFaceLayer')?.data as number[]) ?? [];

  // Objects are classified by their own nature — a native Tiled field
  // (`text`/`image`, always present on Tiled's own Text/Image object types
  // regardless of any custom class) or a custom `type` class
  // (FurnitureObject/ActionArea, see Pixels.tiled-project) — never by which
  // named layer they happen to live in. Same robustness-to-reorganization
  // principle as the Ground layer's per-tile class below: export still
  // groups these into named layers (Furniture/Actions/Text/Images) purely
  // for a tidy Layers panel, but a mapper renaming/merging/splitting those
  // layers can't silently break the import.
  const allObjects = layers
    .filter((l) => l.type === 'objectgroup')
    .flatMap((l) => (l.objects as Array<Record<string, unknown>>) ?? []);
  // A tile object's GID always resolves back to a real FurnitureTile
  // (baked with its own `id`) via the registry, independent of whatever
  // class Tiled happens to have on the OBJECT itself — which matters
  // because dragging a furniture sprite straight from the Tilesets panel
  // onto the map (the natural, expected way to place furniture by hand in
  // Tiled) creates an object with a `gid` but NO class and NO properties at
  // all; only our own exporter's objects reliably carry `type:
  // 'FurnitureObject'`. Falling back to the tile's own class here means a
  // hand-placed sprite is still recognized as furniture instead of being
  // silently dropped — verified against a real hand-authored map where over
  // half the placed furniture had exactly this shape.
  const baseGid = (gid: unknown): number => {
    let raw = Number(gid) || 0;
    if (raw >= TILED_FLIP_H) raw -= TILED_FLIP_H;
    if (raw >= TILED_FLIP_V) raw -= TILED_FLIP_V;
    return raw;
  };
  const isFurnitureTileObject = (o: Record<string, unknown>): boolean => {
    const gid = baseGid(o.gid);
    return gid > 0 && resolveGid(gid)?.class === 'FurnitureTile';
  };
  // Same reasoning as isFurnitureTileObject: an image, being a real GID-
  // backed tile object from images.tsj now (see bake-images-tiled.mts), is
  // recognized by its tile's ImageTile class — not by a custom `type` on the
  // object, which a plain "Insert Tile" placement never sets either.
  const isImageTileObject = (o: Record<string, unknown>): boolean => {
    const gid = baseGid(o.gid);
    return gid > 0 && resolveGid(gid)?.class === 'ImageTile';
  };
  // Tiled's own `text` field is set structurally only by a genuine native
  // Text object (Insert Text) — never by a custom `type`/property, unlike
  // every other classification below. It wins outright over a stale/leftover
  // `type: 'Image'` (etc.) that a copy-pasted-then-retyped object can end up
  // dragging along from whatever it was copied from — confirmed against a
  // live map where two objects copy-pasted from an Image and then edited
  // into plain text labels still carried the old `type: 'Image'` + `imageId`
  // property, silently double-importing as a broken image AND a text label.
  const isTextObject = (o: Record<string, unknown>): boolean => o.text !== undefined;
  const furnitureObjects = allObjects.filter((o) => !isTextObject(o) && (o.type === 'FurnitureObject' || isFurnitureTileObject(o)));
  const actionObjects = allObjects.filter((o) => !isTextObject(o) && o.type === 'ActionArea');
  const textObjects = allObjects.filter(isTextObject);
  const imageObjects = allObjects.filter((o) => !isTextObject(o) && (o.type === 'Image' || isImageTileObject(o)));

  const tiles: number[] = [];
  const tileColors: OfficeLayout['tileColors'] = [];
  const tileFloorSet: number[] = [];
  const tileBlocked: boolean[] = [];
  // Filled as tiles are met, so the layout ends up naming exactly the sets it
  // uses — see setIndexInto.
  const floorSets: string[] = [];
  const wallSets: string[] = [];
  for (let i = 0; i < cols * rows; i++) {
    const groundResolved = resolveGid(ground[i] ?? 0);
    // Classify by Tiled's own `class` (FloorTile — see Pixels.tiled-project),
    // not by which file a tile lives in — a mapper reorganizing tileset files
    // must not silently break this (see docs/design/tiled-editor-integration.md).
    if (groundResolved?.class === 'FloorTile') {
      const { row, swatchIndex } = rowAndSwatchFromLocalId(groundResolved.localId);
      tiles.push(row + 1);
      tileColors.push(swatchIndex);
      // Which set this came from — unlike the floor/void classification above,
      // this one legitimately IS about the file, since "which set" has no other
      // identity (see setIndexFromFile).
      tileFloorSet.push(setIndexInto(floorSets, groundResolved.tileset.file));
    } else {
      tiles.push(TileType.VOID);
      tileColors.push(null);
      tileFloorSet.push(0);
    }
    tileBlocked.push(!!collision[i] && collision[i] !== 0);
  }

  /**
   * Rebuild the edge sets from the painted lattice tiles. A piece's own bitmask
   * IS the statement about which of the four edges at that point are wall, so a
   * painted tile sets those edges — union across lattice points, so two
   * neighbours that disagree about their shared edge both get their way rather
   * than one silently winning.
   *
   * Pieces past the bitmask range are the north-wall FACES: decorative wall
   * surface, not barriers, so they set no edges and are kept verbatim as a
   * latticePiece override. The barrier for a faced wall is the edge run the
   * mapper paints along its base.
   */
  const wallEdges = ((): NonNullable<OfficeLayout['walls']> => {
    const walls = emptyWallEdges(cols, rows);
    const latticeSet: number[] = new Array((cols + 1) * (rows + 1)).fill(0);
    const latticeColor: Array<number | null> = new Array((cols + 1) * (rows + 1)).fill(null);
    const latticePiece: Array<number | null> = new Array((cols + 1) * (rows + 1)).fill(null);
    // Which points the mapper actually painted. Kept separately because a
    // painted point may legitimately have `null` as its colour (the Natural
    // column), so "no entry in latticeColor" cannot mean "not painted".
    const wasPainted = new Array((cols + 1) * (rows + 1)).fill(false);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const resolved = resolveGid(wallLatticeLayer[r * cols + c] ?? 0);
        if (resolved?.class !== 'WallTile') continue;
        const { row: piece, swatchIndex } = rowAndSwatchFromLocalId(resolved.localId);
        const li = latticeIndex(cols, c, r);
        latticeSet[li] = setIndexInto(wallSets, resolved.tileset.file);
        latticeColor[li] = swatchIndex;
        wasPainted[li] = true;
        if (piece >= WALL_BITMASK_COUNT) {
          latticePiece[li] = piece;
          continue;
        }
        if (piece & 1 && r > 0) walls.vertical[vIndex(cols, c, r - 1)] = true; // N
        if (piece & 2) walls.horizontal[hIndex(cols, c, r)] = true; // E
        if (piece & 4 && r < rows) walls.vertical[vIndex(cols, c, r)] = true; // S
        if (piece & 8 && c > 0) walls.horizontal[hIndex(cols, c - 1, r)] = true; // W
      }
    }

    /**
     * Give the ends of a wall run the run's own colour.
     *
     * A run of edges spans one more lattice point than the mapper paints
     * pieces for: painting "east+west" along a corridor asserts the edges, and
     * the point past the last edge then has a west-only mask and is drawn as
     * the run's end cap — but nobody ever painted a tile there, so it had no
     * colour and came out in the sheet's Natural column. On a red wall that is
     * a white stub at every doorway, which reads as a rendering fault rather
     * than as "you did not paint this corner".
     *
     * So an unpainted point inherits colour and set from a neighbour it shares
     * an actual edge with. Repeated until nothing changes, so a chain of them
     * (two runs meeting at an unpainted corner) resolves too; the pass count is
     * bounded by the lattice size and settles in one or two rounds in practice.
     */
    const inheritEnds = (): void => {
      for (let pass = 0; pass < 4; pass++) {
        let changed = false;
        for (let r = 0; r <= rows; r++) {
          for (let c = 0; c <= cols; c++) {
            const li = latticeIndex(cols, c, r);
            if (wasPainted[li]) continue;
            const mask = latticeMask(walls, cols, rows, c, r);
            if (mask === 0) continue;
            // Only across edges that exist — the neighbour on the other side of
            // a wall you are not connected to has nothing to do with this run.
            const neighbours: Array<[number, number]> = [];
            if (mask & 1) neighbours.push([c, r - 1]);
            if (mask & 2) neighbours.push([c + 1, r]);
            if (mask & 4) neighbours.push([c, r + 1]);
            if (mask & 8) neighbours.push([c - 1, r]);
            for (const [nc, nr] of neighbours) {
              if (nc < 0 || nr < 0 || nc > cols || nr > rows) continue;
              const ni = latticeIndex(cols, nc, nr);
              if (!wasPainted[ni]) continue;
              latticeColor[li] = latticeColor[ni];
              latticeSet[li] = latticeSet[ni];
              wasPainted[li] = true; // settled — may now seed a further end
              changed = true;
              break;
            }
          }
        }
        if (!changed) return;
      }
    };
    inheritEnds();
    // Faces are read per cell off their own un-offset layer.
    const facePiece: Array<number | null> = new Array(cols * rows).fill(null);
    const faceSet: number[] = new Array(cols * rows).fill(0);
    const faceColor: Array<number | null> = new Array(cols * rows).fill(null);
    let anyFace = false;
    for (let i = 0; i < cols * rows; i++) {
      const resolved = resolveGid(wallFaceLayer[i] ?? 0);
      if (resolved?.class !== 'WallTile') continue;
      const { row: piece, swatchIndex } = rowAndSwatchFromLocalId(resolved.localId);
      facePiece[i] = piece;
      faceSet[i] = setIndexInto(wallSets, resolved.tileset.file);
      faceColor[i] = swatchIndex;
      anyFace = true;
    }
    return {
      ...walls,
      latticeSet,
      latticeColor,
      latticePiece,
      ...(anyFace ? { faces: { piece: facePiece, set: faceSet, color: faceColor } } : {}),
    };
  })();

  const furniture: PlacedFurniture[] = furnitureObjects.map((obj, idx) => {
    const props: PropBag = Object.fromEntries(((obj.properties as TiledProp[]) ?? []).map((p) => [p.name, p.value]));
    // Identity comes from the GID — i.e. from the tile whose sprite you can
    // see — and an `id` property is read only when there is no GID at all (the
    // rectangle placeholder; see the matching export-side comment for why it
    // is no longer written otherwise). This ordering matters: with the property
    // winning, a hand-edited `id` repointed the placement while the canvas went
    // on showing the old sprite. The GID's flip bits are read back separately,
    // purely for `flippedHorizontally`/`flippedVertically` — an unrelated
    // concern either way.
    const rawGid = Number(obj.gid) || 0;
    const resolvedTile = rawGid > 0 ? resolveGid(baseGid(rawGid)) : null;
    const tileId = typeof resolvedTile?.props.id === 'string' ? resolvedTile.props.id : '';
    const id = tileId || (typeof props.id === 'string' ? props.id : '');
    if (tileId && typeof props.id === 'string' && props.id && props.id !== tileId) {
      console.warn(`[tiled] furniture object at ${obj.x},${obj.y} carries id "${props.id}" but its tile is "${tileId}" — the tile wins; delete the stale property`);
    }
    const entry = getCatalogEntry(id);
    const fh = entry?.footprintH ?? 1;
    const hasGid = rawGid > 0;
    const col = Math.round(Number(obj.x) / TILE_SIZE);
    const row = hasGid ? rowFromTileObjectY(Number(obj.y), fh) : Math.round(Number(obj.y) / TILE_SIZE);
    // zOffset comes purely from this object's position in Tiled's own
    // Furniture object list (drag to reorder there) — no stored property,
    // per docs/design/tiled-editor-integration.md.
    const item: PlacedFurniture = {
      uid: generateUid(),
      id,
      col,
      row,
      zOffset: idx,
    };
    {
      let flipBits = rawGid;
      if (flipBits >= TILED_FLIP_H) {
        item.flippedHorizontally = true;
        flipBits -= TILED_FLIP_H;
      }
      if (flipBits >= TILED_FLIP_V) item.flippedVertically = true;
    }
    // The native Tiled object Name, not a custom property — see the export side.
    if (typeof obj.name === 'string' && obj.name) item.name = obj.name;
    if (typeof props.approachSides === 'string' && props.approachSides) {
      item.approachSides = props.approachSides.split(',').filter((s): s is 'N' | 'S' | 'E' | 'W' => ['N', 'S', 'E', 'W'].includes(s));
    }
    if (props.approachThrough === true) item.approachThrough = true;
    const action = actionFromProps(props);
    if (action) item.action = action;
    // Read from this OBJECT's own properties only, never the tile's — the tile's
    // values are the catalog default that these would override, and copying them
    // down onto the placement would freeze them there.
    Object.assign(item, furnitureBehaviourFromObject(props));
    return item;
  });

  const tileActions: Array<Action | null> = new Array(cols * rows).fill(null);
  for (const obj of actionObjects) {
    const props: PropBag = Object.fromEntries(((obj.properties as TiledProp[]) ?? []).map((p) => [p.name, p.value]));
    const action = actionFromProps(props);
    if (!action) continue;
    // Position IS the data — see the matching export-side comment; never
    // read a stored col/row property (Tiled wouldn't have kept it in sync
    // with a dragged or resized object anyway). Works for either shape: a
    // Point's x/y is its tile's CENTER (see export), so floor() lands on
    // the same tile either way; a Rectangle's x/y is its top-left corner,
    // and its width/height (rounded to whole tiles, minimum one) give the
    // covered range — every tile in that range gets this action. Objects
    // are applied in Tiled's own list order, so a later, more specific
    // shape overriding part of an earlier, larger one wins — same
    // last-write-wins precedent as furniture zOffset-by-list-position.
    const col0 = Math.floor(Number(obj.x) / TILE_SIZE);
    const row0 = Math.floor(Number(obj.y) / TILE_SIZE);
    const wTiles = obj.point === true ? 1 : Math.max(1, Math.round(Number(obj.width) / TILE_SIZE));
    const hTiles = obj.point === true ? 1 : Math.max(1, Math.round(Number(obj.height) / TILE_SIZE));
    for (let row = row0; row < row0 + hTiles; row++) {
      for (let col = col0; col < col0 + wTiles; col++) {
        if (col >= 0 && col < cols && row >= 0 && row < rows) tileActions[row * cols + col] = action;
      }
    }
  }

  const texts: PlacedText[] = textObjects.map((obj) => {
    const textData = (obj.text as Record<string, unknown>) ?? {};
    // Reverse of the export box-centering above — use the object's own
    // width/height (a user may have resized the text box in Tiled) rather
    // than assuming the fixed default size.
    const boxW = Number(obj.width) || 8 * TILE_SIZE;
    const boxH = Number(obj.height) || 2 * TILE_SIZE;
    const t: PlacedText = {
      uid: generateUid(),
      x: Number(obj.x) + boxW / 2,
      y: Number(obj.y) + boxH,
      text: typeof textData.text === 'string' ? textData.text : '',
    };
    if (typeof textData.fontfamily === 'string') t.fontFamily = textData.fontfamily;
    if (typeof textData.pixelsize === 'number') t.fontSize = textData.pixelsize;
    if (typeof textData.color === 'string') {
      const rgb = tiledColorToRgbHex(textData.color);
      if (rgb) t.color = rgb;
    }
    if (typeof obj.rotation === 'number' && obj.rotation) t.angle = ((obj.rotation as number) % 360 + 360) % 360;
    return t;
  });

  const images: PlacedImage[] = [];
  const importedImages: TmjImportResult['images'] = [];
  for (const obj of imageObjects) {
    const props: PropBag = Object.fromEntries(((obj.properties as TiledProp[]) ?? []).map((p) => [p.name, p.value]));
    const rawGid = Number(obj.gid) || 0;
    const resolvedTile = rawGid > 0 ? resolveGid(baseGid(rawGid)) : null;
    // Same "own property wins, tile's baked one is the fallback" precedent
    // as furniture's `id` — a plain Insert Tile placement carries no
    // properties of its own at all, only the tile's.
    const imageId = typeof props.imageId === 'string' && props.imageId ? props.imageId : typeof resolvedTile?.props.imageId === 'string' ? resolvedTile.props.imageId : null;
    if (!imageId) continue;
    const height = Number(obj.height) || TILE_SIZE;
    // Prefer the tile's own declared `image` path — a mapper can add a tile
    // straight in Tiled's Tileset editor (Edit Tileset → Add Tiles) pointing
    // at whatever file they picked, entirely bypassing bake-images-tiled.mts
    // and its png/images/<imageId>.png convention; that convention is only a
    // fallback for the cases with no such tile at all (a bare `type: 'Image'`
    // object with no gid). readImageFile resolves both against assets/tiled
    // itself, never zone-relative (see zoneImport.ts).
    const buffer = readImageFile(resolvedTile?.image ?? `png/images/${imageId}.png`);
    if (buffer) importedImages.push({ imageId, label: imageId, buffer });
    const image: PlacedImage = {
      uid: generateUid(),
      x: Number(obj.x) || 0,
      // Same bottom-edge Y anchor as any other GID-backed tile object — see
      // the matching export-side conversion. No rounding: the exact pixel
      // box Tiled shows is exactly what's stored.
      y: (Number(obj.y) || 0) - height,
      width: Number(obj.width) || TILE_SIZE,
      height,
      imageId,
    };
    // Decode both flip bits independently — strip H first so a lingering H
    // bit can't be mistaken for V (H > V, so any H-flipped gid is already
    // >= TILED_FLIP_V on its own).
    let flipBits = rawGid;
    if (flipBits >= TILED_FLIP_H) {
      image.flippedHorizontally = true;
      flipBits -= TILED_FLIP_H;
    }
    if (flipBits >= TILED_FLIP_V) image.flippedVertically = true;
    images.push(image);
  }

  const layout: OfficeLayout = {
    version: 1,
    cols,
    rows,
    tiles: tiles as OfficeLayout['tiles'],
    furniture,
    tileColors,
    tileFloorSet,
    floorSets,
    wallSets,
    walls: wallEdges,
    tileBlocked,
    tileActions,
    texts,
    images,
  };
  return { layout, images: importedImages, mapName };
}
