/**
 * Mumble voice, renderer half.
 *
 * The Electron main process owns the TLS socket and the Mumble protocol; this
 * class owns everything audio: mic capture, Opus encode/decode via WebCodecs,
 * a small jitter buffer, and per-user mixing. Opus packets cross the IPC
 * boundary opaque in both directions.
 *
 * Desktop only — `mumbleApi()` is null in a browser, so `supported` is false and
 * the UI renders nothing.
 */
import {
  mumbleApi,
  notifyDesktop,
  type MumbleAudioIn,
  type MumbleChannelInfo,
  type MumbleEvent,
  type MumbleUserInfo,
} from '../desktop/bridge.js';
import { MicGraph, clampMicGain } from './micGraph.js';

/** Opus frame size we transmit. Mumble sequence numbers count 10 ms units. */
const FRAME_MS = 20;
const FRAME_SAMPLES = (48000 * FRAME_MS) / 1000; // 960
const FRAME_US = FRAME_MS * 1000;
const OPUS_BITRATE = 32000;
/** Jitter buffer depth. Audio rides TCP, so a little slack beats stuttering. */
const JITTER_S = 0.08;
/** Hard ceiling on jitter buffer depth. A TCP head-of-line stall releases its
 *  backlog in one burst; without a ceiling that backlog becomes permanent added
 *  latency, since nothing ever drains it back down. */
const JITTER_MAX_S = 0.25;
/** Ring capacity, comfortably above JITTER_MAX_S so a burst can never wrap. */
const JITTER_CAP_S = 0.5;
/** Chromium refuses a non-default sink until microphone permission exists, and
 *  playback starts before the mic does, so the first attempt usually fails.
 *  Retry a few times rather than giving up on the user's speaker choice. */
const SINK_RETRY_MS = 2000;
const SINK_RETRY_MAX = 5;
/** How often to compare the output graph's clock against wall time. */
const CLOCK_CHECK_MS = 5000;
/** Report a clock ratio off by more than this. Well outside any sane scheduling
 *  jitter, so a hit means the graph really is rendering at the wrong speed. */
const CLOCK_TOLERANCE = 0.02;
/** A user counts as talking until this long after their last voice packet. */
const TALK_HOLD_MS = 300;
const TALK_TICK_MS = 200;
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
/** Don't queue audio behind a stalled IPC channel — drop it instead. */
const MAX_OPUS_BYTES = 1024;
/** Gather channel join/leave moves this long before notifying, so a server
 *  restart or a group move raises one notification instead of a dozen. */
const ALERT_COALESCE_MS = 600;
/** Above this, the notification counts instead of naming everyone. */
const ALERT_MAX_NAMES = 4;
/** How many activity lines to keep. Bounded because it is only ever read by
 *  eye — a server that churns for an afternoon must not grow this without end.
 *  Roomier than it looks it needs to be because channel moves are logged too,
 *  and people move far more often than they connect: a tight cap would push the
 *  arrivals out behind a handful of restless afternoons. */
const MAX_ACTIVITY = 300;
/** Default input gain. Unity is far too quiet next to the official Mumble
 *  client, whose own amplification defaults well above 1x — a browser mic
 *  captured with AGC off simply arrives quieter than Mumble's. */
const DEFAULT_MIC_GAIN = 4;

/** Opus identification header. Chrome tolerates omitting it; some engines don't. */
const OPUS_HEAD = buildOpusHead();

/**
 * Murmur's per-channel ACL bits (`ChanACL::Perm`), as they arrive in a
 * `permissions` event.
 *
 * The whole table is here even though only three of the bits are read: a
 * bitfield checked against a partial list is a trap for whoever adds the next
 * check. The ones below `kick` are per-channel; the rest are only ever granted
 * on the root channel.
 */
export const MUMBLE_PERM = {
  write: 0x1,
  traverse: 0x2,
  enter: 0x4,
  speak: 0x8,
  muteDeafen: 0x10,
  move: 0x20,
  makeChannel: 0x40,
  linkChannel: 0x80,
  whisper: 0x100,
  textMessage: 0x200,
  makeTempChannel: 0x400,
  listen: 0x800,
  kick: 0x10000,
  ban: 0x20000,
  register: 0x40000,
  selfRegister: 0x80000,
  resetUserContent: 0x100000,
} as const;

export interface MumbleVoiceState {
  connected: boolean;
  connecting: boolean;
  micOn: boolean;
  deafened: boolean;
  micGain: number;
  micThreshold: number;
  master: number;
  /** Channel we are currently in, or 0 before sync. */
  channel: number;
  /** True once the server reports a registered account for us. */
  registered: boolean;
  /** OS notifications when someone joins or leaves our channel. */
  joinAlerts: boolean;
  host: string;
  error?: string;
  notice?: string;
  /** What to suggest under a refusal, set by whoever asked for the thing that
   *  got refused. PermissionDenied says only *that* we may not — without this,
   *  a refused move would be advised to go register a certificate. */
  noticeHint?: string;
}

/** What one activity line records. A move is deliberately its own kind rather
 *  than a leave plus a join: the person never went anywhere. */
export type MumbleActivityKind = 'joined' | 'left' | 'moved';

/**
 * One line of the activity log: somebody arrived on, left, or changed channel.
 *
 * Server-wide, not channel-scoped — that is what the join/leave *alerts* are
 * (they only fire for our own channel, because an OS notification for every
 * stranger on a busy server is noise). The log answers a different question:
 * who has been around since we connected, and where they went.
 */
export interface MumbleActivity {
  /** Strictly increasing within one session, restarting at each sync. Lets a
   *  view say what is new to it without counting calls or diffing the array —
   *  which neither survives the trim at MAX_ACTIVITY nor a repaint that had
   *  nothing to do with the log. */
  seq: number;
  /** Wall clock, so it can be shown as a time of day. */
  ts: number;
  name: string;
  kind: MumbleActivityKind;
  /** For a move: the channels involved, by the *name they had at the time*.
   *  This is a record of something that happened, and the tree it will be read
   *  against has moved on — a channel can be renamed, or cease to exist. */
  from?: string;
  to?: string;
}

export interface MumbleTree {
  channels: MumbleChannelInfo[];
  users: MumbleUserInfo[];
  /** Sessions currently talking. */
  talking: Set<number>;
  /** Our own session id, or 0. */
  me: number;
}

export interface MumbleDevices {
  mics: MediaDeviceInfo[];
  speakers: MediaDeviceInfo[];
  micId?: string;
  speakerId?: string;
}

interface PeerAudio {
  decoder: AudioDecoder;
  /** Jitter buffer; reads at exactly the context rate, so pitch can't drift. */
  playout: AudioWorkletNode;
  gain: GainNode;
  tsUs: number;
  talkingUntil: number;
  /** Last sequence number seen, for gap counting. -1 before the first packet. */
  lastSeq: number;
  /** Packets the sender numbered but we never saw, in 10 ms units. */
  lost: number;
  /** Decoded samples handed to the ring, and the running rate they arrive at.
   *  Debug only: this is the other half of the clock question — how fast audio
   *  goes *in*, against the fixed rate the worklet takes it back out. */
  pushed: number;
  rateAt: number;
  ratePushed: number;
  inRate: number;
  /** Rate the decoder last reported. Should be the context rate; if it ever isn't,
   *  playChunk resamples by that ratio, which would stretch this peer alone. */
  outRate: number;
}

export class MumbleVoice {
  private readonly api = mumbleApi();

  private enabled = false;
  private readonly suspendReasons = new Set<string>();
  private connecting = false;
  private connected = false;
  private micOn: boolean;
  private deafened: boolean;
  private master: number;
  private micGain: number;
  private micThreshold: number;
  private micId: string | undefined;
  private speakerId: string | undefined;
  private joinAlerts: boolean;
  /** Mic state to put back when the user un-deafens (see toggleDeafen). */
  private micOnBeforeDeafen: boolean;
  private host = '';
  private error: string | undefined;
  private notice: string | undefined;
  private noticeHint: string | undefined;

  private mySession = 0;
  private myChannel = 0;
  private registered = false;
  private readonly channels = new Map<number, MumbleChannelInfo>();
  private readonly users = new Map<number, MumbleUserInfo>();
  /** Per-user volume + mute, keyed by display name so it survives reconnects. */
  private readonly userVolumes = new Map<string, number>();
  private readonly userMuted = new Set<string>();
  /** What the server says we may do in each channel, once it has been asked.
   *  Absent means unknown, which is not the same as "nothing allowed" — the two
   *  have to stay apart or an unanswered channel looks forbidden. */
  private readonly channelPerms = new Map<number, number>();
  /** Channels a query is already out for, so the tree's five-times-a-second
   *  repaint asks once rather than for ever. */
  private readonly permsAsked = new Set<number>();

  private unsubEvent: (() => void) | null = null;
  private unsubAudio: (() => void) | null = null;
  private reconnectTimer: number | null = null;
  private reconnectDelay = RECONNECT_MIN_MS;
  private talkTimer: number | null = null;

  /** Pending channel join/leave moves, flushed as one OS notification. */
  private readonly alerts: { name: string; joined: boolean }[] = [];
  private alertTimer: number | null = null;

  /** Server arrivals/departures since the current sync, oldest first. */
  private readonly activityLog: MumbleActivity[] = [];
  private activitySeq = 0;

  // Capture: MicGraph → worklet → 20 ms buffers → AudioEncoder → IPC.
  private mic: MicGraph | null = null;
  private capture: AudioWorkletNode | null = null;
  private captureSink: GainNode | null = null;
  private encoder: AudioEncoder | null = null;
  /** Resolves once the last endSpurt() flush has been sent; stopMic waits on it. */
  private encoderFlush: Promise<void> = Promise.resolve();
  private readonly pending: Float32Array<ArrayBuffer> = new Float32Array(FRAME_SAMPLES);
  private pendingLen = 0;
  private micTsUs = 0;
  private spurtOpen = false;
  private startingMic = false;

  // Playback: one output graph, one jitter buffer + gain per remote user.
  private outCtx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  /** Only set on the fallback path, where the sink is chosen on an element
   *  because this engine can't take a sinkId on the context itself. */
  private outEl: HTMLAudioElement | null = null;
  private readonly peers = new Map<number, PeerAudio>();
  /** Guards startPlayback, which publishes outCtx only at the end and so would
   *  otherwise build a second context if sync arrived twice in quick succession. */
  private startingPlayback = false;
  private sinkRetryTimer: number | null = null;
  private sinkRetries = 0;
  private clockTimer: number | null = null;
  /** One-shot latch so a wrong-speed output graph is reported, not spammed. */
  private warnedClock = false;

  /** Shared worklet module, added once per AudioContext that needs it. */
  private workletUrl: string | null = null;
  private readonly workletReady = new WeakSet<BaseAudioContext>();
  /** One-shot warning latches, so a rate mismatch is reported but not spammed. */
  private warnedRate = false;
  private warnedChannels = false;
  /** Per-peer jitter buffer logging. Off unless pa-mb-audiodebug is set. */
  private readonly audioDebug = localStorage.getItem('pa-mb-audiodebug') === '1';

  constructor(
    private readonly onState: (s: MumbleVoiceState) => void,
    private readonly onTree: (t: MumbleTree) => void,
    private readonly onDevices: (d: MumbleDevices) => void,
    private readonly onMicLevel: (level: number) => void,
    private readonly onActivity: (entries: readonly MumbleActivity[]) => void,
  ) {
    this.master = clampVol(Number(localStorage.getItem('pa-mb-master') ?? '1'));
    this.micGain = clampMicGain(readMicGain());
    this.micThreshold = clamp01(Number(localStorage.getItem('pa-mb-micthresh') ?? '0'));
    this.micOn = localStorage.getItem('pa-mb-micon') === '1';
    this.deafened = localStorage.getItem('pa-mb-deaf') === '1';
    // Restoring a live mic into a deafened session would recreate the state the
    // server refuses; remember it instead and hand it back on un-deafen.
    this.micOnBeforeDeafen = this.micOn;
    if (this.deafened) this.micOn = false;
    // Join/leave alerts default on — an unattended window is exactly when you
    // want to know someone walked into your channel.
    this.joinAlerts = localStorage.getItem('pa-mb-joinalerts') !== '0';
    // Device choices are shared with zone voice: one mic, one pair of speakers.
    this.micId = localStorage.getItem('pa-zv-mic') ?? undefined;
    this.speakerId = localStorage.getItem('pa-zv-speaker') ?? undefined;
    this.loadUserVolumes();
  }

  /** False in the browser, or without WebCodecs Opus. */
  static get supported(): boolean {
    return (
      mumbleApi() !== null && typeof AudioEncoder !== 'undefined' && typeof AudioDecoder !== 'undefined'
    );
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** The activity log as it stands, for a view that is being built after some
   *  of it has already happened. Oldest first. */
  get activity(): readonly MumbleActivity[] {
    return this.activityLog;
  }

  get state(): MumbleVoiceState {
    return {
      connected: this.connected,
      connecting: this.connecting,
      micOn: this.micOn,
      deafened: this.deafened,
      micGain: this.micGain,
      micThreshold: this.micThreshold,
      master: this.master,
      channel: this.myChannel,
      registered: this.registered,
      joinAlerts: this.joinAlerts,
      host: this.host,
      error: this.error,
      notice: this.notice,
      noticeHint: this.noticeHint,
    };
  }

  // ── connection ─────────────────────────────────────────────────────────────

  autoStart(): void {
    void (async () => {
      const settings = await this.api?.getSettings().catch(() => null);
      if (settings) this.host = settings.host;
      // The toggle wins once the user has touched it; before that, the
      // "Connect on start" setting decides.
      const remembered = localStorage.getItem('pa-mb-enabled');
      const wanted = remembered !== null ? remembered === '1' : settings?.autoConnect === true;
      if (wanted && settings?.host) {
        this.enabled = true;
        await this.connect();
      } else {
        this.emitState();
      }
    })();
  }

  join(): void {
    if (this.enabled) return;
    this.enabled = true;
    localStorage.setItem('pa-mb-enabled', '1');
    void this.connect();
  }

  leave(): void {
    this.enabled = false;
    localStorage.setItem('pa-mb-enabled', '0');
    this.cancelReconnect();
    void this.disconnect();
  }

  /** Temporarily drop the connection without losing the user's intent (a
   *  conference, or zone voice taking over — you can't be in two calls). */
  suspend(reason: string): void {
    const wasEmpty = this.suspendReasons.size === 0;
    this.suspendReasons.add(reason);
    if (wasEmpty) {
      this.cancelReconnect();
      void this.disconnect();
    }
  }

  resume(reason: string): void {
    if (!this.suspendReasons.delete(reason)) return;
    if (this.suspendReasons.size === 0 && this.enabled) void this.connect();
  }

  private async connect(): Promise<void> {
    if (!this.api || !this.enabled || this.suspendReasons.size > 0) return;
    if (this.connecting || this.connected) return;
    this.connecting = true;
    this.error = undefined;
    this.emitState();
    await this.refreshHost();
    this.subscribe();
    const result = await this.api.connect().catch(() => ({ ok: false, error: 'connect failed' }));
    if (!result.ok) {
      this.connecting = false;
      this.error = result.error ?? 'connect failed';
      this.emitState();
      this.scheduleReconnect();
    }
  }

  private async disconnect(): Promise<void> {
    this.unsubscribe();
    await this.api?.disconnect().catch(() => undefined);
    this.teardownAudio();
    this.clearAlerts();
    this.connected = false;
    this.connecting = false;
    this.mySession = 0;
    this.myChannel = 0;
    this.registered = false;
    this.channels.clear();
    this.users.clear();
    this.clearPermissions();
    this.emitState();
    this.emitTree();
    this.onDevices({ mics: [], speakers: [] });
  }

  private subscribe(): void {
    if (!this.api || this.unsubEvent) return;
    this.unsubEvent = this.api.onEvent((e) => this.onEvent(e));
    this.unsubAudio = this.api.onAudio((a) => this.onAudio(a));
  }

  private unsubscribe(): void {
    this.unsubEvent?.();
    this.unsubAudio?.();
    this.unsubEvent = null;
    this.unsubAudio = null;
  }

  private async refreshHost(): Promise<void> {
    const settings = await this.api?.getSettings().catch(() => null);
    if (settings) this.host = settings.host;
  }

  private scheduleReconnect(): void {
    if (!this.enabled || this.suspendReasons.size > 0 || this.reconnectTimer !== null) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(RECONNECT_MAX_MS, this.reconnectDelay * 2);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectDelay = RECONNECT_MIN_MS;
  }

  // ── events from main ───────────────────────────────────────────────────────

  private onEvent(e: MumbleEvent): void {
    switch (e.t) {
      case 'status':
        this.onStatus(e.state, e.error);
        return;
      case 'sync': {
        this.connecting = false;
        this.connected = true;
        this.error = undefined;
        this.reconnectDelay = RECONNECT_MIN_MS;
        this.mySession = e.session;
        this.clearAlerts(); // the whole roster arrives here; that isn't news
        // Same reasoning for the log, plus one of its own: a sync is the start
        // of a session on a server, and whatever happened while we were away
        // was never observed. Carrying entries across would read as a
        // continuous record with silent holes in it.
        this.clearActivity();
        // ACLs are per server and per account, so nothing learned before this
        // sync can be trusted after it.
        this.clearPermissions();
        this.channels.clear();
        this.users.clear();
        for (const c of e.channels) this.channels.set(c.id, c);
        for (const u of e.users) this.users.set(u.session, u);
        const me = this.users.get(e.session);
        this.myChannel = me?.channel ?? 0;
        this.registered = me?.userId !== undefined;
        this.startTalkLoop();
        void this.startPlayback();
        if (this.micOn) void this.startMic();
        void this.pushSelfState();
        void this.emitDevices();
        this.emitState();
        this.emitTree();
        return;
      }
      case 'channel':
        this.channels.set(e.channel.id, e.channel);
        this.emitTree();
        return;
      case 'channelRemove':
        this.channels.delete(e.id);
        this.emitTree();
        return;
      case 'user': {
        const before = this.users.get(e.user.session);
        this.users.set(e.user.session, e.user);
        // A prior session in another channel is a move; no prior session at all
        // is an arrival. Both go in the log, as different things — including our
        // own moves, which is the only record there is of having been moved by
        // somebody else.
        const switched = before !== undefined && before.channel !== e.user.channel;
        if (e.user.session === this.mySession) {
          // We moved: everyone around us changed at once, and we already know
          // where we went — announcing that as arrivals would be noise.
          const moved = this.myChannel !== e.user.channel;
          this.myChannel = e.user.channel;
          this.registered = e.user.userId !== undefined;
          if (moved) {
            this.clearAlerts();
            // An ear in the channel we just walked into is now our own ears.
            // Leaving it would have the server route that channel's audio to us
            // twice, so take it back down.
            if (this.isListening(e.user.channel)) void this.setListening(e.user.channel, false);
          }
          this.emitState();
        } else if (before?.channel !== e.user.channel) {
          // A new session (no `before`) or a channel move. Only the two edges
          // that cross our own channel are worth a notification.
          if (e.user.channel === this.myChannel) this.queueAlert(e.user.name, true);
          else if (before && before.channel === this.myChannel) this.queueAlert(e.user.name, false);
          if (!before) this.logActivity(e.user.name, 'joined');
        }
        if (switched) this.logMove(e.user.name, before.channel, e.user.channel);
        this.emitTree();
        return;
      }
      case 'userRemove': {
        const gone = this.users.get(e.session);
        this.users.delete(e.session);
        this.dropPeer(e.session);
        if (gone && e.session !== this.mySession) {
          if (gone.channel === this.myChannel) this.queueAlert(gone.name, false);
          this.logActivity(gone.name, 'left');
        }
        this.emitTree();
        return;
      }
      case 'text':
        return; // text chat is display-only for now; nothing to surface yet
      case 'permission':
        this.notice = e.reason;
        this.emitState();
        return;
      case 'permissions':
        // Order matters: a flush and an answer can arrive in the same message,
        // and clearing after storing would drop the answer we were given.
        if (e.flush) this.clearPermissions();
        if (e.channel !== undefined && e.permissions !== undefined) {
          this.channelPerms.set(e.channel, e.permissions);
          this.permsAsked.add(e.channel);
        }
        return;
    }
  }

  private onStatus(state: 'connecting' | 'connected' | 'error' | 'closed', error?: string): void {
    if (state === 'connecting') {
      this.connecting = true;
      this.error = undefined;
    } else if (state === 'error') {
      this.error = error;
      // A refused certificate is a decision, not a fault — retrying would just
      // re-prompt in a loop, so stop and let the user press the toggle again.
      if (error === 'certificate-rejected') {
        this.error = 'certificate not trusted';
        this.enabled = false;
        localStorage.setItem('pa-mb-enabled', '0');
        this.cancelReconnect();
      }
    } else if (state === 'closed') {
      this.connected = false;
      this.connecting = false;
      this.teardownAudio();
      this.clearAlerts(); // nothing to announce about a channel we just left
      this.clearPermissions();
      this.mySession = 0;
      this.channels.clear();
      this.users.clear();
      this.emitTree();
      if (this.enabled && this.suspendReasons.size === 0) this.scheduleReconnect();
    }
    this.emitState();
  }

  // ── playback ───────────────────────────────────────────────────────────────

  /**
   * Build the output graph.
   *
   * Prefer a sinkId on the AudioContext itself and connect straight to
   * ctx.destination. The obvious-looking alternative — masterGain into a
   * MediaStreamAudioDestinationNode played through an <audio> element — is how
   * this used to work, purely so setSinkId could pick the speaker, but it hands
   * the audio to Chromium's WebRTC renderer, which owns a second playout clock
   * and time-stretches whenever it thinks it has drifted from ours. That stretch
   * is what made voices go low and slow.
   *
   * So the element path is reserved for an engine that has no sinkId on the
   * context *at all*. A setSinkId that merely rejects is a different thing and
   * must not trigger it: Chromium refuses a non-default device until microphone
   * permission has been granted, and we start playback on sync — before, or
   * racing, the mic. Falling back there would trade correct pitch for a device we
   * still can't select, since the element sink needs the very same permission.
   * We stay on ctx.destination (default device, right clock) and retry the sink.
   *
   * outCtx is published last, on purpose: onAudio() bails while it's null, so
   * nothing can build a peer before the worklet module is registered.
   */
  private async startPlayback(): Promise<void> {
    if (this.outCtx || this.startingPlayback) return;
    this.startingPlayback = true;
    try {
      const ctx = new AudioContext({ sampleRate: 48000 });
      await ctx.resume().catch(() => undefined);
      const master = ctx.createGain();
      // With no device pinned, ctx.destination already plays to the system default,
      // so the element is only ever needed to honour an explicit speaker choice on
      // an engine whose context cannot take one.
      const el = this.speakerId && !contextSinkSupported(ctx) ? new Audio() : null;
      if (el) {
        el.style.display = 'none';
        document.body.appendChild(el);
        const dest = ctx.createMediaStreamDestination();
        master.connect(dest);
        el.srcObject = dest.stream;
        await setSinkId(el, this.speakerId as string);
        void el.play().catch(() => undefined);
      } else {
        master.connect(ctx.destination);
      }
      try {
        await this.addWorklet(ctx);
      } catch (e) {
        console.warn('[mumble] playout worklet failed to load; no audio', e);
        el?.remove();
        void ctx.close().catch(() => undefined);
        return;
      }
      // We ask for 48 kHz and assume it everywhere downstream; say so once, since a
      // denied request would otherwise be an invisible cause of wrong-pitch audio.
      // The element path is the known pitch hazard, so it is a warning, not info.
      if (el) {
        console.warn(
          `[mumble] output ${ctx.sampleRate} Hz via an <audio> element — this engine takes no` +
            ' sinkId on the AudioContext, so playback runs on a second clock and pitch may drift',
        );
      } else {
        console.info(`[mumble] output ${ctx.sampleRate} Hz, sink on the context`);
      }
      this.outEl = el;
      this.masterGain = master;
      this.outCtx = ctx;
      this.applyMasterGain();
      this.sinkRetries = 0;
      this.startClockWatch(ctx);
      if (!el && this.speakerId) void this.applyContextSink();
    } finally {
      this.startingPlayback = false;
    }
  }

  /**
   * Watch the output graph's clock against wall time.
   *
   * `ctx.currentTime` advances as the device pulls the graph, so this ratio *is*
   * the playback speed: 1.0 means one second of audio rendered per second of real
   * time, and anything else shifts every voice by exactly that factor. It is the
   * one thing that separates "the graph is running slow" from "the samples we were
   * given are already stretched" — the jitter buffer reads one sample per output
   * sample, so it cannot be the cause either way, and without this number the
   * difference is invisible from the console.
   */
  private startClockWatch(ctx: AudioContext): void {
    this.stopClockWatch();
    let lastCtx = ctx.currentTime;
    let lastWall = performance.now();
    this.clockTimer = window.setInterval(() => {
      const nowCtx = ctx.currentTime;
      const nowWall = performance.now();
      const rendered = nowCtx - lastCtx;
      const elapsed = (nowWall - lastWall) / 1000;
      lastCtx = nowCtx;
      lastWall = nowWall;
      // A suspended context legitimately stops rendering; that isn't drift.
      if (elapsed <= 0 || ctx.state !== 'running') return;
      const ratio = rendered / elapsed;
      if (this.audioDebug) {
        console.info(`[mumble] output clock ${ratio.toFixed(4)}x real time`);
      }
      if (!this.warnedClock && Math.abs(ratio - 1) > CLOCK_TOLERANCE) {
        this.warnedClock = true;
        console.warn(
          `[mumble] output graph is rendering at ${ratio.toFixed(4)}x real time — every voice` +
            ` will be pitched by that factor. The output device and the ${ctx.sampleRate} Hz` +
            ' context are not agreeing on a rate.',
        );
      }
    }, CLOCK_CHECK_MS);
  }

  private stopClockWatch(): void {
    if (this.clockTimer !== null) {
      clearInterval(this.clockTimer);
      this.clockTimer = null;
    }
  }

  /**
   * Point the output context at the chosen speaker, retrying on refusal.
   *
   * Until it lands we play out of the system default, which is the right audio in
   * the right clock domain on the wrong device — strictly better than the element
   * fallback, which gets the device wrong too and warps pitch doing it.
   */
  private async applyContextSink(): Promise<void> {
    this.cancelSinkRetry();
    const ctx = this.outCtx;
    if (!ctx || this.outEl || !this.speakerId) return;
    if (await setContextSink(ctx, this.speakerId)) {
      this.sinkRetries = 0;
      return;
    }
    if (this.sinkRetries >= SINK_RETRY_MAX) {
      console.warn('[mumble] could not select the chosen speaker; using the system default');
      return;
    }
    this.sinkRetries++;
    this.sinkRetryTimer = window.setTimeout(() => {
      this.sinkRetryTimer = null;
      void this.applyContextSink();
    }, SINK_RETRY_MS);
  }

  private cancelSinkRetry(): void {
    if (this.sinkRetryTimer !== null) {
      clearTimeout(this.sinkRetryTimer);
      this.sinkRetryTimer = null;
    }
  }

  /** Register the shared worklet module on a context, at most once each. */
  private async addWorklet(ctx: BaseAudioContext): Promise<void> {
    if (this.workletReady.has(ctx)) return;
    if (!this.workletUrl) {
      this.workletUrl = URL.createObjectURL(new Blob([VOICE_WORKLET], { type: 'application/javascript' }));
    }
    await ctx.audioWorklet.addModule(this.workletUrl);
    this.workletReady.add(ctx);
  }

  private onAudio(a: MumbleAudioIn): void {
    const ctx = this.outCtx;
    if (!ctx || !this.masterGain) return;
    // Structured clone should preserve the typed array; if a future Electron
    // ever degrades it we would go silent, so say so once rather than guessing.
    if (!(a.opus instanceof Uint8Array)) {
      console.warn('[mumble] audio payload arrived without its typed-array shape; dropping');
      return;
    }
    const peer = this.ensurePeer(a.session);
    if (!peer) return;
    if (a.opus.length > 0) {
      peer.talkingUntil = performance.now() + TALK_HOLD_MS;
      // Sequence numbers count 10 ms units, so they jump by the frame size rather
      // than by 1, and reset on each spurt. Only a gap inside a spurt is loss.
      const expected = peer.lastSeq + opusDurationUs(a.opus) / 10_000;
      if (peer.lastSeq >= 0 && a.sequence > expected) peer.lost += a.sequence - expected;
      peer.lastSeq = a.sequence;
      try {
        peer.decoder.decode(
          new EncodedAudioChunk({ type: 'key', timestamp: peer.tsUs, data: a.opus }),
        );
        // Read the real duration off the packet rather than assuming the 20 ms we
        // happen to transmit: official Mumble also sends 10/40/60 ms.
        peer.tsUs += opusDurationUs(a.opus);
      } catch {
        // A codec that has given up throws on every future packet, so rebuild it
        // rather than leaving this user silent for the rest of the call.
        if (peer.decoder.state !== 'configured') this.dropPeer(a.session);
      }
    }
    // Official Mumble sets the terminator on the last frame that still carries
    // audio, while our own endSpurt() sends it on an empty payload. Handling it
    // after the decode above covers both; returning early on it, as this used to,
    // clipped the final syllable off every phrase from an official client.
    if (a.terminator) {
      peer.talkingUntil = 0;
      peer.lastSeq = -1; // the next spurt restarts numbering
    }
  }

  private ensurePeer(session: number): PeerAudio | null {
    const ctx = this.outCtx;
    if (!ctx || !this.masterGain) return null;
    const existing = this.peers.get(session);
    if (existing) {
      if (existing.decoder.state === 'configured') return existing;
      this.dropPeer(session); // errored out; fall through and build a fresh one
    }
    const gain = ctx.createGain();
    let playout: AudioWorkletNode;
    try {
      playout = new AudioWorkletNode(ctx, 'pa-voice-playout', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: {
          capacity: Math.round(JITTER_CAP_S * ctx.sampleRate),
          target: Math.round(JITTER_S * ctx.sampleRate),
          max: Math.round(JITTER_MAX_S * ctx.sampleRate),
        },
      });
    } catch {
      gain.disconnect();
      return null;
    }
    playout.connect(gain);
    gain.connect(this.masterGain);
    const peer: PeerAudio = {
      decoder: null as unknown as AudioDecoder,
      playout,
      gain,
      tsUs: 0,
      talkingUntil: 0,
      lastSeq: -1,
      lost: 0,
      pushed: 0,
      rateAt: performance.now(),
      ratePushed: 0,
      inRate: 0,
      outRate: 0,
    };
    peer.decoder = new AudioDecoder({
      output: (data) => this.playChunk(peer, data),
      // ensurePeer rebuilds the peer once the state check sees this, so a bad
      // stream costs one talk spurt instead of the whole call.
      error: () => this.dropPeer(session),
    });
    try {
      peer.decoder.configure({
        codec: 'opus',
        numberOfChannels: 1,
        sampleRate: 48000,
        description: OPUS_HEAD,
      });
    } catch {
      playout.disconnect();
      gain.disconnect();
      return null;
    }
    if (this.audioDebug) {
      playout.port.onmessage = (ev: MessageEvent<PlayoutStats>) => {
        const name = this.users.get(session)?.name ?? session;
        const ms = (n: number) => Math.round((n / ctx.sampleRate) * 1000);
        // Rate over at least a second — the worklet reports far more often than
        // that, and a quarter-second window is mostly packet jitter.
        const now = performance.now();
        const dt = (now - peer.rateAt) / 1000;
        if (dt >= 1) {
          peer.inRate = (peer.pushed - peer.ratePushed) / dt;
          peer.rateAt = now;
          peer.ratePushed = peer.pushed;
        }
        // depth should hover near JITTER_S and come back to it after a stall.
        // Steadily climbing depth, or dropped climbing without lost, means the
        // sender is outrunning us; lost without dropped means the network is.
        // `in` is decoded samples per second while they are talking: it should sit
        // at the context rate, and a lasting gap between the two is a rate
        // disagreement with the sender rather than anything the buffer can fix.
        console.info(
          `[mumble] ${name}: depth ${ms(ev.data.depth)}ms, underruns ${ev.data.underruns},` +
            ` dropped ${ms(ev.data.dropped)}ms, lost ${Math.round(peer.lost * 10)}ms,` +
            ` in ${Math.round(peer.inRate)} Hz of ${ctx.sampleRate}, decoder ${peer.outRate} Hz`,
        );
      };
    }
    this.peers.set(session, peer);
    this.applyPeerGain(session);
    return peer;
  }

  private playChunk(peer: PeerAudio, data: AudioData): void {
    const ctx = this.outCtx;
    if (!ctx) {
      data.close();
      return;
    }
    const rate = data.sampleRate;
    peer.outRate = rate;
    if (data.numberOfChannels !== 1 && !this.warnedChannels) {
      this.warnedChannels = true;
      console.warn(`[mumble] decoder produced ${data.numberOfChannels} channels; using the first`);
    }
    let samples = new Float32Array(data.numberOfFrames);
    try {
      data.copyTo(samples, { planeIndex: 0, format: 'f32-planar' });
    } catch {
      data.close();
      return;
    }
    data.close();
    // The ring buffer is read one sample per output sample, so unlike an
    // AudioBufferSourceNode it does no resampling of its own. Rates should always
    // match — we pin both — but a mismatch here is exactly the wrong-pitch bug,
    // so convert rather than let it through silently.
    if (rate !== ctx.sampleRate) {
      if (!this.warnedRate) {
        this.warnedRate = true;
        console.warn(`[mumble] decoded ${rate} Hz into a ${ctx.sampleRate} Hz context; resampling`);
      }
      samples = resampleLinear(samples, rate, ctx.sampleRate);
    }
    peer.pushed += samples.length;
    peer.playout.port.postMessage(samples, [samples.buffer]);
  }

  private dropPeer(session: number): void {
    const peer = this.peers.get(session);
    if (!peer) return;
    this.peers.delete(session);
    try {
      if (peer.decoder.state !== 'closed') peer.decoder.close();
      peer.playout.port.onmessage = null;
      peer.playout.disconnect();
      peer.gain.disconnect();
    } catch {
      /* best-effort teardown */
    }
  }

  // ── capture ────────────────────────────────────────────────────────────────

  private async startMic(): Promise<void> {
    if (this.mic || this.startingMic || !this.connected) return;
    this.startingMic = true;
    try {
      const mic = await MicGraph.start({
        deviceId: this.micId,
        gain: this.micGain,
        threshold: this.micThreshold,
        onLevel: (l) => this.onMicLevel(l),
        onGate: (open) => {
          if (!open) this.endSpurt();
        },
      });
      this.mic = mic;
      await this.addWorklet(mic.ctx);
      const node = new AudioWorkletNode(mic.ctx, 'pa-mic-capture', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      node.port.onmessage = (ev: MessageEvent<Float32Array>) => this.onCaptureBlock(ev.data);
      // A worklet whose output goes nowhere is not reliably pulled by every
      // engine; route it to a silent sink so the graph always runs.
      const sink = mic.ctx.createGain();
      sink.gain.value = 0;
      mic.out.connect(node);
      node.connect(sink);
      sink.connect(mic.ctx.destination);
      this.capture = node;
      this.captureSink = sink;
      this.startEncoder();
      // getUserMedia just granted microphone permission, which is also what
      // Chromium gates a non-default output sink on — so a speaker choice that was
      // refused when playback started can be applied now.
      this.sinkRetries = 0;
      void this.applyContextSink();
      await this.emitDevices();
    } catch (e) {
      this.stopMic();
      this.error = `mic unavailable: ${(e as Error)?.message ?? e}`;
      this.emitState();
    } finally {
      this.startingMic = false;
    }
  }

  private startEncoder(): void {
    const encoder = new AudioEncoder({
      output: (chunk) => this.onEncoded(chunk),
      error: () => {
        /* the encoder is finished; toggling the mic rebuilds it */
      },
    });
    const base: AudioEncoderConfig = {
      codec: 'opus',
      sampleRate: 48000,
      numberOfChannels: 1,
      bitrate: OPUS_BITRATE,
    };
    try {
      encoder.configure({ ...base, opus: { frameDuration: FRAME_US } });
    } catch {
      encoder.configure(base); // engine without the opus-specific block
    }
    this.encoder = encoder;
    this.micTsUs = 0;
  }

  private onCaptureBlock(block: Float32Array): void {
    if (!this.encoder || !this.mic) return;
    let offset = 0;
    while (offset < block.length) {
      const take = Math.min(FRAME_SAMPLES - this.pendingLen, block.length - offset);
      this.pending.set(block.subarray(offset, offset + take), this.pendingLen);
      this.pendingLen += take;
      offset += take;
      if (this.pendingLen < FRAME_SAMPLES) return;
      this.pendingLen = 0;
      if (!this.micOn || !this.mic.open) continue; // gate closed: don't transmit
      this.spurtOpen = true;
      const data = new AudioData({
        format: 'f32-planar',
        sampleRate: 48000,
        numberOfFrames: FRAME_SAMPLES,
        numberOfChannels: 1,
        timestamp: this.micTsUs,
        data: this.pending,
      });
      this.micTsUs += FRAME_US;
      try {
        this.encoder.encode(data);
      } catch {
        /* encoder closed underneath us */
      }
      data.close();
    }
  }

  private onEncoded(chunk: EncodedAudioChunk): void {
    if (!this.api || chunk.byteLength > MAX_OPUS_BYTES) return;
    const frame = new Uint8Array(1 + chunk.byteLength);
    frame[0] = 0;
    chunk.copyTo(frame.subarray(1));
    this.api.sendAudio(frame);
  }

  /** Tell the server the talk spurt ended, so listeners release the stream
   *  instead of waiting on one that simply stopped. Flush first: encoder output
   *  is asynchronous, and a terminator that overtakes the last frame would cut
   *  the final word off for everyone else. */
  private endSpurt(): void {
    if (!this.spurtOpen || !this.api) return;
    this.spurtOpen = false;
    const api = this.api;
    const encoder = this.encoder;
    // The encoder stays alive across spurts — flush only waits for its pending
    // output, it doesn't close it. stopMic() chains onto this promise so it
    // never closes the encoder out from under a flush in flight.
    this.encoderFlush = (encoder?.state === 'configured' ? encoder.flush() : Promise.resolve())
      .catch(() => undefined)
      .then(() => {
        api.sendAudio(Uint8Array.of(1));
      });
  }

  private stopMic(): void {
    this.endSpurt();
    if (this.capture) {
      this.capture.port.onmessage = null;
      try {
        this.capture.disconnect();
        this.captureSink?.disconnect();
      } catch {
        /* best-effort teardown */
      }
    }
    this.capture = null;
    this.captureSink = null;
    const encoder = this.encoder;
    this.encoder = null;
    if (encoder) {
      void this.encoderFlush.then(() => {
        try {
          if (encoder.state !== 'closed') encoder.close();
        } catch {
          /* already gone */
        }
      });
    }
    this.pendingLen = 0;
    this.mic?.stop();
    this.mic = null;
    this.onMicLevel(0);
  }

  private teardownAudio(): void {
    this.stopMic();
    this.stopTalkLoop();
    this.cancelSinkRetry();
    this.stopClockWatch();
    for (const session of [...this.peers.keys()]) this.dropPeer(session);
    this.outEl?.pause();
    if (this.outEl) {
      this.outEl.srcObject = null;
      this.outEl.remove();
    }
    this.outEl = null;
    this.masterGain = null;
    void this.outCtx?.close().catch(() => undefined);
    this.outCtx = null;
    // Both contexts are gone, so the shared module blob can go too; startPlayback
    // and startMic recreate it on demand.
    if (this.workletUrl) {
      URL.revokeObjectURL(this.workletUrl);
      this.workletUrl = null;
    }
  }

  // ── controls ───────────────────────────────────────────────────────────────

  /**
   * Mic and sound are coupled the way Mumble itself couples them: self-deaf
   * implies self-mute on the server, so a "deafened but transmitting" client is
   * a state that cannot exist. Turning the mic on therefore lifts the deafen
   * rather than asking for something the server will refuse.
   */
  toggleMic(): void {
    const on = !this.micOn;
    if (on) this.setDeafened(false);
    this.setMicOn(on);
    void this.pushSelfState();
    this.emitState();
  }

  /** Deafening mutes the mic; un-deafening restores whatever it was before, so
   *  a mic you had deliberately muted stays muted. */
  toggleDeafen(): void {
    if (this.deafened) {
      this.setDeafened(false);
      this.setMicOn(this.micOnBeforeDeafen);
    } else {
      this.micOnBeforeDeafen = this.micOn;
      this.setDeafened(true);
      this.setMicOn(false);
    }
    void this.pushSelfState();
    this.emitState();
  }

  private setMicOn(on: boolean): void {
    if (this.micOn === on) return;
    this.micOn = on;
    localStorage.setItem('pa-mb-micon', on ? '1' : '0');
    if (on) void this.startMic();
    else this.stopMic();
  }

  private setDeafened(deafened: boolean): void {
    if (this.deafened === deafened) return;
    this.deafened = deafened;
    localStorage.setItem('pa-mb-deaf', deafened ? '1' : '0');
    this.applyMasterGain();
  }

  joinChannel(id: number): void {
    void this.api?.joinChannel(id).catch(() => undefined);
  }

  // ── permissions, moving people, and ears ───────────────────────────────────

  /**
   * Ask the server what we may do in a channel, at most once per answer.
   *
   * There is no push for this in the protocol: permissions arrive only when
   * asked for, or as a blanket "everything you know is stale" flush. The tree
   * calls this as it draws each channel row, which asks once per channel per
   * session and re-asks by itself after a flush — cheap next to querying the
   * whole tree up front on a server with hundreds of channels.
   */
  requestPermissions(id: number): void {
    if (!this.connected || this.permsAsked.has(id)) return;
    this.permsAsked.add(id);
    void this.api?.queryPermissions(id).catch(() => undefined);
  }

  /**
   * Whether one ACL bit is granted in a channel.
   *
   * Write is Murmur's blanket grant — an admin who holds it holds everything —
   * so it counts for any bit, mirroring the server's own check. Unknown is
   * false: better a control that appears a round-trip late than one that is
   * there and refused. The server stays the authority either way; a refusal
   * comes back as a PermissionDenied and lands in `notice`.
   */
  private allowed(id: number, bit: number): boolean {
    const perms = this.channelPerms.get(id);
    return perms !== undefined && (perms & (bit | MUMBLE_PERM.write)) !== 0;
  }

  /** May we place an ear in this channel? Never in our own — we are already
   *  listening to that one, and a second copy of its audio is all it would
   *  buy. */
  canListen(id: number): boolean {
    return id !== this.myChannel && this.allowed(id, MUMBLE_PERM.listen);
  }

  /** May we move somebody into this channel? Murmur checks the destination,
   *  not where they are now. */
  canMoveInto(id: number): boolean {
    return this.allowed(id, MUMBLE_PERM.move);
  }

  /** Whether to offer moving anyone at all — true as soon as there is one
   *  channel we could move them to. */
  canMoveAnyone(): boolean {
    for (const id of this.channels.keys()) if (this.canMoveInto(id)) return true;
    return false;
  }

  /** Channels we have an ear in. Read from the roster rather than tracked
   *  separately: the server is what decides whether an ear was accepted. */
  isListening(id: number): boolean {
    return this.users.get(this.mySession)?.listening.includes(id) === true;
  }

  /** Place or take back an ear. A no-op where we may not listen, so a stale
   *  view cannot ask for something the server would refuse. */
  toggleListen(id: number): void {
    if (!this.connected) return;
    const on = this.isListening(id);
    if (!on && !this.canListen(id)) return;
    this.clearNotice();
    void this.setListening(id, !on);
  }

  private async setListening(id: number, listening: boolean): Promise<void> {
    await this.api?.setListening(id, listening).catch(() => undefined);
  }

  /** Move somebody else into a channel. Ours is only the affordance — the
   *  server decides, and says so on the `permission` event. */
  moveUser(session: number, channelId: number): void {
    if (!this.connected || session === this.mySession) return;
    this.clearNotice();
    void this.api?.moveUser(session, channelId).catch(() => undefined);
  }

  /** Drop a stale refusal, and the advice that went with it, before asking for
   *  something new — so the note under the panel always belongs to the last
   *  thing that was tried. */
  private clearNotice(): void {
    if (this.notice === undefined && this.noticeHint === undefined) return;
    this.notice = undefined;
    this.noticeHint = undefined;
    this.emitState();
  }

  private clearPermissions(): void {
    this.channelPerms.clear();
    this.permsAsked.clear();
  }

  selfRegister(): void {
    this.clearNotice();
    this.noticeHint = 'ask a server admin to register your certificate';
    void this.api?.selfRegister().catch(() => undefined);
  }

  setMaster(v: number): void {
    this.master = clampVol(v);
    localStorage.setItem('pa-mb-master', String(this.master));
    this.applyMasterGain();
    this.emitState();
  }

  setMicSensitivity(v: number): void {
    this.micGain = clampMicGain(v);
    localStorage.setItem('pa-mb-micgain', String(this.micGain));
    this.mic?.setGain(this.micGain);
    this.emitState();
  }

  setMicThreshold(v: number): void {
    this.micThreshold = clamp01(v);
    localStorage.setItem('pa-mb-micthresh', String(this.micThreshold));
    this.mic?.setThreshold(this.micThreshold);
    this.emitState();
  }

  setJoinAlerts(on: boolean): void {
    this.joinAlerts = on;
    localStorage.setItem('pa-mb-joinalerts', on ? '1' : '0');
    if (!on) this.clearAlerts();
    this.emitState();
  }

  setUserVolume(name: string, v: number): void {
    this.userVolumes.set(name, clampVol(v));
    this.persistUserVolumes();
    this.applyAllPeerGains();
    this.emitTree();
  }

  getUserVolume(name: string): number {
    return this.userVolumes.get(name) ?? 1;
  }

  setUserMuted(name: string, muted: boolean): void {
    if (muted) this.userMuted.add(name);
    else this.userMuted.delete(name);
    this.applyAllPeerGains();
    this.emitTree();
  }

  isUserMuted(name: string): boolean {
    return this.userMuted.has(name);
  }

  async switchMic(deviceId: string): Promise<void> {
    this.micId = deviceId;
    localStorage.setItem('pa-zv-mic', deviceId);
    await this.mic?.switchDevice(deviceId);
    await this.emitDevices();
  }

  async switchSpeaker(deviceId: string): Promise<void> {
    this.speakerId = deviceId;
    localStorage.setItem('pa-zv-speaker', deviceId);
    // outEl is only set on the fallback path; normally the sink lives on the context.
    if (this.outEl) await setSinkId(this.outEl, deviceId);
    else {
      this.sinkRetries = 0;
      await this.applyContextSink();
    }
    await this.emitDevices();
  }

  /** Reconnect so changed settings (host, name, identity) take effect. */
  async reconnect(): Promise<void> {
    if (!this.enabled) {
      await this.refreshHost();
      this.emitState();
      return;
    }
    await this.disconnect();
    this.cancelReconnect();
    await this.connect();
  }

  private async pushSelfState(): Promise<void> {
    if (!this.connected) return;
    await this.api?.selfState({ selfMute: !this.micOn, selfDeaf: this.deafened }).catch(() => undefined);
  }

  private applyMasterGain(): void {
    if (this.masterGain) this.masterGain.gain.value = this.deafened ? 0 : this.master;
  }

  private applyPeerGain(session: number): void {
    const peer = this.peers.get(session);
    if (!peer) return;
    const name = this.users.get(session)?.name ?? '';
    peer.gain.gain.value = this.userMuted.has(name) ? 0 : (this.userVolumes.get(name) ?? 1);
  }

  private applyAllPeerGains(): void {
    for (const session of this.peers.keys()) this.applyPeerGain(session);
  }

  private loadUserVolumes(): void {
    try {
      const raw = localStorage.getItem('pa-mb-uservol');
      if (!raw) return;
      const obj = JSON.parse(raw) as Record<string, unknown>;
      for (const [k, v] of Object.entries(obj)) if (typeof v === 'number') this.userVolumes.set(k, clampVol(v));
    } catch {
      /* corrupt / unavailable — start fresh */
    }
  }

  private persistUserVolumes(): void {
    try {
      localStorage.setItem('pa-mb-uservol', JSON.stringify(Object.fromEntries(this.userVolumes)));
    } catch {
      /* localStorage unavailable */
    }
  }

  private startTalkLoop(): void {
    if (this.talkTimer !== null) return;
    this.talkTimer = window.setInterval(() => this.emitTree(), TALK_TICK_MS);
  }

  private stopTalkLoop(): void {
    if (this.talkTimer !== null) {
      clearInterval(this.talkTimer);
      this.talkTimer = null;
    }
  }

  // ── channel join/leave alerts ──────────────────────────────────────────────

  /** Remember one arrival/departure in our channel; the timer does the telling. */
  private queueAlert(name: string, joined: boolean): void {
    if (!this.joinAlerts) return;
    this.alerts.push({ name: name || 'Someone', joined });
    if (this.alertTimer !== null) return;
    this.alertTimer = window.setTimeout(() => {
      this.alertTimer = null;
      this.flushAlerts();
    }, ALERT_COALESCE_MS);
  }

  private flushAlerts(): void {
    const moves = this.alerts.splice(0);
    if (moves.length === 0 || !this.joinAlerts || !this.connected) return;
    const channel = this.channels.get(this.myChannel)?.name;
    const title = channel ? `Mumble · ${channel}` : 'Mumble';
    if (moves.length <= ALERT_MAX_NAMES) {
      notifyDesktop(title, moves.map((m) => `${m.name} ${m.joined ? 'joined' : 'left'}`).join('\n'));
      return;
    }
    const joined = moves.filter((m) => m.joined).length;
    const parts: string[] = [];
    if (joined > 0) parts.push(`${joined} joined`);
    if (moves.length - joined > 0) parts.push(`${moves.length - joined} left`);
    notifyDesktop(title, parts.join(', '));
  }

  private clearAlerts(): void {
    this.alerts.length = 0;
    if (this.alertTimer !== null) {
      clearTimeout(this.alertTimer);
      this.alertTimer = null;
    }
  }

  // ── server activity log ────────────────────────────────────────────────────

  /** Record one arrival/departure/move. Gated on `connected` so a stray event
   *  before sync cannot enter the whole roster as arrivals. */
  private logActivity(name: string, kind: MumbleActivityKind, from?: string, to?: string): void {
    if (!this.connected) return;
    this.activityLog.push({
      seq: ++this.activitySeq,
      ts: Date.now(),
      name: name || 'Someone',
      kind,
      from,
      to,
    });
    if (this.activityLog.length > MAX_ACTIVITY) {
      this.activityLog.splice(0, this.activityLog.length - MAX_ACTIVITY);
    }
    this.onActivity(this.activityLog);
  }

  /** A channel move, resolved to channel *names* here rather than kept as ids:
   *  see MumbleActivity.from — by the time anyone reads this line, the ids may
   *  name something else or nothing. */
  private logMove(name: string, from: number, to: number): void {
    this.logActivity(name, 'moved', this.channelName(from), this.channelName(to));
  }

  private channelName(id: number): string {
    return this.channels.get(id)?.name ?? `channel ${id}`;
  }

  private clearActivity(): void {
    // The counter restarts with the log, which is what lets a view notice a
    // sync happened: the newest seq it can see went backwards.
    this.activitySeq = 0;
    if (this.activityLog.length === 0) return;
    this.activityLog.length = 0;
    this.onActivity(this.activityLog);
  }

  private async emitDevices(): Promise<void> {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      this.onDevices({
        mics: devices.filter((d) => d.kind === 'audioinput'),
        speakers: devices.filter((d) => d.kind === 'audiooutput'),
        micId: this.micId,
        speakerId: this.speakerId,
      });
    } catch {
      /* enumeration failed — leave the pickers as they are */
    }
  }

  private emitState(): void {
    this.onState(this.state);
  }

  private emitTree(): void {
    const now = performance.now();
    const talking = new Set<number>();
    for (const [session, peer] of this.peers) if (peer.talkingUntil > now) talking.add(session);
    if (this.micOn && this.mic?.open) talking.add(this.mySession);
    this.onTree({
      channels: [...this.channels.values()],
      users: [...this.users.values()],
      talking,
      me: this.mySession,
    });
  }
}

/**
 * Both worklet processors, in one module so a context needs a single addModule.
 *
 * pa-mic-capture posts each 128-sample render quantum to the main thread, where
 * frames are assembled into the 20 ms buffers the encoder wants.
 *
 * pa-voice-playout is the receive jitter buffer: one per remote user, fed decoded
 * PCM from the main thread. It exists because scheduling each decoded frame as its
 * own AudioBufferSourceNode gave us no way to bound or drain the buffer — depth
 * only ever grew. A ring buffer read at exactly one sample per output sample keeps
 * playback at the true rate no matter how packets arrive: it emits silence when
 * starved and discards the oldest audio when overfull, but never stretches or
 * resamples, which is what made voices drift low and slow.
 */
const VOICE_WORKLET = `
class PaMicCapture extends AudioWorkletProcessor {
  process(inputs) {
    const c = inputs[0] && inputs[0][0];
    if (c) this.port.postMessage(new Float32Array(c));
    return true;
  }
}
registerProcessor('pa-mic-capture', PaMicCapture);

class PaVoicePlayout extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.ring = new Float32Array(o.capacity);
    this.target = o.target;
    this.max = o.max;
    this.read = 0;
    this.write = 0;
    this.depth = 0;
    // Output stays silent until the ring first reaches target depth, so a talk
    // spurt doesn't begin by immediately starving.
    this.primed = false;
    this.underruns = 0;
    this.dropped = 0;
    this.ticks = 0;
    this.port.onmessage = (e) => this.push(e.data);
  }

  /** Discard the n oldest samples. Bounded latency beats complete audio. */
  drop(n) {
    if (n > this.depth) n = this.depth;
    if (n <= 0) return;
    this.read = (this.read + n) % this.ring.length;
    this.depth -= n;
    this.dropped += n;
  }

  push(samples) {
    const cap = this.ring.length;
    const n = samples.length;
    if (n <= 0 || n > cap) return;
    // Trim back to target first, so the write below can never outrun the ring.
    if (this.depth + n > this.max) this.drop(this.depth + n - this.target);
    for (let i = 0; i < n; i++) {
      this.ring[this.write] = samples[i];
      this.write = this.write + 1 === cap ? 0 : this.write + 1;
    }
    this.depth += n;
  }

  process(_inputs, outputs) {
    const out = outputs[0] && outputs[0][0];
    if (!out) return true;
    const n = out.length;
    const cap = this.ring.length;
    if (!this.primed) {
      if (this.depth >= this.target) this.primed = true;
      else return this.silence(out);
    }
    if (this.depth < n) {
      this.underruns++;
      // Re-prime rather than dribbling out one quantum per arriving packet.
      this.primed = false;
      return this.silence(out);
    }
    for (let i = 0; i < n; i++) {
      out[i] = this.ring[this.read];
      this.read = this.read + 1 === cap ? 0 : this.read + 1;
    }
    this.depth -= n;
    return this.report();
  }

  silence(out) {
    out.fill(0);
    return this.report();
  }

  report() {
    // ~100 quanta is ~270 ms at 48 kHz: often enough to watch depth move,
    // rare enough to not matter.
    if (++this.ticks >= 100) {
      this.ticks = 0;
      this.port.postMessage({ depth: this.depth, underruns: this.underruns, dropped: this.dropped });
    }
    return true;
  }
}
registerProcessor('pa-voice-playout', PaVoicePlayout);
`;

function buildOpusHead(): Uint8Array {
  const head = new Uint8Array(19);
  head.set(new TextEncoder().encode('OpusHead'), 0);
  const view = new DataView(head.buffer);
  view.setUint8(8, 1); // version
  view.setUint8(9, 1); // channel count
  // Pre-skip 0: we don't author these streams, so there is no encoder delay for us
  // to declare, and anything non-zero makes the decoder silently discard that much
  // audio from the start of every stream.
  view.setUint16(10, 0, true); // pre-skip
  view.setUint32(12, 48000, true); // original sample rate
  view.setInt16(16, 0, true); // output gain
  view.setUint8(18, 0); // channel mapping family
  return head;
}

async function setSinkId(el: HTMLMediaElement, deviceId: string): Promise<void> {
  const sinkable = el as HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> };
  if (typeof sinkable.setSinkId === 'function') await sinkable.setSinkId(deviceId).catch(() => undefined);
}

interface SinkableContext extends AudioContext {
  setSinkId?: (id: string) => Promise<void>;
}

/**
 * Whether this engine can pick an output device on the context at all — which is
 * a different question from whether a given call succeeds, and the only one that
 * justifies the <audio> element fallback and the extra playout clock it drags in.
 */
function contextSinkSupported(ctx: AudioContext): boolean {
  return typeof (ctx as SinkableContext).setSinkId === 'function';
}

/** Point a context at an output device. False if the engine can't, or refuses —
 *  Chromium does until microphone permission exists, so callers retry. */
async function setContextSink(ctx: AudioContext, deviceId: string): Promise<boolean> {
  const sinkable = ctx as SinkableContext;
  if (typeof sinkable.setSinkId !== 'function') return false;
  try {
    await sinkable.setSinkId(deviceId);
    return true;
  } catch {
    return false;
  }
}

/** Depth/underrun/drop counters the playout worklet reports back, in samples. */
interface PlayoutStats {
  depth: number;
  underruns: number;
  dropped: number;
}

/** Frame duration in microseconds for each of the 32 Opus TOC configurations. */
const OPUS_CONFIG_US = [
  // SILK NB / MB / WB: 10, 20, 40, 60 ms
  10000, 20000, 40000, 60000, 10000, 20000, 40000, 60000, 10000, 20000, 40000, 60000,
  // Hybrid SWB / FB: 10, 20 ms
  10000, 20000, 10000, 20000,
  // CELT NB / WB / SWB / FB: 2.5, 5, 10, 20 ms
  2500, 5000, 10000, 20000, 2500, 5000, 10000, 20000, 2500, 5000, 10000, 20000, 2500, 5000,
  10000, 20000,
];

/**
 * Duration of an Opus packet, read from its TOC byte (RFC 6716 §3.1). Mumble
 * doesn't tell us the frame size, and it varies by client and by bitrate, so the
 * packet itself is the only honest source. Falls back to our own 20 ms on anything
 * malformed — the decoder will reject such a packet anyway.
 */
function opusDurationUs(packet: Uint8Array): number {
  if (packet.length < 1) return FRAME_US;
  const toc = packet[0];
  const perFrame = OPUS_CONFIG_US[toc >> 3];
  switch (toc & 3) {
    case 0:
      return perFrame; // one frame
    case 1:
    case 2:
      return perFrame * 2; // two frames, equal or variable length
    default: {
      if (packet.length < 2) return FRAME_US;
      const count = packet[1] & 0x3f; // arbitrary frame count
      return count > 0 ? perFrame * count : FRAME_US;
    }
  }
}

/**
 * Linear resample. Only reached if the decoder and the output context disagree on
 * rate, which shouldn't happen since we pin both to 48 kHz — quality matters less
 * here than not shifting pitch.
 */
function resampleLinear(
  src: Float32Array,
  from: number,
  to: number,
): Float32Array<ArrayBuffer> {
  const ratio = to / from;
  const out = new Float32Array(Math.max(1, Math.round(src.length * ratio)));
  const last = src.length - 1;
  for (let i = 0; i < out.length; i++) {
    const pos = i / ratio;
    const j = Math.min(last, Math.floor(pos));
    const next = Math.min(last, j + 1);
    out[i] = src[j] + (src[next] - src[j]) * (pos - j);
  }
  return out;
}

/**
 * Stored input gain, with a one-time lift for settings saved under the old 2x
 * ceiling. Everyone on that ceiling was inaudibly quiet next to the official
 * Mumble client, so raise them to the new default once — never lower, so a
 * deliberately high setting is kept, and the flag stops us touching it again.
 */
function readMicGain(): number {
  const stored = localStorage.getItem('pa-mb-micgain');
  if (stored === null) return DEFAULT_MIC_GAIN;
  const value = Number(stored);
  if (localStorage.getItem('pa-mb-gain-v2') === '1') return value;
  const lifted = Number.isFinite(value) ? Math.max(value, DEFAULT_MIC_GAIN) : DEFAULT_MIC_GAIN;
  try {
    localStorage.setItem('pa-mb-gain-v2', '1');
    localStorage.setItem('pa-mb-micgain', String(lifted));
  } catch {
    /* localStorage unavailable — the lift just repeats next launch */
  }
  return lifted;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

function clampVol(v: number): number {
  if (!Number.isFinite(v)) return 1;
  return Math.max(0, Math.min(2, v));
}
