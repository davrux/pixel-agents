import {
  app,
  BrowserWindow,
  desktopCapturer,
  ipcMain,
  Menu,
  Notification,
  protocol,
  safeStorage,
  session,
  shell,
} from 'electron';
import type { DesktopCapturerSource } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, sep } from 'node:path';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { ensureTrusted, isTrusted, loadTrustedCerts } from './certTrust.js';
import { PIXEL_DESKTOP_CHANNELS, type DesktopNotification } from './ipc.js';
import { registerMumbleIpc, shutdownMumble } from './mumble/service.js';

// Custom scheme serving the client Vite output. A registered "standard" +
// "secure" scheme gives the renderer a stable secure-context origin across
// launches — required for getUserMedia/WebRTC and for pa-zv-* localStorage
// persistence. A file:// origin is opaque/unstable and cannot provide this.
const APP_SCHEME = 'app';
// Fixed host so the origin (app://bundle) is identical on every launch.
const APP_HOST = 'bundle';
const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
const APP_INDEX = `${APP_ORIGIN}/index.html`;

const HERE = dirname(fileURLToPath(import.meta.url));

// desktop/src/main.ts -> client/dist (the existing client vite build output).
const DIST_ROOT = join(HERE, '..', '..', 'client', 'dist');

// Preload injected into the renderer; exposes the typed window.pixelDesktop API.
// Bundled to CommonJS (preload.cjs) because a sandboxed preload cannot be an
// ES module — with sandbox:true Electron only loads a CommonJS preload.
const PRELOAD_PATH = join(HERE, 'preload.cjs');

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
  // application/wasm enables WebAssembly.instantiateStreaming for the js-dos emulator.
  '.wasm': 'application/wasm',
  '.jsdos': 'application/octet-stream',
};

function contentType(filePath: string): string {
  const dot = filePath.lastIndexOf('.');
  const ext = dot === -1 ? '' : filePath.slice(dot).toLowerCase();
  return MIME_TYPES[ext] ?? 'application/octet-stream';
}

// Map an app:// request URL onto a file inside client/dist, rejecting any path
// that escapes the dist root (path-traversal guard).
function resolveDistPath(requestUrl: string): string | null {
  const { pathname } = new URL(requestUrl);
  const decoded = decodeURIComponent(pathname);
  const relative = decoded === '/' || decoded === '' ? 'index.html' : decoded.replace(/^\/+/, '');
  const resolved = normalize(join(DIST_ROOT, relative));
  if (resolved !== DIST_ROOT && !resolved.startsWith(DIST_ROOT + sep)) return null;
  return resolved;
}

async function serveBundle(request: Request): Promise<Response> {
  const filePath = resolveDistPath(request.url);
  if (!filePath) return new Response('Forbidden', { status: 403 });
  try {
    const body = await readFile(filePath);
    return new Response(body, { status: 200, headers: { 'content-type': contentType(filePath) } });
  } catch {
    return new Response('Not Found', { status: 404 });
  }
}

function isAppOrigin(targetUrl: string): boolean {
  try {
    // The custom `app:` scheme is not a WHATWG "special" scheme, so URL.origin is
    // the opaque string "null" — comparing it to APP_ORIGIN always fails and the
    // will-navigate guard would wrongly block legitimate in-app navigation (e.g.
    // reloadApp()'s reload of index.html itself). Compare scheme + host directly.
    const u = new URL(targetUrl);
    return u.protocol === `${APP_SCHEME}:` && u.host === APP_HOST;
  } catch {
    return false;
  }
}

// Durable persistence for the typed IPC contract, rooted at userData:
// - the bearer token is written as safeStorage ciphertext (OS keychain-backed;
//   AC-020) so it is never plaintext on disk and survives relaunch (AC-007);
// - the server URL is a plaintext JSON config (not a secret; Field Propagation Map).
// Files are resolved lazily (after app is ready) since app.getPath('userData')
// is only valid then. Unreadable/corrupt/undecryptable values are treated as
// absent so the boot flow falls through to Connection/SignIn, never a blank state.
const TOKEN_FILE = 'pixel-token.bin';
const CONFIG_FILE = 'pixel-config.json';

function tokenPath(): string {
  return join(app.getPath('userData'), TOKEN_FILE);
}

function configPath(): string {
  return join(app.getPath('userData'), CONFIG_FILE);
}

async function readServerUrl(): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(configPath(), 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && typeof (parsed as { serverUrl?: unknown }).serverUrl === 'string') {
      return (parsed as { serverUrl: string }).serverUrl;
    }
    return null;
  } catch {
    return null;
  }
}

async function writeServerUrl(url: string): Promise<void> {
  await writeFile(configPath(), JSON.stringify({ serverUrl: url }), 'utf8');
}

// Forgets the saved server URL. The next boot then finds no URL and falls
// through to the Connection screen (mirrors clearStoredToken; "Change server").
async function clearStoredServerUrl(): Promise<void> {
  await rm(configPath(), { force: true });
}

// --- TLS certificate trust (trust-on-first-use) --------------------------------
// The desktop app connects to a user-configured, self-hosted server that may
// present a self-signed / private-CA certificate Chromium won't trust by default
// (ERR_CERT_AUTHORITY_INVALID). Rather than disabling TLS verification globally,
// we intercept verification and, for a cert Chromium rejects, ask the user to
// explicitly trust THIS host's THIS certificate (shown by fingerprint). Accepted
// fingerprints are remembered per host so later launches connect silently. Certs
// Chromium already trusts are deferred to Chromium unchanged.
//
// The store + dialog live in ./certTrust.ts because the Mumble client's Node
// `tls` socket needs the same trust decisions, and this verify proc only covers
// Chromium's own network stack.
function registerCertificateTrust(getWindow: () => BrowserWindow | null): void {
  session.defaultSession.setCertificateVerifyProc((request, callback) => {
    const { hostname, certificate, verificationResult } = request;
    if (verificationResult === 'net::OK') {
      callback(-3); // already valid — defer to Chromium's own result
      return;
    }
    if (isTrusted(hostname, certificate.fingerprint)) {
      callback(0); // user previously trusted this exact cert for this host
      return;
    }
    void ensureTrusted(getWindow(), {
      host: hostname,
      subject: certificate.subjectName,
      issuer: certificate.issuerName,
      fingerprint: certificate.fingerprint,
      because: verificationResult,
    }).then((accepted) => {
      // trust -> the in-flight request proceeds, no reload needed
      callback(accepted ? 0 : -2);
    });
  });
}

// Reads and decrypts the stored bearer token. Returns null (treated as absent)
// when encryption is unavailable, the file is missing, or the ciphertext cannot
// be decrypted (e.g. corrupt or written under a different OS key).
async function readToken(): Promise<string | null> {
  if (!safeStorage.isEncryptionAvailable()) return null;
  let ciphertext: Buffer;
  try {
    ciphertext = await readFile(tokenPath());
  } catch {
    return null;
  }
  try {
    return safeStorage.decryptString(ciphertext);
  } catch {
    return null;
  }
}

// Encrypts the token to ciphertext at rest. The plaintext token is never
// written to disk and never logged.
async function writeToken(token: string): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('safeStorage encryption unavailable; refusing to persist token in plaintext');
  }
  const ciphertext = safeStorage.encryptString(token);
  await writeFile(tokenPath(), ciphertext);
}

async function clearStoredToken(): Promise<void> {
  await rm(tokenPath(), { force: true });
}

// Reachability probe: main performs the /health fetch so the renderer avoids
// CORS/mixed-content quirks. Returns false on any non-2xx or network error.
async function probeServer(rawUrl: string): Promise<boolean> {
  let healthUrl: string;
  try {
    const base = new URL(rawUrl);
    if (base.protocol !== 'http:' && base.protocol !== 'https:') return false;
    healthUrl = new URL('/health', base).toString();
  } catch {
    return false;
  }
  try {
    const response = await fetch(healthUrl, { method: 'GET' });
    return response.ok;
  } catch {
    return false;
  }
}

// Screen-share (AC-021). The renderer's LiveKitConference calls
// navigator.mediaDevices.getDisplayMedia(); in Electron that call is only
// satisfied when the main process answers via setDisplayMediaRequestHandler.
// The handler enumerates real screen/window sources with desktopCapturer and
// grants one back to the renderer.
//
// Linux note (DD Fact 7 / risk row): on X11 getSources enumerates sources
// directly; on Wayland capture is routed through xdg-desktop-portal / PipeWire,
// but the handler must still be registered so getDisplayMedia resolves rather
// than rejecting for lack of a handler. Some Wayland portals present their own
// selection UI. If a distro's portal blocks capture, that is validated/escalated
// during manual FR-4/AC-021 testing (T5.3).

// One-shot id chosen by an explicit pickScreenSource() call. When set, the next
// display-media request honors it; otherwise the handler defaults to the first
// screen source (whole-screen share, matching the browser default). Consumed
// on use so a stale choice never leaks into a later, unrelated request.
let pendingScreenSourceId: string | null = null;

async function listScreenSources(): Promise<DesktopCapturerSource[]> {
  // thumbnailSize 0x0 skips thumbnail capture — the current AC needs only ids.
  return desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 0, height: 0 },
  });
}

// Explicit picker (PixelDesktopApi.pickScreenSource). Records the chosen id for
// the next getDisplayMedia and returns it; null when no source is available or
// enumeration fails (the renderer treats null as "no explicit choice").
async function pickScreenSource(): Promise<{ id: string } | null> {
  let sources: DesktopCapturerSource[];
  try {
    sources = await listScreenSources();
  } catch {
    return null;
  }
  const chosen = sources[0];
  if (!chosen) return null;
  pendingScreenSourceId = chosen.id;
  return { id: chosen.id };
}

// Answers renderer getDisplayMedia calls. Grants the pending explicit choice
// when present, else the first screen source. Denies with callback({}) when no
// source is available or enumeration fails — this rejects the renderer promise
// so LiveKitConference.setScreenShareEnabled throws and its existing catch
// reverts screenOn=false (Error Handling — Media row). No client code change.
function registerDisplayMediaHandler(): void {
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    void listScreenSources()
      .then((sources) => {
        const source = selectScreenSource(sources);
        pendingScreenSourceId = null; // one-shot: consume any explicit choice
        if (source) {
          callback({ video: source });
        } else {
          callback({}); // no source -> reject getDisplayMedia (cancel/deny path)
        }
      })
      .catch(() => {
        pendingScreenSourceId = null;
        callback({}); // enumeration failed -> reject; renderer reverts screenOn
      });
  });
}

function selectScreenSource(sources: DesktopCapturerSource[]): DesktopCapturerSource | undefined {
  if (pendingScreenSourceId) {
    const chosen = sources.find((source) => source.id === pendingScreenSourceId);
    if (chosen) return chosen;
  }
  const screen = sources.find((source) => source.id.startsWith('screen:'));
  return screen ?? sources[0];
}

/**
 * Show an OS notification for the renderer. The renderer's own `Notification`
 * constructor is not used: under the custom app:// scheme its permission state
 * is unreliable, and going through main means one place owns the click-to-focus
 * behaviour. A platform without a notification service is not an error — the
 * message is an aside, so we simply skip it.
 */
function showNotification(window: BrowserWindow | null, options: DesktopNotification): void {
  if (!Notification.isSupported()) return;
  const title = String(options?.title ?? '').slice(0, 120);
  const body = String(options?.body ?? '').slice(0, 500);
  if (!title && !body) return;
  const notification = new Notification({ title, body, silent: options?.silent === true });
  notification.on('click', () => {
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });
  notification.show();
}

function registerIpcHandlers(getWindow: () => BrowserWindow | null): void {
  const channels = PIXEL_DESKTOP_CHANNELS;
  registerMumbleIpc(getWindow);
  ipcMain.handle(channels.getServerUrl, (): Promise<string | null> => readServerUrl());
  ipcMain.handle(channels.setServerUrl, (_event, url: string): Promise<void> => writeServerUrl(url));
  ipcMain.handle(channels.clearServerUrl, (): Promise<void> => clearStoredServerUrl());
  ipcMain.handle(channels.probeServer, (_event, url: string): Promise<boolean> => probeServer(url));
  ipcMain.handle(channels.getToken, (): Promise<string | null> => readToken());
  ipcMain.handle(channels.setToken, (_event, token: string): Promise<void> => writeToken(token));
  ipcMain.handle(channels.clearToken, (): Promise<void> => clearStoredToken());
  ipcMain.handle(channels.keychainAvailable, (): boolean => safeStorage.isEncryptionAvailable());
  ipcMain.handle(channels.pickScreenSource, (): Promise<{ id: string } | null> => pickScreenSource());
  ipcMain.handle(channels.closeWindow, (event): void => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });
  ipcMain.handle(channels.toggleDevTools, (event): void => {
    event.sender.toggleDevTools();
  });
  ipcMain.handle(channels.reload, (event): void => {
    // Reload the current document (respects a query set via history.replaceState),
    // driven from the main process because renderer-side location.reload() is
    // unreliable under the app:// scheme.
    event.sender.reload();
  });
  ipcMain.handle(channels.notify, (event, options: DesktopNotification): void => {
    showNotification(BrowserWindow.fromWebContents(event.sender) ?? getWindow(), options);
  });
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: '#14161c',
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Allow DevTools to be opened via the Developer menu (Electron's default,
      // stated explicitly so the menu's Toggle DevTools item always works).
      devTools: true,
    },
  });

  // Origin allowlisting: the renderer may only navigate within the app:// bundle
  // origin. Any other origin is denied; http/https links open in the system browser.
  window.webContents.on('will-navigate', (event, targetUrl) => {
    if (isAppOrigin(targetUrl)) return;
    event.preventDefault();
    openExternalIfWeb(targetUrl);
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternalIfWeb(url);
    return { action: 'deny' };
  });

  void window.loadURL(APP_INDEX);
  return window;
}

function openExternalIfWeb(targetUrl: string): void {
  try {
    const { protocol: scheme } = new URL(targetUrl);
    if (scheme === 'http:' || scheme === 'https:') void shell.openExternal(targetUrl);
  } catch {
    // Ignore malformed URLs; nothing to open.
  }
}

// safeStorage backend selection (Linux). Electron/Chromium auto-detects the OS
// keyring from the desktop-environment NAME, not from what is actually on D-Bus.
// On compositors it does not recognize (Hyprland, sway and other tiling WMs) it
// falls back to the "basic" plaintext store, for which
// safeStorage.isEncryptionAvailable() is false — so writeToken() refuses to
// persist the bearer token and desktop sign-in fails ("Sign-in failed…"). Force
// the libsecret backend so any running Secret Service provider (gnome-keyring,
// or KWallet's org.freedesktop.secrets shim) is used regardless of the DE name.
// Where no keyring exists at all this simply reports unavailable, exactly as
// before — no regression. macOS/Windows keep their native Keychain/DPAPI backends.
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('password-store', 'gnome-libsecret');
}

// Registered before app ready so the scheme is treated as a standard, secure
// origin (stable secure context) rather than a plain custom protocol.
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

// Single-instance lock (P3): a second launch focuses the existing window.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  let mainWindow: BrowserWindow | null = null;

  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  void app.whenReady().then(async () => {
    // Drop the default application menu bar (File/Edit/View/Window/Help). The
    // app's own in-canvas HUD (`#pa-menubar`) is the only chrome we want; this
    // removes the strip entirely on Linux/Windows (macOS keeps a minimal system
    // menu, which the OS requires). Also kills the Alt-to-reveal menu behaviour.
    // Window controls (close app, toggle DevTools) are exposed to the renderer
    // via the window-control IPC channels instead.
    Menu.setApplicationMenu(null);

    // Windows attributes toast notifications to an AppUserModelID; without one
    // they are credited to electron.exe or dropped outright. Match the
    // electron-builder `appId` so our toasts and the installed shortcut agree.
    if (process.platform === 'win32') app.setAppUserModelId('org.pixelagents.desktop');

    protocol.handle(APP_SCHEME, serveBundle);
    registerIpcHandlers(() => mainWindow);
    registerDisplayMediaHandler();
    // Load remembered cert trust and install the verify proc BEFORE the window
    // loads, so the first connection attempt is already intercepted.
    await loadTrustedCerts();
    registerCertificateTrust(() => mainWindow);
    mainWindow = createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
    });
  });

  // Close the Mumble socket before quitting so the voice server sees a clean
  // leave rather than a half-open connection lingering until its ping timeout.
  app.on('before-quit', () => shutdownMumble());

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
