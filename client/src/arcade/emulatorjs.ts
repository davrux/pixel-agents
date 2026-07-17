/**
 * Thin loader for the self-hosted EmulatorJS engine (libretro cores → WASM), used by
 * the arcade for non-DOS games (NES/SNES/GB/arcade/…). Assets live under
 * /emulatorjs/data/ (vendored by scripts/vendor-emulatorjs.mjs — NOT a CDN, same
 * self-hosting stance as js-dos). EmulatorJS is driven entirely by `window.EJS_*`
 * globals + its loader.js, so we set the globals, (re)inject the loader per launch,
 * and hand back a { stop } matching js-dos' DosInstance so ArcadeUI can treat both
 * emulators the same.
 *
 * Teardown is best-effort: EmulatorJS has no clean dispose API (it normally assumes a
 * page reload), so stop() removes its DOM + loader script and clears the globals.
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

let scriptEl: HTMLScriptElement | null = null;

/** Boot one game into `mount`. Returns a DosInstance-shaped handle for close(). */
export async function loadEmulatorJs(mount: HTMLElement, opts: EmuJsOptions): Promise<DosInstance> {
  const w = window as unknown as EjsWindow & Record<string, unknown>;
  // Fresh child the engine renders into (EmulatorJS replaces the target's contents).
  mount.innerHTML = '<div id="ejs-mount" style="width:100%;height:100%"></div>';
  w.EJS_player = '#ejs-mount';
  w.EJS_pathtodata = EJS_BASE;
  w.EJS_core = opts.core;
  w.EJS_gameUrl = opts.gameUrl;
  w.EJS_gameName = opts.gameName ?? 'game';
  w.EJS_startOnLoaded = true;
  w.EJS_disableDatabases = true; // no external ROM/BIOS database lookups
  w.EJS_onGameStart = () => opts.onStart?.();
  // Re-inject loader.js each open so it re-initialises against the new globals.
  scriptEl?.remove();
  scriptEl = document.createElement('script');
  scriptEl.src = `${EJS_BASE}loader.js`;
  document.body.appendChild(scriptEl);

  return {
    stop: async () => {
      try { w.EJS_emulator?.callEvent?.('exit'); } catch { /* best effort */ }
      try { w.EJS_emulator?.elements?.parent?.remove(); } catch { /* best effort */ }
      scriptEl?.remove();
      scriptEl = null;
      w.EJS_emulator = undefined;
      mount.innerHTML = '';
    },
  };
}
