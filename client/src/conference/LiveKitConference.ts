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
  type LocalVideoTrack,
  type Participant,
  type RemoteParticipant,
  type Track as LkTrack,
  type LocalTrackPublication,
  type TrackPublication,
} from 'livekit-client';
import { reactionById, type Reaction } from './reactions.js';
import { getAudioSettings, onAudioSettingsChange } from '../voice/audioSettings.js';
import { MicGraph } from '../voice/micGraph.js';
import { CameraFilters, type VideoFilterId } from './videoFilters.js';

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
  /** Somebody (possibly us) sent a reaction — play it over the whole window. */
  onReaction?: (r: Reaction, from: string) => void;
  /** The camera filter actually in force changed (a failed one falls back to 'none'). */
  onVideoFilter?: (id: VideoFilterId) => void;
  /** Number of active screen-shares changed (0 → nobody sharing). */
  onScreens?: (count: number) => void;
  /** Live input level 0..1 of our own processed mic, for a level meter. */
  onMicLevel?: (level: number) => void;
}

interface PTile {
  root: HTMLElement;
  media: HTMLElement; // holds the <video> or the placeholder
  placeholder: HTMLElement;
  hasVideo: boolean;
  /** Small "muted" badge shown over the tile while this participant's mic is off. */
  micBadge: HTMLElement;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Smallest gap between two reactions from the same participant. Reactions cover
 *  the whole window, so an unthrottled sender could blind everyone else — and the
 *  sender is another client, i.e. untrusted (AGENTS.md rule 7). Ours is throttled
 *  on the way out too, so our own effect matches what others see. */
const REACTION_GAP_MS = 900;

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
  /** Last reaction time per identity (own identity included) — rate limiting. */
  private readonly lastReaction = new Map<string, number>();
  /** Background blur / virtual background for our own camera track. */
  private readonly filters: CameraFilters;
  private camOn = true;
  private micOn = true;
  private screenOn = false;
  private speakerId?: string;
  /** Device id the mic is currently captured from ('' = system default). Our own
   *  bookkeeping because, once the graph owns the capture, LiveKit's
   *  `getActiveDevice('audioinput')` no longer describes what we are recording. */
  private micId?: string;
  /** Unsubscribe from the shared audio settings (set on connect). */
  private unsubAudio?: () => void;
  /**
   * Our own mic, processed: raw device → gain → gate → published track.
   *
   * NOT LiveKit's own capture (setMicrophoneEnabled), because that publishes the
   * bare device and the viewer's sensitivity and voice-activity threshold would do
   * nothing in a meeting. The graph is the same one the zone-wide call used, lifted
   * rather than reinvented — see micGraph.ts.
   */
  private micGraph?: MicGraph;
  private micPub?: LocalTrackPublication;

  constructor(
    private stage: HTMLElement,
    private screensEl: HTMLElement,
    private readonly cb: ConferenceCallbacks,
  ) {
    this.loadSavedVolumes();
    this.filters = new CameraFilters((text) => this.cb.onNotice?.(text));
  }

  /** Move every currently-rendered tile / screen-share / audio element from
   *  the old stage+screens containers into new ones, and point all FUTURE
   *  renders (ensureTile/addTrack) at the new containers too — lets a live
   *  call switch between a small ambient view (meeting areas) and the full
   *  monitor-style window without reconnecting media. */
  retarget(stage: HTMLElement, screensEl: HTMLElement): void {
    if (stage === this.stage && screensEl === this.screensEl) return;
    for (const t of this.tiles.values()) stage.appendChild(t.root);
    for (const el of this.screens.values()) screensEl.appendChild(el);
    for (const a of this.audios.values()) stage.appendChild(a.el);
    this.stage = stage;
    this.screensEl = screensEl;
  }

  /** `video: false` (default true) skips auto-enabling the camera on connect
   *  — for a 'meetingRoom' action with video disabled (see shared Action):
   *  audio+chat only by default, though the usual camera toggle still works
   *  if someone chooses to turn it on. */
  async connect(url: string, token: string, opts?: { video?: boolean }): Promise<void> {
    const enableCamera = opts?.video !== false;
    this.camOn = enableCamera;
    // The viewer's own device choice and volume apply to every call, so they are
    // read here rather than asked for per meeting (see audioSettings.ts). The
    // subscription is what makes the audio panel work DURING a call instead of
    // only before one.
    const audio = getAudioSettings();
    if (audio.speakerId) this.speakerId = audio.speakerId;
    this.unsubAudio?.();
    this.unsubAudio = onAudioSettingsChange((next) => void this.applyAudioSettings(next));
    // The chosen input has to be the capture default, not a switch afterwards: the
    // combined camera+mic request happens before anything of ours runs, and its
    // track is the one the graph adopts (see processPublishedMic).
    const room = new Room({
      adaptiveStream: true,
      dynacast: true,
      audioCaptureDefaults: {
        ...(audio.micId ? { deviceId: audio.micId } : {}),
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: false, // the sensitivity slider replaces it (micGraph.ts)
      },
    });
    this.room = room;
    room
      .on(RoomEvent.TrackSubscribed, (track, _pub, p) => this.addTrack(track, p, false))
      .on(RoomEvent.TrackUnsubscribed, (track, _pub, p) => this.removeTrack(track, p))
      .on(RoomEvent.LocalTrackPublished, (pub) => {
        if (pub.track) this.addTrack(pub.track, room.localParticipant, true);
        // Every fresh camera track starts unfiltered — publishing on join, turning
        // the camera back on, switching device. Re-apply the chosen filter to it.
        if (pub.source === Track.Source.Camera) void this.applyFilterToCamera();
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
    await this.publishLocalMedia(enableCamera);
    this.ensureTile(room.localParticipant, true);
    for (const p of room.remoteParticipants.values()) this.ensureTile(p, false);
    this.notify();
    this.emitParticipants();
    this.cb.onVideoFilter?.(this.filters.current); // show the remembered filter as picked
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
   *  published.
   *
   *  `enableCamera: false` skips the camera outright (a 'meetingRoom' action
   *  with video disabled) — only the microphone is requested, so there's
   *  still just the one permission prompt. */
  private async publishLocalMedia(enableCamera: boolean): Promise<void> {
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
    if (!enableCamera) {
      this.camOn = false;
      this.micOn = await this.tryPublish('mic');
      if (!this.micOn) this.cb.onNotice?.('No microphone: device unavailable.');
      return;
    }
    try {
      await lp.enableCameraAndMicrophone();
      // That published the *raw* device. Swap in the processed one, and keep the
      // raw mic if the swap fails — audible beats correct.
      this.micOn = (await this.processPublishedMic()) || this.micOn;
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
      else return await this.publishProcessedMic();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Capture the mic through the viewer's own gain + voice gate and publish THAT.
   *
   * The alternative — LiveKit's setMicrophoneEnabled — publishes the raw device,
   * which is why the sensitivity and threshold sliders had no effect on meetings.
   * A failure here is reported as "no microphone" by the caller rather than thrown,
   * same as a camera failure.
   *
   * Verified from a single browser (headless Chromium, fake device, live LiveKit):
   * one getUserMedia, and the RTP sender's audio track is this graph's
   * MediaStreamAudioDestinationNode — so it really is the processed audio on the
   * wire, in both this path and processPublishedMic's. Mute/unmute flips that same
   * track rather than republishing.
   *
   * STILL UNTESTED (needs a second participant): that the far end actually *hears*
   * it, that the gate cuts and reopens without clipping words, and that a mid-call
   * device change (switchMic) stays audible across the swap.
   */
  private async publishProcessedMic(): Promise<boolean> {
    const lp = this.room?.localParticipant;
    if (!lp) return false;
    const s = getAudioSettings();
    try {
      this.micGraph = await MicGraph.start({
        deviceId: s.micId || undefined,
        gain: s.micGain,
        threshold: s.micThreshold,
        onLevel: (level) => this.cb.onMicLevel?.(level),
      });
      this.micPub = await lp.publishTrack(this.micGraph.createTrack(), { source: Track.Source.Microphone });
      this.micId = s.micId;
      return true;
    } catch {
      this.micGraph?.stop();
      this.micGraph = undefined;
      this.micPub = undefined;
      return false;
    }
  }

  /**
   * Re-route the microphone LiveKit itself captured (`enableCameraAndMicrophone`)
   * through our gain + gate, without touching the camera.
   *
   * The combined capture exists to show one permission prompt instead of two, so
   * this must not open the device a second time — Firefox would prompt again. It
   * adopts the granted track instead, which is why the unpublish must not stop it:
   * that track is the graph's input from here on.
   *
   * Same verification status as publishProcessedMic — see there.
   */
  private async processPublishedMic(): Promise<boolean> {
    const lp = this.room?.localParticipant;
    const rawTrack = lp?.getTrackPublication(Track.Source.Microphone)?.track;
    if (!lp || !rawTrack) return false;
    const s = getAudioSettings();
    try {
      await lp.unpublishTrack(rawTrack, false); // false = keep the track alive
      this.micGraph = await MicGraph.start({
        stream: new MediaStream([rawTrack.mediaStreamTrack]),
        gain: s.micGain,
        threshold: s.micThreshold,
        onLevel: (level) => this.cb.onMicLevel?.(level),
      });
      this.micPub = await lp.publishTrack(this.micGraph.createTrack(), { source: Track.Source.Microphone });
      this.micId = s.micId;
      return true;
    } catch {
      // Half-swapped is the one unacceptable outcome: put an unprocessed mic back
      // rather than leave the meeting silent.
      this.micGraph?.stop();
      this.micGraph = undefined;
      this.micPub = undefined;
      await lp.setMicrophoneEnabled(true).catch(() => undefined);
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
    const micBadge = document.createElement('div');
    micBadge.className = 'pa-conf-micoff';
    micBadge.textContent = '🚫';
    micBadge.style.display = p.isMicrophoneEnabled ? 'none' : '';
    root.append(media, tag, micBadge);
    t = { root, media, placeholder, hasVideo: false, micBadge };
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
        this.screensEl.appendChild(tile);
        this.cb.onScreens?.(this.screens.size);
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
        this.cb.onScreens?.(this.screens.size);
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
    // Our own identity is in here too, which is wanted: your tile lights up the
    // way everyone else's does.
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
      const msg = JSON.parse(dec.decode(payload)) as {
        t?: string;
        text?: string;
        at?: number;
        target?: string;
        r?: unknown;
      };
      if (msg.t === 'chat' && typeof msg.text === 'string') {
        this.cb.onChat?.({
          from: p?.name || p?.identity || '?',
          text: msg.text,
          at: typeof msg.at === 'number' ? msg.at : Date.now(),
          local: false,
        });
      } else if (msg.t === 'mute' && msg.target === this.room?.localParticipant.identity) {
        void this.muteSelf(p?.name || p?.identity || 'Someone');
      } else if (msg.t === 'react') {
        // Untrusted: only a known reaction id plays, and only every
        // REACTION_GAP_MS per sender. Anything else is dropped silently.
        const reaction = reactionById(msg.r);
        const identity = p?.identity ?? '?';
        if (reaction && this.allowReaction(identity)) {
          this.playReaction(reaction, p?.name || identity, identity);
        }
      }
    } catch {
      /* ignore malformed data */
    }
  }

  // ── Reactions (whole-window emoji + sound, like Jitsi) ─────────────

  /** Send one of the five reactions to everybody, and play it here too (the data
   *  channel doesn't loop back). Ignored while throttled or when the id is bogus. */
  sendReaction(id: string): void {
    const room = this.room;
    const reaction = reactionById(id);
    if (!room || !reaction) return;
    const me = room.localParticipant.identity;
    if (!this.allowReaction(me)) return;
    room.localParticipant.publishData(enc.encode(JSON.stringify({ t: 'react', r: reaction.id })), {
      reliable: true,
    });
    this.playReaction(reaction, 'You', me);
  }

  /** Rate limit per participant — see REACTION_GAP_MS. */
  private allowReaction(identity: string): boolean {
    const now = Date.now();
    const last = this.lastReaction.get(identity) ?? 0;
    if (now - last < REACTION_GAP_MS) return false;
    this.lastReaction.set(identity, now);
    return true;
  }

  /** The window-wide effect (owned by ConferenceUI) plus a badge on the sender's
   *  own tile, so a busy call still shows *who* reacted. */
  private playReaction(reaction: Reaction, who: string, identity: string): void {
    this.cb.onReaction?.(reaction, who);
    const tile = this.tiles.get(identity);
    if (!tile) return;
    tile.root.querySelector('.pa-conf-react')?.remove();
    const badge = document.createElement('span');
    badge.className = 'pa-conf-react';
    badge.textContent = reaction.emoji;
    badge.addEventListener('animationend', () => badge.remove());
    tile.root.appendChild(badge);
    window.setTimeout(() => badge.remove(), 2600);
  }

  // ── Camera background filters (blur / virtual background) ──────────

  /** Our own camera track, if one is published (LiveKit replaces it whenever the
   *  camera is toggled or the device switched). */
  private cameraTrack(): LocalVideoTrack | undefined {
    const pub = this.room?.localParticipant.getTrackPublication(Track.Source.Camera);
    return pub?.track as LocalVideoTrack | undefined;
  }

  private async applyFilterToCamera(): Promise<void> {
    await this.filters.attach(this.cameraTrack());
    this.cb.onVideoFilter?.(this.filters.current);
  }

  /** Pick a background filter. Reports back the one actually in force — applying
   *  can fail (unsupported browser, missing assets), and then it's 'none'. */
  async setVideoFilter(id: VideoFilterId): Promise<void> {
    const effective = await this.filters.select(id, this.cameraTrack());
    this.cb.onVideoFilter?.(effective);
    if (effective !== 'none' && !this.cameraTrack()) {
      this.cb.onNotice?.('Filter saved — it applies as soon as your camera is on.');
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

  /** Rebuild the participant list AND sync every tile's mic-off badge — both
   *  read the same p.isMicrophoneEnabled, and every mic (un)mute / (un)publish
   *  / connect / disconnect already calls this, so there's no separate
   *  audio-mute listener needed. */
  private emitParticipants(): void {
    const room = this.room;
    if (!room) return;
    const list: ConferenceParticipant[] = [];
    const add = (p: Participant, local: boolean): void => {
      const t = this.tiles.get(p.identity);
      if (t) t.micBadge.style.display = p.isMicrophoneEnabled ? 'none' : '';
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
    this.cb.onParticipants?.(list);
  }

  // ── Per-member playback volume (local to this viewer) ─────────────

  /** Apply effective volume (0 if locally muted) to all of a member's audio elements. */
  private applyVolume(identity: string): void {
    // Per-member choice times the viewer's master volume (audioSettings) — the
    // same master the audio panel shows, so one slider governs every call.
    // Clamped because master goes to 2 (a boost) while element volume stops at 1;
    // the extra headroom above unity is the GainNode's job, not this element's.
    const master = getAudioSettings().master;
    const v = this.peerMuted.has(identity) ? 0 : Math.min(1, (this.peerVolumes.get(identity) ?? 1) * master);
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
      // Mute the publication, not LiveKit's capture: the track is ours (see
      // publishProcessedMic), so setMicrophoneEnabled would not touch it. If we
      // never got a mic at all, this is the moment to try again — unless LiveKit
      // is holding an unprocessed one (the swap's fallback), which it owns and
      // must therefore also switch off, or we'd publish a second microphone.
      const lkMic = this.room?.localParticipant.getTrackPublication(Track.Source.Microphone);
      if (!this.micPub && lkMic) {
        await this.room?.localParticipant.setMicrophoneEnabled(next);
        this.micOn = next;
      } else if (!this.micPub) {
        this.micOn = next ? await this.publishProcessedMic() : false;
      } else {
        if (next) await this.micPub.unmute();
        else await this.micPub.mute();
        this.micOn = next;
      }
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
        micId: this.micId ?? room.getActiveDevice('audioinput'),
        speakerId: room.getActiveDevice('audiooutput') ?? this.speakerId,
      });
    } catch {
      /* enumeration failed — leave the picker as-is */
    }
  }

  /** Re-apply the viewer's audio preferences to this live call. Device switches go
   *  through the same methods the meeting window's own pickers use, so there is one
   *  path and no second source of truth. */
  private async applyAudioSettings(s: { micId: string; speakerId: string; master: number; micGain: number; micThreshold: number }): Promise<void> {
    if (!this.room) return;
    if (s.speakerId && s.speakerId !== this.speakerId) await this.switchSpeaker(s.speakerId);
    // Only on an actual change: switchMic re-opens the device, and this runs on
    // every settings change — dragging the gain slider must not reopen the mic.
    if (s.micId && s.micId !== this.micId) await this.switchMic(s.micId).catch(() => undefined);
    this.micGraph?.setGain(s.micGain);
    this.micGraph?.setThreshold(s.micThreshold);
    for (const identity of new Set([...this.audios.values()].map((a) => a.identity))) this.applyVolume(identity);
  }

  async switchCamera(deviceId: string): Promise<void> {
    await this.room?.switchActiveDevice('videoinput', deviceId);
    await this.emitDevices();
  }
  async switchMic(deviceId: string): Promise<void> {
    // Swap the source feeding the graph, so the PUBLISHED track stays the same —
    // no republish, and nobody hears a gap. Falls back to LiveKit's own switch
    // when there is no graph (mic never came up).
    if (this.micGraph) await this.micGraph.switchDevice(deviceId);
    else await this.room?.switchActiveDevice('audioinput', deviceId);
    this.micId = deviceId;
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

  /** What this call would report right now — for anything that has to ask
   *  instead of remembering the last onState it happened to receive (see the
   *  top bar's refreshCallBar). */
  currentState(): ConferenceState {
    return { connected: this.isConnected(), camOn: this.camOn, micOn: this.micOn, screenOn: this.screenOn };
  }

  async disconnect(): Promise<void> {
    const r = this.room;
    this.room = null;
    // Stop listening for setting changes — a disconnected call must not keep
    // switching devices in the background.
    this.unsubAudio?.();
    this.unsubAudio = undefined;
    // Free the segmenter's WASM/WebGL before the track goes away — a leftover
    // processor would keep decoding frames from a camera nobody is watching.
    await this.filters.destroy();
    await r?.disconnect();
    this.cleanup();
  }

  private cleanup(): void {
    void this.filters.destroy(); // also covers a drop we didn't initiate (idempotent)
    // A call that has ended has to SAY so: whoever shows its state (the meeting
    // window, the top bar's live dot and mic button) otherwise keeps showing the
    // last thing it heard, which was "connected". Reset the published flags first
    // so the notify at the end reports the truth and not a lit mic on a dead call.
    this.camOn = false;
    this.micOn = false;
    this.screenOn = false;
    // Here rather than in disconnect(), so a call the server or the network ends
    // also releases the microphone — otherwise the device light stays on.
    this.micGraph?.stop();
    this.micGraph = undefined;
    this.micPub = undefined;
    this.micId = undefined;
    for (const t of this.tiles.values()) t.root.remove();
    this.tiles.clear();
    for (const el of this.screens.values()) el.remove();
    this.screens.clear();
    for (const a of this.audios.values()) a.el.remove();
    this.audios.clear();
    this.peerVolumes.clear();
    this.peerMuted.clear();
    this.lastReaction.clear();
    this.notify();
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
