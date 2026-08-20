/**
 * Keep one bad frame from freezing the window for good.
 *
 * Phaser drives the world from `requestAnimationFrame`, and its RAF wrapper asks for
 * the NEXT frame only after the callback returns (`RequestAnimationFrame.step`). So an
 * exception anywhere inside a frame — a scene's `update`, a renderer sync, Phaser's own
 * draw — never reaches that line, no further frame is ever requested, and the game loop
 * is dead: the canvas holds its last image, the camera stops following, keys do nothing.
 * From the outside that is "the app froze", and only a restart clears it.
 *
 * That is a wildly disproportionate outcome for a frame that could not draw a sprite,
 * so the game's step runs inside a guard. A failing frame is skipped and the loop lives,
 * which keeps the chrome, the chat and the menus usable — including whatever the user
 * needs to reconnect or update. The error is still reported: loudly the first time,
 * then at most once a second, because a broken frame usually repeats 60 times a second
 * and a console that scrolls for a minute hides the first, useful stack.
 *
 * It is a backstop, not a licence: a frame that throws is a bug to fix where it throws.
 */

/** How often repeated failures are logged after the first (ms). */
const REPEAT_LOG_MS = 1000;

let failures = 0;
let lastLog = 0;

/**
 * Wrap the game's per-frame step. Call from Phaser's `postBoot` callback: `start()`
 * binds `game.step` into the loop immediately after that runs, so replacing the method
 * here is what the loop picks up.
 */
export function guardFrames(game: Phaser.Game): void {
  const step = game.step.bind(game);
  game.step = (time: number, delta: number): void => {
    try {
      step(time, delta);
    } catch (err) {
      onFrameError(err);
    }
  };
}

function onFrameError(err: unknown): void {
  failures++;
  const now = performance.now();
  if (failures === 1) {
    console.error(
      '[frameGuard] a frame threw — skipping it and keeping the loop alive. ' +
        'The world may draw wrong until this is fixed.',
      err,
    );
    lastLog = now;
    return;
  }
  if (now - lastLog < REPEAT_LOG_MS) return;
  lastLog = now;
  console.error(`[frameGuard] frame errors continue (${failures} so far)`, err);
}

/** How many frames have been skipped this session (0 = the loop never faltered). */
export function frameFailures(): number {
  return failures;
}
