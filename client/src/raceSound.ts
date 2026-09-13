/**
 * What a race sounds like: an engine, tyres, the lights and the flag.
 *
 * Synthesised rather than sampled, and that is a decision rather than laziness. An engine note has
 * to follow the speed continuously — a looping sample pitched up and down is exactly what an
 * oscillator already is — and a squeal is filtered noise. It also means no audio files, so nothing
 * here carries a licence, needs downloading, or has to be prefetched before the first frame.
 *
 * Everything shares the one AudioContext the chimes use (`sound.ts`), because browsers cap how
 * many a page may have and two would mean two volume settings and two things to forget to stop.
 *
 * The rule that matters most in here is the last one: **it must go quiet.** A continuous sound has
 * no natural end, so every path that stops driving — getting out, a race ending, the tab going
 * away, sound switched off — has to reach `stop()`, or a player who parks their car hears an idling
 * engine for the rest of the session.
 */
import { audioContext, currentVolume } from './sound.js';

/** How loud, relative to the master volume. An engine you cannot talk over is an engine nobody keeps on. */
const ENGINE_VOL = 0.05;
const SKID_VOL = 0.05;
/** Engine note at a standstill and at top speed, in Hz. A fifth and a bit apart — enough to hear
 *  the difference between fourth and flat out without becoming a siren. */
const IDLE_HZ = 58;
const FLAT_HZ = 190;

/**
 * The car you are driving, as a sound.
 *
 * One oscillator for the engine and one noise source for the tyres, both created on `start` and
 * destroyed on `stop` rather than kept and muted: a suspended graph is a thing to leak, and the
 * cost of building two nodes is nothing next to a race.
 */
export class EngineSound {
  private osc: OscillatorNode | null = null;
  private sub: OscillatorNode | null = null;
  private gain: GainNode | null = null;
  private noise: AudioBufferSourceNode | null = null;
  private skidGain: GainNode | null = null;

  get running(): boolean {
    return this.osc !== null;
  }

  /** Start the engine. A second call while running does nothing. */
  start(): void {
    if (this.osc) return;
    const ctx = audioContext();
    if (!ctx) return;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.connect(ctx.destination);
    // A sawtooth alone is a wasp; a square an octave down under it is what makes it an engine.
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = IDLE_HZ;
    const sub = ctx.createOscillator();
    sub.type = 'square';
    sub.frequency.value = IDLE_HZ / 2;
    const subGain = ctx.createGain();
    subGain.gain.value = 0.5;
    osc.connect(gain);
    sub.connect(subGain);
    subGain.connect(gain);
    osc.start();
    sub.start();

    // Tyres: white noise through a band-pass, silent until something slides.
    const seconds = 1;
    const buffer = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource();
    noise.buffer = buffer;
    noise.loop = true;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 1400;
    band.Q.value = 0.8;
    const skidGain = ctx.createGain();
    skidGain.gain.value = 0;
    noise.connect(band);
    band.connect(skidGain);
    skidGain.connect(ctx.destination);
    noise.start();

    this.osc = osc;
    this.sub = sub;
    this.gain = gain;
    this.noise = noise;
    this.skidGain = skidGain;
  }

  /**
   * Follow the car. `speed` is px/s, `top` its maximum.
   *
   * Ramped rather than set: a frequency that jumps every patch is a machine gun, and 60 ms is
   * short enough that the note still tracks the throttle.
   */
  update(speed: number, top: number, sliding: boolean): void {
    const ctx = audioContext();
    if (!ctx || !this.osc || !this.gain || !this.sub || !this.skidGain) return;
    const t = ctx.currentTime;
    const rev = Math.max(0, Math.min(1, speed / Math.max(1, top)));
    const hz = IDLE_HZ + (FLAT_HZ - IDLE_HZ) * rev;
    const vol = currentVolume();
    this.osc.frequency.linearRampToValueAtTime(hz, t + 0.06);
    this.sub.frequency.linearRampToValueAtTime(hz / 2, t + 0.06);
    // Quieter at a standstill, so a car waiting on the grid does not drone.
    this.gain.gain.linearRampToValueAtTime(ENGINE_VOL * vol * (0.45 + 0.55 * rev), t + 0.06);
    this.skidGain.gain.linearRampToValueAtTime(sliding ? SKID_VOL * vol : 0, t + 0.05);
  }

  /** Silence, and let the nodes go. Safe to call when not running. */
  stop(): void {
    for (const node of [this.osc, this.sub, this.noise]) {
      try {
        node?.stop();
      } catch {
        /* already stopped */
      }
      node?.disconnect();
    }
    this.gain?.disconnect();
    this.skidGain?.disconnect();
    this.osc = this.sub = null;
    this.noise = null;
    this.gain = this.skidGain = null;
  }
}

/** One note, for the one-shot race sounds. Shares the chimes' context and volume. */
function blip(freq: number, start: number, dur: number, vol: number, type: OscillatorType = 'square'): void {
  const ctx = audioContext();
  if (!ctx) return;
  const peak = vol * currentVolume();
  if (peak <= 0) return;
  const t = ctx.currentTime + start;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  gain.gain.setValueAtTime(peak, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(t);
  osc.stop(t + dur);
}

/** A lamp coming on — and the green one, which is higher and longer so it is unmistakable. */
export function lightsBeep(go: boolean): void {
  if (go) blip(1046.5, 0, 0.5, 0.16); // C6
  else blip(523.25, 0, 0.16, 0.12); // C5
}

/** Crossing the line: a little fanfare for a win, one note for everybody else. */
export function finishChime(won: boolean): void {
  if (won) {
    blip(659.25, 0, 0.14, 0.14);
    blip(830.61, 0.13, 0.14, 0.14);
    blip(987.77, 0.26, 0.3, 0.16);
  } else {
    blip(587.33, 0, 0.22, 0.11);
  }
}

/** A new record — two quick rising notes, distinct from the finish. */
export function recordChime(): void {
  blip(880, 0, 0.1, 0.12, 'triangle');
  blip(1318.51, 0.1, 0.22, 0.13, 'triangle');
}
