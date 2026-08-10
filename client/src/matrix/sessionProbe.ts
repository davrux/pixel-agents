/**
 * Zero-import leaf module. This is the one thing under client/src/matrix/
 * that OfficeScene.ts (the host) is allowed to import STATICALLY — everything
 * else here pulls in matrix-js-sdk (directly or transitively via ./sdk.js),
 * and a static import of that from the main bundle would defeat the whole
 * point of loading Matrix as a lazy chunk. Keep this file import-free.
 */

/** localStorage key holding the persisted MxSession JSON for a pixel-agents
 *  user. Unchanged from the pre-SDK client. */
export function storageKey(paUserId: string): string {
  return `pa-mx:${paUserId || '_'}`;
}

/** Cheap presence check — no JSON parse, no chunk beyond this small module —
 *  so the host can decide whether to eagerly load the Matrix chunk and start
 *  background sync (for the unread badge) without paying for the whole
 *  panel just to find out. */
export function hasMatrixSession(paUserId: string): boolean {
  try {
    return localStorage.getItem(storageKey(paUserId)) !== null;
  } catch {
    return false;
  }
}

/**
 * Every pixel-agents user id that has a stored Matrix session on this device.
 *
 * For the case where the pixel-agents server is unreachable: Matrix talks to a
 * homeserver, not to us, so it can work perfectly well while we are down — but
 * the session is filed under the pixel user id, and that normally arrives in a
 * `viewerIdentity` message from the server. This answers the only question that
 * identity was needed for ("which stored session do I resume?") without asking
 * the server, and when exactly one session is on the device there is nothing to
 * disambiguate.
 *
 * `storageKey('')` writes `pa-mx:_`, so an id of `'_'` round-trips back to the
 * same key and namespace — no special case needed for the anonymous viewer.
 *
 * The `pa-mx:` prefix is deliberately the colon form: every other key this
 * feature owns is `pa-mx-…` (`pa-mx-ck:`, `pa-mx-nsgen:`, `pa-mx-draft:`,
 * `pa-mx-view`, `pa-mx-win-…`), so this can never scoop one up.
 */
export function storedSessionUserIds(): string[] {
  const prefix = 'pa-mx:';
  const out: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(prefix)) out.push(k.slice(prefix.length));
    }
  } catch {
    return []; // private mode
  }
  return out;
}
