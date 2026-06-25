/**
 * WebAudio chimes, ported 1:1 from the original pixel-agents notificationSound.
 * A rising two-note "done" chime and a short "permission" tap, gated by a
 * sound-enabled flag and a master volume.
 */
const NOTE = {
  done1: 659.25, // E5
  done2: 1318.51, // E6
  done2Start: 0.1,
  doneDur: 0.18,
  doneVol: 0.14,
  perm1: 880, // A5
  perm2: 659.25, // E5
  perm2Start: 0.12,
  permDur: 0.15,
  permVol: 0.12,
};

let soundEnabled = true;
let alertVolume = 1;
let ctx: AudioContext | null = null;

export function setSoundEnabled(on: boolean): void {
  soundEnabled = on;
}
export function isSoundEnabled(): boolean {
  return soundEnabled;
}
export function setAlertVolume(v: number): void {
  alertVolume = Math.max(0, Math.min(1, v));
}
export function getAlertVolume(): number {
  return alertVolume;
}

/** Unlock/resume the AudioContext from a user gesture (browsers suspend it). */
export function unlockAudio(): void {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
  } catch {
    /* no audio */
  }
}

function note(freq: number, start: number, dur: number, vol: number): void {
  if (!ctx) return;
  const peak = vol * alertVolume;
  if (peak <= 0) return;
  const t = ctx.currentTime + start;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(freq, t);
  gain.gain.setValueAtTime(peak, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(t);
  osc.stop(t + dur);
}

async function ensure(): Promise<boolean> {
  if (!soundEnabled) return false;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') await ctx.resume();
    return true;
  } catch {
    return false;
  }
}

export async function playDoneSound(): Promise<void> {
  if (!(await ensure())) return;
  note(NOTE.done1, 0, NOTE.doneDur, NOTE.doneVol);
  note(NOTE.done2, NOTE.done2Start, NOTE.doneDur, NOTE.doneVol);
}

export async function playPermissionSound(): Promise<void> {
  if (!(await ensure())) return;
  note(NOTE.perm1, 0, NOTE.permDur, NOTE.permVol);
  note(NOTE.perm2, NOTE.perm2Start, NOTE.permDur, NOTE.permVol);
}
