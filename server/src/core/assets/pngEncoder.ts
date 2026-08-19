/**
 * PNG encoding — the exact inverse of pngDecoder's `decodeDirectionalSheet`.
 *
 * Why the server needs to write PNGs at all: the art it serves is already PNG on
 * disk (assets/characters, assets/pets), but anything a user edited lives in the
 * database as SpriteData — hex strings, one per pixel. Those are 24× the size of the
 * same image as PNG (measured: 956 KB of sprite data across the bundled roster
 * against 39 KB of PNG), and they are what a join currently ships. To send a URL
 * instead of pixels, an edited sprite has to become an image again.
 *
 * `pngjs` writes as well as reads, so this is a conversion, not a codec.
 */
import { PNG } from 'pngjs';

import { hexToRgba } from './colorUtils.js';

/**
 * Not pngjs' defaults, and the difference is large. Measured over the twelve bundled
 * sheets: 101.6 KB with the defaults, **20.5 KB** with these — smaller even than the
 * committed files (43.6 KB). Two settings do it:
 *
 * - `deflateStrategy: 0` (zlib's default) instead of pngjs' 3 (Z_RLE). RLE assumes
 *   runs within a scanline; pixel art repeats whole ROWS, which only the full
 *   match-finder exploits. On char_0 alone: 12.6 KB → 2.3 KB.
 * - `filterType: 0` (no per-row filter). A filter helps photographs, where neighbours
 *   differ slightly; on flat colour it turns identical rows into different byte
 *   sequences and costs (auto-filtering measured 36.4 KB, worse than none).
 */
const WRITE_OPTIONS = { filterType: 0, deflateLevel: 9, deflateStrategy: 0 } as const;

/** One direction's frames, as stored in SpriteData (`''` = transparent). */
export type SheetFrames = Record<string, string[][][]>;

/**
 * Lay out `dirs` as rows (top to bottom, in the given order) and frames as columns
 * (left to right) and encode the result.
 *
 * Without `cols` the width comes from the longest direction; a direction with fewer
 * frames leaves the remaining cells transparent, which is exactly how the decoder reads
 * them back. A frame shorter or narrower than the stated size is padded the same way,
 * so a half-finished sprite from the editor round-trips instead of throwing.
 *
 * Pass `cols` when the reader expects a FIXED grid: `decodePetPng` always slices six
 * columns per row regardless of the file, so a pet sheet written narrower than that
 * makes it read past the end of the image (measured: it throws inside rgbaToHex). The
 * character decoder derives its count from the width and needs no help.
 */
export function encodeDirectionalSheet(
  sprites: SheetFrames,
  dirs: readonly string[],
  frameW: number,
  frameH: number,
  cols?: number,
): Buffer {
  const widest = Math.max(1, ...dirs.map((d) => sprites[d]?.length ?? 0));
  const columns = Math.max(cols ?? 0, widest);
  const png = new PNG({ width: columns * frameW, height: dirs.length * frameH });
  png.data.fill(0); // transparent ground: every cell the art does not cover stays a gap
  dirs.forEach((dir, row) => {
    const frames = sprites[dir] ?? [];
    frames.forEach((frame, col) => {
      for (let y = 0; y < frameH; y++) {
        const line = frame[y];
        if (!line) continue;
        for (let x = 0; x < frameW; x++) {
          const { r, g, b, a } = hexToRgba(line[x] ?? '');
          if (a === 0) continue;
          const i = ((row * frameH + y) * png.width + (col * frameW + x)) * 4;
          png.data[i] = r;
          png.data[i + 1] = g;
          png.data[i + 2] = b;
          png.data[i + 3] = a;
        }
      }
    });
  });
  return PNG.sync.write(png, WRITE_OPTIONS);
}
