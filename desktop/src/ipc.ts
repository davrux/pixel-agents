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
  keychainAvailable: 'pixelDesktop:keychainAvailable',
  pickScreenSource: 'pixelDesktop:pickScreenSource',
  closeWindow: 'pixelDesktop:closeWindow',
  toggleDevTools: 'pixelDesktop:toggleDevTools',
  reload: 'pixelDesktop:reload',
  notify: 'pixelDesktop:notify',
  setUnreadCount: 'pixelDesktop:setUnreadCount',
  // Mumble voice. Control is invoke/handle like everything above; audio is
  // fire-and-forget in both directions because a promise per 20 ms frame would
  // be pure overhead at 50 packets/s.
  mumbleConnect: 'pixelDesktop:mumbleConnect',
  mumbleDisconnect: 'pixelDesktop:mumbleDisconnect',
  mumbleJoinChannel: 'pixelDesktop:mumbleJoinChannel',
  mumbleSetListening: 'pixelDesktop:mumbleSetListening',
  mumbleQueryPermissions: 'pixelDesktop:mumbleQueryPermissions',
  mumbleSelfState: 'pixelDesktop:mumbleSelfState',
  mumbleSendText: 'pixelDesktop:mumbleSendText',
  mumbleSelfRegister: 'pixelDesktop:mumbleSelfRegister',
  mumbleGetSettings: 'pixelDesktop:mumbleGetSettings',
  mumbleSetSettings: 'pixelDesktop:mumbleSetSettings',
  mumblePickCertFile: 'pixelDesktop:mumblePickCertFile',
  mumbleSendAudio: 'pixelDesktop:mumbleSendAudio', // renderer -> main, send
  mumbleEvent: 'pixelDesktop:mumbleEvent', // main -> renderer
  mumbleAudio: 'pixelDesktop:mumbleAudio', // main -> renderer
  // TimeTracking. Same shape as Mumble's control channels, and for the same
  // reason: the credential and the third-party connection live in main, and the
  // renderer only ever sees derived state.
  ttGetSettings: 'pixelDesktop:ttGetSettings',
  ttSetSettings: 'pixelDesktop:ttSetSettings',
  ttDisconnect: 'pixelDesktop:ttDisconnect',
  ttGetStatus: 'pixelDesktop:ttGetStatus',
  ttBook: 'pixelDesktop:ttBook',
  ttStatusEvent: 'pixelDesktop:ttStatusEvent', // main -> renderer
} as const;

export type PixelDesktopChannel =
  (typeof PIXEL_DESKTOP_CHANNELS)[keyof typeof PIXEL_DESKTOP_CHANNELS];

/** An OS-level notification, shown by the main process via Electron's
 *  `Notification` (native notification centre / libnotify / toast). */
export interface DesktopNotification {
  title: string;
  body: string;
  /** True to suppress the OS notification sound. */
  silent?: boolean;
}

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
  /** Channels this user has an ear in (Mumble 1.4 ChannelListener): they hear
   *  those as well as their own, without leaving it. */
  listening: number[];
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
  | { t: 'permission'; reason: string }
  /** What we are allowed to do in one channel: Murmur's ACL bitfield (see
   *  `PermissionQueryMsg` in mumble/protocol.ts for the bits, and `MUMBLE_PERM`
   *  in the renderer for the names). `flush` means every cached answer is stale
   *  — it arrives unsolicited when an admin edits an ACL, and then carries no
   *  channel of its own. */
  | { t: 'permissions'; channel?: number; permissions?: number; flush: boolean };

/** Pushed from main on the `mumbleAudio` channel: one Opus packet. */
export interface MumbleAudioIn {
  session: number;
  /** Sender's sequence number, in 10 ms units. Lets the renderer tell a gap in
   *  the stream apart from a talker who simply stopped. */
  sequence: number;
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
  /** Place or remove an ear in another channel — we keep hearing our own and
   *  hear that one too. Needs the Listen permission there. */
  setListening(channelId: number, listening: boolean): Promise<void>;
  /** Ask what we may do in a channel; answered by a `permissions` event. */
  queryPermissions(channelId: number): Promise<void>;
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

// ── TimeTracking ─────────────────────────────────────────────────────────────

/** The coarse status the world shows. Mirrors `WorkStatus` in
 *  `@pixel/shared/timetracking` — this workspace is self-contained and cannot
 *  import it, and the renderer reconciles the two structurally, exactly as it
 *  does for everything else in this file. */
export type WorkStatus = '' | 'working' | 'break' | 'homeoffice' | 'trip' | 'away';

/** The three buttons on the time clock's face. */
export type WorkAction = 'start' | 'pause' | 'end';

/** Connection details. The password is never part of this — see
 *  TimeTrackingSettingsPatch for the write-only path. */
export interface TimeTrackingSettings {
  /** Origin of the TimeTracking install; '' when unconfigured. */
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

/**
 * Everything the clock's face needs, derived in main so the renderer needs to
 * know nothing about booking types or the vendor's DFA of legal transitions.
 */
export interface WorkSnapshot {
  configured: boolean;
  status: WorkStatus;
  /** Epoch ms the running entry began, or null. The face adds `now - this` so
   *  its clock ticks without polling. */
  runningSince: number | null;
  /** Today's already-closed working time, in ms. */
  completedMs: number;
  /** Which buttons the install permits right now — already resolved from its
   *  `allowedBookings`, so the renderer just enables or disables. */
  can: Record<WorkAction, boolean>;
  /** Epoch ms this snapshot was taken; 0 when never fetched. */
  asOf: number;
  /** Human-readable reason the last refresh failed, or null. */
  error: string | null;
}

export interface TimeTrackingApi {
  getSettings(): Promise<TimeTrackingSettingsView>;
  /** Validates by really logging in; rejects (with a message) rather than
   *  storing credentials that don't work. */
  setSettings(
    patch: TimeTrackingSettingsPatch,
  ): Promise<{ ok: true; view: TimeTrackingSettingsView; displayName: string } | { ok: false; error: string }>;
  /** Forget the stored account entirely. */
  disconnect(): Promise<TimeTrackingSettingsView>;
  /** Cached snapshot, refreshed first if stale. */
  getStatus(): Promise<WorkSnapshot>;
  book(action: WorkAction): Promise<{ ok: true; snapshot: WorkSnapshot } | { ok: false; error: string }>;
  /** Pushed whenever main refreshes the status (its own poll, or a booking), so
   *  the renderer can forward it to the pixel-agents server without polling
   *  main in turn. Returns an unsubscribe function. */
  onStatus(cb: (snapshot: WorkSnapshot) => void): () => void;
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
  /** Encrypts the bearer token to safeStorage (T4.3). Rejects when there is no
   *  OS keychain, rather than persisting the token in plaintext. */
  setToken(token: string): Promise<void>;
  clearToken(): Promise<void>;
  /** Whether safeStorage can actually encrypt — i.e. whether `setToken` can
   *  succeed. Lets the sign-in screen tell a missing keyring apart from a
   *  network failure instead of blaming the connection for both. */
  keychainAvailable(): Promise<boolean>;
  /** Optional explicit screen-source picker (see AC-021; implemented in T4.4). */
  pickScreenSource(): Promise<{ id: string } | null>;
  /** Closes the window that made the call. Quits the app on Linux/Windows —
   *  unless the user turned on the tray's "Close button hides to tray", which
   *  this path deliberately honours too, so the HUD's ✕ and the OS titlebar's
   *  behave alike. */
  closeWindow(): Promise<void>;
  /** Opens/closes DevTools for the calling window's web contents. */
  toggleDevTools(): Promise<void>;
  /** Reloads the calling window from the main process. Renderer-initiated
   *  `location.reload()` is unreliable in the app:// shell; this always works. */
  reload(): Promise<void>;
  /** Shows an OS notification. Resolves whether or not the platform showed one
   *  — a notification is an aside, never something the caller must handle. */
  notify(notification: DesktopNotification): Promise<void>;
  /** Reports the number of unread chat messages, for the system tray icon and
   *  the dock/launcher badge. The renderer owns the Matrix session, so it is the
   *  only side that can know this; main only decides how to display it. Safe to
   *  call with the same value repeatedly — main ignores a count that has not
   *  changed. */
  setUnreadCount(count: number): Promise<void>;
  /** Mumble voice client (protocol + TLS live in main; audio lives here). */
  mumble: MumbleApi;
  /** TimeTracking (credential + third-party HTTP live in main). */
  timeTracking: TimeTrackingApi;
}
