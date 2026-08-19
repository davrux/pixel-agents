/**
 * The panel that covers the canvas until the world's art is actually in hand.
 *
 * Why it exists at all: sheets, the atlas, the catalog and the layout arrive over four
 * independent channels — two HTTP, two websocket — and nothing ordered them. The first
 * frames were therefore drawn from whatever had landed: grey floors, black boxes where
 * trees belong, dozens of "no art for OW_7_5" warnings, all repainted a moment later
 * once the rest showed up. Waiting is both honest and cheaper than painting the world
 * twice.
 *
 * Presentation only, and deliberately DOM rather than Phaser: it has to be up before
 * the renderer has any textures, and it must not depend on the very thing it is waiting
 * for. Colours come from the tokens in OfficeScene's stylesheet (`.pa-panel`, the
 * primary red) so it looks like the rest of the chrome rather than like a browser
 * default.
 */

export interface LoadingProgress {
  /** Announce one more thing to wait for. Safe to call while already running. */
  expect(count?: number): void;
  /** One of them is done. `label` replaces the line under the bar. */
  advance(label?: string): void;
  /** Say what is happening without moving the bar. */
  say(label: string): void;
  /** Take it down. Idempotent — a second call (or a failure path) is harmless. */
  finish(): void;
}

const STYLE_ID = 'pa-loading-style';
const CSS = `
.pa-loading {
  position: fixed; inset: 0; z-index: 40;
  display: flex; align-items: center; justify-content: center;
  background: #171514;
  font-family: 'FS Pixel Sans', ui-monospace, monospace;
  transition: opacity .18s ease-out;
}
.pa-loading.gone { opacity: 0; pointer-events: none; }
.pa-loading-box {
  min-width: 18rem; max-width: min(28rem, 80vw);
  padding: 1.1rem 1.25rem 1.25rem;
  background: #1c1a19; border: 2px solid #0a0908; border-radius: .6rem;
  box-shadow: inset 0 2px 0 #292725, inset 0 -3px 0 #030303, 0 12px 28px rgba(0,0,0,.55);
  color: #f1efec;
}
.pa-loading-title { font-size: .95rem; letter-spacing: .04em; margin-bottom: .8rem; }
.pa-loading-track {
  height: .7rem; background: #141312; border: 2px solid #0a0908; border-radius: .3rem;
  overflow: hidden;
}
.pa-loading-fill {
  height: 100%; width: 0%; background: #c51a1b;
  box-shadow: inset 0 2px 0 #e2585a, inset 0 -2px 0 #5c0f10;
  transition: width .12s linear;
}
.pa-loading-note { margin-top: .6rem; font-size: .8rem; color: #adb0b2; min-height: 1.1em; }
`;

/**
 * Put the panel up and return the handle that moves it.
 *
 * `expected` is the number of steps known at the start; more can be announced later
 * (the ref images are only countable once the layout is known), and the bar simply
 * rescales — better an honest bar that slows down than one that lies about being done.
 */
export function showLoadingOverlay(title: string, expected: number): LoadingProgress {
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
  }
  const root = document.createElement('div');
  root.className = 'pa-loading';
  root.innerHTML =
    `<div class="pa-loading-box" role="status" aria-live="polite">` +
    `<div class="pa-loading-title"></div>` +
    `<div class="pa-loading-track"><div class="pa-loading-fill"></div></div>` +
    `<div class="pa-loading-note"></div></div>`;
  (root.querySelector('.pa-loading-title') as HTMLElement).textContent = title;
  document.body.appendChild(root);
  const fill = root.querySelector('.pa-loading-fill') as HTMLElement;
  const note = root.querySelector('.pa-loading-note') as HTMLElement;

  let total = Math.max(1, expected);
  let done = 0;
  let finished = false;
  const paint = () => {
    fill.style.width = `${Math.min(100, Math.round((done / total) * 100))}%`;
  };
  paint();

  return {
    expect(count = 1) {
      total += count;
      paint();
    },
    advance(label) {
      done++;
      if (label) note.textContent = label;
      paint();
    },
    say(label) {
      note.textContent = label;
    },
    finish() {
      if (finished) return;
      finished = true;
      done = total;
      paint();
      root.classList.add('gone');
      // Long enough for the fade, short enough that nobody waits on it.
      window.setTimeout(() => root.remove(), 200);
    },
  };
}
