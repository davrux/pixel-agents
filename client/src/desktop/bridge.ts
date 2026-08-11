/**
 * Renderer-side accessor for the Electron preload-injected `window.pixelDesktop`
 * API and the `isDesktop()` discriminator. The public Vite bundle bakes in
 * nothing desktop-specific: `isDesktop()` is false in a browser because the
 * global is never injected there, so every consumer falls back to the browser
 * (`window.location`-derived) code paths.
 *
 * This is a SEPARATE file from `client/src/net/bridge.ts` (the unrelated
 * asset/layout message bridge) by design.
 */

/**
 * Typed contract for the preload-injected API. Mirrors the Design Doc
 * (§ Preload interface `PixelDesktopApi`). The authoritative definition lives
 * in `desktop/src/ipc.ts` (authored in T4.2); this consuming shape is
 * reconciled with it there.
 */
export interface MumbleChannelInfo {
  id: number;
  parent: number;
  name: string;
  description?: string;
  position?: number;
}

export interface MumbleUserInfo {
  session: number;
  name: string;
  channel: number;
  selfMute: boolean;
  selfDeaf: boolean;
  mute: boolean;
  deaf: boolean;
  suppress: boolean;
  /** Present once the server reports a registered account for this user. */
  userId?: number;
}

export type MumbleEvent =
  | { t: 'status'; state: 'connecting' | 'connected' | 'error' | 'closed'; error?: string }
  | {
      t: 'sync';
      session: number;
      welcome?: string;
      channels: MumbleChannelInfo[];
      users: MumbleUserInfo[];
    }
  | { t: 'channel'; channel: MumbleChannelInfo }
  | { t: 'channelRemove'; id: number }
  | { t: 'user'; user: MumbleUserInfo }
  | { t: 'userRemove'; session: number }
  | { t: 'text'; actor: number; message: string }
  | { t: 'permission'; reason: string };

export interface MumbleAudioIn {
  session: number;
  /** Sender's sequence number, in 10 ms units. */
  sequence: number;
  terminator: boolean;
  opus: Uint8Array;
}

export interface MumbleSettings {
  host: string;
  port: number;
  username: string;
  channel: string;
  certPath: string | null;
  autoConnect: boolean;
}

export interface MumbleSettingsView extends MumbleSettings {
  hasPassword: boolean;
  hasPassphrase: boolean;
  keychainAvailable: boolean;
}

export type MumbleSettingsPatch = Partial<MumbleSettings> & {
  /** '' clears the stored value; undefined leaves it untouched. */
  password?: string;
  passphrase?: string;
};

/** Mumble voice: the protocol and TLS socket live in the Electron main process;
 *  this renderer only captures, encodes, decodes and plays Opus. */
export interface MumbleApi {
  connect(): Promise<{ ok: boolean; error?: string }>;
  disconnect(): Promise<void>;
  joinChannel(id: number): Promise<void>;
  selfState(state: { selfMute: boolean; selfDeaf: boolean }): Promise<void>;
  sendText(message: string): Promise<void>;
  selfRegister(): Promise<void>;
  getSettings(): Promise<MumbleSettingsView>;
  setSettings(patch: MumbleSettingsPatch): Promise<MumbleSettingsView>;
  pickCertFile(): Promise<string | null>;
  /** [flags, ...opus] — flag bit 0 marks the end of a talk spurt. */
  sendAudio(frame: Uint8Array): void;
  onEvent(cb: (event: MumbleEvent) => void): () => void;
  onAudio(cb: (audio: MumbleAudioIn) => void): () => void;
}

// ── TimeTracking ─────────────────────────────────────────────────────────────
// Desktop-only, exactly like Mumble: the credential and the connection to the
// user's TimeTracking install live in the Electron main process, and this
// renderer only ever sees derived status. WorkStatus/WorkAction are the same
// types `@pixel/shared/timetracking` declares (structurally reconciled, as with
// everything else in this file).

export type WorkStatus = '' | 'working' | 'break' | 'homeoffice' | 'trip' | 'away';
export type WorkAction = 'start' | 'pause' | 'end';

export interface TimeTrackingSettings {
  baseUrl: string;
  username: string;
}

export interface TimeTrackingSettingsView extends TimeTrackingSettings {
  hasPassword: boolean;
  keychainAvailable: boolean;
  /** True once a server address, a username AND a password are all stored. */
  configured: boolean;
}

export type TimeTrackingSettingsPatch = Partial<TimeTrackingSettings> & {
  /** '' clears the stored value; undefined leaves it untouched. */
  password?: string;
};

export interface WorkSnapshot {
  configured: boolean;
  status: WorkStatus;
  /** Epoch ms the running entry began, or null — the face ticks off this. */
  runningSince: number | null;
  completedMs: number;
  /** Already resolved from the install's own rules by main. */
  can: Record<WorkAction, boolean>;
  asOf: number;
  error: string | null;
}

export interface TimeTrackingApi {
  getSettings(): Promise<TimeTrackingSettingsView>;
  setSettings(
    patch: TimeTrackingSettingsPatch,
  ): Promise<{ ok: true; view: TimeTrackingSettingsView; displayName: string } | { ok: false; error: string }>;
  disconnect(): Promise<TimeTrackingSettingsView>;
  getStatus(): Promise<WorkSnapshot>;
  book(action: WorkAction): Promise<{ ok: true; snapshot: WorkSnapshot } | { ok: false; error: string }>;
  onStatus(cb: (snapshot: WorkSnapshot) => void): () => void;
}

/** An OS-level notification, shown by the Electron main process. */
export interface DesktopNotification {
  title: string;
  body: string;
  /** True to suppress the OS notification sound. */
  silent?: boolean;
}

export interface PixelDesktopApi {
  /** Presence of a `true` value marks the desktop build. */
  isDesktop: true;
  getServerUrl(): Promise<string | null>;
  setServerUrl(url: string): Promise<void>;
  /** Forgets the saved server URL so the next boot returns to the Connection screen. */
  clearServerUrl(): Promise<void>;
  /** Main performs the `/health` fetch (avoids renderer CORS/mixed-content quirks). */
  probeServer(url: string): Promise<boolean>;
  /** Decrypts the bearer token from safeStorage. */
  getToken(): Promise<string | null>;
  /** Encrypts the bearer token to safeStorage. */
  setToken(token: string): Promise<void>;
  clearToken(): Promise<void>;
  /** Optional explicit screen-source picker (see AC-021). */
  pickScreenSource(): Promise<{ id: string } | null>;
  /** Closes the window that made the call (quits the app on Linux/Windows). */
  closeWindow(): Promise<void>;
  /** Opens/closes DevTools for the calling window's web contents. */
  toggleDevTools(): Promise<void>;
  /** Reloads the calling window from the main process (reliable under app://). */
  reload(): Promise<void>;
  /** Shows an OS notification via the main process. */
  notify(notification: DesktopNotification): Promise<void>;
  /** Mumble voice client (desktop only). */
  mumble: MumbleApi;
  /** TimeTracking client (desktop only). */
  timeTracking: TimeTrackingApi;
}

declare global {
  interface Window {
    pixelDesktop?: PixelDesktopApi;
  }
}

/** True only in the Electron renderer, where preload injected `window.pixelDesktop`. */
export function isDesktop(): boolean {
  return typeof window.pixelDesktop !== 'undefined' && window.pixelDesktop.isDesktop === true;
}

/** The typed desktop API. Throws if called outside the desktop build. */
export function desktop(): PixelDesktopApi {
  const api = window.pixelDesktop;
  if (!api || api.isDesktop !== true) {
    throw new Error('desktop() called in a non-desktop environment');
  }
  return api;
}

/** The Mumble client, or null in the browser (where there is no Electron main
 *  process to hold the TLS socket). One guarded accessor so renderer code never
 *  has to branch on `isDesktop()` itself. */
export function mumbleApi(): MumbleApi | null {
  return isDesktop() ? (window.pixelDesktop?.mumble ?? null) : null;
}

/** The TimeTracking client, or null in the browser — where there is no main
 *  process to hold the credential, so the feature genuinely does not exist
 *  rather than merely being unconfigured. The time clock tells those two apart
 *  by this being null (see TimeTrackingUI). */
export function timeTrackingApi(): TimeTrackingApi | null {
  return isDesktop() ? (window.pixelDesktop?.timeTracking ?? null) : null;
}

/**
 * Reload the app reliably on both platforms. Renderer-initiated
 * `window.location.reload()` is silently dropped in the Electron `app://` shell,
 * so on desktop we reload via the main-process IPC; the browser uses the normal
 * `location.reload()`. Use this instead of `window.location.reload()` anywhere a
 * reload must also work in the desktop build (reconnect, sign-out, change-server).
 */
export function reloadApp(): void {
  if (isDesktop()) void desktop().reload();
  else window.location.reload();
}

/**
 * Raise an OS notification, or do nothing in the browser build (which has no
 * permission-free path to one — the web Notification API would prompt, and a
 * background tab prompt is worse than no notification). Never throws and never
 * needs awaiting: a notification is an aside to whatever the caller is doing.
 */
export function notifyDesktop(title: string, body: string, silent = false): void {
  if (!isDesktop()) return;
  void desktop()
    .notify({ title, body, silent })
    .catch(() => undefined);
}

/**
 * The configured server origin for the desktop build, held synchronously so the
 * `window.location`-shaped origin functions in `room.ts` can stay synchronous.
 * The desktop screens flow (T3.x/T4.2) reads the async `getServerUrl()` IPC and
 * populates this before the world connect. Null until then.
 */
let configuredServerOrigin: string | null = null;

/** Set the desktop configured server origin (called by the screens flow). */
export function setConfiguredServerOrigin(origin: string | null): void {
  configuredServerOrigin = origin;
}

/** The desktop configured server origin, or null if not yet set. */
export function getConfiguredServerOrigin(): string | null {
  return configuredServerOrigin;
}
