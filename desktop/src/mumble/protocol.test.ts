import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ProtoWriter,
  pbBool,
  pbNum,
  pbNums,
  pbStr,
  readProto,
} from './protobuf.js';
import {
  FrameReader,
  MSG,
  decodePermissionQuery,
  decodeServerSync,
  decodeUserState,
  encodePermissionQuery,
  encodeUserState,
  frame,
  packAudio,
  unpackAudio,
  type MumbleFrame,
} from './protocol.js';
import { applyListening } from './session.js';
import { encodeVarint, readVarint } from './varint.js';

test('varint round-trips across every width boundary', () => {
  const values = [0, 1, 127, 128, 16383, 16384, 2097151, 2097152, 268435455, 268435456];
  for (const v of values) {
    const bytes = encodeVarint(v);
    const read = readVarint(bytes, 0);
    assert.equal(read.value, v, `value ${v}`);
    assert.equal(read.next, bytes.length, `width for ${v}`);
  }
});

test('varint uses the exact upstream byte forms', () => {
  assert.deepEqual([...encodeVarint(127)], [0x7f]);
  assert.deepEqual([...encodeVarint(128)], [0x80, 0x80]);
  assert.deepEqual([...encodeVarint(16383)], [0xbf, 0xff]);
  assert.deepEqual([...encodeVarint(16384)], [0xc0, 0x40, 0x00]);
  assert.deepEqual([...encodeVarint(268435456)], [0xf0, 0x10, 0x00, 0x00, 0x00]);
});

test('varint decode rejects truncated input', () => {
  assert.throws(() => readVarint(Uint8Array.of(0x80), 0), RangeError);
  assert.throws(() => readVarint(Uint8Array.of(0xf0, 0x01), 0), RangeError);
  assert.throws(() => readVarint(new Uint8Array(0), 0), RangeError);
});

test('varint decodes at an offset', () => {
  const buf = Uint8Array.of(0xff, 0xc0, 0x40, 0x00, 0x09);
  const read = readVarint(buf, 1);
  assert.equal(read.value, 16384);
  assert.equal(read.next, 4);
});

test('protobuf round-trips a UserState', () => {
  const encoded = encodeUserState({ session: 42, channelId: 7, selfMute: true, selfDeaf: false });
  const decoded = decodeUserState(Buffer.from(encoded));
  assert.equal(decoded.session, 42);
  assert.equal(decoded.channelId, 7);
  assert.equal(decoded.selfMute, true);
  assert.equal(decoded.selfDeaf, false);
  // Absent fields must stay absent, not default: UserState is a delta, and a
  // false-by-default would silently unmute people.
  assert.equal(decoded.name, undefined);
  assert.equal(decoded.mute, undefined);
});

test('UserState carries the ChannelListener deltas both ways', () => {
  const decoded = decodeUserState(
    Buffer.from(encodeUserState({ session: 3, listenAdd: [7, 8], listenRemove: [9] })),
  );
  assert.deepEqual(decoded.listenAdd, [7, 8]);
  assert.deepEqual(decoded.listenRemove, [9]);
  // An ordinary UserState says nothing about ears, and must not read as
  // "stop listening to everything".
  const plain = decodeUserState(Buffer.from(encodeUserState({ session: 3, selfMute: true })));
  assert.deepEqual(plain.listenAdd, []);
  assert.deepEqual(plain.listenRemove, []);
});

test('listening deltas accumulate rather than replace', () => {
  assert.deepEqual(applyListening(undefined, [4], []), [4]);
  assert.deepEqual(applyListening([4], [7], []), [4, 7]);
  assert.deepEqual(applyListening([4, 7], [], [4]), [7]);
  assert.deepEqual(applyListening([4, 7], [7], []), [4, 7]); // no duplicates
  assert.deepEqual(applyListening([4, 7], [], []), [4, 7]); // untouched by an unrelated update
  assert.deepEqual(applyListening(undefined, [], []), []);
});

test('PermissionQuery tells an answer apart from a flush', () => {
  const query = readProto(encodePermissionQuery(12));
  assert.equal(pbNum(query, 1), 12);

  const answer = decodePermissionQuery(
    new ProtoWriter().varint(1, 12).varint(2, 0x84e).finish(),
  );
  assert.equal(answer.channelId, 12);
  assert.equal(answer.permissions, 0x84e);
  assert.equal(answer.flush, false);

  // The flush Murmur broadcasts when an ACL changes names no channel — and a
  // channel that defaulted to 0 would be the root, whose permissions we would
  // then wrongly believe to be none.
  const flush = decodePermissionQuery(new ProtoWriter().bool(3, true).finish());
  assert.equal(flush.channelId, undefined);
  assert.equal(flush.permissions, undefined);
  assert.equal(flush.flush, true);
});

test('ServerSync permissions stay optional', () => {
  const withPerms = decodeServerSync(
    new ProtoWriter().varint(1, 5).string(3, 'hi').varint(4, 0x1).finish(),
  );
  assert.equal(withPerms.session, 5);
  assert.equal(withPerms.welcome, 'hi');
  assert.equal(withPerms.permissions, 0x1);
  assert.equal(decodeServerSync(new ProtoWriter().varint(1, 5).finish()).permissions, undefined);
});

test('protobuf handles strings, bools and repeated fields', () => {
  const payload = new ProtoWriter()
    .string(1, 'älpha ✓')
    .bool(2, true)
    .varint(3, 1)
    .varint(3, 2)
    .varint(3, 3)
    .finish();
  const fields = readProto(payload);
  assert.equal(pbStr(fields, 1), 'älpha ✓');
  assert.equal(pbBool(fields, 2), true);
  assert.deepEqual(pbNums(fields, 3), [1, 2, 3]);
  assert.equal(pbNum(fields, 9, 5), 5); // missing field falls back
});

test('protobuf reader survives garbage instead of throwing', () => {
  assert.doesNotThrow(() => readProto(Uint8Array.of(0xff, 0xff, 0xff)));
  assert.doesNotThrow(() => readProto(Uint8Array.of(0x0a, 0x7f))); // length past the end
});

test('frame writes the 6-byte big-endian header', () => {
  const framed = frame(MSG.USER_STATE, Uint8Array.of(1, 2, 3));
  assert.equal(framed.length, 9);
  assert.equal(framed.readUInt16BE(0), 9); // USER_STATE
  assert.equal(framed.readUInt32BE(2), 3);
  assert.deepEqual([...framed.subarray(6)], [1, 2, 3]);
});

test('audio packets round-trip, terminator included', () => {
  const opus = Uint8Array.from([1, 2, 3, 4, 5]);
  // packAudio writes an outgoing packet (no session id); rebuild the incoming
  // shape by splicing the sender's session in after the header byte.
  const outgoing = packAudio(4, opus, false);
  const incoming = withSession(outgoing, 77);
  const parsed = unpackAudio(incoming);
  assert.ok(parsed);
  assert.equal(parsed.session, 77);
  assert.equal(parsed.sequence, 4);
  assert.equal(parsed.terminator, false);
  assert.deepEqual([...parsed.opus], [...opus]);
});

test('a zero-length terminator packet parses', () => {
  const parsed = unpackAudio(withSession(packAudio(0, new Uint8Array(0), true), 3));
  assert.ok(parsed);
  assert.equal(parsed.terminator, true);
  assert.equal(parsed.opus.length, 0);
});

test('unpackAudio rejects non-Opus codecs and truncation', () => {
  const celt = Uint8Array.of(0 << 5, 1, 0, 0); // codec 0 = CELT alpha
  assert.equal(unpackAudio(celt), null);
  const good = withSession(packAudio(1, Uint8Array.from([9, 9, 9]), false), 5);
  assert.equal(unpackAudio(good.subarray(0, good.length - 1)), null);
  assert.equal(unpackAudio(new Uint8Array(0)), null);
});

/** Turn a client->server packet into the server->client shape by inserting the
 *  speaker's session id, which only the incoming direction carries. */
function withSession(outgoing: Uint8Array, session: number): Uint8Array {
  const sessionBytes = encodeVarint(session);
  const out = new Uint8Array(outgoing.length + sessionBytes.length);
  out[0] = outgoing[0];
  out.set(sessionBytes, 1);
  out.set(outgoing.subarray(1), 1 + sessionBytes.length);
  return out;
}

test('frame reassembly is independent of how TCP splits the stream', () => {
  const messages: MumbleFrame[] = [
    { type: MSG.VERSION, payload: Buffer.from([1, 2, 3, 4]) },
    { type: MSG.UDP_TUNNEL, payload: Buffer.from(packAudio(2, Uint8Array.from([7, 7]), false)) },
    { type: MSG.PING, payload: Buffer.alloc(0) },
    { type: MSG.USER_STATE, payload: Buffer.from(encodeUserState({ session: 9, channelId: 1 })) },
  ];
  const stream = Buffer.concat(messages.map((m) => frame(m.type, m.payload)));
  const expected = messages.map((m) => `${m.type}:${m.payload.toString('hex')}`);

  // Every split point, plus byte-at-a-time — the classic source of framing bugs.
  for (let split = 0; split <= stream.length; split++) {
    const reader = new FrameReader(1024);
    const got = [
      ...reader.push(stream.subarray(0, split)),
      ...reader.push(stream.subarray(split)),
    ].map((f) => `${f.type}:${f.payload.toString('hex')}`);
    assert.deepEqual(got, expected, `split at ${split}`);
  }

  const byteReader = new FrameReader(1024);
  const drip: string[] = [];
  for (const byte of stream) {
    for (const f of byteReader.push(Buffer.from([byte]))) drip.push(`${f.type}:${f.payload.toString('hex')}`);
  }
  assert.deepEqual(drip, expected);
});

test('frame reassembly rejects an implausible length', () => {
  const reader = new FrameReader(16);
  assert.throws(() => reader.push(frame(MSG.VERSION, Buffer.alloc(64))), RangeError);
});
