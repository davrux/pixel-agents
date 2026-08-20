import Phaser from 'phaser';
import { OfficeScene } from './scenes/OfficeScene.js';
import { isDesktop } from './desktop/bridge';
import { runDesktopBootFlow } from './desktop/boot';
import { guardFrames } from './render/frameGuard';

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
    // A throw inside a frame would otherwise stop Phaser asking for the next one —
    // a permanently frozen window rather than one dropped frame. See frameGuard.ts.
    callbacks: { postBoot: guardFrames },
  });
}

void loadFonts().then(async () => {
  // Browser build (`isDesktop()` false): boot Phaser directly — unchanged path.
  if (isDesktop()) {
    await runDesktopBootFlow();
  }
  bootGame();
});
