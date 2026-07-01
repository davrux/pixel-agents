import { app, BrowserWindow, ipcMain, protocol, safeStorage, shell } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, sep } from 'node:path';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { PIXEL_DESKTOP_CHANNELS } from './ipc.js';

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
const PRELOAD_PATH = join(HERE, 'preload.js');

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
    return new URL(targetUrl).origin === APP_ORIGIN;
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

function registerIpcHandlers(): void {
  const channels = PIXEL_DESKTOP_CHANNELS;
  ipcMain.handle(channels.getServerUrl, (): Promise<string | null> => readServerUrl());
  ipcMain.handle(channels.setServerUrl, (_event, url: string): Promise<void> => writeServerUrl(url));
  ipcMain.handle(channels.probeServer, (_event, url: string): Promise<boolean> => probeServer(url));
  ipcMain.handle(channels.getToken, (): Promise<string | null> => readToken());
  ipcMain.handle(channels.setToken, (_event, token: string): Promise<void> => writeToken(token));
  ipcMain.handle(channels.clearToken, (): Promise<void> => clearStoredToken());
  // Explicit screen-source picker is implemented in T4.4.
  ipcMain.handle(channels.pickScreenSource, (): { id: string } | null => null);
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

  void app.whenReady().then(() => {
    protocol.handle(APP_SCHEME, serveBundle);
    registerIpcHandlers();
    mainWindow = createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
