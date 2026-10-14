/**
 * DeepFilterNet3 noise suppression for the desktop Mumble client's microphone.
 *
 * A neural filter that keeps speech and drops what is not speech — keyboard,
 * fans, a dog, the dishwasher. It does NOT tell voices apart: a colleague talking
 * beside you is speech too and gets through. That would be target-speaker
 * extraction, a different model and not something with a usable open-source
 * real-time implementation today.
 *
 * Desktop only, by being Mumble only: MumbleVoice is unsupported in the browser,
 * and nothing else asks for this node. The assets therefore load from the BUNDLE
 * (`/deepfilter/…` resolves to app:// on the desktop), never from the server:
 *   - df_bg.wasm + df.js — the runtime, compiled from upstream source by
 *     scripts/build-deepfilter-wasm.sh and committed;
 *   - DeepFilterNet3_onnx.tar.gz — the model, 8 MB, fetched and hash-checked at
 *     build time by scripts/vendor-deepfilter.mjs (gitignored).
 * A build that skipped the vendor step has no model, and the toggle says so
 * instead of failing silently (`deepFilterAvailable`).
 *
 * The filter runs entirely inside an AudioWorklet: the WASM module is compiled
 * here once, handed to the worklet (a WebAssembly.Module is structured-
 * cloneable), and instantiated synchronously there, because AudioWorkletGlobal-
 * Scope has no fetch. Measured in node on this build: ~1.2 ms of CPU per 10 ms
 * frame, and 30 ms of algorithmic latency plus one 10 ms hop of buffering.
 */

const BASE = '/deepfilter';
const WASM_URL = `${BASE}/df_bg.wasm`;
const GLUE_URL = `${BASE}/df.js`;
const MODEL_URL = `${BASE}/DeepFilterNet3_onnx.tar.gz`;

/** The processor name, unique to this module so it cannot collide with the
 *  voice worklets registered on the same context. */
const PROCESSOR = 'pa-deepfilter';

/** Attenuation limit in dB. 100 is upstream's default: no limit, i.e. remove
 *  all the noise the model finds rather than turning it down by a fixed amount. */
const ATTEN_LIM_DB = 100;

interface DeepFilterAssets {
  module: WebAssembly.Module;
  model: ArrayBuffer;
  glue: string;
}

/**
 * The compiled runtime and the model, loaded once per page. Bounded: one entry,
 * ~18 MB, held for the life of the page because a mic restart (device switch,
 * reconnect, toggling the mic) would otherwise re-fetch and re-compile it. A
 * failure is not cached, so a later toggle can try again.
 */
let assets: Promise<DeepFilterAssets> | null = null;

function loadAssets(): Promise<DeepFilterAssets> {
  assets ??= (async () => {
    const get = async (url: string): Promise<Response> => {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
      return r;
    };
    const [wasm, model, glue] = await Promise.all([
      get(WASM_URL).then((r) => r.arrayBuffer()),
      get(MODEL_URL).then((r) => r.arrayBuffer()),
      get(GLUE_URL).then((r) => r.text()),
    ]);
    return { module: await WebAssembly.compile(wasm), model, glue };
  })().catch((e: unknown) => {
    assets = null;
    throw e;
  });
  return assets;
}

let available: Promise<boolean> | null = null;

/** Is the model actually in this build? One HEAD, cached for the page. */
export function deepFilterAvailable(): Promise<boolean> {
  available ??= fetch(MODEL_URL, { method: 'HEAD', cache: 'no-store' })
    .then((r) => r.ok)
    .catch(() => false);
  return available;
}

export const DEEPFILTER_MISSING_HINT =
  'The noise filter model is not in this build — run `pnpm vendor:deepfilter` and rebuild the desktop app.';

/** Contexts the processor is registered on (a context cannot unregister one). */
const registered = new WeakSet<BaseAudioContext>();

/**
 * A mono node that denoises what flows through it, on `ctx` (which must run at
 * 48 kHz — the model's rate, and MicGraph's). Throws if the assets cannot be
 * loaded or the model cannot be built; the caller decides what to fall back to.
 * `onFailure` is for the rarer case of the model failing AFTER it started.
 */
export async function createDeepFilterNode(
  ctx: AudioContext,
  onFailure?: (reason: string) => void,
): Promise<AudioWorkletNode> {
  if (ctx.sampleRate !== 48000) throw new Error(`DeepFilterNet needs 48 kHz, context runs at ${ctx.sampleRate}`);
  const { module, model, glue } = await loadAssets();
  if (!registered.has(ctx)) {
    const url = URL.createObjectURL(
      new Blob([WORKLET_PRELUDE, glue, WORKLET_PROCESSOR], { type: 'application/javascript' }),
    );
    try {
      await ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    registered.add(ctx);
  }
  const node = new AudioWorkletNode(ctx, PROCESSOR, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    channelCount: 1,
    channelCountMode: 'explicit',
    // The model is copied into the worklet (8 MB, once per mic start); the
    // module is shared, not copied.
    processorOptions: { module, model, attenLimDb: ATTEN_LIM_DB },
  });
  // The model is built in the processor's constructor; wait for its verdict so
  // a broken model fails HERE, where the caller can fall back, rather than as a
  // node that silently passes nothing.
  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error('DeepFilterNet did not start')), 10_000);
    node.port.onmessage = (ev: MessageEvent<{ ready?: boolean; error?: string }>) => {
      window.clearTimeout(timer);
      if (ev.data.ready) resolve();
      else reject(new Error(ev.data.error ?? 'DeepFilterNet failed'));
    };
  });
  // From here on the only message is a failure mid-stream, after which the node
  // outputs silence (see the processor) until the caller rebuilds without it.
  node.port.onmessage = (ev: MessageEvent<{ error?: string }>) => {
    if (!ev.data.error) return;
    console.warn('[mic] noise filter stopped:', ev.data.error);
    onFailure?.(ev.data.error);
  };
  return node;
}

/**
 * AudioWorkletGlobalScope has no TextDecoder in Chromium, and wasm-bindgen's glue
 * only needs one to read a panic message out of WASM memory. Without it every
 * failure would read "TextDecoder not available" — so a Latin-1 stand-in, which
 * is all a Rust panic string from this crate ever is in practice.
 */
const WORKLET_PRELUDE = `
if (typeof TextDecoder === 'undefined') {
  globalThis.TextDecoder = class { decode(b) { let s = ''; if (b) for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return s; } };
}
`;

/**
 * The processor: 128-sample render quanta in, 480-sample model hops through.
 *
 * The output FIFO starts with one hop of silence, and a hop is processed BEFORE
 * the quantum is read out, so it can never run dry: after n quanta the input has
 * received 128n samples and the output has been given 480 + 480·⌊128n/480⌋ of
 * which 128n were taken. That hop of priming is the buffering latency (10 ms).
 */
const WORKLET_PROCESSOR = `
class PaDeepFilter extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions;
    try {
      wasm_bindgen.initSync(o.module);
      this.st = wasm_bindgen.df_create(new Uint8Array(o.model), o.attenLimDb);
      this.hop = wasm_bindgen.df_get_frame_length(this.st);
    } catch (e) {
      this.st = 0;
      this.port.postMessage({ error: String(e && e.message || e) });
      return;
    }
    this.inBuf = new Float32Array(this.hop);
    this.inLen = 0;
    this.out = new Float32Array(this.hop * 4);
    this.outRead = 0;
    this.outLen = this.hop; // one hop of silence: see above
    this.failed = false;
    this.port.postMessage({ ready: true });
  }

  process(inputs, outputs) {
    const out = outputs[0] && outputs[0][0];
    if (!out) return true;
    const inp = inputs[0] && inputs[0][0];
    if (!this.st || this.failed) {
      // Never pass the unfiltered mic through on a failure: the user asked for
      // it to be filtered, and a filter that quietly stops is worse than silence.
      out.fill(0);
      return true;
    }
    const n = out.length;
    for (let i = 0; i < n; i++) {
      this.inBuf[this.inLen++] = inp ? inp[i] : 0;
      if (this.inLen === this.hop) {
        this.inLen = 0;
        let y;
        try {
          y = wasm_bindgen.df_process_frame(this.st, this.inBuf);
        } catch (e) {
          this.failed = true;
          this.port.postMessage({ error: String(e && e.message || e) });
          out.fill(0);
          return true;
        }
        const cap = this.out.length;
        let w = (this.outRead + this.outLen) % cap;
        for (let j = 0; j < y.length; j++) { this.out[w] = y[j]; w = (w + 1) % cap; }
        this.outLen += y.length;
      }
    }
    const cap = this.out.length;
    for (let i = 0; i < n; i++) {
      out[i] = this.outLen > 0 ? this.out[this.outRead] : 0;
      if (this.outLen > 0) { this.outRead = (this.outRead + 1) % cap; this.outLen--; }
    }
    return true;
  }
}
registerProcessor('${PROCESSOR}', PaDeepFilter);
`;
