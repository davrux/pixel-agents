/**
 * Mumble message layer: TCP framing, the control messages this client needs,
 * and the legacy UDP voice packet (which we only ever carry tunnelled over TCP).
 *
 * Framing: [uint16 BE type][uint32 BE length][payload].
 */
import {
  ProtoWriter,
  pbBool,
  pbBoolOpt,
  pbNum,
  pbNumOpt,
  pbNums,
  pbStr,
  pbStrOpt,
  readProto,
} from './protobuf.js';
import { encodeVarint, readVarint } from './varint.js';

export const MSG = {
  VERSION: 0,
  UDP_TUNNEL: 1,
  AUTHENTICATE: 2,
  PING: 3,
  REJECT: 4,
  SERVER_SYNC: 5,
  CHANNEL_REMOVE: 6,
  CHANNEL_STATE: 7,
  USER_REMOVE: 8,
  USER_STATE: 9,
  TEXT_MESSAGE: 11,
  PERMISSION_DENIED: 12,
  CRYPT_SETUP: 15,
  PERMISSION_QUERY: 20,
  CODEC_VERSION: 21,
  SERVER_CONFIG: 24,
} as const;

/** Codec id 4 = Opus, in the top 3 bits of a voice packet's first byte. */
const CODEC_OPUS = 4;
/** Bit 13 of the payload-length varint marks the last frame of a talk spurt. */
const TERMINATOR_BIT = 0x2000;
const LENGTH_MASK = 0x1fff;

export function frame(type: number, payload: Uint8Array): Buffer {
  const out = Buffer.allocUnsafe(6 + payload.length);
  out.writeUInt16BE(type, 0);
  out.writeUInt32BE(payload.length, 2);
  out.set(payload, 6);
  return out;
}

export interface MumbleFrame {
  type: number;
  payload: Buffer;
}

/** Reassembles the length-prefixed message stream. TCP hands us arbitrary
 *  chunks, so a message may arrive in pieces or several may share one chunk. */
export class FrameReader {
  private buffer: Buffer = Buffer.alloc(0);

  constructor(private readonly maxMessageBytes: number) {}

  /** Consume a chunk, returning whatever complete messages it completed.
   *  Throws when the stream declares an implausible length — the caller should
   *  treat that as a hostile or desynchronised peer and drop the connection. */
  push(chunk: Buffer): MumbleFrame[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const out: MumbleFrame[] = [];
    for (;;) {
      if (this.buffer.length < 6) return out;
      const type = this.buffer.readUInt16BE(0);
      const length = this.buffer.readUInt32BE(2);
      if (length > this.maxMessageBytes) throw new RangeError('oversized message');
      if (this.buffer.length < 6 + length) return out;
      out.push({ type, payload: this.buffer.subarray(6, 6 + length) });
      this.buffer = this.buffer.subarray(6 + length);
    }
  }
}

// ── outgoing control messages ────────────────────────────────────────────────

/** Announce 1.3.0. Deliberately no `version_v2` (field 5): advertising 1.5
 *  would let Murmur switch to the new protobuf voice format, and we parse the
 *  legacy one. */
export function encodeVersion(release: string, os: string, osVersion: string): Uint8Array {
  return new ProtoWriter()
    .varint(1, 0x00010300)
    .string(2, release)
    .string(3, os)
    .string(4, osVersion)
    .finish();
}

export function encodeAuthenticate(username: string, password: string, tokens: string[]): Uint8Array {
  const w = new ProtoWriter().string(1, username).string(2, password);
  for (const t of tokens) w.string(3, t);
  return w.bool(5, true).finish(); // opus: true
}

export function encodePing(timestampMs: number): Uint8Array {
  return new ProtoWriter().varint(1, BigInt(Math.trunc(timestampMs))).finish();
}

export interface UserStatePatch {
  session?: number;
  channelId?: number;
  selfMute?: boolean;
  selfDeaf?: boolean;
  /** 0 requests self-registration on the server. */
  userId?: number;
  /** Channels to start listening to without leaving our own — Mumble 1.4's
   *  ChannelListener ("place an ear"). Needs the Listen permission there. */
  listenAdd?: number[];
  listenRemove?: number[];
}

export function encodeUserState(patch: UserStatePatch): Uint8Array {
  const w = new ProtoWriter();
  if (patch.session !== undefined) w.varint(1, patch.session);
  if (patch.userId !== undefined) w.varint(4, patch.userId);
  if (patch.channelId !== undefined) w.varint(5, patch.channelId);
  if (patch.selfMute !== undefined) w.bool(9, patch.selfMute);
  if (patch.selfDeaf !== undefined) w.bool(10, patch.selfDeaf);
  for (const id of patch.listenAdd ?? []) w.varint(21, id);
  for (const id of patch.listenRemove ?? []) w.varint(22, id);
  return w.finish();
}

/** Ask what we are allowed to do in one channel. Murmur answers with a
 *  PermissionQuery carrying the bitfield; see decodePermissionQuery. */
export function encodePermissionQuery(channelId: number): Uint8Array {
  return new ProtoWriter().varint(1, channelId).finish();
}

export function encodeTextMessage(channelId: number, message: string): Uint8Array {
  return new ProtoWriter().varint(3, channelId).string(5, message).finish();
}

// ── incoming control messages ────────────────────────────────────────────────

const REJECT_REASONS: Record<number, string> = {
  0: 'no reason given',
  1: 'unsupported client version',
  2: 'that name is already taken on the server',
  3: 'invalid username',
  4: 'wrong user password',
  5: 'wrong server password',
  6: 'a user with this certificate is already connected',
  7: 'the server does not allow this certificate',
  8: 'the server requires a certificate',
  9: 'you are banned from this server',
};

export function decodeReject(payload: Uint8Array): { type: number; reason: string } {
  const f = readProto(payload);
  const type = pbNum(f, 1);
  return { type, reason: pbStr(f, 2) || REJECT_REASONS[type] || 'connection rejected' };
}

export function decodeServerSync(payload: Uint8Array): {
  session: number;
  welcome: string;
  /** Our permissions in the channel we land in — the one answer we get for
   *  free, without asking. Absent on servers that do not send it. */
  permissions?: number;
} {
  const f = readProto(payload);
  return { session: pbNum(f, 1), welcome: pbStr(f, 3), permissions: pbNumOpt(f, 4) };
}

export interface ChannelStateMsg {
  id: number;
  parent?: number;
  name?: string;
  description?: string;
  position?: number;
}

export function decodeChannelState(payload: Uint8Array): ChannelStateMsg {
  const f = readProto(payload);
  return {
    id: pbNum(f, 1),
    parent: pbNumOpt(f, 2),
    name: pbStrOpt(f, 3),
    description: pbStrOpt(f, 5),
    position: pbNumOpt(f, 9),
  };
}

export function decodeChannelRemove(payload: Uint8Array): number {
  return pbNum(readProto(payload), 1);
}

export interface UserStateMsg {
  session: number;
  name?: string;
  userId?: number;
  channelId?: number;
  mute?: boolean;
  deaf?: boolean;
  suppress?: boolean;
  selfMute?: boolean;
  selfDeaf?: boolean;
  /** Ears placed / removed. These are a *delta* on whatever the user was
   *  already listening to, not the whole set — Murmur echoes back only the
   *  additions it accepted, so the reader has to keep the running set. */
  listenAdd: number[];
  listenRemove: number[];
}

export function decodeUserState(payload: Uint8Array): UserStateMsg {
  const f = readProto(payload);
  return {
    session: pbNum(f, 1),
    name: pbStrOpt(f, 3),
    userId: pbNumOpt(f, 4),
    channelId: pbNumOpt(f, 5),
    mute: pbBoolOpt(f, 6),
    deaf: pbBoolOpt(f, 7),
    suppress: pbBoolOpt(f, 8),
    selfMute: pbBoolOpt(f, 9),
    selfDeaf: pbBoolOpt(f, 10),
    listenAdd: pbNums(f, 21),
    listenRemove: pbNums(f, 22),
  };
}

/**
 * `permissions` is Murmur's ACL bitfield (`ChanACL::Perm`) for one channel:
 * Write 0x1, Traverse 0x2, Enter 0x4, Speak 0x8, MuteDeafen 0x10, Move 0x20,
 * MakeChannel 0x40, LinkChannel 0x80, Whisper 0x100, TextMessage 0x200,
 * MakeTempChannel 0x400, Listen 0x800; and, on the root channel only, Kick
 * 0x10000, Ban 0x20000, Register 0x40000, SelfRegister 0x80000,
 * ResetUserContent 0x100000.
 *
 * Nothing in main reads it — the renderer decides what to offer (see
 * `MUMBLE_PERM` in client/src/voice/MumbleVoice.ts). It is spelled out here
 * because this is where the number arrives.
 */
export interface PermissionQueryMsg {
  /** Absent on the unsolicited flush Murmur sends when an ACL changes — which
   *  is why this is optional rather than defaulting to 0, the root channel. */
  channelId?: number;
  permissions?: number;
  /** Every cached answer is now stale; ask again for whatever still matters. */
  flush: boolean;
}

export function decodePermissionQuery(payload: Uint8Array): PermissionQueryMsg {
  const f = readProto(payload);
  return { channelId: pbNumOpt(f, 1), permissions: pbNumOpt(f, 2), flush: pbBool(f, 3) };
}

export function decodeUserRemove(payload: Uint8Array): { session: number; reason: string } {
  const f = readProto(payload);
  return { session: pbNum(f, 1), reason: pbStr(f, 3) };
}

export function decodeTextMessage(payload: Uint8Array): { actor: number; message: string } {
  const f = readProto(payload);
  return { actor: pbNum(f, 1), message: pbStr(f, 5) };
}

export function decodePermissionDenied(payload: Uint8Array): string {
  const f = readProto(payload);
  return pbStr(f, 4) || `permission denied (type ${pbNum(f, 5)})`;
}

export function decodeCodecVersion(payload: Uint8Array): { opus: boolean } {
  return { opus: pbBool(readProto(payload), 4, true) };
}

// ── voice packets ────────────────────────────────────────────────────────────

/** Build the legacy UDP voice packet we tunnel over TCP. Target 0 = normal talk. */
export function packAudio(seq: number, opus: Uint8Array, terminator: boolean): Uint8Array {
  const header = Uint8Array.of((CODEC_OPUS << 5) | 0);
  const seqBytes = encodeVarint(seq);
  const lenBytes = encodeVarint(opus.length | (terminator ? TERMINATOR_BIT : 0));
  const out = new Uint8Array(header.length + seqBytes.length + lenBytes.length + opus.length);
  let off = 0;
  out.set(header, off);
  off += header.length;
  out.set(seqBytes, off);
  off += seqBytes.length;
  out.set(lenBytes, off);
  off += lenBytes.length;
  out.set(opus, off);
  return out;
}

export interface IncomingAudio {
  session: number;
  sequence: number;
  opus: Uint8Array;
  terminator: boolean;
}

/** Parse a tunnelled voice packet. Returns null for a non-Opus codec (ancient
 *  CELT/Speex clients) or truncated data — both mean "drop this packet". Any
 *  trailing positional-audio floats are ignored. */
export function unpackAudio(buf: Uint8Array): IncomingAudio | null {
  if (buf.length < 1) return null;
  if (buf[0] >> 5 !== CODEC_OPUS) return null;
  try {
    const session = readVarint(buf, 1);
    const sequence = readVarint(buf, session.next);
    const header = readVarint(buf, sequence.next);
    const len = header.value & LENGTH_MASK;
    const start = header.next;
    if (start + len > buf.length) return null;
    return {
      session: session.value,
      sequence: sequence.value,
      opus: buf.subarray(start, start + len),
      terminator: (header.value & TERMINATOR_BIT) !== 0,
    };
  } catch {
    return null;
  }
}
