/**
 * Shared desktop session flows (boot, reauth, sign-out) used by every entry
 * page (index, voxel, rooms). All functions here are desktop-only: callers
 * must guard with `isDesktop()` before invoking them.
 */
import { desktop, reloadApp, setConfiguredServerOrigin } from './bridge';
import { showConnectionScreen } from '../screens/connection';
import { showSignInScreen } from '../screens/signin';
import { serverHttpOrigin } from '../net/room';

/**
 * Desktop-only pre-world routing (DD § State Transitions and Invariants):
 * Connection → SignIn → world (Authenticating). The screens own their internal
 * transitions (probe `/health`, token exchange); this function only decides
 * which screens to show before booting Phaser.
 *
 * A saved server URL skips the Connection screen (AC-003); a stored token skips
 * the Sign-in screen (AC-007). A returning user with both goes straight to the
 * world (the `saved URL + token --> Authenticating` transition). An unreadable
 * token is treated as absent so the flow falls through to Sign-in — never a
 * blank Connected (DD invariant).
 */
export async function runDesktopBootFlow(): Promise<void> {
  let savedUrl: string | null = null;
  try {
    savedUrl = await desktop().getServerUrl();
  } catch {
    savedUrl = null;
  }

  if (savedUrl !== null && savedUrl !== '') {
    setConfiguredServerOrigin(savedUrl);
  } else {
    // showConnectionScreen sets the configured origin and persists the URL on resolve.
    await showConnectionScreen();
  }

  let savedToken: string | null = null;
  try {
    savedToken = await desktop().getToken();
  } catch {
    savedToken = null;
  }

  if (savedToken === null || savedToken === '') {
    // showSignInScreen stores the issued token on resolve.
    await showSignInScreen();
  }
}

/** Desktop auth recovery (AC-009): drop the rejected token, sign in again in-app,
 *  then reload so the boot flow reads the new token from safeStorage and lands
 *  back in the current page — a rejected token deterministically returns to SignIn. */
export async function desktopReauth(): Promise<void> {
  await desktop().clearToken();
  await showSignInScreen();
  reloadApp();
}

/** Desktop sign-out (AC-008): revoke the server session via `POST /desktop/signout`
 *  (idempotent, best-effort), clear the stored bearer token so `getToken()` returns
 *  null (never a stale reuse), then re-run the in-app sign-in flow. There is no
 *  server logout page to navigate to on desktop, so this replaces `gotoLogout()`. */
export async function desktopSignOut(): Promise<void> {
  try {
    const token = await desktop().getToken();
    if (token) {
      await fetch(`${serverHttpOrigin()}/desktop/signout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      });
    }
  } catch {
    // Best-effort server revocation: even if the request fails, still clear the
    // local token below so the client cannot reuse it (the session also expires
    // server-side). The token is never logged.
  }
  await desktop().clearToken();
  await showSignInScreen();
  reloadApp();
}
