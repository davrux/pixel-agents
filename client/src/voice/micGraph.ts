/**
 * Microphone capture chain shared by the voice clients: raw mic → gain → gate,
 * with an analyser tap driving both the level meter and the voice-activity gate.
 *
 * Owning the graph (rather than handing the raw track to a voice SDK) is what
 * makes the sensitivity slider and the threshold gate possible: gain is applied
 * before the gate, and switching input device just swaps the source feeding it,
 * so downstream consumers never see the graph change.
 *
 * The context is pinned to 48 kHz because that is Opus's native rate.
 */

const LEVEL_INTERVAL_MS = 50;
/** Hold the gate open briefly after the last loud sample, so normal pauses
 *  between words don't chop the tail off every phrase. */
const GATE_HOLD_MS = 250;
/** Ceiling for the input gain. Matches the official Mumble client's maximum
 *  amplification (20x, +26 dB) — browser capture without AGC is far quieter
 *  than Mumble's, so a 2x ceiling leaves quiet mics inaudible to everyone else. */
export const MAX_MIC_GAIN = 20;

export interface MicGraphOpts {
  deviceId?: string;
  /**
   * Process this already-captured audio instead of opening a device.
   *
   * For a caller that has *just* been granted a microphone as part of a combined
   * camera+mic capture (see LiveKitConference): asking for the device again would
   * make Firefox show a second permission prompt, which is exactly what the one
   * combined request was for. The graph takes ownership — `stop()` stops it.
   */
  stream?: MediaStream;
  /** Input gain, 0..{@link MAX_MIC_GAIN} (1 = unity). */
  gain: number;
  /** Voice-activity threshold, 0..1 (0 = always transmit). */
  threshold: number;
  onLevel: (level: number) => void;
  onGate?: (open: boolean) => void;
}

export class MicGraph {
  /** Post-gain, post-gate output. Connect consumers here. */
  readonly out: GainNode;

  private raw: MediaStream;
  private source: MediaStreamAudioSourceNode;
  private readonly gainNode: GainNode;
  private readonly limiter: DynamicsCompressorNode;
  private readonly analyser: AnalyserNode;
  private readonly buf: Float32Array<ArrayBuffer>;
  private timer: number | null = null;
  private openUntil = 0;
  private gateOpen = false;
  private threshold: number;
  private stopped = false;

  private constructor(
    readonly ctx: AudioContext,
    raw: MediaStream,
    private readonly onLevel: (level: number) => void,
    private readonly onGate: ((open: boolean) => void) | undefined,
    gain: number,
    threshold: number,
  ) {
    this.raw = raw;
    this.threshold = threshold;
    this.source = ctx.createMediaStreamSource(raw);
    this.gainNode = ctx.createGain();
    this.gainNode.gain.value = clampMicGain(gain);
    // Safety limiter after the gain. Without it, a boost big enough to make a
    // quiet mic audible would clip the loud syllables into distortion — so the
    // limiter is what makes the higher ceiling usable rather than just louder.
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -6; // dBFS
    this.limiter.knee.value = 0; // hard: limit, don't colour
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.25;
    this.out = ctx.createGain();
    this.out.gain.value = 1;
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.buf = new Float32Array(this.analyser.fftSize);
    this.source.connect(this.gainNode);
    // Meter/gate tap sits post-gain but pre-limiter, so the level you see is the
    // level the threshold compares against.
    this.gainNode.connect(this.analyser); // tap: a leaf, so it doesn't affect audio
    this.gainNode.connect(this.limiter);
    this.limiter.connect(this.out);
    this.startLevelLoop();
  }

  static async start(opts: MicGraphOpts): Promise<MicGraph> {
    const raw =
      opts.stream ??
      (await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: opts.deviceId ? { exact: opts.deviceId } : undefined,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: false, // the sensitivity slider is the manual replacement
        },
      }));
    const ctx = new AudioContext({ sampleRate: 48000 });
    await ctx.resume().catch(() => undefined);
    // Callers encode at a hardcoded 48 kHz, so a denied request would time-warp
    // everything we transmit. Report the granted rate rather than assume it.
    if (ctx.sampleRate !== 48000) {
      console.warn(`[mic] asked for 48000 Hz, got ${ctx.sampleRate} Hz`);
    }
    return new MicGraph(ctx, raw, opts.onLevel, opts.onGate, opts.gain, opts.threshold);
  }

  /** A track carrying the processed audio, for consumers that want a MediaStream. */
  createTrack(): MediaStreamTrack {
    const dest = this.ctx.createMediaStreamDestination();
    this.out.connect(dest);
    return dest.stream.getAudioTracks()[0];
  }

  setGain(v: number): void {
    this.gainNode.gain.value = clampMicGain(v);
  }

  setThreshold(v: number): void {
    this.threshold = v;
  }

  get open(): boolean {
    return this.gateOpen;
  }

  async switchDevice(deviceId: string): Promise<void> {
    if (this.stopped) return;
    let raw: MediaStream;
    try {
      raw = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: { exact: deviceId },
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: false,
        },
      });
    } catch {
      return; // keep the working source rather than going silent
    }
    this.source.disconnect();
    this.raw.getTracks().forEach((t) => t.stop());
    this.raw = raw;
    this.source = this.ctx.createMediaStreamSource(raw);
    this.source.connect(this.gainNode);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.onLevel(0);
    this.raw.getTracks().forEach((t) => t.stop());
    try {
      this.source.disconnect();
      this.gainNode.disconnect();
      this.analyser.disconnect();
      this.limiter.disconnect();
      this.out.disconnect();
    } catch {
      /* best-effort teardown */
    }
    void this.ctx.close().catch(() => undefined);
  }

  private startLevelLoop(): void {
    this.timer = window.setInterval(() => {
      this.analyser.getFloatTimeDomainData(this.buf);
      let sum = 0;
      for (let i = 0; i < this.buf.length; i++) sum += this.buf[i] * this.buf[i];
      const rms = Math.sqrt(sum / this.buf.length);
      // Perceptual (dB) scale so quiet speech is clearly visible: -60 dB → 0,
      // -10 dB → 1. Linear RMS barely moves at normal speaking levels.
      const db = 20 * Math.log10(rms || 1e-7);
      const level = Math.max(0, Math.min(1, (db + 60) / 50));
      this.onLevel(level);
      const now = performance.now();
      if (this.threshold <= 0 || level >= this.threshold) this.openUntil = now + GATE_HOLD_MS;
      const open = now < this.openUntil;
      if (open !== this.gateOpen) {
        this.gateOpen = open;
        this.onGate?.(open);
      }
    }, LEVEL_INTERVAL_MS);
  }
}

/** Clamp an input gain to 0..MAX_MIC_GAIN (1 = unity). */
export function clampMicGain(v: number): number {
  if (!Number.isFinite(v)) return 1;
  return Math.max(0, Math.min(MAX_MIC_GAIN, v));
}
