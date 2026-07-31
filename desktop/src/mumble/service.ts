/**
 * Main-process side of the Mumble client: owns at most one live session and
 * relays it to whichever renderer asked for it.
 *
 * The renderer is treated as the less-trusted half even in a packaged app, so
 * every payload crossing IPC is bounds-checked here, and a `connect` call takes
 * no parameters at all — host, port and credentials come from stored settings,
 * which can only be changed through `setSettings`.
 */
import { BrowserWindow, app, dialog, ipcMain, type WebContents } from 'electron';

import {
  PIXEL_DESKTOP_CHANNELS,
  type MumbleAudioIn,
  type MumbleEvent,
  type MumbleSettingsPatch,
  type MumbleSettingsView,
} from '../ipc.js';
import { MumbleSession, type MumbleChannel, type MumbleUser } from './session.js';
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

interface Active {
  session: MumbleSession;
  wc: WebContents;
}

let active: Active | null = null;

function post(wc: WebContents, event: MumbleEvent): void {
  if (wc.isDestroyed()) return;
  wc.send(PIXEL_DESKTOP_CHANNELS.mumbleEvent, event);
}

function stop(): void {
  const current = active;
  active = null;
  current?.session.close();
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
  stop(); // one session per app; a second connect takes ownership

  const settings = await loadMumbleSettings();
  if (!settings.host) return { ok: false, error: 'no server configured' };
  const secrets = await loadMumbleSecrets();
  const pfx = await readCertFile(settings.certPath);
  if (settings.certPath && !pfx) {
    post(wc, {
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

  active = { session, wc };
  const forward = (event: MumbleEvent): void => {
    if (active?.session === session) post(wc, event);
  };

  session.on('sync', (s: { session: number; welcome: string; channels: MumbleChannel[]; users: MumbleUser[] }) => {
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
  session.on('error', (error: string) => forward({ t: 'status', state: 'error', error }));
  session.on('close', () => {
    forward({ t: 'status', state: 'closed' });
    if (active?.session === session) active = null;
  });
  session.on('audio', (audio: MumbleAudioIn) => {
    if (active?.session !== session || wc.isDestroyed()) return;
    wc.send(PIXEL_DESKTOP_CHANNELS.mumbleAudio, audio);
  });

  post(wc, { t: 'status', state: 'connecting' });
  session.connect();
  return { ok: true };
}

/** Register every Mumble IPC handler. Call once, from the main process. */
export function registerMumbleIpc(getWindow: () => BrowserWindow | null): void {
  const channels = PIXEL_DESKTOP_CHANNELS;

  ipcMain.handle(channels.mumbleConnect, (event) => startSession(event.sender, getWindow));
  ipcMain.handle(channels.mumbleDisconnect, () => stop());

  ipcMain.handle(channels.mumbleJoinChannel, (event, id: unknown) => {
    if (!isOwner(event.sender) || !Number.isInteger(id) || (id as number) < 0) return;
    active?.session.joinChannel(id as number);
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

  // A reload or a closed window must tear the socket down, or the voice server
  // keeps showing a user whose renderer is already gone.
  app.on('web-contents-created', (_e, wc) => {
    wc.on('destroyed', () => {
      if (active?.wc === wc) stop();
    });
    wc.on('did-start-navigation', (details) => {
      if (details.isMainFrame && active?.wc === wc) stop();
    });
  });
}

function isOwner(wc: WebContents): boolean {
  return active !== null && active.wc === wc;
}
