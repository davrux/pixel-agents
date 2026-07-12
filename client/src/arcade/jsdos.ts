/**
 * Thin loader + typing for the js-dos v8 player, self-hosted under /jsdos/.
 *
 * js-dos ships as a plain script that assigns `window.Dos` (no ESM export), so we
 * inject the stylesheet + script once and resolve the global. The WASM emulator
 * files live next to it under /jsdos/emulators/ (pointed at via `pathPrefix`), so
 * nothing is fetched from the js-dos CDN — everything is served by us.
 *
 * Only the option surface we actually use is typed here; see js-dos.com/player-api.
 */

export interface DosNetConfig {
  /** PeerJS-style signaling server for the WebRTC IPX transport. */
  peerServer?: string;
  token?: string;
  secret?: string;
  iceServers?: RTCIceServer[];
}

/** The subset of the js-dos CommandInterface we use (handed to onEvent on 'ci-ready'). */
export interface DosCommandInterface {
  /** Snapshot the filesystem as a `.jsdos` bundle; onlyChanges=true → just the diff. */
  persist(onlyChanges?: boolean): Promise<Uint8Array | null>;
}

/** A filesystem seed entry: a raw `.jsdos` bundle (e.g. a saved persist() blob) or a file. */
export type InitFsEntry = Uint8Array | { path: string; contents: Uint8Array };

export interface DosOptions {
  /** URL to a `.jsdos` bundle. */
  url?: string;
  /** Inline dosbox.conf (used when no bundle url). */
  dosboxConf?: string;
  /** Base URL for the emulators/*.wasm deployment files. */
  pathPrefix?: string;
  backend?: 'dosbox' | 'dosboxX';
  /** Extra files layered onto the bundle FS at boot — used to restore savegames. */
  initFs?: InitFsEntry[];
  /** Start the emulator immediately (no play button). */
  autoStart?: boolean;
  /** Hide js-dos' own chrome so our pixel-menu frame wraps the canvas. */
  kiosk?: boolean;
  /** Pointer-lock the mouse in the player — needed for Doom mouselook. */
  mouseCapture?: boolean;
  noCursor?: boolean;
  onEvent?: (event: string, ci?: DosCommandInterface) => void;
  /** Multiplayer: become the IPX server host. */
  startIpxServer?: boolean;
  /** Multiplayer: connect to a host's peer id / alias. */
  connectIpxAddress?: string;
  net?: DosNetConfig;
}

export interface DosInstance {
  stop: () => Promise<void>;
}

type DosFn = (element: HTMLElement, options: DosOptions) => DosInstance;

declare global {
  interface Window {
    Dos?: DosFn;
  }
}

const JSDOS_BASE = '/jsdos/';
export const JSDOS_PATH_PREFIX = `${JSDOS_BASE}emulators/`;

let loading: Promise<DosFn> | null = null;

/** Load the js-dos player script once and resolve the `Dos` global. */
export function loadJsDos(): Promise<DosFn> {
  if (window.Dos) return Promise.resolve(window.Dos);
  if (loading) return loading;
  loading = new Promise<DosFn>((resolve, reject) => {
    if (!document.getElementById('jsdos-css')) {
      const link = document.createElement('link');
      link.id = 'jsdos-css';
      link.rel = 'stylesheet';
      link.href = `${JSDOS_BASE}js-dos.css`;
      document.head.appendChild(link);
    }
    const s = document.createElement('script');
    s.id = 'jsdos-js';
    s.src = `${JSDOS_BASE}js-dos.js`;
    s.async = true;
    s.onload = () =>
      window.Dos ? resolve(window.Dos) : reject(new Error('js-dos.js loaded but window.Dos is missing'));
    s.onerror = () => {
      loading = null;
      reject(new Error('failed to load js-dos.js'));
    };
    document.head.appendChild(s);
  });
  return loading;
}
