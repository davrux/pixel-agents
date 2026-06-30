import {
  type LocalTrackPublication,
  RemoteAudioTrack,
  Room,
  RoomEvent,
  Track,
  type Participant,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
} from 'livekit-client';

/**
 * Zone voice chat over LiveKit (WebRTC). One room per zone — entering a zone
 * connects to that zone's room; media is outside the game's authoritative state
 * (only positions, already synced for rendering, are used for proximity).
 *
 * Audio-only (no video). A participant's identity is `p<playerId>` so we can map
 * it back to its avatar and scale its volume by distance when proximity is on.
 * Effective per-peer volume = master · perUser · (proximity ? distanceFactor : 1).
 */

const NEAR_PX = 32; // within ~2 tiles → full volume
const FAR_PX = 256; // beyond ~16 tiles → silent
const PROXIMITY_TICK_MS = 150;

export interface ZoneVoiceHooks {
  /** Ask the server for a token (OfficeScene sends 'zoneVoiceToken'). */
  requestToken(): void;
  /** This viewer's avatar pixel position, or null (spectator / not spawned). */
  myPosition(): { x: number; y: number } | null;
  /** Pixel position of a given player id, or null if not present in this zone. */
  positionOf(playerId: number): { x: number; y: number } | null;
  /** Players currently talking (by id), for a talking indicator over avatars. */
  onSpeakers(playerIds: Set<number>): void;
  /** Per-player zone-voice presence + mic/sound state, for small status icons
   *  over avatars (key present = in voice; muted = mic off; deaf = sound off). */
  onVoiceStatus(status: Map<number, { muted: boolean; deaf: boolean }>): void;
}

export interface Peer {
  identity: string;
  name: string;
  playerId: number | null;
  volume: number; // per-user gain 0..2 (1 = unity, up to 2 = +100% boost)
  muted: boolean;
}

/** Web Audio playback graph for one remote participant's voice. */
interface PeerAudio {
  track: RemoteAudioTrack;
  pump: HTMLAudioElement; // muted; keeps the remote track flowing (Chrome quirk)
  source: MediaStreamAudioSourceNode;
  gain: GainNode;
  out: HTMLAudioElement; // plays the gain-processed stream; setSinkId picks the device
}

export interface ZoneVoiceState {
  connected: boolean;
  connecting: boolean;
  micOn: boolean;
  /** Whether all incoming zone voice is silenced (you hear no one). */
  deafened: boolean;
  /** Mic input gain / sensitivity (0..2, 1 = unity). */
  micGain: number;
  /** Voice-activity threshold (0..1; 0 = always transmit). */
  micThreshold: number;
  proximity: boolean;
  master: number;
  error?: string;
}

export interface ZoneVoiceDevices {
  mics: MediaDeviceInfo[];
  speakers: MediaDeviceInfo[];
  micId?: string;
  speakerId?: string;
}

export class ZoneVoice {
  private room: Room | null = null;
  private readonly audioBin: HTMLElement;
  // Each remote track plays through Web Audio so we can boost beyond 100%:
  // track → source → gain → MediaStreamDestination → <audio> (setSinkId for the
  // speaker device works on the element, in Chrome AND Firefox). A muted "pump"
  // element keeps the remote track flowing into Web Audio (Chrome quirk).
  private outCtx: AudioContext | null = null;
  private readonly peerAudio = new Map<string, PeerAudio>(); // identity → audio graph
  private readonly peers = new Map<string, Peer>(); // identity → peer

  private enabled = false; // user intent (Join/Leave)
  private suspended = false; // temporarily off (e.g. while in a conference) — keeps intent
  private connecting = false;
  private micOn = false; // start muted: joining a zone shouldn't open a hot mic
  private proximity: boolean;
  private master: number;
  /** Silence all incoming voice (deafen). Mic is independent (see micOn). */
  private deafened = false;
  private micId: string | undefined;
  private speakerId: string | undefined;
  private proximityTimer: number | null = null;

  // Mic capture graph: raw mic → gain → destination → published track. We own it
  // (rather than LiveKit's setMicrophoneEnabled) so a sensitivity slider can set
  // the gain, while device switching just swaps the source feeding the gain.
  private micGain = 1;
  private micCtx: AudioContext | null = null;
  private micGainNode: GainNode | null = null;
  private micDest: MediaStreamAudioDestinationNode | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private micRawStream: MediaStream | null = null;
  private micTrack: MediaStreamTrack | null = null;
  private micPub: LocalTrackPublication | null = null;
  // Voice-activity gate: below the threshold we silence outgoing audio (a gate
  // gain node after the user gain), so quiet background noise isn't transmitted.
  private micThreshold = 0; // 0 = always transmit (no gate)
  private gateNode: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private gateTimer: number | null = null;
  private gateOpenUntil = 0; // hold-open deadline (ms) for a smooth release

  constructor(
    private readonly hooks: ZoneVoiceHooks,
    private readonly onState: (s: ZoneVoiceState) => void,
    private readonly onPeers: (peers: Peer[]) => void,
    private readonly onDevices: (d: ZoneVoiceDevices) => void,
    private readonly onMicLevel: (level: number) => void,
  ) {
    this.proximity = localStorage.getItem('pa-zv-proximity') === '1';
    this.master = clampVol(Number(localStorage.getItem('pa-zv-master') ?? '1'));
    this.micGain = clampGain(Number(localStorage.getItem('pa-zv-micgain') ?? '1'));
    this.micThreshold = clamp01(Number(localStorage.getItem('pa-zv-micthresh') ?? '0'));
    // Persist mic/deafen across zone switches (a zone change reloads the page),
    // so you stay live/muted/deafened exactly as in the previous zone.
    this.micOn = localStorage.getItem('pa-zv-micon') === '1';
    this.deafened = localStorage.getItem('pa-zv-deaf') === '1';
    this.micId = localStorage.getItem('pa-zv-mic') ?? undefined;
    this.speakerId = localStorage.getItem('pa-zv-speaker') ?? undefined;
    this.audioBin = document.createElement('div');
    this.audioBin.style.display = 'none';
    document.body.appendChild(this.audioBin);
  }

  // ---- intent ----

  /** True if the user has zone voice enabled (auto-connects on each zone). */
  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Turn zone voice on and connect to the current zone's room. */
  join(): void {
    if (this.enabled) return;
    this.enabled = true;
    localStorage.setItem('pa-zv-enabled', '1');
    this.connect();
  }

  /** Turn zone voice off and disconnect. */
  leave(): void {
    this.enabled = false;
    localStorage.setItem('pa-zv-enabled', '0');
    void this.disconnect();
  }

  /** Temporarily disconnect without losing the user's intent (e.g. while in a
   *  conference monitor — you can't be in two voice calls at once). */
  suspend(): void {
    if (this.suspended) return;
    this.suspended = true;
    void this.disconnect();
  }

  /** Undo {@link suspend}: reconnect to the zone if still enabled. */
  resume(): void {
    if (!this.suspended) return;
    this.suspended = false;
    if (this.enabled) this.connect();
  }

  /** Called on startup: if previously enabled, auto-connect to this zone. */
  autoStart(): void {
    if (localStorage.getItem('pa-zv-enabled') === '1') {
      this.enabled = true;
      this.connect();
    } else {
      this.emitState();
    }
  }

  private connect(): void {
    if (!this.enabled || this.suspended || this.connecting || this.room) return;
    this.connecting = true;
    this.emitState();
    this.hooks.requestToken(); // server replies → onToken()
  }

  /** Server delivered a token (or an error). */
  async onToken(msg: { url?: string; token?: string; error?: string }): Promise<void> {
    if (!this.enabled || this.suspended) return;
    if (msg.error || !msg.url || !msg.token) {
      this.connecting = false;
      this.emitState(msg.error === 'not-configured' ? 'voice not configured on server' : msg.error);
      return;
    }
    const room = new Room();
    this.room = room;
    room
      .on(RoomEvent.TrackSubscribed, (t, _p, participant) => this.onTrack(t, participant))
      .on(RoomEvent.TrackUnsubscribed, (t) => this.onTrackGone(t))
      .on(RoomEvent.ParticipantConnected, (p) => this.addPeer(p))
      .on(RoomEvent.ParticipantDisconnected, (p) => this.removePeer(p.identity))
      .on(RoomEvent.ActiveSpeakersChanged, (speakers) => this.onActiveSpeakers(speakers))
      .on(RoomEvent.MediaDevicesChanged, () => void this.emitDevices())
      // Mic mute/publish changes (ours or others') → refresh the status icons.
      .on(RoomEvent.TrackMuted, () => this.emitVoiceStatus())
      .on(RoomEvent.TrackUnmuted, () => this.emitVoiceStatus())
      .on(RoomEvent.TrackPublished, () => this.emitVoiceStatus())
      .on(RoomEvent.TrackUnpublished, () => this.emitVoiceStatus())
      .on(RoomEvent.ParticipantAttributesChanged, () => this.emitVoiceStatus())
      .on(RoomEvent.Disconnected, () => this.cleanup());
    try {
      await room.connect(msg.url, msg.token);
      await room.startAudio().catch(() => undefined); // resume audio after the join gesture
      // Publish our gain-processed mic only if unmuted (mic starts muted, so no
      // getUserMedia prompt on join until the user actually unmutes).
      if (this.micOn) await this.publishMic();
      // Re-apply the saved output device (best-effort; ids can change).
      if (this.speakerId) await room.switchActiveDevice('audiooutput', this.speakerId).catch(() => undefined);
      this.connecting = false;
      room.remoteParticipants.forEach((p) => this.addPeer(p));
      this.startProximity();
      if (this.deafened) this.broadcastDeaf(); // announce sound-off if we joined deafened
      this.emitState();
      this.emitVoiceStatus();
      await this.emitDevices(); // labels are available now that mic permission is granted
    } catch (e) {
      this.connecting = false;
      this.emitState((e as Error)?.message || 'connection failed');
      void this.disconnect();
    }
  }

  private async disconnect(): Promise<void> {
    this.stopProximity();
    const r = this.room;
    this.room = null;
    await r?.disconnect();
    this.cleanup();
  }

  private cleanup(): void {
    this.stopProximity();
    this.stopMicGraph();
    for (const pa of this.peerAudio.values()) this.teardownPeerAudio(pa);
    this.peerAudio.clear();
    void this.outCtx?.close().catch(() => undefined);
    this.outCtx = null;
    this.peers.clear();
    this.audioBin.replaceChildren();
    this.room = null;
    this.connecting = false;
    this.onPeers([]);
    this.onDevices({ mics: [], speakers: [] });
    this.hooks.onSpeakers(new Set()); // clear talking indicators
    this.hooks.onVoiceStatus(new Map()); // clear status icons
    this.emitState();
  }

  /** LiveKit reports who's currently talking (incl. us); map to player ids. */
  private onActiveSpeakers(speakers: Participant[]): void {
    const ids = new Set<number>();
    for (const p of speakers) {
      const id = parsePlayerId(p.identity);
      if (id !== null) ids.add(id);
    }
    this.hooks.onSpeakers(ids);
  }

  // ---- participants + tracks ----

  private addPeer(p: Participant): void {
    if (this.peers.has(p.identity)) return;
    this.peers.set(p.identity, {
      identity: p.identity,
      name: p.name || p.identity,
      playerId: parsePlayerId(p.identity),
      volume: 1,
      muted: false,
    });
    this.emitPeers();
    this.emitVoiceStatus();
  }

  private removePeer(identity: string): void {
    this.peers.delete(identity);
    const pa = this.peerAudio.get(identity);
    if (pa) {
      this.teardownPeerAudio(pa);
      this.peerAudio.delete(identity);
    }
    this.emitPeers();
    this.emitVoiceStatus();
  }

  private ensureOutCtx(): AudioContext {
    if (!this.outCtx) {
      this.outCtx = new AudioContext();
      void this.outCtx.resume().catch(() => undefined);
    }
    return this.outCtx;
  }

  private onTrack(track: RemoteTrack, p: RemoteParticipant): void {
    if (track.kind !== Track.Kind.Audio) return;
    this.addPeer(p);
    const ctx = this.ensureOutCtx();
    const stream = new MediaStream([track.mediaStreamTrack]);
    // Chrome won't pull a remote track into Web Audio unless it's also attached
    // to a playing element; a muted pump element satisfies that (harmless in FF).
    const pump = new Audio();
    pump.srcObject = stream;
    pump.muted = true;
    void pump.play().catch(() => undefined);
    const source = ctx.createMediaStreamSource(stream);
    const gain = ctx.createGain();
    const dest = ctx.createMediaStreamDestination();
    source.connect(gain);
    gain.connect(dest);
    // Audible output is this element (the boost lives in the gain node);
    // setSinkId on it selects the speaker device in both Chrome and Firefox.
    const out = new Audio();
    out.srcObject = dest.stream;
    out.style.display = 'none';
    this.audioBin.appendChild(out);
    if (this.speakerId) void setSinkId(out, this.speakerId);
    void out.play().catch(() => undefined);
    this.peerAudio.set(p.identity, { track: track as RemoteAudioTrack, pump, source, gain, out });
    this.applyVolume(p.identity);
  }

  private onTrackGone(track: RemoteTrack): void {
    for (const [identity, pa] of this.peerAudio) {
      if (pa.track === track) {
        this.teardownPeerAudio(pa);
        this.peerAudio.delete(identity);
      }
    }
  }

  private teardownPeerAudio(pa: PeerAudio): void {
    try {
      pa.pump.pause();
      pa.pump.srcObject = null;
      pa.out.pause();
      pa.out.srcObject = null;
      pa.out.remove();
      pa.source.disconnect();
      pa.gain.disconnect();
    } catch {
      /* best-effort teardown */
    }
  }

  // ---- volume model ----

  /** Recompute and apply the effective volume for one peer. */
  private applyVolume(identity: string): void {
    const pa = this.peerAudio.get(identity);
    const peer = this.peers.get(identity);
    if (!pa || !peer) return;
    let v = this.deafened ? 0 : this.master * (peer.muted ? 0 : peer.volume);
    if (!this.deafened && this.proximity) v *= this.distanceFactor(peer.playerId);
    // Web Audio gain can exceed 1 → boost beyond 100% (cap to avoid clipping).
    pa.gain.gain.value = clampOut(v);
  }

  private applyAllVolumes(): void {
    for (const id of this.peerAudio.keys()) this.applyVolume(id);
  }

  /** 1 near, fading to 0 by FAR_PX; 0 if either position is unknown. */
  private distanceFactor(playerId: number | null): number {
    if (playerId === null) return 1; // unlocatable peer → not attenuated
    const me = this.hooks.myPosition();
    const them = this.hooks.positionOf(playerId);
    if (!me || !them) return 0;
    const d = Math.hypot(me.x - them.x, me.y - them.y);
    if (d <= NEAR_PX) return 1;
    if (d >= FAR_PX) return 0;
    return (FAR_PX - d) / (FAR_PX - NEAR_PX);
  }

  private startProximity(): void {
    if (this.proximityTimer !== null) return;
    this.proximityTimer = window.setInterval(() => {
      if (this.proximity) this.applyAllVolumes();
    }, PROXIMITY_TICK_MS);
  }

  private stopProximity(): void {
    if (this.proximityTimer !== null) {
      clearInterval(this.proximityTimer);
      this.proximityTimer = null;
    }
  }

  // ---- public controls (driven by the UI) ----

  toggleMic(): void {
    this.micOn = !this.micOn;
    localStorage.setItem('pa-zv-micon', this.micOn ? '1' : '0');
    // Use the LiveKit publication's mute/unmute (signals to other clients, so
    // they can show our mute state) — not just track.enabled.
    if (this.micOn && !this.micPub) void this.publishMic();
    else if (this.micPub) void (this.micOn ? this.micPub.unmute() : this.micPub.mute());
    this.emitState();
    this.emitVoiceStatus();
  }

  /** Set mic input gain / sensitivity (0..2, 1 = unity). */
  setMicSensitivity(v: number): void {
    this.micGain = clampGain(v);
    localStorage.setItem('pa-zv-micgain', String(this.micGain));
    if (this.micGainNode) this.micGainNode.gain.value = this.micGain;
    this.emitState();
  }

  /** Set the voice-activity threshold (0..1; 0 = always transmit). */
  setMicThreshold(v: number): void {
    this.micThreshold = clamp01(v);
    localStorage.setItem('pa-zv-micthresh', String(this.micThreshold));
    this.emitState();
  }

  /** Sample the mic level ~20 Hz to drive the gate (open above threshold, with a
   *  short release hold) and the UI meter. */
  private startGate(): void {
    if (this.gateTimer !== null || !this.analyser) return;
    const buf = new Float32Array(this.analyser.fftSize);
    this.gateTimer = window.setInterval(() => {
      const an = this.analyser;
      const gate = this.gateNode;
      if (!an || !gate) return;
      an.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      const rms = Math.sqrt(sum / buf.length);
      // Perceptual (dB) scale so quiet speech is clearly visible: map -60 dB → 0,
      // -10 dB → 1. Linear RMS barely moves for normal voice levels.
      const db = 20 * Math.log10(rms || 1e-7);
      const level = Math.max(0, Math.min(1, (db + 60) / 50));
      this.onMicLevel(level);
      const now = performance.now();
      if (this.micThreshold <= 0 || level >= this.micThreshold) this.gateOpenUntil = now + 250;
      gate.gain.value = now < this.gateOpenUntil ? 1 : 0;
    }, 50);
  }

  private stopGate(): void {
    if (this.gateTimer !== null) {
      clearInterval(this.gateTimer);
      this.gateTimer = null;
    }
    this.onMicLevel(0);
  }

  /** Capture the mic, run it through a gain node, and publish the result. */
  private async publishMic(): Promise<void> {
    if (!this.room || this.micTrack) return;
    try {
      const raw = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: this.micId ? { exact: this.micId } : undefined,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: false, // we provide manual gain (the sensitivity slider)
        },
      });
      const ctx = new AudioContext();
      await ctx.resume().catch(() => undefined);
      const source = ctx.createMediaStreamSource(raw);
      const gain = ctx.createGain();
      gain.gain.value = this.micGain;
      // Voice-activity gate after the user gain; an analyser taps the level to
      // drive the gate + the UI meter. source → gain → gate → dest.
      const gate = ctx.createGain();
      gate.gain.value = 1;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      const dest = ctx.createMediaStreamDestination();
      source.connect(gain);
      gain.connect(analyser); // tap (leaf; doesn't affect audio)
      gain.connect(gate);
      gate.connect(dest);
      const track = dest.stream.getAudioTracks()[0];
      this.micCtx = ctx;
      this.micSource = source;
      this.micGainNode = gain;
      this.gateNode = gate;
      this.analyser = analyser;
      this.micDest = dest;
      this.micRawStream = raw;
      this.micTrack = track;
      this.startGate();
      this.micPub = await this.room.localParticipant.publishTrack(track, { source: Track.Source.Microphone });
      if (!this.micOn) await this.micPub.mute();
      this.emitVoiceStatus();
    } catch (e) {
      this.stopMicGraph();
      this.emitState(`mic unavailable: ${(e as Error)?.message ?? e}`);
    }
  }

  /** Tear down the mic capture graph (on disconnect / failure). */
  private stopMicGraph(): void {
    this.stopGate();
    this.micRawStream?.getTracks().forEach((t) => t.stop());
    this.micSource?.disconnect();
    this.micGainNode?.disconnect();
    this.gateNode?.disconnect();
    this.analyser?.disconnect();
    void this.micCtx?.close().catch(() => undefined);
    this.micCtx = null;
    this.micSource = null;
    this.micGainNode = null;
    this.gateNode = null;
    this.analyser = null;
    this.micDest = null;
    this.micRawStream = null;
    this.micTrack = null;
    this.micPub = null;
  }

  /** Silence / un-silence all incoming zone voice at once (deafen). */
  toggleDeafen(): void {
    this.deafened = !this.deafened;
    localStorage.setItem('pa-zv-deaf', this.deafened ? '1' : '0');
    this.applyAllVolumes();
    this.broadcastDeaf(); // let others see our sound-off state
    this.emitState();
    this.emitVoiceStatus();
  }

  /** Publish our deafened state as a participant attribute (others read it). */
  private broadcastDeaf(): void {
    void this.room?.localParticipant
      .setAttributes({ deaf: this.deafened ? '1' : '0' })
      .catch(() => undefined);
  }

  setMaster(v: number): void {
    this.master = clampVol(v);
    localStorage.setItem('pa-zv-master', String(this.master));
    this.applyAllVolumes();
    this.emitState();
  }

  setProximity(on: boolean): void {
    this.proximity = on;
    localStorage.setItem('pa-zv-proximity', on ? '1' : '0');
    this.applyAllVolumes(); // reset to full when turning off
    this.emitState();
  }

  async switchMic(deviceId: string): Promise<void> {
    if (!this.room) return; // device switching only applies to a live room
    this.micId = deviceId;
    localStorage.setItem('pa-zv-mic', deviceId);
    // If the mic graph is live, swap the source feeding the gain node so the
    // published track (and its gain) stays the same — no republish needed.
    if (this.micCtx && this.micGainNode) {
      try {
        const raw = await navigator.mediaDevices.getUserMedia({
          audio: { deviceId: { exact: deviceId }, echoCancellation: true, noiseSuppression: true, autoGainControl: false },
        });
        this.micSource?.disconnect();
        this.micRawStream?.getTracks().forEach((t) => t.stop());
        this.micRawStream = raw;
        this.micSource = this.micCtx.createMediaStreamSource(raw);
        this.micSource.connect(this.micGainNode);
      } catch {
        /* keep the old source on failure */
      }
    }
    await this.emitDevices();
  }

  async switchSpeaker(deviceId: string): Promise<void> {
    if (!this.room) return;
    this.speakerId = deviceId;
    localStorage.setItem('pa-zv-speaker', deviceId);
    // Route each peer's output element to the chosen device (works in Chrome+FF).
    for (const pa of this.peerAudio.values()) void setSinkId(pa.out, deviceId);
    await this.emitDevices();
  }

  /** Enumerate mics + speakers (labels need mic permission, granted on connect). */
  private async emitDevices(): Promise<void> {
    if (!this.room) return;
    try {
      const mics = await Room.getLocalDevices('audioinput');
      const speakers = await Room.getLocalDevices('audiooutput');
      this.onDevices({
        mics,
        speakers,
        micId: this.micId, // we own the mic graph, so track our own selection
        speakerId: this.room.getActiveDevice('audiooutput') ?? this.speakerId,
      });
    } catch {
      /* enumeration failed — leave the pickers as-is */
    }
  }

  setPeerVolume(identity: string, v: number): void {
    const peer = this.peers.get(identity);
    if (!peer) return;
    peer.volume = clampVol(v);
    this.applyVolume(identity);
    this.emitPeers();
  }

  setPeerMuted(identity: string, muted: boolean): void {
    const peer = this.peers.get(identity);
    if (!peer) return;
    peer.muted = muted;
    this.applyVolume(identity);
    this.emitPeers();
  }

  get state(): ZoneVoiceState {
    return {
      connected: this.room?.state === 'connected',
      connecting: this.connecting,
      micOn: this.micOn,
      deafened: this.deafened,
      micGain: this.micGain,
      micThreshold: this.micThreshold,
      proximity: this.proximity,
      master: this.master,
    };
  }

  private emitState(error?: string): void {
    this.onState({ ...this.state, error });
  }

  private emitPeers(): void {
    this.onPeers([...this.peers.values()].sort((a, b) => a.name.localeCompare(b.name)));
  }

  /** Per-player presence + mic-mute state (self + remotes), for status icons. */
  private emitVoiceStatus(): void {
    const status = new Map<number, { muted: boolean; deaf: boolean }>();
    if (this.room) {
      const me = parsePlayerId(this.room.localParticipant.identity);
      if (me !== null) status.set(me, { muted: !this.micOn, deaf: this.deafened });
      this.room.remoteParticipants.forEach((p) => {
        const id = parsePlayerId(p.identity);
        if (id !== null) status.set(id, { muted: !p.isMicrophoneEnabled, deaf: p.attributes?.deaf === '1' });
      });
    }
    this.hooks.onVoiceStatus(status);
  }
}

function parsePlayerId(identity: string): number | null {
  const m = /^p(\d+)$/.exec(identity);
  return m ? Number(m[1]) : null;
}

/** Route an audio element to a specific output device (where supported). */
async function setSinkId(el: HTMLMediaElement, deviceId: string): Promise<void> {
  const sinkable = el as HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> };
  if (typeof sinkable.setSinkId === 'function') {
    await sinkable.setSinkId(deviceId).catch(() => undefined);
  }
}

/** Clamp to 0..1 (default 0 for non-finite input) — used for the mic threshold. */
function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

/** Clamp a volume slider value to 0..2 (1 = unity, 2 = +100% boost). */
function clampVol(v: number): number {
  if (!Number.isFinite(v)) return 1;
  return Math.max(0, Math.min(2, v));
}

/** Clamp the effective per-peer output gain (master·perUser·proximity) to a
 *  sane ceiling so a double-boost can't clip too hard. */
function clampOut(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(3, v));
}

/** Clamp mic gain to 0..2 (1 = unity); default 1 for non-finite input. */
function clampGain(v: number): number {
  if (!Number.isFinite(v)) return 1;
  return Math.max(0, Math.min(2, v));
}
