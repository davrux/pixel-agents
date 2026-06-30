import {
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
}

export interface Peer {
  identity: string;
  name: string;
  playerId: number | null;
  volume: number; // per-user gain 0..1
  muted: boolean;
}

export interface ZoneVoiceState {
  connected: boolean;
  connecting: boolean;
  micOn: boolean;
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
  private readonly tracks = new Map<string, RemoteAudioTrack>(); // identity → track
  private readonly peers = new Map<string, Peer>(); // identity → peer

  private enabled = false; // user intent (Join/Leave)
  private suspended = false; // temporarily off (e.g. while in a conference) — keeps intent
  private connecting = false;
  private micOn = false; // start muted: joining a zone shouldn't open a hot mic
  private proximity: boolean;
  private master: number;
  private micId: string | undefined;
  private speakerId: string | undefined;
  private proximityTimer: number | null = null;

  constructor(
    private readonly hooks: ZoneVoiceHooks,
    private readonly onState: (s: ZoneVoiceState) => void,
    private readonly onPeers: (peers: Peer[]) => void,
    private readonly onDevices: (d: ZoneVoiceDevices) => void,
  ) {
    this.proximity = localStorage.getItem('pa-zv-proximity') === '1';
    this.master = clamp01(Number(localStorage.getItem('pa-zv-master') ?? '1'));
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
      .on(RoomEvent.Disconnected, () => this.cleanup());
    try {
      await room.connect(msg.url, msg.token);
      await room.startAudio().catch(() => undefined); // resume audio after the join gesture
      await room.localParticipant.setMicrophoneEnabled(this.micOn);
      // Re-apply the saved input/output devices (best-effort; ids can change).
      if (this.micId) await room.switchActiveDevice('audioinput', this.micId).catch(() => undefined);
      if (this.speakerId) await room.switchActiveDevice('audiooutput', this.speakerId).catch(() => undefined);
      this.connecting = false;
      room.remoteParticipants.forEach((p) => this.addPeer(p));
      this.startProximity();
      this.emitState();
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
    this.tracks.clear();
    this.peers.clear();
    this.audioBin.replaceChildren();
    this.room = null;
    this.connecting = false;
    this.onPeers([]);
    this.onDevices({ mics: [], speakers: [] });
    this.hooks.onSpeakers(new Set()); // clear talking indicators
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
  }

  private removePeer(identity: string): void {
    this.peers.delete(identity);
    this.tracks.delete(identity);
    this.emitPeers();
  }

  private onTrack(track: RemoteTrack, p: RemoteParticipant): void {
    if (track.kind !== Track.Kind.Audio) return;
    this.addPeer(p);
    const audio = track.attach();
    audio.style.display = 'none';
    this.audioBin.appendChild(audio);
    if (this.speakerId) void setSinkId(audio, this.speakerId);
    this.tracks.set(p.identity, track as RemoteAudioTrack);
    this.applyVolume(p.identity);
  }

  private onTrackGone(track: RemoteTrack): void {
    track.detach().forEach((el) => el.remove());
    for (const [identity, t] of this.tracks) {
      if (t === track) this.tracks.delete(identity);
    }
  }

  // ---- volume model ----

  /** Recompute and apply the effective volume for one peer. */
  private applyVolume(identity: string): void {
    const track = this.tracks.get(identity);
    const peer = this.peers.get(identity);
    if (!track || !peer) return;
    let v = this.master * (peer.muted ? 0 : peer.volume);
    if (this.proximity) v *= this.distanceFactor(peer.playerId);
    track.setVolume(clamp01(v));
  }

  private applyAllVolumes(): void {
    for (const id of this.tracks.keys()) this.applyVolume(id);
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
    void this.room?.localParticipant.setMicrophoneEnabled(this.micOn);
    this.emitState();
  }

  setMaster(v: number): void {
    this.master = clamp01(v);
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
    this.micId = deviceId;
    localStorage.setItem('pa-zv-mic', deviceId);
    await this.room?.switchActiveDevice('audioinput', deviceId).catch(() => undefined);
    await this.emitDevices();
  }

  async switchSpeaker(deviceId: string): Promise<void> {
    this.speakerId = deviceId;
    localStorage.setItem('pa-zv-speaker', deviceId);
    // LiveKit routes its managed elements; also set the sink on ours directly.
    await this.room?.switchActiveDevice('audiooutput', deviceId).catch(() => undefined);
    for (const el of Array.from(this.audioBin.children)) {
      void setSinkId(el as HTMLMediaElement, deviceId);
    }
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
        micId: this.room.getActiveDevice('audioinput') ?? this.micId,
        speakerId: this.room.getActiveDevice('audiooutput') ?? this.speakerId,
      });
    } catch {
      /* enumeration failed — leave the pickers as-is */
    }
  }

  setPeerVolume(identity: string, v: number): void {
    const peer = this.peers.get(identity);
    if (!peer) return;
    peer.volume = clamp01(v);
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

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 1;
  return Math.max(0, Math.min(1, v));
}
