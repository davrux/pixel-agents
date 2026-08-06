/**
 * LiveKit media layer for the in-world conference monitors. Owns the room
 * lifecycle and renders **one tile per participant** into the stage (video, or
 * an initials placeholder when the camera is off) plus one tile per screen
 * share. Also carries an ephemeral in-meeting chat over the LiveKit data
 * channel and surfaces participant / active-speaker changes.
 *
 * Every tile carries a `data-focus-key` and lands in the same stage element:
 * ConferenceUI owns the layout on top of that (grid vs. focused tile) and picks
 * tiles up by watching the stage, so nothing here needs to know about it.
 *
 * Camera/mic permission is treated as something that routinely goes wrong, which
 * on Firefox it does — it forgets a grant as soon as capture stops, so it prompts
 * again on every join. Hence: one combined getUserMedia for the single prompt,
 * a join that degrades to mic-only (or watch-only) instead of failing whole,
 * camOn/micOn that only claim what is actually published, and device
 * enumeration that never triggers a permission request of its own.
 *
 * The surrounding shell (control bar, chat/participants sidebars, fullscreen)
 * lives in ConferenceUI; this class only manages media + data. All of it is
 * outside the game's authoritative state — only call membership is server-synced.
 */
import {
  Room,
  RoomEvent,
  Track,
  DataPacket_Kind,
  type Participant,
  type RemoteParticipant,
  type Track as LkTrack,
  type TrackPublication,
} from 'livekit-client';

export interface ConferenceState {
  connected: boolean;
  camOn: boolean;
  micOn: boolean;
  screenOn: boolean;
  error?: string;
}

export interface ConferenceDevices {
  cameras: MediaDeviceInfo[];
  mics: MediaDeviceInfo[];
  speakers: MediaDeviceInfo[];
  camId?: string;
  micId?: string;
  speakerId?: string;
}

export interface ConferenceParticipant {
  identity: string;
  name: string;
  local: boolean;
  micOn: boolean;
  camOn: boolean;
  /** Playback volume this viewer set for the member (0..1; local is always 1). */
  volume: number;
  /** Whether this viewer muted the member locally (never true for local). */
  mutedLocally: boolean;
}

export interface ConferenceChatMsg {
  from: string;
  text: string;
  at: number;
  local: boolean;
}

export interface ConferenceCallbacks {
  onState: (s: ConferenceState) => void;
  onDevices?: (d: ConferenceDevices) => void;
  onChat?: (m: ConferenceChatMsg) => void;
  onParticipants?: (list: ConferenceParticipant[]) => void;
  /** Transient message for the viewer (e.g. "Ada muted you"). */
  onNotice?: (text: string) => void;
}

interface PTile {
  root: HTMLElement;
  media: HTMLElement; // holds the <video> or the placeholder
  placeholder: HTMLElement;
  hasVideo: boolean;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export class LiveKitConference {
  private room: Room | null = null;
  /** One tile per participant identity (camera / placeholder). */
  private readonly tiles = new Map<string, PTile>();
  /** Screen-share tiles, keyed by track sid. */
  private readonly screens = new Map<string, HTMLElement>();
  /** Hidden remote audio elements, keyed by track sid. */
  private readonly audios = new Map<string, { el: HTMLMediaElement; identity: string }>();
  /** Per-member playback volume this viewer chose (identity → 0..1). */
  private readonly peerVolumes = new Map<string, number>();
  /** Members this viewer muted locally (identity). */
  private readonly peerMuted = new Set<string>();
  /** Persisted volumes, keyed by display name (else identity) — survives reloads. */
  private readonly savedVolumes = new Map<string, number>();
  private camOn = true;
  private micOn = true;
  private screenOn = false;
  private speakerId?: string;

  constructor(
    private readonly stage: HTMLElement,
    private readonly cb: ConferenceCallbacks,
  ) {
    this.loadSavedVolumes();
  }

  async connect(url: string, token: string): Promise<void> {
    const room = new Room({ adaptiveStream: true, dynacast: true });
    this.room = room;
    room
      .on(RoomEvent.TrackSubscribed, (track, _pub, p) => this.addTrack(track, p, false))
      .on(RoomEvent.TrackUnsubscribed, (track, _pub, p) => this.removeTrack(track, p))
      .on(RoomEvent.LocalTrackPublished, (pub) => {
        if (pub.track) this.addTrack(pub.track, room.localParticipant, true);
      })
      .on(RoomEvent.LocalTrackUnpublished, (pub) => {
        if (pub.track) this.removeTrack(pub.track, room.localParticipant);
      })
      .on(RoomEvent.TrackMuted, (pub, p) => this.onCamMute(pub, p, true))
      .on(RoomEvent.TrackUnmuted, (pub, p) => this.onCamMute(pub, p, false))
      .on(RoomEvent.ParticipantConnected, (p) => {
        this.ensureTile(p, false);
        this.emitParticipants();
      })
      .on(RoomEvent.ParticipantDisconnected, (p) => {
        this.dropParticipant(p.identity);
        this.emitParticipants();
      })
      .on(RoomEvent.ActiveSpeakersChanged, (speakers) => this.markSpeakers(speakers))
      .on(RoomEvent.DataReceived, (payload, p) => this.onData(payload, p))
      .on(RoomEvent.MediaDevicesChanged, () => void this.emitDevices())
      .on(RoomEvent.Disconnected, () => this.cleanup());
    try {
      await room.connect(url, token);
    } catch (e) {
      this.notify((e as Error)?.message || 'connection failed');
      throw e;
    }
    // Only the connect above is fatal. Publishing is best-effort: a blocked,
    // missing or busy camera must not take the whole meeting — and the
    // microphone — down with it.
    await this.publishLocalMedia();
    this.ensureTile(room.localParticipant, true);
    for (const p of room.remoteParticipants.values()) this.ensureTile(p, false);
    this.notify();
    this.emitParticipants();
    await this.emitDevices(); // whatever labels the publish above unlocked
  }

  // ── Local media (one permission prompt, and no all-or-nothing join) ─

  /** Publish camera + mic from a **single** getUserMedia
   *  (`enableCameraAndMicrophone`), so the browser shows one permission prompt
   *  instead of two. Firefox re-asks on every join unless the member ticked
   *  "Remember this decision", so the second prompt isn't hypothetical there.
   *
   *  Whatever fails, we stay in the call with what works and report honest
   *  camOn/micOn — the control bar must not show 📷/🎙 lit while nothing is
   *  published. */
  private async publishLocalMedia(): Promise<void> {
    const lp = this.room?.localParticipant;
    if (!lp) return;
    // No mediaDevices at all = insecure origin (plain http on anything but
    // localhost). Watching and listening still works, so it's a notice, not an
    // error.
    if (!navigator.mediaDevices?.getUserMedia) {
      this.camOn = false;
      this.micOn = false;
      this.cb.onNotice?.('Camera and microphone need an https connection — you can watch and listen, but not publish.');
      return;
    }
    try {
      await lp.enableCameraAndMicrophone();
      return;
    } catch (e) {
      const err = e as Error;
      if (err?.name === 'NotAllowedError') {
        // Permission refused. getUserMedia is all-or-nothing, so somebody who
        // keeps their camera permanently blocked (Firefox remembers a "Block",
        // and then never even shows a prompt) lands here with a perfectly good
        // microphone — so ask for the mic on its own, once. The camera is not
        // asked for again: they said no, and the Cam button is there for later.
        this.camOn = false;
        this.micOn = await this.tryPublish('mic');
        this.cb.onNotice?.(
          this.micOn
            ? `Camera blocked — joined with microphone only. ${grantHint()}`
            : `Camera and microphone blocked. ${grantHint()}`,
        );
        return;
      }
      // A device-level problem instead — none present, already in use by
      // another app, unsupported constraints. The combined request fails as a
      // unit, so retry the two separately and keep whatever works. Mic first: a
      // meeting survives without a picture, not without sound.
      this.micOn = await this.tryPublish('mic');
      this.camOn = await this.tryPublish('cam');
      const dead = [!this.camOn ? 'camera' : '', !this.micOn ? 'microphone' : ''].filter(Boolean).join(' or ');
      if (dead) this.cb.onNotice?.(`No ${dead}: ${err?.message || 'device unavailable'}`);
    }
  }

  /** Enable one device, reporting failure instead of throwing. */
  private async tryPublish(kind: 'cam' | 'mic'): Promise<boolean> {
    const lp = this.room?.localParticipant;
    if (!lp) return false;
    try {
      if (kind === 'cam') await lp.setCameraEnabled(true);
      else await lp.setMicrophoneEnabled(true);
      return true;
    } catch {
      return false;
    }
  }

  // ── Tiles ──────────────────────────────────────────────────────────

  private ensureTile(p: Participant, local: boolean): PTile {
    if (!local && !this.peerVolumes.has(p.identity)) {
      const saved = this.savedVolumes.get(volKey(p.name, p.identity));
      if (saved !== undefined) this.peerVolumes.set(p.identity, saved);
    }
    let t = this.tiles.get(p.identity);
    if (t) return t;
    const root = document.createElement('div');
    root.className = 'pa-conf-tile';
    root.dataset.identity = p.identity;
    root.dataset.focusKey = `p:${p.identity}`;
    root.title = 'Click to focus';
    const media = document.createElement('div');
    media.className = 'pa-conf-media';
    const placeholder = document.createElement('div');
    placeholder.className = 'pa-conf-ph';
    placeholder.textContent = initials(local ? 'You' : p.name || p.identity);
    media.appendChild(placeholder);
    const tag = document.createElement('span');
    tag.className = 'pa-conf-name';
    tag.textContent = local ? 'You' : p.name || p.identity;
    root.append(media, tag);
    t = { root, media, placeholder, hasVideo: false };
    this.tiles.set(p.identity, t);
    this.stage.appendChild(root);
    return t;
  }

  private addTrack(track: LkTrack, p: Participant, local: boolean): void {
    if (track.kind === Track.Kind.Video) {
      const isScreen = track.source === Track.Source.ScreenShare;
      const video = track.attach() as HTMLVideoElement;
      video.classList.add('pa-conf-video');
      if (local && !isScreen) video.classList.add('mirror'); // mirror your own camera (not your screen)
      if (isScreen) {
        const sid = track.sid || `${p.identity}-screen`;
        const tile = document.createElement('div');
        tile.className = 'pa-conf-tile screen';
        tile.dataset.focusKey = `s:${sid}`;
        tile.title = 'Click to focus';
        const tag = document.createElement('span');
        tag.className = 'pa-conf-name';
        tag.textContent = `🖥 ${local ? 'You' : p.name || p.identity}`;
        video.classList.add('contain');
        tile.append(video, tag);
        this.screens.set(sid, tile);
        this.stage.appendChild(tile);
      } else {
        const t = this.ensureTile(p, local);
        t.placeholder.style.display = 'none';
        t.media.appendChild(video);
        t.hasVideo = true;
        t.root.classList.remove('camoff'); // real video → drop the black cam-off screen
      }
    } else if (track.kind === Track.Kind.Audio && !local) {
      const audio = track.attach();
      audio.style.display = 'none';
      if (this.speakerId) void setSinkId(audio, this.speakerId);
      this.audios.set(track.sid || `${p.identity}-audio`, { el: audio, identity: p.identity });
      this.stage.appendChild(audio);
      this.applyVolume(p.identity);
    }
    this.emitParticipants();
  }

  private removeTrack(track: LkTrack, p: Participant): void {
    const sid = track.sid;
    if (track.kind === Track.Kind.Video && track.source === Track.Source.ScreenShare) {
      const el = sid ? this.screens.get(sid) : undefined;
      if (el && sid) {
        el.remove();
        this.screens.delete(sid);
      }
      return;
    }
    if (track.kind === Track.Kind.Video) {
      // Camera gone → show the placeholder again on this participant's tile only
      // (the tile stays; other participants' videos are untouched).
      const t = this.tiles.get(p.identity);
      const v = t?.media.querySelector('video');
      if (t && v) {
        v.remove();
        t.hasVideo = false;
        t.placeholder.style.display = '';
        t.root.classList.add('camoff'); // camera gone → black cam-off screen
      }
    } else if (sid) {
      const a = this.audios.get(sid);
      if (a) {
        a.el.remove();
        this.audios.delete(sid);
      }
    }
    this.emitParticipants();
  }

  private dropParticipant(identity: string): void {
    const t = this.tiles.get(identity);
    if (t) {
      t.root.remove();
      this.tiles.delete(identity);
    }
  }

  private markSpeakers(speakers: Participant[]): void {
    const active = new Set(speakers.map((s) => s.identity));
    for (const [identity, t] of this.tiles) t.root.classList.toggle('speaking', active.has(identity));
  }

  /** A camera track was (un)muted — a participant toggled their cam without unpublishing.
   *  Hide the (frozen) video and show a black "camera off" tile, or restore it. */
  private onCamMute(pub: TrackPublication, p: Participant, muted: boolean): void {
    if (pub.kind === Track.Kind.Video && pub.source === Track.Source.Camera) {
      const t = this.tiles.get(p.identity);
      if (t) this.setCamOff(t, muted);
    }
    this.emitParticipants();
  }

  /** Toggle a tile's "camera off" state: black background + placeholder, video hidden. */
  private setCamOff(t: PTile, off: boolean): void {
    t.root.classList.toggle('camoff', off);
    t.placeholder.style.display = off ? '' : 'none';
    const v = t.media.querySelector('video');
    if (v) (v as HTMLElement).style.display = off ? 'none' : '';
  }

  // ── Chat (LiveKit data channel — ephemeral, per meeting) ───────────

  sendChat(text: string): void {
    const room = this.room;
    if (!room || !text) return;
    const at = Date.now();
    room.localParticipant.publishData(enc.encode(JSON.stringify({ t: 'chat', text, at })), {
      reliable: true,
    });
    this.cb.onChat?.({ from: 'You', text, at, local: true });
  }

  private onData(payload: Uint8Array, p?: RemoteParticipant): void {
    try {
      const msg = JSON.parse(dec.decode(payload)) as { t?: string; text?: string; at?: number; target?: string };
      if (msg.t === 'chat' && typeof msg.text === 'string') {
        this.cb.onChat?.({
          from: p?.name || p?.identity || '?',
          text: msg.text,
          at: typeof msg.at === 'number' ? msg.at : Date.now(),
          local: false,
        });
      } else if (msg.t === 'mute' && msg.target === this.room?.localParticipant.identity) {
        void this.muteSelf(p?.name || p?.identity || 'Someone');
      }
    } catch {
      /* ignore malformed data */
    }
  }

  // ── Mute for everyone (a request, not an enforcement) ──────────────

  /** Ask a member to switch their microphone off. It's their own client that
   *  does the muting, so the mic really is off at the source — everyone stops
   *  hearing them, not just us — and they can turn it back on whenever they
   *  like with their own Mic button. (Anyone in the call may do this; there are
   *  no moderators here, same as the rest of the office.) */
  requestMute(identity: string): void {
    const room = this.room;
    if (!room || identity === room.localParticipant.identity) return;
    room.localParticipant.publishData(enc.encode(JSON.stringify({ t: 'mute', target: identity })), {
      reliable: true,
      destinationIdentities: [identity], // nobody else needs to see the request
    });
    const name = room.remoteParticipants.get(identity)?.name || identity;
    this.cb.onNotice?.(`Asked ${name} to mute.`);
  }

  /** Someone asked us to mute — comply, and say who so it isn't a mystery. */
  private async muteSelf(by: string): Promise<void> {
    if (!this.micOn) return;
    this.micOn = false;
    await this.room?.localParticipant.setMicrophoneEnabled(false).catch(() => undefined);
    this.notify();
    this.emitParticipants();
    this.cb.onNotice?.(`${by} muted you. Press 🎙 Mic to unmute.`);
  }

  // ── Participants ───────────────────────────────────────────────────

  private emitParticipants(): void {
    const room = this.room;
    if (!room || !this.cb.onParticipants) return;
    const list: ConferenceParticipant[] = [];
    const add = (p: Participant, local: boolean): void => {
      list.push({
        identity: p.identity,
        name: local ? 'You' : p.name || p.identity,
        local,
        micOn: p.isMicrophoneEnabled,
        camOn: p.isCameraEnabled,
        volume: local ? 1 : (this.peerVolumes.get(p.identity) ?? 1),
        mutedLocally: !local && this.peerMuted.has(p.identity),
      });
    };
    add(room.localParticipant, true);
    for (const p of room.remoteParticipants.values()) add(p, false);
    this.cb.onParticipants(list);
  }

  // ── Per-member playback volume (local to this viewer) ─────────────

  /** Apply effective volume (0 if locally muted) to all of a member's audio elements. */
  private applyVolume(identity: string): void {
    const v = this.peerMuted.has(identity) ? 0 : (this.peerVolumes.get(identity) ?? 1);
    for (const a of this.audios.values()) if (a.identity === identity) a.el.volume = v;
  }

  setParticipantVolume(identity: string, v: number): void {
    const vol = clamp01(v);
    this.peerVolumes.set(identity, vol);
    this.applyVolume(identity);
    const name = this.room?.remoteParticipants.get(identity)?.name;
    this.savedVolumes.set(volKey(name, identity), vol);
    this.persistSavedVolumes();
    this.emitParticipants();
  }

  setParticipantMuted(identity: string, muted: boolean): void {
    if (muted) this.peerMuted.add(identity);
    else this.peerMuted.delete(identity);
    this.applyVolume(identity);
    this.emitParticipants();
  }

  private loadSavedVolumes(): void {
    try {
      const raw = localStorage.getItem('pa-conf-peervol');
      if (!raw) return;
      const obj = JSON.parse(raw) as Record<string, unknown>;
      for (const [k, v] of Object.entries(obj)) if (typeof v === 'number' && Number.isFinite(v)) this.savedVolumes.set(k, clamp01(v));
    } catch {
      /* corrupt/unavailable — start fresh */
    }
  }

  private persistSavedVolumes(): void {
    try {
      localStorage.setItem('pa-conf-peervol', JSON.stringify(Object.fromEntries(this.savedVolumes)));
    } catch {
      /* localStorage unavailable */
    }
  }

  // ── Controls ───────────────────────────────────────────────────────

  async toggleCam(): Promise<void> {
    const next = !this.camOn;
    try {
      await this.room?.localParticipant.setCameraEnabled(next);
      this.camOn = next;
    } catch {
      // Switching the camera back on re-runs getUserMedia — LiveKit stops the
      // camera track on mute so the hardware light goes out, and unmuting has to
      // re-acquire it. In Firefox that's a fresh permission prompt every time,
      // and a dismissed one lands here. Stay off rather than claim to be live.
      this.camOn = false;
      this.cb.onNotice?.(`Camera unavailable. ${grantHint()}`);
    }
    this.notify();
    this.emitParticipants();
  }

  async toggleMic(): Promise<void> {
    const next = !this.micOn;
    try {
      await this.room?.localParticipant.setMicrophoneEnabled(next);
      this.micOn = next;
    } catch {
      this.micOn = false;
      this.cb.onNotice?.(`Microphone unavailable. ${grantHint()}`);
    }
    this.notify();
    this.emitParticipants();
  }

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

  private async emitDevices(): Promise<void> {
    const room = this.room;
    if (!room || !this.cb.onDevices) return;
    try {
      // requestPermissions: false. The default (true) makes LiveKit fire *another*
      // getUserMedia whenever a kind's list is empty or any label is blank — i.e.
      // another Firefox prompt, and one that grabs the mic just to read labels.
      // Firefox's speaker list is routinely empty (it gates audiooutput
      // enumeration), so the default would re-prompt on every enumeration: on
      // join, on every devicechange, and after every device switch. Our own
      // publish already unlocked whatever labels we're going to get.
      const [cameras, mics, speakers] = await Promise.all([
        Room.getLocalDevices('videoinput', false),
        Room.getLocalDevices('audioinput', false),
        Room.getLocalDevices('audiooutput', false),
      ]);
      this.cb.onDevices({
        cameras,
        mics,
        speakers,
        camId: room.getActiveDevice('videoinput'),
        micId: room.getActiveDevice('audioinput'),
        speakerId: room.getActiveDevice('audiooutput') ?? this.speakerId,
      });
    } catch {
      /* enumeration failed — leave the picker as-is */
    }
  }

  async switchCamera(deviceId: string): Promise<void> {
    await this.room?.switchActiveDevice('videoinput', deviceId);
    await this.emitDevices();
  }
  async switchMic(deviceId: string): Promise<void> {
    await this.room?.switchActiveDevice('audioinput', deviceId);
    await this.emitDevices();
  }
  async switchSpeaker(deviceId: string): Promise<void> {
    this.speakerId = deviceId;
    await this.room?.switchActiveDevice('audiooutput', deviceId).catch(() => undefined);
    for (const a of this.audios.values()) void setSinkId(a.el, deviceId);
    await this.emitDevices();
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
    for (const t of this.tiles.values()) t.root.remove();
    this.tiles.clear();
    for (const el of this.screens.values()) el.remove();
    this.screens.clear();
    for (const a of this.audios.values()) a.el.remove();
    this.audios.clear();
    this.peerVolumes.clear();
    this.peerMuted.clear();
  }

  private notify(error?: string): void {
    this.cb.onState({ connected: this.isConnected(), camOn: this.camOn, micOn: this.micOn, screenOn: this.screenOn, error });
  }
}

/** How to get the permission back, worded for the browser in front of us.
 *  Firefox drops a camera/mic grant the moment capture stops, so it re-asks on
 *  every join and every camera re-enable unless "Remember this decision" was
 *  ticked — worth saying out loud, because the prompt is easy to miss. */
function grantHint(): string {
  const ff = typeof navigator !== 'undefined' && navigator.userAgent.includes('Firefox');
  return ff
    ? 'Allow it in the address-bar prompt, and tick "Remember this decision" so Firefox stops asking each time.'
    : 'Allow it in the address-bar prompt.';
}

/** Route a media element to a specific output device (where supported). */
async function setSinkId(el: HTMLMediaElement, deviceId: string): Promise<void> {
  const sinkable = el as HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> };
  if (typeof sinkable.setSinkId === 'function') await sinkable.setSinkId(deviceId).catch(() => undefined);
}

/** Stable-ish persistence key for a member: prefer the display name (survives
 *  reconnects/reloads that rotate the ephemeral identity). */
function volKey(name: string | undefined, identity: string): string {
  return name && name.trim() ? name : identity;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 1;
  return Math.max(0, Math.min(1, v));
}

/** Up-to-two-letter initials for a name (camera-off placeholder). */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Keep the data-kind import referenced for older livekit typings.
void DataPacket_Kind;
