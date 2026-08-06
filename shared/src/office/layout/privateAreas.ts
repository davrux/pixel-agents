import type { OfficeLayout } from '../types.js';

/**
 * Flood-fill every maximal 4-connected group of `layout.tilePrivateArea` tiles
 * into its own area id (0, 1, 2, …). Ids are never authored or stored — they're
 * recomputed from the raw per-tile flag on every layout build/rebuild, so
 * uniqueness and contiguity are structural: two areas painted separately can
 * never collide, and bridging them with one more tile merges them into a
 * single id on the next rebuild, exactly like any other flood fill.
 *
 * Returns a flat `cols*rows` array parallel to `layout.tiles`; -1 = not in any
 * area. Use {@link privateAreaIdAt} for a bounds-checked (col,row) lookup.
 */
export function computePrivateAreaIds(layout: OfficeLayout): Int32Array {
  const { cols, rows, tilePrivateArea } = layout;
  const ids = new Int32Array(cols * rows).fill(-1);
  if (!tilePrivateArea) return ids;

  let nextId = 0;
  const stack: number[] = [];
  for (let start = 0; start < cols * rows; start++) {
    if (!tilePrivateArea[start] || ids[start] !== -1) continue;
    const id = nextId++;
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
        if (n >= 0 && tilePrivateArea[n] && ids[n] === -1) {
          ids[n] = id;
          stack.push(n);
        }
      }
    }
  }
  return ids;
}

/** Bounds-checked lookup into a {@link computePrivateAreaIds} result. */
export function privateAreaIdAt(ids: Int32Array, cols: number, rows: number, col: number, row: number): number | null {
  if (col < 0 || col >= cols || row < 0 || row >= rows) return null;
  const id = ids[row * cols + col];
  return id >= 0 ? id : null;
}
