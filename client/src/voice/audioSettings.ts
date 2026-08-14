/**
 * The viewer's audio preferences, in one place: input/output device, playback
 * volume, mic sensitivity and the voice-activity threshold.
 *
 * They used to live inside ZoneVoice, which meant they belonged to the zone-wide
 * voice call — so removing that call would have taken the settings with it. They
 * are not a property of any one call: the same microphone and the same speakers
 * serve whatever you happen to be in. Meetings read them from here (see
 * LiveKitConference), and a change reaches a call that is already running, because
 * opening the audio panel mid-conversation and finding the sliders inert is worse
 * than having no sliders.
 *
 * The storage keys are deliberately the old `pa-zv-*` ones: everybody's existing
 * device choice and volume carry over untouched. `pa-zv-proximity` is NOT among
 * them — proximity was a property of the zone-wide call and went with it.
 */

/** Input gain ceiling, mirroring micGraph's MAX_MIC_GAIN. */
const MAX_GAIN = 20;

export interface AudioSettings {
  /** `deviceId` of the chosen microphone, or '' for the system default. */
  micId: string;
  /** `deviceId` of the chosen output, or '' for the system default. */
  speakerId: string;
  /** Playback volume applied on top of any per-member volume, 0..2. */
  master: number;
  /** Mic input gain, 0..MAX_GAIN (1 = unity). */
  micGain: number;
  /** Voice-activity threshold, 0..1 (0 = always transmit). */
  micThreshold: number;
}

type Listener = (s: AudioSettings) => void;

const KEYS = {
  micId: 'pa-zv-mic',
  speakerId: 'pa-zv-speaker',
  master: 'pa-zv-master',
  micGain: 'pa-zv-micgain',
  micThreshold: 'pa-zv-micthresh',
} as const;

const clamp = (v: number, lo: number, hi: number, fallback: number): number =>
  Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;

function read(): AudioSettings {
  let store: Storage | null = null;
  try {
    store = localStorage;
  } catch {
    /* storage unavailable (private mode, embedded) — defaults it is */
  }
  const str = (k: string): string => store?.getItem(k) ?? '';
  const num = (k: string, dflt: number): number => {
    const raw = store?.getItem(k);
    return raw === null || raw === undefined ? dflt : Number(raw);
  };
  return {
    micId: str(KEYS.micId),
    speakerId: str(KEYS.speakerId),
    master: clamp(num(KEYS.master, 1), 0, 2, 1),
    micGain: clamp(num(KEYS.micGain, 1), 0, MAX_GAIN, 1),
    micThreshold: clamp(num(KEYS.micThreshold, 0), 0, 1, 0),
  };
}

let current = read();
const listeners = new Set<Listener>();

/** The current settings (a copy — mutate through `setAudioSettings`). */
export function getAudioSettings(): AudioSettings {
  return { ...current };
}

/**
 * Change one or more settings: persisted, then broadcast.
 *
 * Silent about storage failures on purpose — a viewer in private mode should still
 * be able to pick a microphone for this session; only the remembering is lost.
 */
export function setAudioSettings(patch: Partial<AudioSettings>): void {
  const next: AudioSettings = { ...current, ...patch };
  next.master = clamp(next.master, 0, 2, current.master);
  next.micGain = clamp(next.micGain, 0, MAX_GAIN, current.micGain);
  next.micThreshold = clamp(next.micThreshold, 0, 1, current.micThreshold);
  const changed = (Object.keys(KEYS) as Array<keyof AudioSettings>).filter((k) => next[k] !== current[k]);
  if (changed.length === 0) return;
  current = next;
  try {
    for (const k of changed) localStorage.setItem(KEYS[k], String(next[k]));
  } catch {
    /* not persisted — still live for this session */
  }
  for (const fn of listeners) fn({ ...current });
}

/** Be told when they change (returns an unsubscribe). */
export function onAudioSettingsChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
