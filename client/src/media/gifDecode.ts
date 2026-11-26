/**
 * A GIF decoder: the file's frames, composited the way a browser plays them, plus their delays.
 *
 * Why the client decodes GIFs itself rather than letting the browser do it: a browser animates a
 * GIF in an `<img>`, but the spec tells `drawImage` to use the FIRST frame of an animated image,
 * and Firefox does exactly that — so the only way to get every frame in both browsers (AGENTS.md
 * invariant 9) without a WebCodecs `ImageDecoder` that one of them may lack is to read the format.
 * It is small: LZW, a palette, and four disposal rules.
 *
 * Two passes, on purpose. `parseGif` only walks the block structure (it skips the image data), so
 * a caller learns how many frames there are and how long each lasts before decoding anything — and
 * can choose to keep only some of them (`renderGif`'s `keep`). Compositing still has to visit every
 * frame, since a frame may draw over its predecessor, but only the kept ones are handed out.
 *
 * This runs on a file the player chose on their own machine, so a hostile file can at worst stall
 * their own tab; the bounds below exist so an absurd file fails with a message instead of doing
 * that.
 */

/** Larger than any GIF anyone would put on a television, small enough to allocate. */
const MAX_SIDE = 4096;
/** Frames, and composited pixels across all of them — what keeps a pathological file finite. */
const MAX_FRAMES = 5000;
const MAX_WORK_PIXELS = 400_000_000;

interface GifFrame {
  left: number;
  top: number;
  width: number;
  height: number;
  interlaced: boolean;
  palette: Uint8Array;
  transparent: number; // -1 = none
  disposal: number;
  /** In ms, as the file states it (1/100 s units × 10); 0 when absent. */
  delay: number;
  minCodeSize: number;
  /** The image data's sub-blocks, as [start, end) ranges into the file. */
  chunks: Array<[number, number]>;
}

export interface ParsedGif {
  width: number;
  height: number;
  frames: GifFrame[];
}

export function isGif(bytes: Uint8Array): boolean {
  return bytes.length >= 6 && String.fromCharCode(...bytes.subarray(0, 6)).match(/^GIF8[79]a$/) !== null;
}

export function parseGif(bytes: Uint8Array): ParsedGif {
  if (!isGif(bytes)) throw new Error('not a GIF');
  let p = 6;
  const u8 = (): number => {
    if (p >= bytes.length) throw new Error('GIF ends early');
    return bytes[p++];
  };
  const u16 = (): number => u8() | (u8() << 8);
  const width = u16();
  const height = u16();
  if (width < 1 || height < 1 || width > MAX_SIDE || height > MAX_SIDE) throw new Error(`GIF is ${width}×${height}`);
  const packed = u8();
  u8(); // background colour index — browsers clear to transparent, not to this
  u8(); // pixel aspect
  let global = new Uint8Array(0);
  if (packed & 0x80) {
    const n = 3 * (1 << ((packed & 7) + 1));
    global = bytes.slice(p, p + n);
    p += n;
  }

  const frames: GifFrame[] = [];
  let gce = { transparent: -1, disposal: 0, delay: 0 };
  const skipSubBlocks = (): void => {
    for (let n = u8(); n !== 0; n = u8()) p += n;
  };
  for (;;) {
    if (p >= bytes.length) break; // a missing trailer is common; what came before still plays
    const block = u8();
    if (block === 0x3b) break;
    if (block === 0x21) {
      const label = u8();
      if (label === 0xf9) {
        const size = u8();
        const start = p;
        const flags = u8();
        const delay = u16();
        const tIndex = u8();
        p = start + size;
        skipSubBlocks();
        gce = { transparent: flags & 1 ? tIndex : -1, disposal: (flags >> 2) & 7, delay: delay * 10 };
      } else {
        skipSubBlocks();
      }
      continue;
    }
    if (block !== 0x2c) throw new Error(`unknown GIF block 0x${block.toString(16)}`);
    const left = u16();
    const top = u16();
    const w = u16();
    const h = u16();
    const f = u8();
    let palette = global;
    if (f & 0x80) {
      const n = 3 * (1 << ((f & 7) + 1));
      palette = bytes.slice(p, p + n);
      p += n;
    }
    const minCodeSize = u8();
    if (minCodeSize < 1 || minCodeSize > 11) throw new Error('bad LZW code size');
    const chunks: Array<[number, number]> = [];
    for (let n = u8(); n !== 0; n = u8()) {
      chunks.push([p, Math.min(p + n, bytes.length)]);
      p += n;
    }
    frames.push({ left, top, width: w, height: h, interlaced: (f & 0x40) !== 0, palette, minCodeSize, chunks, ...gce });
    gce = { transparent: -1, disposal: 0, delay: 0 };
    if (frames.length > MAX_FRAMES) throw new Error(`more than ${MAX_FRAMES} frames`);
  }
  if (frames.length === 0) throw new Error('GIF has no frames');
  if (frames.length * width * height > MAX_WORK_PIXELS) throw new Error('GIF is too large to decode');
  return { width, height, frames };
}

/** LZW-decode one frame's indices. Tolerant of a short stream, as browsers are: what is missing
 *  stays index 0 rather than failing the whole file. */
function lzw(bytes: Uint8Array, frame: GifFrame): Uint8Array {
  const out = new Uint8Array(frame.width * frame.height);
  const clear = 1 << frame.minCodeSize;
  const eoi = clear + 1;
  const prefix = new Uint16Array(4096);
  const suffix = new Uint8Array(4096);
  const stack = new Uint8Array(4097);
  let codeSize = frame.minCodeSize + 1;
  let codeMask = (1 << codeSize) - 1;
  let next = clear + 2;
  let prev = -1;
  let first = 0;
  let o = 0;
  let bits = 0;
  let datum = 0;
  outer: for (const [start, end] of frame.chunks) {
    for (let i = start; i < end; i++) {
      datum |= bytes[i] << bits;
      bits += 8;
      while (bits >= codeSize) {
        let code = datum & codeMask;
        datum >>>= codeSize;
        bits -= codeSize;
        if (code === clear) {
          codeSize = frame.minCodeSize + 1;
          codeMask = (1 << codeSize) - 1;
          next = clear + 2;
          prev = -1;
          continue;
        }
        if (code === eoi) break outer;
        if (prev === -1) {
          if (code >= clear) continue; // garbage before the first literal
          out[o++] = code;
          prev = first = code;
          if (o >= out.length) break outer;
          continue;
        }
        const inCode = code;
        let sp = 0;
        if (code >= next) {
          // The KwKwK case: the code being defined right now.
          stack[sp++] = first;
          code = prev;
        }
        while (code >= clear) {
          if (code >= 4096 || sp >= 4096) break outer;
          stack[sp++] = suffix[code];
          code = prefix[code];
        }
        first = code;
        stack[sp++] = code;
        if (next < 4096) {
          prefix[next] = prev;
          suffix[next] = first;
          next++;
          if ((next & codeMask) === 0 && next < 4096) {
            codeSize++;
            codeMask = (1 << codeSize) - 1;
          }
        }
        prev = inCode;
        while (sp > 0) {
          out[o++] = stack[--sp];
          if (o >= out.length) break outer;
        }
      }
    }
  }
  return out;
}

/** The row an interlaced image's n-th stored row belongs to (passes of 8, 8, 4, 2). */
function deinterlaceRows(h: number): number[] {
  const rows: number[] = [];
  for (const [start, step] of [
    [0, 8],
    [4, 8],
    [2, 4],
    [1, 2],
  ]) {
    for (let y = start; y < h; y += step) rows.push(y);
  }
  return rows;
}

/**
 * Composite every frame onto the logical screen, in order, and hand out the ones in `keep` as
 * RGBA of the full screen size. Disposal follows what browsers do: 2 clears the frame's rectangle
 * to TRANSPARENT (not to the background colour, which every engine ignores), 3 restores what was
 * there before it was drawn.
 */
export function renderGif(gif: ParsedGif, bytes: Uint8Array, keep: (i: number) => boolean, onFrame: (i: number, rgba: Uint8ClampedArray) => void): void {
  const { width: W, height: H } = gif;
  const screen = new Uint8ClampedArray(W * H * 4);
  let saved: Uint8ClampedArray | null = null;
  gif.frames.forEach((f, i) => {
    if (f.disposal === 3) saved = screen.slice();
    const idx = lzw(bytes, f);
    const rowMap = f.interlaced ? deinterlaceRows(f.height) : null;
    for (let r = 0; r < f.height; r++) {
      const y = f.top + (rowMap ? rowMap[r] : r);
      if (y >= H) continue;
      for (let c = 0; c < f.width; c++) {
        const x = f.left + c;
        if (x >= W) continue;
        const ci = idx[r * f.width + c];
        if (ci === f.transparent || ci * 3 + 2 >= f.palette.length) continue;
        const d = (y * W + x) * 4;
        screen[d] = f.palette[ci * 3];
        screen[d + 1] = f.palette[ci * 3 + 1];
        screen[d + 2] = f.palette[ci * 3 + 2];
        screen[d + 3] = 255;
      }
    }
    if (keep(i)) onFrame(i, screen);
    if (f.disposal === 2) {
      for (let y = f.top; y < Math.min(H, f.top + f.height); y++) {
        screen.fill(0, (y * W + f.left) * 4, (y * W + Math.min(W, f.left + f.width)) * 4);
      }
    } else if (f.disposal === 3 && saved) {
      screen.set(saved);
    }
  });
}
