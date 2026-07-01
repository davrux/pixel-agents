import { app, BrowserWindow, ipcMain, protocol, shell } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, sep } from 'node:path';
import { readFile } from 'node:fs/promises';
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

// In-memory persistence for the typed IPC contract. safeStorage-backed
// encryption at rest for the token and durable storage of the server URL are
// T4.3; the screen-source picker is T4.4. This task wires the plumbing so the
// renderer bridge's accessors resolve against real handlers.
let serverUrl: string | null = null;
let bearerToken: string | null = null;

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
  ipcMain.handle(channels.getServerUrl, (): string | null => serverUrl);
  ipcMain.handle(channels.setServerUrl, (_event, url: string): void => {
    serverUrl = url;
  });
  ipcMain.handle(channels.probeServer, (_event, url: string): Promise<boolean> => probeServer(url));
  ipcMain.handle(channels.getToken, (): string | null => bearerToken);
  ipcMain.handle(channels.setToken, (_event, token: string): void => {
    bearerToken = token;
  });
  ipcMain.handle(channels.clearToken, (): void => {
    bearerToken = null;
  });
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
