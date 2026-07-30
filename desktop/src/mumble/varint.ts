/**
 * Mumble's own variable-length integer, used inside voice packets.
 *
 * This is NOT protobuf's LEB128 — Mumble uses a big-endian, prefix-tagged
 * encoding of its own (see PacketDataStream in the upstream client). Protobuf
 * varints live in ./protobuf.ts; do not mix the two.
 */

/** Encode a non-negative integer. The negative forms exist upstream but are
 *  never produced by a client, so they are decode-only here. */
export function encodeVarint(value: number): Uint8Array {
  const v = Math.trunc(value);
  if (v < 0) throw new RangeError('encodeVarint: negative values are not supported');
  if (v < 0x80) return Uint8Array.of(v);
  if (v < 0x4000) return Uint8Array.of(0x80 | (v >> 8), v & 0xff);
  if (v < 0x200000) return Uint8Array.of(0xc0 | (v >> 16), (v >> 8) & 0xff, v & 0xff);
  if (v < 0x10000000) return Uint8Array.of(0xe0 | (v >> 24), (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff);
  const u = v >>> 0;
  return Uint8Array.of(0xf0, (u >>> 24) & 0xff, (u >>> 16) & 0xff, (u >>> 8) & 0xff, u & 0xff);
}

function need(buf: Uint8Array, off: number, n: number): void {
  if (off + n > buf.length) throw new RangeError('readVarint: truncated input');
}

/** Decode one varint at `off`. Returns the value and the offset just past it. */
export function readVarint(buf: Uint8Array, off: number): { value: number; next: number } {
  need(buf, off, 1);
  const v = buf[off];
  // Prefix tests must stay in this order: the 0xF0 family overlaps the 0xE0 and
  // 0xC0 masks, so checking it late would misread 5- and 9-byte forms.
  if ((v & 0x80) === 0x00) return { value: v & 0x7f, next: off + 1 };
  if ((v & 0xc0) === 0x80) {
    need(buf, off, 2);
    return { value: ((v & 0x3f) << 8) | buf[off + 1], next: off + 2 };
  }
  if ((v & 0xf0) === 0xf0) {
    switch (v & 0xfc) {
      case 0xf0: {
        need(buf, off, 5);
        const value =
          (buf[off + 1] * 0x1000000 + (buf[off + 2] << 16) + (buf[off + 3] << 8) + buf[off + 4]) >>> 0;
        return { value, next: off + 5 };
      }
      case 0xf4: {
        need(buf, off, 9);
        let value = 0;
        for (let i = 1; i <= 8; i++) value = value * 256 + buf[off + i];
        return { value, next: off + 9 };
      }
      case 0xf8: {
        const inner = readVarint(buf, off + 1);
        return { value: ~inner.value, next: inner.next };
      }
      default: // 0xFC
        return { value: ~(v & 0x03), next: off + 1 };
    }
  }
  if ((v & 0xf0) === 0xe0) {
    need(buf, off, 4);
    return {
      value: ((v & 0x0f) << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3],
      next: off + 4,
    };
  }
  need(buf, off, 3);
  return { value: ((v & 0x1f) << 16) | (buf[off + 1] << 8) | buf[off + 2], next: off + 3 };
}
