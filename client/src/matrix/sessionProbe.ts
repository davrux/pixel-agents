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
