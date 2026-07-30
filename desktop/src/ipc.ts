/**
 * Single shared typed IPC contract for the desktop shell.
 *
 * `PixelDesktopApi` is the authoritative definition of the `window.pixelDesktop`
 * global. The Electron main process (`ipcMain.handle`), the preload
 * (`contextBridge.exposeInMainWorld` + `ipcRenderer.invoke`), and the renderer
 * bridge (`client/src/desktop/bridge.ts`) all agree on this shape.
 *
 * The renderer bridge keeps a structurally-identical local declaration rather
 * than importing this module: the client Vite bundle is the single UI source
 * (AC-018) and must stay free of desktop-workspace code and secrets. TypeScript
 * structural typing makes the object the preload exposes satisfy the renderer's
 * contract without a shared import.
 */

/** Channel names shared by the preload (`invoke`) and main (`handle`). */
export const PIXEL_DESKTOP_CHANNELS = {
  getServerUrl: 'pixelDesktop:getServerUrl',
  setServerUrl: 'pixelDesktop:setServerUrl',
  clearServerUrl: 'pixelDesktop:clearServerUrl',
  probeServer: 'pixelDesktop:probeServer',
  getToken: 'pixelDesktop:getToken',
  setToken: 'pixelDesktop:setToken',
  clearToken: 'pixelDesktop:clearToken',
  pickScreenSource: 'pixelDesktop:pickScreenSource',
  closeWindow: 'pixelDesktop:closeWindow',
  toggleDevTools: 'pixelDesktop:toggleDevTools',
  reload: 'pixelDesktop:reload',
  // Mumble voice. Control is invoke/handle like everything above; audio is
  // fire-and-forget in both directions because a promise per 20 ms frame would
  // be pure overhead at 50 packets/s.
  mumbleConnect: 'pixelDesktop:mumbleConnect',
  mumbleDisconnect: 'pixelDesktop:mumbleDisconnect',
  mumbleJoinChannel: 'pixelDesktop:mumbleJoinChannel',
  mumbleSelfState: 'pixelDesktop:mumbleSelfState',
  mumbleSendText: 'pixelDesktop:mumbleSendText',
  mumbleSelfRegister: 'pixelDesktop:mumbleSelfRegister',
  mumbleGetSettings: 'pixelDesktop:mumbleGetSettings',
  mumbleSetSettings: 'pixelDesktop:mumbleSetSettings',
  mumblePickCertFile: 'pixelDesktop:mumblePickCertFile',
  mumbleSendAudio: 'pixelDesktop:mumbleSendAudio', // renderer -> main, send
  mumbleEvent: 'pixelDesktop:mumbleEvent', // main -> renderer
  mumbleAudio: 'pixelDesktop:mumbleAudio', // main -> renderer
} as const;

export type PixelDesktopChannel =
  (typeof PIXEL_DESKTOP_CHANNELS)[keyof typeof PIXEL_DESKTOP_CHANNELS];

// ── Mumble voice ─────────────────────────────────────────────────────────────

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

/** Pushed from main on the `mumbleEvent` channel. */
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

/** Pushed from main on the `mumbleAudio` channel: one Opus packet. */
export interface MumbleAudioIn {
  session: number;
  terminator: boolean;
  opus: Uint8Array;
}

export interface MumbleSettings {
  host: string;
  port: number;
  username: string;
  /** Optional channel to join on connect. */
  channel: string;
  /** Path to the user's PKCS#12 identity, or null to connect as a guest. */
  certPath: string | null;
  autoConnect: boolean;
}

/** Settings as shown to the renderer: the secrets themselves never cross. */
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

export interface MumbleApi {
  connect(): Promise<{ ok: boolean; error?: string }>;
  disconnect(): Promise<void>;
  joinChannel(id: number): Promise<void>;
  selfState(state: { selfMute: boolean; selfDeaf: boolean }): Promise<void>;
  sendText(message: string): Promise<void>;
  selfRegister(): Promise<void>;
  getSettings(): Promise<MumbleSettingsView>;
  setSettings(patch: MumbleSettingsPatch): Promise<MumbleSettingsView>;
  /** Native file picker for a .p12/.pfx identity; null when cancelled. */
  pickCertFile(): Promise<string | null>;
  /** [flags, ...opus] — flag bit 0 marks the end of a talk spurt. */
  sendAudio(frame: Uint8Array): void;
  /** Both subscriptions return an unsubscribe function. */
  onEvent(cb: (event: MumbleEvent) => void): () => void;
  onAudio(cb: (audio: MumbleAudioIn) => void): () => void;
}

/**
 * The typed API injected as `window.pixelDesktop` in the desktop renderer.
 * Absent in the browser build, where `isDesktop()` is therefore false.
 */
export interface PixelDesktopApi {
  /** Presence of a `true` value marks the desktop build. */
  isDesktop: true;
  getServerUrl(): Promise<string | null>;
  setServerUrl(url: string): Promise<void>;
  /** Forgets the saved server URL so the next boot returns to the Connection screen. */
  clearServerUrl(): Promise<void>;
  /** Main performs the `/health` fetch (avoids renderer CORS/mixed-content quirks). */
  probeServer(url: string): Promise<boolean>;
  /** Decrypts the bearer token from safeStorage (T4.3). */
  getToken(): Promise<string | null>;
  /** Encrypts the bearer token to safeStorage (T4.3). */
  setToken(token: string): Promise<void>;
  clearToken(): Promise<void>;
  /** Optional explicit screen-source picker (see AC-021; implemented in T4.4). */
  pickScreenSource(): Promise<{ id: string } | null>;
  /** Closes the window that made the call (quits the app on Linux/Windows). */
  closeWindow(): Promise<void>;
  /** Opens/closes DevTools for the calling window's web contents. */
  toggleDevTools(): Promise<void>;
  /** Reloads the calling window from the main process. Renderer-initiated
   *  `location.reload()` is unreliable in the app:// shell; this always works. */
  reload(): Promise<void>;
  /** Mumble voice client (protocol + TLS live in main; audio lives here). */
  mumble: MumbleApi;
}
