/**
 * Turning frames back into a sheet PNG — the one encoder on the client.
 *
 * Art comes DOWN as a PNG and is drawn from the atlas; only two surfaces still hold pixels (the
 * editor and the thumbnails, see templates.ts). This is the way back up: a save sends the image
 * rather than one hex string per pixel, which measured 2.8 KB against 95.3 KB for char_0 — a
 * factor of 34 — and 1.5 MB against 3.6 MB for the largest sheet the rules allow.
 *
 * One function, used by both the save and the "export a file for the repo" button, because the
 * two must produce the same bytes: an exported sheet is meant to be droppable into
 * assets/characters as-is, so if they ever differed, one of them would be wrong.
 *
 * The canvas is the encoder. `toBlob` is asynchronous and that is why saving is: there is no
 * synchronous way to get PNG bytes out of a browser, and `toDataURL` only hides the cost behind
 * base64 (a third more bytes, then decoded again).
 */
import type { SpriteData } from '@pixel/shared/office/types.js';

/**
 * The direction rows, in the order a sheet stores them.
 *
 * `left` is optional because two producers do not have one: the avatar generator composes
 * three sides (characterParts.ts leaves left to the engine), and so did every sheet drawn
 * before left became a row. A sheet carries all four sides, so one is filled in here from a
 * mirrored right — the documented SEED for a left row, and the only place this encoder invents
 * anything. Anything asymmetric should be painted, which is why the editor materialises its own
 * left row before saving rather than relying on this.
 */
export interface SheetRows {
  down: SpriteData[];
  up: SpriteData[];
  right: SpriteData[];
  left?: SpriteData[];
}

/** One frame, mirrored — every pixel row reversed. */
const mirror = (frame: SpriteData): SpriteData => frame.map((row) => [...row].reverse());

/**
 * Draw the rows into one `frames × 4` sheet of `w × h` cells and return its PNG bytes.
 *
 * Empty pixels stay untouched, so a cell the art does not cover is transparent — the same
 * contract the decoder reads back (`a < 2` is a gap).
 */
// `Uint8Array<ArrayBuffer>` rather than a bare Uint8Array: the bytes go straight into a Blob and
// into a room message, and TypeScript 5.7 keeps the buffer kind in the type — a plain
// `Uint8Array` could be backed by a SharedArrayBuffer, which neither accepts.
export async function encodeSheetPng(rows: SheetRows, w: number, h: number): Promise<Uint8Array<ArrayBuffer>> {
  const left = rows.left?.length ? rows.left : rows.right.map(mirror);
  const order: SpriteData[][] = [rows.down, rows.up, rows.right, left];
  const frames = Math.max(1, ...order.map((r) => r.length));
  const cv = document.createElement('canvas');
  cv.width = frames * w;
  cv.height = order.length * h;
  const ctx = cv.getContext('2d');
  if (!ctx) throw new Error('no 2d context to encode a sheet with');
  order.forEach((arr, rowIdx) => {
    for (let f = 0; f < frames; f++) {
      const sprite = arr[f];
      if (!sprite) continue;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const px = sprite[y]?.[x];
          if (!px) continue;
          ctx.fillStyle = px;
          ctx.fillRect(f * w + x, rowIdx * h + y, 1, 1);
        }
      }
    }
  });
  const blob = await new Promise<Blob | null>((resolve) => cv.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('the canvas produced no PNG');
  return new Uint8Array(await blob.arrayBuffer()) as Uint8Array<ArrayBuffer>;
}
