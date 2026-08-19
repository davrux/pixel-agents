/**
 * Main-process side of the Mumble client: owns at most one live session and
 * relays it to whichever renderer asked for it.
 *
 * The renderer is treated as the less-trusted half even in a packaged app, so
 * every payload crossing IPC is bounds-checked here, and a `connect` call takes
 * no parameters at all — host, port and credentials come from stored settings,
 * which can only be changed through `setSettings`.
 *
 * The session's lifetime is deliberately NOT the page's. Voice talks straight to
 * a Mumble server that the pixel-agents server neither relays nor knows about,
 * but the world reloads the page whenever that server restarts (and on a zone
 * change) — so tying the socket to the renderer made every restart cost the user
 * their place in the channel: a fresh handshake, a new session id, and a
 * leave/rejoin that everyone in the channel saw. A navigation therefore only
 * *detaches* the session; the renderer that comes back picks the same socket up
 * again and is replayed the roster it missed. Audio stops for the moment the page
 * is gone — capture and playback live there — but the connection does not.
 *
 * What still ends a session: the window being destroyed, the app quitting, an
 * explicit `disconnect`, and a renderer that never comes back (REATTACH_GRACE_MS).
 */
import { BrowserWindow, app, dialog, ipcMain, type WebContents } from 'electron';

import {
  PIXEL_DESKTOP_CHANNELS,
  type MumbleAudioIn,
  type MumbleEvent,
  type MumbleSettingsPatch,
  type MumbleSettingsView,
} from '../ipc.js';
import {
  MumbleSession,
  type MumbleChannel,
  type MumblePermissions,
  type MumbleSnapshot,
  type MumbleUser,
} from './session.js';
import {
  keychainAvailable,
  loadMumbleSecrets,
  loadMumbleSettings,
  readCertFile,
  saveMumbleSecrets,
  saveMumbleSettings,
  verifyMumblePeer,
} from './settings.js';

/** A 20 ms Opus frame is ~80 bytes; 1 KB plus the flag byte is generous. */
const MAX_AUDIO_FRAME = 1025;
const MAX_TEXT_LENGTH = 500;
/**
 * How long a session waits for its renderer to come back after a navigation.
 *
 * A reload is back within a second or two (the world's own reconnect waits for
 * `/health` before reloading at all, so the page is not racing a dead server).
 * Much longer than that means the renderer is not coming back to voice — it is
 * sitting on the sign-in screen, or crash-looping — and a session nobody is
 * attached to is a ghost in the channel: present to everyone else, unable to
 * hear or speak. Then close it properly rather than leave a half-open socket for
 * the server's ping timeout to reap.
 */
const REATTACH_GRACE_MS = 30_000;

interface Active {
  session: MumbleSession;
  /** The renderer this session belongs to. Survives a reload: the WebContents
   *  object is the same one after a navigation, only its page is new. */
  wc: WebContents;
  /** False between a navigation and the reattach — the page is gone, so nothing
   *  may be sent to it, but the socket is still ours. */
  attached: boolean;
}

let active: Active | null = null;
/** Runs out REATTACH_GRACE_MS after a detach; cleared by an attach or a stop. */
let reattachTimer: NodeJS.Timeout | null = null;

/** Send to one renderer regardless of attachment — for the few notices that
 *  belong to the caller of a handler rather than to the live session. */
function postTo(wc: WebContents, event: MumbleEvent): void {
  if (wc.isDestroyed()) return;
  wc.send(PIXEL_DESKTOP_CHANNELS.mumbleEvent, event);
}

/** Send to whichever renderer currently holds the session, if any is attached. */
function post(event: MumbleEvent): void {
  const current = active;
  if (!current || !current.attached) return;
  postTo(current.wc, event);
}

function stop(): void {
  cancelReattachGrace();
  const current = active;
  active = null;
  current?.session.close();
}

function cancelReattachGrace(): void {
  if (reattachTimer === null) return;
  clearTimeout(reattachTimer);
  reattachTimer = null;
}

/** The owning page is navigating away. Keep the socket, stop talking to a page
 *  that no longer exists, and start the clock on nobody claiming it. */
function detach(): void {
  const current = active;
  if (!current || !current.attached) return;
  current.attached = false;
  cancelReattachGrace();
  reattachTimer = setTimeout(() => {
    reattachTimer = null;
    if (active === current && !current.attached) stop();
  }, REATTACH_GRACE_MS);
  reattachTimer.unref();
}

/**
 * Hand a live session to the renderer asking to connect.
 *
 * The new page knows nothing — it has its own empty roster and no session id —
 * so replay the snapshot the session kept, exactly as a real ServerSync would
 * have arrived. The renderer rebuilds everything from a sync, so it cannot tell
 * a first connect from a reattach, and does not have to.
 */
function attach(wc: WebContents, current: Active): void {
  cancelReattachGrace();
  current.wc = wc;
  current.attached = true;
  const snapshot = current.session.snapshot();
  if (snapshot) {
    post({ t: 'sync', ...snapshot });
    post({ t: 'status', state: 'connected' });
  } else {
    // Reloaded mid-handshake: the real sync is still coming, and the renderer
    // waits for it exactly as on a first connect.
    post({ t: 'status', state: 'connecting' });
  }
}

/** Called on app quit so the voice server sees a clean leave. */
export function shutdownMumble(): void {
  stop();
}

async function settingsView(): Promise<MumbleSettingsView> {
  const settings = await loadMumbleSettings();
  const secrets = await loadMumbleSecrets();
  return {
    ...settings,
    hasPassword: secrets.password.length > 0,
    hasPassphrase: secrets.passphrase.length > 0,
    keychainAvailable: keychainAvailable(),
  };
}

async function startSession(
  wc: WebContents,
  getWindow: () => BrowserWindow | null,
): Promise<{ ok: boolean; error?: string }> {
  // One session per app, and a live one is worth more than a fresh one: whoever
  // asks gets the existing socket, replayed. That covers the reload case (same
  // WebContents, new page) and a second window (ownership simply moves). A
  // caller that really wants a new connection — changed settings — calls
  // `disconnect` first, which is what MumbleVoice.reconnect() does.
  if (active?.session.live) {
    attach(wc, active);
    return { ok: true };
  }
  stop();

  const settings = await loadMumbleSettings();
  if (!settings.host) return { ok: false, error: 'no server configured' };
  const secrets = await loadMumbleSecrets();
  const pfx = await readCertFile(settings.certPath);
  if (settings.certPath && !pfx) {
    postTo(wc, {
      t: 'status',
      state: 'error',
      error: 'certificate file could not be read — connecting as a guest',
    });
  }

  const session = new MumbleSession({
    host: settings.host,
    port: settings.port,
    username: settings.username || 'player',
    password: secrets.password,
    tokens: [],
    channel: settings.channel || undefined,
    pfx: pfx ?? undefined,
    passphrase: pfx ? secrets.passphrase || undefined : undefined,
    verifyPeer: verifyMumblePeer(getWindow, settings.host),
    release: 'pixel-agents',
    os: process.platform,
    osVersion: process.versions.electron ?? 'electron',
  });

  active = { session, wc, attached: true };
  // Addressed through `post`, never a captured WebContents: after a reload the
  // holder is a different page, and it is `active` that knows which.
  const forward = (event: MumbleEvent): void => {
    if (active?.session === session) post(event);
  };

  session.on('sync', (s: MumbleSnapshot) => {
    forward({ t: 'sync', session: s.session, welcome: s.welcome, channels: s.channels, users: s.users });
    forward({ t: 'status', state: 'connected' });
  });
  session.on('channel', (channel: MumbleChannel) => forward({ t: 'channel', channel }));
  session.on('channelRemove', (id: number) => forward({ t: 'channelRemove', id }));
  session.on('user', (user: MumbleUser) => forward({ t: 'user', user }));
  session.on('userRemove', (s: number) => forward({ t: 'userRemove', session: s }));
  session.on('text', (msg: { actor: number; message: string }) =>
    forward({ t: 'text', actor: msg.actor, message: msg.message }),
  );
  session.on('permission', (reason: string) => forward({ t: 'permission', reason }));
  session.on('permissions', (p: MumblePermissions) =>
    forward({ t: 'permissions', channel: p.channel, permissions: p.permissions, flush: p.flush }),
  );
  session.on('error', (error: string) => forward({ t: 'status', state: 'error', error }));
  session.on('close', () => {
    forward({ t: 'status', state: 'closed' });
    if (active?.session === session) active = null;
  });
  session.on('audio', (audio: MumbleAudioIn) => {
    const current = active;
    if (current?.session !== session || !current.attached || current.wc.isDestroyed()) return;
    current.wc.send(PIXEL_DESKTOP_CHANNELS.mumbleAudio, audio);
  });

  post({ t: 'status', state: 'connecting' });
  session.connect();
  return { ok: true };
}

/** Register every Mumble IPC handler. Call once, from the main process. */
export function registerMumbleIpc(getWindow: () => BrowserWindow | null): void {
  const channels = PIXEL_DESKTOP_CHANNELS;

  ipcMain.handle(channels.mumbleConnect, (event) => startSession(event.sender, getWindow));
  ipcMain.handle(channels.mumbleDisconnect, () => stop());

  ipcMain.handle(channels.mumbleJoinChannel, (event, id: unknown) => {
    if (!isOwner(event.sender) || !isId(id)) return;
    active?.session.joinChannel(id);
  });

  // Placing an ear in another channel is permission-gated — by the *server*,
  // which refuses with PermissionDenied. Nothing here second-guesses that: the
  // session only checks that the id names a channel the server has told us
  // about (see MumbleSession.setListening).
  ipcMain.handle(channels.mumbleSetListening, (event, id: unknown, listening: unknown) => {
    if (!isOwner(event.sender) || !isId(id)) return;
    active?.session.setListening(id, listening === true);
  });

  ipcMain.handle(channels.mumbleQueryPermissions, (event, id: unknown) => {
    if (!isOwner(event.sender) || !isId(id)) return;
    active?.session.queryPermissions(id);
  });

  ipcMain.handle(channels.mumbleSelfState, (event, state: unknown) => {
    if (!isOwner(event.sender) || typeof state !== 'object' || state === null) return;
    const { selfMute, selfDeaf } = state as { selfMute?: unknown; selfDeaf?: unknown };
    active?.session.setSelfState(selfMute === true, selfDeaf === true);
  });

  ipcMain.handle(channels.mumbleSendText, (event, message: unknown) => {
    if (!isOwner(event.sender) || typeof message !== 'string') return;
    const trimmed = message.slice(0, MAX_TEXT_LENGTH).trim();
    if (trimmed) active?.session.sendText(trimmed);
  });

  ipcMain.handle(channels.mumbleSelfRegister, (event) => {
    if (!isOwner(event.sender)) return;
    active?.session.selfRegister();
  });

  ipcMain.handle(channels.mumbleGetSettings, () => settingsView());

  ipcMain.handle(channels.mumbleSetSettings, async (_event, patch: unknown) => {
    const p = (typeof patch === 'object' && patch !== null ? patch : {}) as MumbleSettingsPatch;
    await saveMumbleSettings(p);
    if (typeof p.password === 'string' || typeof p.passphrase === 'string') {
      try {
        await saveMumbleSecrets({
          ...(typeof p.password === 'string' ? { password: p.password } : {}),
          ...(typeof p.passphrase === 'string' ? { passphrase: p.passphrase } : {}),
        });
      } catch {
        // No keychain. The view below reports keychainAvailable: false, which
        // the settings UI turns into an explanation rather than a silent loss.
      }
    }
    return settingsView();
  });

  ipcMain.handle(channels.mumblePickCertFile, async (): Promise<string | null> => {
    const window = getWindow();
    const opts = {
      title: 'Choose your Mumble certificate',
      properties: ['openFile' as const],
      filters: [{ name: 'Mumble identity', extensions: ['p12', 'pfx'] }],
    };
    const result = window ? await dialog.showOpenDialog(window, opts) : await dialog.showOpenDialog(opts);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  // Fire-and-forget: [flags, ...opus].
  ipcMain.on(channels.mumbleSendAudio, (event, frame: unknown) => {
    if (!isOwner(event.sender)) return;
    if (!(frame instanceof Uint8Array) || frame.length < 1 || frame.length > MAX_AUDIO_FRAME) return;
    active?.session.sendAudio(frame.subarray(1), (frame[0] & 1) !== 0);
  });

  // A closed window must tear the socket down, or the voice server keeps showing
  // a user whose renderer is already gone. A *navigation* must not: see the file
  // header — the world reloads itself on every server restart, and voice has
  // nothing to do with that server.
  app.on('web-contents-created', (_e, wc) => {
    wc.on('destroyed', () => {
      // Gone for good, and with it the mic and the audio graph. Nothing left to
      // hold a session for.
      if (active?.wc === wc) stop();
    });
    wc.on('render-process-gone', () => {
      // A crashed page is not coming back on its own, and Electron does not
      // reload it. Detaching rather than closing keeps a manual reload able to
      // pick the call back up; if none comes, the grace period ends it.
      if (active?.wc === wc) detach();
    });
    wc.on('did-start-navigation', (details) => {
      // Same-document navigations are excluded: they are not a page change at
      // all, and the world does make them — it rewrites `?zone=` through
      // history.replaceState. Only a real load can lose the renderer's state.
      if (details.isMainFrame && !details.isSameDocument && active?.wc === wc) detach();
    });
  });
}

function isOwner(wc: WebContents): boolean {
  return active !== null && active.wc === wc;
}

/** A Mumble session or channel id off the wire: an unsigned 32-bit integer. */
function isId(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 0xffffffff;
}
