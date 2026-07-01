import Phaser from 'phaser';
import { OfficeScene } from './scenes/OfficeScene.js';
import { isDesktop, desktop, setConfiguredServerOrigin } from './desktop/bridge';
import { showConnectionScreen } from './screens/connection';
import { showSignInScreen } from './screens/signin';

/** Wait for the pixel font so Phaser/labels measure correctly on first render. */
async function loadFonts(): Promise<void> {
  try {
    await document.fonts.load("8px 'FS Pixel Sans'");
    await document.fonts.ready;
  } catch {
    /* fall back to the CSS stack */
  }
}

/** Boot the Phaser world. On desktop, `OfficeScene`→`connect()` reads the
 *  configured origin + stored token from the desktop bridge (the Authenticating
 *  → Connected leg of the state machine). */
function bootGame(): void {
  new Phaser.Game({
    type: Phaser.AUTO,
    parent: 'game',
    backgroundColor: '#14161c',
    pixelArt: true,
    scale: { mode: Phaser.Scale.RESIZE, width: window.innerWidth, height: window.innerHeight },
    render: { antialias: false, roundPixels: true },
    scene: [OfficeScene],
  });
}

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
async function runDesktopBootFlow(): Promise<void> {
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

void loadFonts().then(async () => {
  // Browser build (`isDesktop()` false): boot Phaser directly — unchanged path.
  if (isDesktop()) {
    await runDesktopBootFlow();
  }
  bootGame();
});
