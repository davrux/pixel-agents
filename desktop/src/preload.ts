import { contextBridge, ipcRenderer } from 'electron';
import {
  PIXEL_DESKTOP_CHANNELS,
  type DesktopNotification,
  type MumbleAudioIn,
  type MumbleEvent,
  type MumbleSettingsPatch,
  type PixelDesktopApi,
} from './ipc.js';

/**
 * Preload bridge. Exposes the minimal typed `window.pixelDesktop` API to the
 * renderer via `contextBridge.exposeInMainWorld`. Every renderer -> main call is
 * an `ipcRenderer.invoke` to a typed `ipcMain.handle` handler; no Node globals
 * (`process`, `require`, `Buffer`, …) leak across the contextIsolation boundary.
 *
 * The Mumble audio channels are the one exception to invoke/handle: they are
 * fire-and-forget in both directions, since a promise per 20 ms frame would be
 * pure overhead. Their subscription wrappers deliberately drop Electron's event
 * object and hand the renderer only the payload.
 */
function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_event: unknown, payload: T): void => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

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
  closeWindow: () => ipcRenderer.invoke(PIXEL_DESKTOP_CHANNELS.closeWindow),
  toggleDevTools: () => ipcRenderer.invoke(PIXEL_DESKTOP_CHANNELS.toggleDevTools),
  reload: () => ipcRenderer.invoke(PIXEL_DESKTOP_CHANNELS.reload),
  notify: (notification: DesktopNotification) =>
    ipcRenderer.invoke(PIXEL_DESKTOP_CHANNELS.notify, notification),
  mumble: {
    connect: () => ipcRenderer.invoke(PIXEL_DESKTOP_CHANNELS.mumbleConnect),
    disconnect: () => ipcRenderer.invoke(PIXEL_DESKTOP_CHANNELS.mumbleDisconnect),
    joinChannel: (id: number) => ipcRenderer.invoke(PIXEL_DESKTOP_CHANNELS.mumbleJoinChannel, id),
    selfState: (state: { selfMute: boolean; selfDeaf: boolean }) =>
      ipcRenderer.invoke(PIXEL_DESKTOP_CHANNELS.mumbleSelfState, state),
    sendText: (message: string) => ipcRenderer.invoke(PIXEL_DESKTOP_CHANNELS.mumbleSendText, message),
    selfRegister: () => ipcRenderer.invoke(PIXEL_DESKTOP_CHANNELS.mumbleSelfRegister),
    getSettings: () => ipcRenderer.invoke(PIXEL_DESKTOP_CHANNELS.mumbleGetSettings),
    setSettings: (patch: MumbleSettingsPatch) =>
      ipcRenderer.invoke(PIXEL_DESKTOP_CHANNELS.mumbleSetSettings, patch),
    pickCertFile: () => ipcRenderer.invoke(PIXEL_DESKTOP_CHANNELS.mumblePickCertFile),
    sendAudio: (frame: Uint8Array) => ipcRenderer.send(PIXEL_DESKTOP_CHANNELS.mumbleSendAudio, frame),
    onEvent: (cb: (event: MumbleEvent) => void) => subscribe(PIXEL_DESKTOP_CHANNELS.mumbleEvent, cb),
    onAudio: (cb: (audio: MumbleAudioIn) => void) => subscribe(PIXEL_DESKTOP_CHANNELS.mumbleAudio, cb),
  },
};

contextBridge.exposeInMainWorld('pixelDesktop', api);
