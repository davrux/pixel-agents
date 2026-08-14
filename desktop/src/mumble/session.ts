/**
 * One connection to a Mumble (Murmur) server.
 *
 * Runs in the Electron main process because a browser cannot open a raw TLS
 * socket. Audio is tunnelled over the control connection (UDPTunnel), so there
 * is no UDP path and no crypto setup to negotiate — the tradeoff is TCP's
 * head-of-line blocking, which the renderer's jitter buffer absorbs.
 *
 * Opus payloads pass through untouched: this class never decodes audio.
 */
import { EventEmitter } from 'node:events';
import { isIP } from 'node:net';
import { connect as tlsConnect, type PeerCertificate, type TLSSocket } from 'node:tls';

import {
  MSG,
  decodeChannelRemove,
  decodeChannelState,
  decodeCodecVersion,
  decodePermissionDenied,
  decodePermissionQuery,
  decodeReject,
  decodeServerSync,
  decodeTextMessage,
  decodeUserRemove,
  decodeUserState,
  encodeAuthenticate,
  encodePermissionQuery,
  encodePing,
  encodeTextMessage,
  encodeUserState,
  encodeVersion,
  frame,
  FrameReader,
  packAudio,
  unpackAudio,
  type ChannelStateMsg,
  type PermissionQueryMsg,
  type UserStateMsg,
} from './protocol.js';

const PING_INTERVAL_MS = 15_000; // Murmur drops idle clients after ~30 s
const HANDSHAKE_TIMEOUT_MS = 10_000;
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
/** Mumble sequence numbers count 10 ms units; we always send 20 ms frames. */
const SEQ_PER_FRAME = 2;

export interface MumbleChannel {
  id: number;
  parent: number;
  name: string;
  description?: string;
  position?: number;
}

export interface MumbleUser {
  session: number;
  name: string;
  channel: number;
  selfMute: boolean;
  selfDeaf: boolean;
  mute: boolean;
  deaf: boolean;
  suppress: boolean;
  /** Present once the server reports a registered account for this user. */
  userId?: number;
  /** Channels this user has an ear in (Mumble 1.4 ChannelListener). Kept as a
   *  running set here because the wire only ever carries the delta. */
  listening: number[];
}

/** Answer to a PermissionQuery, or the unsolicited flush Murmur broadcasts
 *  when an ACL changes — which carries no channel at all. */
export interface MumblePermissions {
  channel?: number;
  permissions?: number;
  flush: boolean;
}

export interface MumbleSessionOptions {
  host: string;
  port: number;
  username: string;
  password: string;
  tokens: string[];
  /** Channel name to join once the tree has synced. */
  channel?: string;
  /** PKCS#12 identity (what the official Mumble client exports). */
  pfx?: Buffer;
  passphrase?: string;
  /** Asked to approve the server's certificate before the handshake completes. */
  verifyPeer: (cert: PeerCertificate) => Promise<boolean>;
  release: string;
  os: string;
  osVersion: string;
}

/** Emits: sync, channel, channelRemove, user, userRemove, audio, text,
 *  permission, permissions, error, close. */
export class MumbleSession extends EventEmitter {
  private socket: TLSSocket | null = null;
  private readonly reader = new FrameReader(MAX_MESSAGE_BYTES);
  private pingTimer: NodeJS.Timeout | null = null;
  private handshakeTimer: NodeJS.Timeout | null = null;
  private synced = false;
  private closed = false;
  private seq = 0;
  private warnedNonOpus = false;

  private ourSession = 0;
  private currentChannel = 0;
  private readonly channels = new Map<number, MumbleChannel>();
  private readonly users = new Map<number, MumbleUser>();

  constructor(private readonly opts: MumbleSessionOptions) {
    super();
  }

  connect(): void {
    // rejectUnauthorized is off because Murmur is self-signed by default, so a
    // chain check is meaningless. Safety comes from verifyPeer below, which
    // pins the fingerprint — never remove that check.
    let socket: TLSSocket;
    try {
      socket = tlsConnect({
        host: this.opts.host,
        port: this.opts.port,
        // SNI must be omitted for a bare IP — Node throws outright otherwise,
        // and people do type addresses like 192.168.1.10 for a home server.
        servername: isIP(this.opts.host) ? undefined : this.opts.host,
        rejectUnauthorized: false,
        pfx: this.opts.pfx,
        passphrase: this.opts.passphrase,
      });
    } catch (e) {
      // Bad passphrase on the PKCS#12 surfaces here, synchronously.
      this.fail(describeSocketError(e as Error));
      return;
    }
    this.socket = socket;

    this.handshakeTimer = setTimeout(() => {
      this.fail('the server did not respond in time');
    }, HANDSHAKE_TIMEOUT_MS);

    socket.on('secureConnect', () => {
      void this.onSecureConnect(socket);
    });
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('error', (err: Error) => this.fail(describeSocketError(err)));
    socket.on('close', () => {
      if (!this.closed) {
        this.closed = true;
        this.stopTimers();
        this.emit('close');
      }
    });
  }

  private async onSecureConnect(socket: TLSSocket): Promise<void> {
    let accepted = false;
    try {
      accepted = await this.opts.verifyPeer(socket.getPeerCertificate());
    } catch {
      accepted = false;
    }
    if (this.closed) return;
    if (!accepted) {
      this.fail('certificate-rejected');
      return;
    }
    this.send(MSG.VERSION, encodeVersion(this.opts.release, this.opts.os, this.opts.osVersion));
    this.send(
      MSG.AUTHENTICATE,
      encodeAuthenticate(this.opts.username, this.opts.password, this.opts.tokens),
    );
    this.pingTimer = setInterval(() => this.send(MSG.PING, encodePing(Date.now())), PING_INTERVAL_MS);
  }

  // ── framing ────────────────────────────────────────────────────────────────

  private onData(chunk: Buffer): void {
    let frames;
    try {
      frames = this.reader.push(chunk);
    } catch {
      this.fail('the server sent an oversized message');
      return;
    }
    for (const { type, payload } of frames) {
      try {
        this.dispatch(type, payload);
      } catch {
        /* one malformed message must not kill the connection */
      }
      if (this.closed) return;
    }
  }

  private dispatch(type: number, payload: Buffer): void {
    switch (type) {
      case MSG.UDP_TUNNEL:
        this.onAudio(payload);
        return;
      case MSG.CHANNEL_STATE:
        this.onChannelState(decodeChannelState(payload));
        return;
      case MSG.CHANNEL_REMOVE: {
        const id = decodeChannelRemove(payload);
        this.channels.delete(id);
        if (this.synced) this.emit('channelRemove', id);
        return;
      }
      case MSG.USER_STATE:
        this.onUserState(decodeUserState(payload));
        return;
      case MSG.USER_REMOVE: {
        const { session } = decodeUserRemove(payload);
        this.users.delete(session);
        if (this.synced) this.emit('userRemove', session);
        return;
      }
      case MSG.SERVER_SYNC:
        this.onServerSync(payload);
        return;
      case MSG.TEXT_MESSAGE:
        this.emit('text', decodeTextMessage(payload));
        return;
      case MSG.PERMISSION_DENIED:
        this.emit('permission', decodePermissionDenied(payload));
        return;
      case MSG.PERMISSION_QUERY:
        this.onPermissionQuery(decodePermissionQuery(payload));
        return;
      case MSG.REJECT:
        this.fail(decodeReject(payload).reason);
        return;
      case MSG.CODEC_VERSION:
        if (!decodeCodecVersion(payload).opus) {
          console.warn('[mumble] server reports non-Opus codec clients; they will not be audible');
        }
        return;
      default:
        return; // Ping, CryptSetup, ServerConfig, ACLs… — nothing we act on
    }
  }

  // ── state ──────────────────────────────────────────────────────────────────

  private onChannelState(msg: ChannelStateMsg): void {
    const existing = this.channels.get(msg.id);
    const channel: MumbleChannel = {
      id: msg.id,
      parent: msg.parent ?? existing?.parent ?? 0,
      name: msg.name ?? existing?.name ?? `channel ${msg.id}`,
      description: msg.description ?? existing?.description,
      position: msg.position ?? existing?.position ?? 0,
    };
    this.channels.set(msg.id, channel);
    // Before ServerSync the server dumps the whole tree; hold those until sync
    // so the renderer gets one complete picture instead of hundreds of deltas.
    if (this.synced) this.emit('channel', channel);
  }

  private onUserState(msg: UserStateMsg): void {
    const existing = this.users.get(msg.session);
    const user: MumbleUser = {
      session: msg.session,
      name: msg.name ?? existing?.name ?? `user ${msg.session}`,
      channel: msg.channelId ?? existing?.channel ?? 0,
      selfMute: msg.selfMute ?? existing?.selfMute ?? false,
      selfDeaf: msg.selfDeaf ?? existing?.selfDeaf ?? false,
      mute: msg.mute ?? existing?.mute ?? false,
      deaf: msg.deaf ?? existing?.deaf ?? false,
      suppress: msg.suppress ?? existing?.suppress ?? false,
      userId: msg.userId ?? existing?.userId,
      listening: applyListening(existing?.listening, msg.listenAdd, msg.listenRemove),
    };
    this.users.set(msg.session, user);
    if (msg.session === this.ourSession && msg.channelId !== undefined) {
      this.currentChannel = msg.channelId;
    }
    if (this.synced) this.emit('user', user);
  }

  private onServerSync(payload: Buffer): void {
    const { session, welcome, permissions } = decodeServerSync(payload);
    this.ourSession = session;
    this.currentChannel = this.users.get(session)?.channel ?? 0;
    this.synced = true;
    this.stopHandshakeTimer();
    if (this.opts.channel) this.joinChannelByName(this.opts.channel);
    this.emit('sync', {
      session,
      welcome,
      channels: [...this.channels.values()],
      users: [...this.users.values()],
    });
    // After the sync, never before: the renderer empties its permission cache
    // on a sync, and this is the one channel's answer it does not have to ask
    // for. `currentChannel` is still where we landed — a join requested above
    // only takes effect when the server echoes it back.
    if (permissions !== undefined) {
      this.emit('permissions', { channel: this.currentChannel, permissions, flush: false });
    }
  }

  private onPermissionQuery(msg: PermissionQueryMsg): void {
    if (!this.synced) return;
    // A flush and an answer are independent: forward both parts as they came,
    // and let the renderer clear before it stores.
    this.emit('permissions', {
      channel: msg.channelId,
      permissions: msg.channelId === undefined ? undefined : (msg.permissions ?? 0),
      flush: msg.flush,
    } satisfies MumblePermissions);
  }

  private onAudio(payload: Buffer): void {
    const packet = unpackAudio(payload);
    if (!packet) {
      if (!this.warnedNonOpus) {
        this.warnedNonOpus = true;
        console.warn('[mumble] dropping a voice packet in an unsupported codec (not Opus)');
      }
      return;
    }
    this.emit('audio', {
      session: packet.session,
      sequence: packet.sequence,
      terminator: packet.terminator,
      // Copy out of the socket buffer: the subarray aliases memory that is
      // reused for the next chunk, and this crosses an async IPC boundary.
      opus: Uint8Array.from(packet.opus),
    });
  }

  // ── outgoing ───────────────────────────────────────────────────────────────

  sendAudio(opus: Uint8Array, terminator: boolean): void {
    if (!this.synced) return;
    this.send(MSG.UDP_TUNNEL, packAudio(this.seq, opus, terminator));
    if (terminator) this.seq = 0;
    else this.seq += SEQ_PER_FRAME;
  }

  joinChannel(id: number): void {
    if (!this.synced) return;
    this.send(MSG.USER_STATE, encodeUserState({ session: this.ourSession, channelId: id }));
  }

  private joinChannelByName(name: string): void {
    const wanted = name.trim().toLowerCase();
    for (const channel of this.channels.values()) {
      if (channel.name.toLowerCase() === wanted) {
        this.joinChannel(channel.id);
        return;
      }
    }
  }

  /**
   * Move somebody else into a channel.
   *
   * The server is the authority — it answers PermissionDenied when we may not,
   * which the renderer already surfaces as a notice. The checks here are not a
   * permission model, only a bound on what a compromised renderer can make us
   * send: a session and a channel the server has actually told us about.
   */
  moveUser(session: number, channelId: number): void {
    if (!this.synced || !this.users.has(session) || !this.channels.has(channelId)) return;
    this.send(MSG.USER_STATE, encodeUserState({ session, channelId }));
  }

  /** Place or remove an ear in another channel: we keep hearing our own, and
   *  hear that one too. Needs the Listen permission there (Mumble 1.4+). */
  setListening(channelId: number, listening: boolean): void {
    if (!this.synced || !this.channels.has(channelId)) return;
    this.send(
      MSG.USER_STATE,
      encodeUserState({
        session: this.ourSession,
        ...(listening ? { listenAdd: [channelId] } : { listenRemove: [channelId] }),
      }),
    );
  }

  /** Ask what we may do in one channel. The answer comes back as a
   *  `permissions` event; there is no reply-matching to do. */
  queryPermissions(channelId: number): void {
    if (!this.synced || !this.channels.has(channelId)) return;
    this.send(MSG.PERMISSION_QUERY, encodePermissionQuery(channelId));
  }

  setSelfState(selfMute: boolean, selfDeaf: boolean): void {
    if (!this.synced) return;
    this.send(MSG.USER_STATE, encodeUserState({ session: this.ourSession, selfMute, selfDeaf }));
  }

  sendText(message: string): void {
    if (!this.synced) return;
    this.send(MSG.TEXT_MESSAGE, encodeTextMessage(this.currentChannel, message));
  }

  /** Ask the server to register us. Needs a client certificate and the
   *  SelfRegister permission; otherwise Murmur answers PermissionDenied. */
  selfRegister(): void {
    if (!this.synced) return;
    this.send(MSG.USER_STATE, encodeUserState({ session: this.ourSession, userId: 0 }));
  }

  private send(type: number, payload: Uint8Array): void {
    if (!this.socket || this.closed || this.socket.destroyed) return;
    this.socket.write(frame(type, payload));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopTimers();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.end();
      setTimeout(() => socket.destroy(), 1000).unref();
    }
    this.emit('close');
  }

  private fail(error: string): void {
    if (this.closed) return;
    this.closed = true;
    this.stopTimers();
    const socket = this.socket;
    this.socket = null;
    socket?.destroy();
    this.emit('error', error);
    this.emit('close');
  }

  private stopHandshakeTimer(): void {
    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }
  }

  private stopTimers(): void {
    this.stopHandshakeTimer();
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }
}

/** Fold a UserState's listen delta into the set the user already had. Returns
 *  the previous array untouched when nothing changed, so the common case (every
 *  ordinary UserState) allocates nothing. Exported for its test — the delta is
 *  the whole subtlety of ChannelListener, and getting it wrong looks like an ear
 *  that silently un-places itself on the next unrelated state change. */
export function applyListening(current: number[] | undefined, add: number[], remove: number[]): number[] {
  if (add.length === 0 && remove.length === 0) return current ?? [];
  const set = new Set(current ?? []);
  for (const id of add) set.add(id);
  for (const id of remove) set.delete(id);
  return [...set];
}

/** Turn Node's TLS/socket errors into something a user can act on. */
function describeSocketError(err: Error): string {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ENOTFOUND') return 'server not found — check the address';
  if (code === 'ECONNREFUSED') return 'connection refused — check the address and port';
  if (code === 'ETIMEDOUT') return 'connection timed out';
  const message = err.message || 'connection failed';
  // OpenSSL's wording for a PKCS#12 that will not open with the given secret.
  if (/mac verify failure|wrong final block|bad decrypt/i.test(message)) {
    return 'wrong certificate passphrase';
  }
  return message;
}
