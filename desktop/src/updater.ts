/**
 * Self-update (electron-updater).
 *
 * The feed is the rolling "latest" GitHub release: electron-builder bakes a
 * GENERIC-provider `app-update.yml` into the package (see `publish` in
 * electron-builder.yml), and the CI release job uploads the versioned
 * artifacts plus the `latest*.yml` channel files next to the stable-URL
 * aliases. Generic and not the github provider on purpose — that one resolves
 * releases by semver TAG, and the rolling release's tag is the non-semver
 * literal `latest`.
 *
 * What can actually update itself:
 *  - Linux, but only running as an AppImage (the updater swaps the file
 *    `$APPIMAGE` points at and relaunches). A future .deb/.rpm install has no
 *    file to swap.
 *  - Windows (NSIS). Unsigned is fine here; SmartScreen only fronts the first
 *    manual install.
 *  - macOS never: Squirrel.Mac verifies the code signature before applying an
 *    update, and this build is ad-hoc signed. Those users keep the manual
 *    instructions (and electron-builder.yml sets `mac.publish: null`, so a mac
 *    package does not even carry a feed it could not use).
 *
 * Nothing checks by itself. The rolling channel gets a new version on every
 * master commit, so a background updater would churn binaries for changes that
 * do not matter to a running client — the protocol gate (versionGate.ts) is
 * the signal an update is actually NEEDED, and the tray item is the manual
 * path. Both are user-triggered.
 *
 * electron-updater is a devDependency BUNDLED to dist/vendor/ at build time
 * (`build:vendor`, same pattern as the preload bundle), so the desktop package
 * keeps declaring no runtime dependencies and electron-builder keeps packaging
 * nothing but our own dist. Loaded via createRequire because this module
 * compiles to ESM and the bundle is CJS.
 */
import { app, dialog, ipcMain, BrowserWindow } from 'electron';
import { createRequire } from 'node:module';
import { PIXEL_DESKTOP_CHANNELS, type UpdateCheckStatus, type UpdateEvent } from './ipc.js';
import type { AppUpdater } from 'electron-updater';

const requireVendor = createRequire(import.meta.url);

let getWindow: () => BrowserWindow | null = () => null;

/** Lazily constructed: requiring the bundle is cheap, but AppUpdater's
 *  constructor touches `app`, and nothing needs it before the first check. */
let updater: AppUpdater | null = null;

function sendEvent(event: UpdateEvent): void {
  const wc = getWindow()?.webContents;
  if (wc && !wc.isDestroyed()) wc.send(PIXEL_DESKTOP_CHANNELS.updatesEvent, event);
}

function getUpdater(): AppUpdater {
  if (updater) return updater;
  const { autoUpdater } = requireVendor(
    './vendor/electron-updater.cjs',
  ) as typeof import('electron-updater');
  // Both steps stay explicit renderer/tray calls; the one automatism kept is
  // "a download that already happened installs on quit" (autoInstallOnAppQuit),
  // because throwing a fetched update away would only mean fetching it again.
  autoUpdater.autoDownload = false;
  autoUpdater.on('download-progress', (progress) => {
    sendEvent({
      t: 'progress',
      percent: progress.percent,
      transferredBytes: progress.transferred,
      totalBytes: progress.total,
    });
  });
  autoUpdater.on('update-downloaded', (info) => {
    sendEvent({ t: 'downloaded', version: info.version });
  });
  // Always listened to: AppUpdater is an EventEmitter, and an 'error' with no
  // listener would crash the main process even though every await below
  // already surfaces the same failure to its caller.
  autoUpdater.on('error', (error) => {
    console.warn('[updater]', error?.message ?? error);
    sendEvent({ t: 'error', message: String(error?.message ?? error) });
  });
  updater = autoUpdater;
  return updater;
}

/** Whether THIS process can be updated in place — a fact about the build and
 *  how it is running, decided before electron-updater is even loaded. Reasons
 *  are English like the tray and the Settings panel that display them (the
 *  German version gate shows them verbatim too — two of its three consumers
 *  won the language). */
function support(): { ok: true } | { ok: false; reason: string } {
  if (!app.isPackaged) return { ok: false, reason: 'development start (not packaged)' };
  if (process.platform === 'darwin') {
    return { ok: false, reason: 'macOS refuses updates without a real signature' };
  }
  if (process.platform === 'linux' && !process.env.APPIMAGE) {
    return { ok: false, reason: 'not running as an AppImage' };
  }
  return { ok: true };
}

async function check(): Promise<UpdateCheckStatus> {
  const s = support();
  if (!s.ok) return { status: 'unsupported', reason: s.reason };
  try {
    const result = await getUpdater().checkForUpdates();
    if (!result) return { status: 'error', error: 'Updater ist in dieser Umgebung inaktiv' };
    return result.isUpdateAvailable
      ? { status: 'available', version: result.updateInfo.version }
      : { status: 'none', version: result.updateInfo.version };
  } catch (error) {
    return { status: 'error', error: error instanceof Error ? error.message : String(error) };
  }
}

async function download(): Promise<{ ok: boolean; error?: string }> {
  const s = support();
  if (!s.ok) return { ok: false, error: s.reason };
  try {
    // Requires a preceding successful check() — electron-updater rejects with
    // "Please check update first" otherwise, which lands in the error branch.
    await getUpdater().downloadUpdate();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function install(): void {
  // isSilent: the NSIS installer runs with /S rather than opening its wizard —
  // the user already said yes in the app. isForceRunAfter relaunches; on the
  // AppImage path both flags are ignored and the file swap relaunches anyway.
  // quitAndInstall fires app.quit(), so before-quit sets `quitting` and the
  // close-to-tray intercept lets the window actually close.
  getUpdater().quitAndInstall(true, true);
}

export function registerUpdaterIpc(windowGetter: () => BrowserWindow | null): void {
  getWindow = windowGetter;
  ipcMain.handle(PIXEL_DESKTOP_CHANNELS.updatesCheck, (): Promise<UpdateCheckStatus> => check());
  ipcMain.handle(PIXEL_DESKTOP_CHANNELS.updatesDownload, (): Promise<{ ok: boolean; error?: string }> => download());
  ipcMain.handle(PIXEL_DESKTOP_CHANNELS.updatesInstall, (): void => install());
}

let interactive = false;

/**
 * The tray's "Check for updates…": check, ask, download, relaunch — all through
 * native message boxes, since the renderer may be hidden to tray right now.
 * English like the rest of the tray menu. Never throws (a menu click has no
 * caller to catch), and re-entry while a run is in flight is dropped.
 */
export async function checkForUpdatesInteractive(): Promise<void> {
  if (interactive) return;
  interactive = true;
  try {
    const window = getWindow();
    const box = (options: Electron.MessageBoxOptions): Promise<Electron.MessageBoxReturnValue> =>
      window && !window.isDestroyed() ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options);

    const found = await check();
    if (found.status === 'unsupported') {
      await box({ type: 'info', message: 'Self-update is not available here.', detail: found.reason });
      return;
    }
    if (found.status === 'error') {
      await box({ type: 'warning', message: 'Update check failed.', detail: found.error });
      return;
    }
    if (found.status === 'none') {
      await box({
        type: 'info',
        message: 'You are up to date.',
        detail: `Installed: ${app.getVersion()} — published: ${found.version}`,
      });
      return;
    }
    const answer = await box({
      type: 'question',
      message: `Update to ${found.version}?`,
      detail: `Installed: ${app.getVersion()}. The app downloads the update and restarts.`,
      buttons: ['Update and restart', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });
    if (answer.response !== 0) return;
    const dl = await download();
    if (!dl.ok) {
      await box({ type: 'warning', message: 'Update download failed.', detail: dl.error ?? '' });
      return;
    }
    install();
  } catch (error) {
    console.warn('[updater] interactive check failed:', error);
  } finally {
    interactive = false;
  }
}
