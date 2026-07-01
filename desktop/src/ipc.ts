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
  probeServer: 'pixelDesktop:probeServer',
  getToken: 'pixelDesktop:getToken',
  setToken: 'pixelDesktop:setToken',
  clearToken: 'pixelDesktop:clearToken',
  pickScreenSource: 'pixelDesktop:pickScreenSource',
} as const;

export type PixelDesktopChannel =
  (typeof PIXEL_DESKTOP_CHANNELS)[keyof typeof PIXEL_DESKTOP_CHANNELS];

/**
 * The typed API injected as `window.pixelDesktop` in the desktop renderer.
 * Absent in the browser build, where `isDesktop()` is therefore false.
 */
export interface PixelDesktopApi {
  /** Presence of a `true` value marks the desktop build. */
  isDesktop: true;
  getServerUrl(): Promise<string | null>;
  setServerUrl(url: string): Promise<void>;
  /** Main performs the `/health` fetch (avoids renderer CORS/mixed-content quirks). */
  probeServer(url: string): Promise<boolean>;
  /** Decrypts the bearer token from safeStorage (T4.3). */
  getToken(): Promise<string | null>;
  /** Encrypts the bearer token to safeStorage (T4.3). */
  setToken(token: string): Promise<void>;
  clearToken(): Promise<void>;
  /** Optional explicit screen-source picker (see AC-021; implemented in T4.4). */
  pickScreenSource(): Promise<{ id: string } | null>;
}
