/**
 * The app's name and where its per-user state lives.
 *
 * Both are one decision, because Electron derives the second from the first:
 * `userData` defaults to `<appData>/<app.getName()>`, and `app.getName()`
 * defaults to the `name` field of the nearest package.json. Ours is the scoped
 * workspace name `@pixel/desktop`, so every launch to date has run with an app
 * name containing a slash — which the path join then reads as a directory
 * separator. Measured on a running build: state was landing in
 * `~/.config/@pixel/desktop/`, a nested pair of directories where one was meant,
 * holding `pixel-token.bin`, `pixel-config.json` and the trusted-cert store.
 *
 * The same name is also published on D-Bus as the tray item's `Id` (Chromium
 * builds it as `<app name>_status_icon_<n>`), where it read
 * `@pixel/desktop_status_icon_1` — an identifier hosts use for keying and icon
 * caching, carrying a path separator. Check it with the app running:
 *
 *   busctl --user get-property \
 *     org.freedesktop.StatusNotifierItem-<pid>-1 /StatusNotifierItem \
 *     org.kde.StatusNotifierItem Id
 *
 * So the name is set explicitly here, and `userData` is then PINNED rather than
 * left to follow it. Pinning is the point: a path derived from the app's name
 * silently relocates every stored credential the day somebody renames the app or
 * the package, and the failure mode is a user who is simply logged out with no
 * explanation. From here the directory name is a constant no rename can reach,
 * and the one-time move of the old directory is in userDataDir.ts.
 *
 * Call `configureAppPaths()` as the FIRST thing the main module does — before
 * `requestSingleInstanceLock()`, which keys the lock off `userData` and would
 * otherwise take the lock in the pre-pin directory, and before anything else
 * resolves a path from it.
 */
import { app } from 'electron';
import { mkdirSync } from 'node:fs';
import { resolveUserDataDir, type ResolveOutcome } from './userDataDir.js';

/** Display name: window titles, Linux notifications, the tray item's D-Bus Id. */
const APP_NAME = 'Pixel Agents';

/**
 * Set the app name and pin `userData`, migrating the legacy directory on the
 * first run that sees it. Never throws; returns what happened, for the caller to
 * log. A failure to set the path at all leaves Electron on its default — the
 * wrong directory beats no app.
 */
export function configureAppPaths(): ResolveOutcome {
  app.setName(APP_NAME);

  // `appData` is the parent (~/.config, ~/Library/Application Support,
  // %APPDATA%) and carries no app name, so it is unaffected by setName and has
  // the same shape on all three platforms.
  const { dir, outcome } = resolveUserDataDir(app.getPath('appData'));
  try {
    // setPath throws if the directory does not exist, so make sure it does.
    mkdirSync(dir, { recursive: true });
    app.setPath('userData', dir);
  } catch {
    // Nothing actionable here, and the app must still start.
  }
  return outcome;
}
