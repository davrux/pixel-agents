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
export interface PixelDesktopApi {
  /** Presence of a `true` value marks the desktop build. */
  isDesktop: true;
  getServerUrl(): Promise<string | null>;
  setServerUrl(url: string): Promise<void>;
  /** Main performs the `/health` fetch (avoids renderer CORS/mixed-content quirks). */
  probeServer(url: string): Promise<boolean>;
  /** Decrypts the bearer token from safeStorage. */
  getToken(): Promise<string | null>;
  /** Encrypts the bearer token to safeStorage. */
  setToken(token: string): Promise<void>;
  clearToken(): Promise<void>;
  /** Optional explicit screen-source picker (see AC-021). */
  pickScreenSource(): Promise<{ id: string } | null>;
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
