/**
 * Thin loader for the self-hosted EmulatorJS engine (libretro cores → WASM), used by
 * the arcade for non-DOS games (NES/SNES/GB/arcade/…). Assets live under
 * /emulatorjs/data/ (vendored by scripts/vendor-emulatorjs.mjs — NOT a CDN, same
 * self-hosting stance as js-dos). EmulatorJS is driven entirely by `window.EJS_*`
 * globals + its loader.js, so we set the globals and (re)inject the loader per launch.
 * emulator.min.js is only loaded once (the vendored loader.js skips it when EmulatorJS
 * is already defined), so top-level let/const re-declaration errors can't occur.
 */
import type { DosInstance } from './jsdos.js';

const EJS_BASE = '/emulatorjs/data/';

export interface EmuJsOptions {
  /** EmulatorJS system name: 'nes','snes','gb','gba','n64','arcade','segaMD',… */
  core: string;
  /** ROM URL (a blob: URL on desktop, where the fetch carried the bearer). */
  gameUrl: string;
  gameName?: string;
  /** Called once the core has started the game (to drop the loading overlay). */
  onStart?: () => void;
}

interface EjsWindow {
  EJS_emulator?: { elements?: { parent?: HTMLElement }; callEvent?: (e: string) => void };
  [k: string]: unknown;
}

let loaderEl: HTMLScriptElement | null = null;

/** Boot one game into `mount`. Returns a DosInstance-shaped handle for close(). */
export async function loadEmulatorJs(mount: HTMLElement, opts: EmuJsOptions): Promise<DosInstance> {
  const w = window as unknown as EjsWindow & Record<string, unknown>;
  mount.innerHTML = '<div id="ejs-mount" style="width:100%;height:100%"></div>';
  w.EJS_player = '#ejs-mount';
  w.EJS_pathtodata = EJS_BASE;
  w.EJS_core = opts.core;
  w.EJS_gameUrl = opts.gameUrl;
  w.EJS_gameName = opts.gameName ?? 'game';
  w.EJS_startOnLoaded = true;
  w.EJS_language = 'en-US';
  w.EJS_disableDatabases = true;
  w.EJS_onGameStart = () => opts.onStart?.();
  // Re-inject loader.js each open so it re-reads the new EJS_* globals and
  // instantiates a fresh EmulatorJS. emulator.min.js itself is only loaded once
  // (the patched loader.js skips it when EmulatorJS is already defined).
  loaderEl?.remove();
  loaderEl = document.createElement('script');
  loaderEl.src = `${EJS_BASE}loader.js`;
  document.body.appendChild(loaderEl);

  return {
    stop: async () => {
      try { w.EJS_emulator?.callEvent?.('exit'); } catch { /* best effort */ }
      try { w.EJS_emulator?.elements?.parent?.remove(); } catch { /* best effort */ }
      loaderEl?.remove();
      loaderEl = null;
      w.EJS_emulator = undefined;
      mount.innerHTML = '';
    },
  };
}
