/**
 * Global mic/deafen hotkeys.
 *
 * Registered in main with Electron's `globalShortcut`, so they work while the
 * window is unfocused or hidden to the tray — which is where a voice hotkey
 * earns its keep. The grab is best-effort: on Wayland (and wherever else the
 * OS refuses a global key grab) `register` fails or silently never fires, and
 * the renderer's own keydown fallback (client/src/voice/hotkeys.ts) covers the
 * focused-window case instead. Where the grab *does* work the OS swallows the
 * key before the renderer sees it, so the two paths cannot double-toggle.
 *
 * A hotkey only ever *asks*: the renderer owns the voice state, so the handler
 * posts a MumbleCommand over IPC (service.ts) rather than mutating anything
 * here.
 */
import { globalShortcut } from 'electron';

import type { MumbleCommand, MumbleSettings } from '../ipc.js';

/** What is currently registered, so a settings change releases the old keys —
 *  never `unregisterAll`, which would take a future non-Mumble shortcut with it. */
const registered = new Map<string, MumbleCommand['action']>();

/**
 * Make the registered shortcuts match the settings. Call after `app.whenReady`
 * (globalShortcut is inert before that) and again whenever the settings change.
 * Failures are deliberately silent: an unavailable grab is a fact about the OS,
 * and the settings UI already says the hotkey then only works while focused.
 */
export function applyMumbleHotkeys(
  settings: Pick<MumbleSettings, 'hotkeyMuteMic' | 'hotkeyDeafen'>,
  send: (action: MumbleCommand['action']) => void,
): void {
  const wanted = new Map<string, MumbleCommand['action']>();
  if (settings.hotkeyMuteMic) wanted.set(settings.hotkeyMuteMic, 'toggleMic');
  if (settings.hotkeyDeafen) wanted.set(settings.hotkeyDeafen, 'toggleDeafen');

  for (const [accelerator, action] of registered) {
    if (wanted.get(accelerator) === action) continue;
    try {
      globalShortcut.unregister(accelerator);
    } catch {
      /* an accelerator that never registered has nothing to release */
    }
    registered.delete(accelerator);
  }
  for (const [accelerator, action] of wanted) {
    if (registered.get(accelerator) === action) continue;
    try {
      if (globalShortcut.register(accelerator, () => send(action))) {
        registered.set(accelerator, action);
      }
    } catch {
      /* refused by the OS — the renderer's focused-window fallback remains */
    }
  }
}

/** Release everything we hold. Called on quit; Electron would do this at
 *  will-quit anyway, but the release belongs next to the acquisition. */
export function unregisterMumbleHotkeys(): void {
  for (const accelerator of registered.keys()) {
    try {
      globalShortcut.unregister(accelerator);
    } catch {
      /* already gone */
    }
  }
  registered.clear();
}
