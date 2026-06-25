import Phaser from 'phaser';
import { OfficeScene } from './scenes/OfficeScene.js';

/** Wait for the pixel font so Phaser/labels measure correctly on first render. */
async function loadFonts(): Promise<void> {
  try {
    await document.fonts.load("8px 'FS Pixel Sans'");
    await document.fonts.ready;
  } catch {
    /* fall back to the CSS stack */
  }
}

void loadFonts().then(() => {
  new Phaser.Game({
    type: Phaser.AUTO,
    parent: 'game',
    backgroundColor: '#14161c',
    pixelArt: true,
    scale: { mode: Phaser.Scale.RESIZE, width: window.innerWidth, height: window.innerHeight },
    render: { antialias: false, roundPixels: true },
    scene: [OfficeScene],
  });
});
