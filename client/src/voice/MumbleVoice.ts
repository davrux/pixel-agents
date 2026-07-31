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
/** Default input gain. Unity is far too quiet next to the official Mumble
 *  client, whose own amplification defaults well above 1x — a browser mic
 *  captured with AGC off simply arrives quieter than Mumble's. */
const DEFAULT_MIC_GAIN = 4;

/** Opus identification header. Chrome tolerates omitting it; some engines don't. */
const OPUS_HEAD = buildOpusHead();

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

  private mySession = 0;
  private myChannel = 0;
  private registered = false;
  private readonly channels = new Map<number, MumbleChannelInfo>();
  private readonly users = new Map<number, MumbleUserInfo>();
  /** Per-user volume + mute, keyed by display name so it survives reconnects. */
  private readonly userVolumes = new Map<string, number>();
  private readonly userMuted = new Set<string>();

  private unsubEvent: (() => void) | null = null;
  private unsubAudio: (() => void) | null = null;
  private reconnectTimer: number | null = null;
  private reconnectDelay = RECONNECT_MIN_MS;
  private talkTimer: number | null = null;

  /** Pending channel join/leave moves, flushed as one OS notification. */
  private readonly alerts: { name: string; joined: boolean }[] = [];
  private alertTimer: number | null = null;

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
        if (e.user.session === this.mySession) {
          // We moved: everyone around us changed at once, and we already know
          // where we went — announcing that as arrivals would be noise.
          const moved = this.myChannel !== e.user.channel;
          this.myChannel = e.user.channel;
          this.registered = e.user.userId !== undefined;
          if (moved) this.clearAlerts();
          this.emitState();
        } else if (before?.channel !== e.user.channel) {
          // A new session (no `before`) or a channel move. Only the two edges
          // that cross our own channel are worth a notification.
          if (e.user.channel === this.myChannel) this.queueAlert(e.user.name, true);
          else if (before && before.channel === this.myChannel) this.queueAlert(e.user.name, false);
        }
        this.emitTree();
        return;
      }
      case 'userRemove': {
        const gone = this.users.get(e.session);
        this.users.delete(e.session);
        this.dropPeer(e.session);
        if (gone && gone.channel === this.myChannel && e.session !== this.mySession) {
          this.queueAlert(gone.name, false);
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
   * is what made voices go low and slow, so we only take that path on an engine
   * that can't set a sink on the context.
   *
   * outCtx is published last, on purpose: onAudio() bails while it's null, so
   * nothing can build a peer before the worklet module is registered.
   */
  private async startPlayback(): Promise<void> {
    if (this.outCtx) return;
    const ctx = new AudioContext({ sampleRate: 48000 });
    // With no device pinned, ctx.destination already plays to the system default,
    // so the element is only ever needed to honour an explicit speaker choice that
    // the context itself won't take.
    let el: HTMLAudioElement | null = null;
    if (this.speakerId && !(await setContextSink(ctx, this.speakerId))) {
      el = new Audio();
      el.style.display = 'none';
      document.body.appendChild(el);
    }
    await ctx.resume().catch(() => undefined);
    const master = ctx.createGain();
    if (el) {
      const dest = ctx.createMediaStreamDestination();
      master.connect(dest);
      el.srcObject = dest.stream;
      if (this.speakerId) await setSinkId(el, this.speakerId);
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
    console.info(
      `[mumble] output ${ctx.sampleRate} Hz, sink via ${el ? 'element (fallback)' : 'context'}`,
    );
    this.outEl = el;
    this.masterGain = master;
    this.outCtx = ctx;
    this.applyMasterGain();
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
        // depth should hover near JITTER_S and come back to it after a stall.
        // Steadily climbing depth, or dropped climbing without lost, means the
        // sender is outrunning us; lost without dropped means the network is.
        console.info(
          `[mumble] ${name}: depth ${ms(ev.data.depth)}ms, underruns ${ev.data.underruns},` +
            ` dropped ${ms(ev.data.dropped)}ms, lost ${Math.round(peer.lost * 10)}ms`,
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

  selfRegister(): void {
    this.notice = undefined;
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
    else if (this.outCtx && !(await setContextSink(this.outCtx, deviceId))) {
      // Rare — the device would have to have vanished. Say so, since otherwise the
      // setting looks applied while audio keeps coming out of the old speaker.
      console.warn('[mumble] could not switch output device; reconnect to retry');
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
 * Point a context at an output device. Returns false if this engine can't, or
 * refuses the device, so the caller can fall back to an <audio> element.
 */
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
