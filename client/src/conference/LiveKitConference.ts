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
  screenOn: boolean;
  error?: string;
}

export class LiveKitConference {
  private room: Room | null = null;
  /** Attached media elements/tiles, keyed by track sid (for clean teardown). */
  private readonly tiles = new Map<string, HTMLElement>();
  private camOn = true;
  private micOn = true;
  private screenOn = false;

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
      const isScreen = track.source === Track.Source.ScreenShare;
      const video = track.attach() as HTMLVideoElement;
      video.style.cssText = `width:100%;height:100%;object-fit:${isScreen ? 'contain' : 'cover'};border-radius:0.35rem;background:#000;`;
      if (local && !isScreen) video.style.transform = 'scaleX(-1)'; // mirror your own camera (not your screen)
      const tile = document.createElement('div');
      const tag = document.createElement('span');
      const who = local ? 'You' : p.name || p.identity;
      tag.textContent = isScreen ? `🖥 ${who}` : who;
      tag.style.cssText =
        'position:absolute;left:0.25rem;bottom:0.2rem;font:0.8rem ui-monospace,monospace;color:#fff;text-shadow:0 0 3px #000,0 0 3px #000;z-index:1;';
      tile.append(video, tag);
      if (isScreen) {
        // Screen shares get a wider tile + a toggle to blow them up to ~tab size
        // (and back), so a shared screen is actually readable.
        const small = 'position:relative;width:18rem;height:10.5rem;flex:0 0 auto;';
        const big =
          'position:fixed;left:4vw;top:4vh;width:92vw;height:86vh;z-index:90;flex:0 0 auto;box-shadow:0 0 0 9999px rgba(0,0,0,.6);';
        tile.style.cssText = small;
        const zoom = document.createElement('button');
        zoom.textContent = '⤢ Tab size';
        zoom.style.cssText =
          'position:absolute;right:0.25rem;top:0.25rem;z-index:2;cursor:pointer;background:rgba(20,24,33,.85);' +
          'border:1px solid #3a4150;color:#eef1f6;border-radius:0.3rem;font:0.8rem ui-monospace,monospace;padding:0.2rem 0.45rem;';
        let enlarged = false;
        zoom.onclick = () => {
          enlarged = !enlarged;
          tile.style.cssText = enlarged ? big : small;
          zoom.textContent = enlarged ? '⤡ Shrink' : '⤢ Tab size';
        };
        tile.appendChild(zoom);
      } else {
        tile.style.cssText = 'position:relative;width:9rem;height:6.5rem;flex:0 0 auto;';
      }
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

  /** Start/stop screen sharing (browser shows the picker; cancelling reverts). */
  async toggleScreen(): Promise<void> {
    const next = !this.screenOn;
    try {
      await this.room?.localParticipant.setScreenShareEnabled(next);
      this.screenOn = next;
    } catch {
      this.screenOn = false; // user cancelled the picker or permission denied
    }
    this.notify();
  }

  get cam(): boolean {
    return this.camOn;
  }
  get mic(): boolean {
    return this.micOn;
  }
  get screen(): boolean {
    return this.screenOn;
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
    this.onState({ connected: this.isConnected(), camOn: this.camOn, micOn: this.micOn, screenOn: this.screenOn, error });
  }
}
