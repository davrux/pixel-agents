/**
 * Viewer identity (username) used for per-user sound filtering.
 *
 * Two sources feed the effective username, in priority order:
 *   1. settings username — explicitly chosen in the Settings modal (persisted server-side)
 *   2. login username — from standalone auth (the `viewerIdentity` message)
 *
 * The settings value wins when set; otherwise the login value applies. When both
 * are empty, the viewer has no identity and task sounds play for all agents.
 */

let settingsUsername = '';
let loginUsername = '';

/** Set the login (auth) username — from the `viewerIdentity` message. */
export function setLoginUsername(name: string | undefined): void {
  loginUsername = name ?? '';
}

/** Set the settings username — from `settingsLoaded` or a Settings-modal edit. */
export function setSettingsUsername(name: string): void {
  settingsUsername = name;
}

/** Effective viewer username ('' = none → sounds play for all agents). */
export function getViewerUsername(): string {
  return settingsUsername || loginUsername;
}
