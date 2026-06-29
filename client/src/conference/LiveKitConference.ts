/**
 * Thin wrapper around a LiveKit Room for the in-world conference monitors
 * (C-RTC-2). Owns the room lifecycle and renders video tiles into a grid element;
 * the scene drives connect/disconnect and cam/mic toggles. Media is entirely
 * outside the game's authoritative state — only call membership is server-synced.
 */
import { Room, RoomEvent, Track, type Participant, type Track as LkTrack } from 'livekit-client';

export interface ConferenceState {
  connected: boolean;
  camOn: boolean;
  micOn: boolean;
  error?: string;
}

export class LiveKitConference {
  private room: Room | null = null;
  /** Attached media elements/tiles, keyed by track sid (for clean teardown). */
  private readonly tiles = new Map<string, HTMLElement>();
  private camOn = true;
  private micOn = true;

  constructor(
    private readonly grid: HTMLElement,
    private readonly onState: (s: ConferenceState) => void,
  ) {}

  async connect(url: string, token: string): Promise<void> {
    const room = new Room({ adaptiveStream: true, dynacast: true });
    this.room = room;
    room
      .on(RoomEvent.TrackSubscribed, (track, _pub, p) => this.addTrack(track, p, false))
      .on(RoomEvent.TrackUnsubscribed, (track) => this.removeTrack(track.sid))
      .on(RoomEvent.LocalTrackPublished, (pub) => {
        if (pub.track) this.addTrack(pub.track, room.localParticipant, true);
      })
      .on(RoomEvent.LocalTrackUnpublished, (pub) => this.removeTrack(pub.trackSid))
      .on(RoomEvent.Disconnected, () => this.cleanup());
    try {
      await room.connect(url, token);
      await room.localParticipant.setCameraEnabled(true);
      await room.localParticipant.setMicrophoneEnabled(true);
      this.notify();
    } catch (e) {
      this.notify((e as Error)?.message || 'connection failed');
      throw e;
    }
  }

  private addTrack(track: LkTrack, p: Participant, local: boolean): void {
    const sid = track.sid || `${p.identity}-${track.kind}`;
    if (track.kind === Track.Kind.Video) {
      const video = track.attach() as HTMLVideoElement;
      video.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:0.35rem;background:#000;';
      if (local) video.style.transform = 'scaleX(-1)'; // mirror your own camera
      const tile = document.createElement('div');
      tile.style.cssText = 'position:relative;width:9rem;height:6.5rem;flex:0 0 auto;';
      const tag = document.createElement('span');
      tag.textContent = local ? 'You' : p.name || p.identity;
      tag.style.cssText =
        'position:absolute;left:0.25rem;bottom:0.2rem;font:0.8rem ui-monospace,monospace;color:#fff;text-shadow:0 0 3px #000,0 0 3px #000;';
      tile.append(video, tag);
      this.tiles.set(sid, tile);
      this.grid.appendChild(tile);
    } else if (track.kind === Track.Kind.Audio && !local) {
      // Play remote audio (hidden); never attach our own mic (would echo).
      const audio = track.attach();
      audio.style.display = 'none';
      this.tiles.set(sid, audio);
      this.grid.appendChild(audio);
    }
  }

  private removeTrack(sid: string | undefined): void {
    if (!sid) return;
    const el = this.tiles.get(sid);
    if (el) {
      el.remove();
      this.tiles.delete(sid);
    }
  }

  async toggleCam(): Promise<void> {
    this.camOn = !this.camOn;
    await this.room?.localParticipant.setCameraEnabled(this.camOn);
    this.notify();
  }

  async toggleMic(): Promise<void> {
    this.micOn = !this.micOn;
    await this.room?.localParticipant.setMicrophoneEnabled(this.micOn);
    this.notify();
  }

  get cam(): boolean {
    return this.camOn;
  }
  get mic(): boolean {
    return this.micOn;
  }
  isConnected(): boolean {
    return this.room?.state === 'connected';
  }

  async disconnect(): Promise<void> {
    const r = this.room;
    this.room = null;
    await r?.disconnect();
    this.cleanup();
  }

  private cleanup(): void {
    for (const el of this.tiles.values()) el.remove();
    this.tiles.clear();
  }

  private notify(error?: string): void {
    this.onState({ connected: this.isConnected(), camOn: this.camOn, micOn: this.micOn, error });
  }
}
