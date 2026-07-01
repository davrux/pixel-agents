import { contextBridge, ipcRenderer } from 'electron';
import { PIXEL_DESKTOP_CHANNELS, type PixelDesktopApi } from './ipc.js';

/**
 * Preload bridge. Exposes the minimal typed `window.pixelDesktop` API to the
 * renderer via `contextBridge.exposeInMainWorld`. Every renderer -> main call is
 * an `ipcRenderer.invoke` to a typed `ipcMain.handle` handler; no Node globals
 * (`process`, `require`, `Buffer`, …) leak across the contextIsolation boundary.
 */
const api: PixelDesktopApi = {
  isDesktop: true,
  getServerUrl: () => ipcRenderer.invoke(PIXEL_DESKTOP_CHANNELS.getServerUrl),
  setServerUrl: (url: string) => ipcRenderer.invoke(PIXEL_DESKTOP_CHANNELS.setServerUrl, url),
  clearServerUrl: () => ipcRenderer.invoke(PIXEL_DESKTOP_CHANNELS.clearServerUrl),
  probeServer: (url: string) => ipcRenderer.invoke(PIXEL_DESKTOP_CHANNELS.probeServer, url),
  getToken: () => ipcRenderer.invoke(PIXEL_DESKTOP_CHANNELS.getToken),
  setToken: (token: string) => ipcRenderer.invoke(PIXEL_DESKTOP_CHANNELS.setToken, token),
  clearToken: () => ipcRenderer.invoke(PIXEL_DESKTOP_CHANNELS.clearToken),
  pickScreenSource: () => ipcRenderer.invoke(PIXEL_DESKTOP_CHANNELS.pickScreenSource),
};

contextBridge.exposeInMainWorld('pixelDesktop', api);
