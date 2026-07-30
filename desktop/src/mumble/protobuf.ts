/**
 * Minimal protobuf wire codec — just enough for the ~10 Mumble control messages
 * this client speaks. Field meanings live in ./protocol.ts; this file only knows
 * tags, wire types and lengths.
 *
 * Note the varint here is the standard protobuf LEB128 (little-endian 7-bit
 * groups). Mumble's *audio* packets use a different, big-endian varint — see
 * ./varint.ts.
 */

export type ProtoValue = number | bigint | Uint8Array;
export type ProtoFields = Map<number, ProtoValue[]>;

const WIRE_VARINT = 0;
const WIRE_64 = 1;
const WIRE_LEN = 2;
const WIRE_32 = 5;

export class ProtoWriter {
  private readonly parts: number[] = [];

  private raw(byte: number): void {
    this.parts.push(byte & 0xff);
  }

  private leb(value: number | bigint): void {
    let v = typeof value === 'bigint' ? value : BigInt(Math.trunc(value));
    if (v < 0n) v += 1n << 64n; // two's complement, as protobuf encodes negatives
    do {
      const byte = Number(v & 0x7fn);
      v >>= 7n;
      this.raw(v > 0n ? byte | 0x80 : byte);
    } while (v > 0n);
  }

  private tag(field: number, wire: number): void {
    this.leb((field << 3) | wire);
  }

  varint(field: number, value: number | bigint): this {
    this.tag(field, WIRE_VARINT);
    this.leb(value);
    return this;
  }

  bool(field: number, value: boolean): this {
    return this.varint(field, value ? 1 : 0);
  }

  bytes(field: number, value: Uint8Array): this {
    this.tag(field, WIRE_LEN);
    this.leb(value.length);
    for (const b of value) this.raw(b);
    return this;
  }

  string(field: number, value: string): this {
    return this.bytes(field, new TextEncoder().encode(value));
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.parts);
  }
}

/** Parse a message into field number -> occurrences. Repeated fields collect in
 *  order. Malformed input yields whatever was read so far rather than throwing:
 *  a peer sending garbage should not take the connection down here. */
export function readProto(buf: Uint8Array): ProtoFields {
  const out: ProtoFields = new Map();
  const push = (field: number, value: ProtoValue): void => {
    const list = out.get(field);
    if (list) list.push(value);
    else out.set(field, [value]);
  };
  let off = 0;
  try {
    while (off < buf.length) {
      const tag = readLeb(buf, off);
      off = tag.next;
      const field = Number(tag.value >> 3n);
      const wire = Number(tag.value & 7n);
      if (field === 0) break;
      if (wire === WIRE_VARINT) {
        const v = readLeb(buf, off);
        off = v.next;
        push(field, v.value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v.value) : v.value);
      } else if (wire === WIRE_LEN) {
        const len = readLeb(buf, off);
        off = len.next;
        const n = Number(len.value);
        if (n < 0 || off + n > buf.length) break;
        push(field, buf.subarray(off, off + n));
        off += n;
      } else if (wire === WIRE_64) {
        if (off + 8 > buf.length) break;
        push(field, buf.subarray(off, off + 8));
        off += 8;
      } else if (wire === WIRE_32) {
        if (off + 4 > buf.length) break;
        push(field, buf.subarray(off, off + 4));
        off += 4;
      } else {
        break; // deprecated group wire types — nothing sane to skip to
      }
    }
  } catch {
    /* truncated — return what parsed */
  }
  return out;
}

function readLeb(buf: Uint8Array, off: number): { value: bigint; next: number } {
  let value = 0n;
  let shift = 0n;
  let i = off;
  for (;;) {
    if (i >= buf.length) throw new RangeError('readLeb: truncated');
    const byte = buf[i++];
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7n;
    if (shift > 70n) throw new RangeError('readLeb: overlong');
  }
  return { value, next: i };
}

export function pbNum(fields: ProtoFields, field: number, def = 0): number {
  const v = fields.get(field)?.[0];
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  return def;
}

export function pbNumOpt(fields: ProtoFields, field: number): number | undefined {
  return fields.has(field) ? pbNum(fields, field) : undefined;
}

export function pbBool(fields: ProtoFields, field: number, def = false): boolean {
  const v = fields.get(field)?.[0];
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'bigint') return v !== 0n;
  return def;
}

export function pbBoolOpt(fields: ProtoFields, field: number): boolean | undefined {
  return fields.has(field) ? pbBool(fields, field) : undefined;
}

export function pbStr(fields: ProtoFields, field: number, def = ''): string {
  const v = fields.get(field)?.[0];
  return v instanceof Uint8Array ? new TextDecoder().decode(v) : def;
}

export function pbStrOpt(fields: ProtoFields, field: number): string | undefined {
  return fields.has(field) ? pbStr(fields, field) : undefined;
}

export function pbNums(fields: ProtoFields, field: number): number[] {
  return (fields.get(field) ?? [])
    .map((v) => (typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : NaN))
    .filter((n) => Number.isFinite(n));
}
