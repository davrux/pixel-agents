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
/** A user counts as talking until this long after their last voice packet. */
const TALK_HOLD_MS = 300;
const TALK_TICK_MS = 200;
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
/** Don't queue audio behind a stalled IPC channel — drop it instead. */
const MAX_OPUS_BYTES = 1024;
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
  gain: GainNode;
  nextTime: number;
  tsUs: number;
  talkingUntil: number;
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

  // Capture: MicGraph → worklet → 20 ms buffers → AudioEncoder → IPC.
  private mic: MicGraph | null = null;
  private capture: AudioWorkletNode | null = null;
  private captureSink: GainNode | null = null;
  private workletUrl: string | null = null;
  private encoder: AudioEncoder | null = null;
  /** Resolves once the last endSpurt() flush has been sent; stopMic waits on it. */
  private encoderFlush: Promise<void> = Promise.resolve();
  private readonly pending: Float32Array<ArrayBuffer> = new Float32Array(FRAME_SAMPLES);
  private pendingLen = 0;
  private micTsUs = 0;
  private spurtOpen = false;
  private startingMic = false;

  // Playback: one output graph, one gain per remote user.
  private outCtx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private outEl: HTMLAudioElement | null = null;
  private readonly peers = new Map<number, PeerAudio>();

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
        this.users.set(e.user.session, e.user);
        if (e.user.session === this.mySession) {
          this.myChannel = e.user.channel;
          this.registered = e.user.userId !== undefined;
          this.emitState();
        }
        this.emitTree();
        return;
      }
      case 'userRemove': {
        this.users.delete(e.session);
        this.dropPeer(e.session);
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
      this.mySession = 0;
      this.channels.clear();
      this.users.clear();
      this.emitTree();
      if (this.enabled && this.suspendReasons.size === 0) this.scheduleReconnect();
    }
    this.emitState();
  }

  // ── playback ───────────────────────────────────────────────────────────────

  private async startPlayback(): Promise<void> {
    if (this.outCtx) return;
    const ctx = new AudioContext({ sampleRate: 48000 });
    await ctx.resume().catch(() => undefined);
    const master = ctx.createGain();
    const dest = ctx.createMediaStreamDestination();
    master.connect(dest);
    // Play through an element rather than ctx.destination so setSinkId can pick
    // the output device (works in Chromium and Firefox alike).
    const el = new Audio();
    el.srcObject = dest.stream;
    el.style.display = 'none';
    document.body.appendChild(el);
    if (this.speakerId) await setSinkId(el, this.speakerId);
    void el.play().catch(() => undefined);
    this.outCtx = ctx;
    this.masterGain = master;
    this.outEl = el;
    this.applyMasterGain();
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
    if (a.terminator || a.opus.length === 0) {
      peer.talkingUntil = 0;
      peer.nextTime = 0; // re-prime the jitter buffer on the next talk spurt
      return;
    }
    peer.talkingUntil = performance.now() + TALK_HOLD_MS;
    try {
      peer.decoder.decode(
        new EncodedAudioChunk({ type: 'key', timestamp: peer.tsUs, data: a.opus }),
      );
      peer.tsUs += FRAME_US;
    } catch {
      /* a corrupt packet must not kill the stream */
    }
  }

  private ensurePeer(session: number): PeerAudio | null {
    const ctx = this.outCtx;
    if (!ctx || !this.masterGain) return null;
    const existing = this.peers.get(session);
    if (existing) return existing;
    const gain = ctx.createGain();
    gain.connect(this.masterGain);
    const peer: PeerAudio = { decoder: null as unknown as AudioDecoder, gain, nextTime: 0, tsUs: 0, talkingUntil: 0 };
    peer.decoder = new AudioDecoder({
      output: (data) => this.playChunk(peer, data),
      error: () => {
        /* decoder gave up on this stream; the next talk spurt re-primes it */
      },
    });
    try {
      peer.decoder.configure({
        codec: 'opus',
        numberOfChannels: 1,
        sampleRate: 48000,
        description: OPUS_HEAD,
      });
    } catch {
      gain.disconnect();
      return null;
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
    const samples = new Float32Array(data.numberOfFrames);
    try {
      data.copyTo(samples, { planeIndex: 0, format: 'f32-planar' });
    } catch {
      data.close();
      return;
    }
    data.close();
    const buffer = ctx.createBuffer(1, samples.length, 48000);
    buffer.copyToChannel(samples, 0);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(peer.gain);
    if (peer.nextTime < ctx.currentTime + 0.02) peer.nextTime = ctx.currentTime + JITTER_S;
    src.start(peer.nextTime);
    peer.nextTime += buffer.duration;
  }

  private dropPeer(session: number): void {
    const peer = this.peers.get(session);
    if (!peer) return;
    this.peers.delete(session);
    try {
      if (peer.decoder.state !== 'closed') peer.decoder.close();
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
      const url = URL.createObjectURL(new Blob([CAPTURE_WORKLET], { type: 'application/javascript' }));
      this.workletUrl = url;
      await mic.ctx.audioWorklet.addModule(url);
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
    if (this.workletUrl) {
      URL.revokeObjectURL(this.workletUrl);
      this.workletUrl = null;
    }
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
  }

  // ── controls ───────────────────────────────────────────────────────────────

  toggleMic(): void {
    this.micOn = !this.micOn;
    localStorage.setItem('pa-mb-micon', this.micOn ? '1' : '0');
    if (this.micOn) void this.startMic();
    else this.stopMic();
    void this.pushSelfState();
    this.emitState();
  }

  toggleDeafen(): void {
    this.deafened = !this.deafened;
    localStorage.setItem('pa-mb-deaf', this.deafened ? '1' : '0');
    this.applyMasterGain();
    void this.pushSelfState();
    this.emitState();
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
    if (this.outEl) await setSinkId(this.outEl, deviceId);
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

/** Posts each 128-sample render quantum to the main thread, where frames are
 *  assembled into the 20 ms buffers the encoder wants. */
const CAPTURE_WORKLET = `
class PaMicCapture extends AudioWorkletProcessor {
  process(inputs) {
    const c = inputs[0] && inputs[0][0];
    if (c) this.port.postMessage(new Float32Array(c));
    return true;
  }
}
registerProcessor('pa-mic-capture', PaMicCapture);
`;

function buildOpusHead(): Uint8Array {
  const head = new Uint8Array(19);
  head.set(new TextEncoder().encode('OpusHead'), 0);
  const view = new DataView(head.buffer);
  view.setUint8(8, 1); // version
  view.setUint8(9, 1); // channel count
  view.setUint16(10, 3840, true); // pre-skip
  view.setUint32(12, 48000, true); // original sample rate
  view.setInt16(16, 0, true); // output gain
  view.setUint8(18, 0); // channel mapping family
  return head;
}

async function setSinkId(el: HTMLMediaElement, deviceId: string): Promise<void> {
  const sinkable = el as HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> };
  if (typeof sinkable.setSinkId === 'function') await sinkable.setSinkId(deviceId).catch(() => undefined);
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
