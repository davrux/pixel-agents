/**
 * "A newer build is available" — the toolbar indicator a wire-incompatible client shows.
 *
 * Why it exists: the browser gets its bundle from the same deployment it talks to, so
 * a mismatch there is a stale cache and a reload fixes it. The desktop app is the real
 * case — invariant #10, it runs its OWN bundle from an `app://` origin against a
 * remote server, and it only ever updates when the user lets it (the self-updater in
 * desktop/src/updater.ts never runs on its own). Removing one synced schema field
 * shifts every field index after it, and an older desktop build then decodes
 * characters into nonsense with no error anywhere. That is the failure this reports.
 *
 * This used to be a non-dismissable dialog carrying a manual `curl` one-liner. It is a
 * chip in the top bar now, deliberately quieter: the world stays visible and playable
 * behind a mismatch it may be drawing wrongly, which is a trade this UI makes on
 * purpose — the report is one click from fixing itself rather than in the way.
 *
 * Clicking it drives the desktop self-updater: check, download (progress on the chip),
 * install-and-relaunch. Where that cannot work — macOS refuses updates without a real
 * signature, a dev start, a build predating the updater — the chip says so and stays,
 * so the reason is readable instead of being a dead control. In the browser it just
 * reloads.
 *
 * What it can NOT do: warn builds that shipped before it existed. A client too old to
 * know about `protocol` also cannot be told about it — the gate covers every break
 * from here on, not the one that introduced it.
 */
import { isDesktop, reloadApp, updatesApi } from '../desktop/bridge';

/** The chip in the top bar, once createUpdateIndicator has built it. */
let chip: HTMLButtonElement | null = null;
let label: HTMLElement | null = null;
/** Why this build is out of step, or null while it still matches. Kept even when
 *  no chip exists yet: the mismatch can be detected before the bar is built. */
let reason: string | null = null;

/**
 * Build the (hidden) top-bar chip. The caller decides where in the bar it sits;
 * everything about *when* it appears and what it does belongs here. Call once —
 * a second call replaces the element the first one handed out.
 */
export function createUpdateIndicator(): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'pa-btn pa-update';
  b.style.display = 'none';
  const ico = document.createElement('span');
  ico.className = 'ico';
  ico.textContent = '⬆';
  const text = document.createElement('span');
  text.textContent = 'Update';
  b.append(ico, text);
  b.onclick = () => void onClick();
  chip = b;
  label = text;
  if (reason) paint(reason); // the mismatch landed before the bar existed
  return b;
}

/**
 * Show the indicator if `serverProtocol` disagrees with what this build speaks.
 * Idempotent and silent when they match, so it can be called on every join.
 *
 * A server that sends no protocol number predates the field — treated as compatible,
 * because refusing to run against it would be worse than the mismatch it cannot have.
 * Such a server is instead caught by its own state, see `reportStateMismatch` below.
 */
export function checkProtocol(serverProtocol: unknown, ownProtocol: number, serverVersion?: string): void {
  if (reason) return;
  if (typeof serverProtocol !== 'number' || serverProtocol === ownProtocol) return;
  flag(
    `protocol: server ${serverProtocol}, this build ${ownProtocol}` +
      (serverVersion ? ` · server ${serverVersion}` : ''),
  );
}

/**
 * Same indicator, raised because the world arrived UNDECODABLE rather than because the
 * two numbers disagreed — a synced value the server cannot possibly have written (see
 * the callers in OfficeScene). That is proof of a schema this build doesn't share, and
 * it catches the two cases the number can't: a server OLDER than the gate, which sends
 * no protocol number at all and is therefore treated as compatible, and a wire change
 * that shipped without its PROTOCOL_VERSION bump. Idempotent, like checkProtocol — the
 * offending state repeats every tick.
 */
export function reportStateMismatch(what: string): void {
  if (reason) return;
  flag(`undecodable state: ${what}`);
}

function flag(detail: string): void {
  reason = detail;
  paint(detail);
}

function paint(detail: string): void {
  if (!chip) return;
  chip.style.display = '';
  chip.title = isDesktop()
    ? `This app and the server speak different protocol versions (${detail}). Characters and ` +
      'furniture may be drawn wrongly — click to update and restart.'
    : `This tab is running a different build than the server (${detail}), usually a cached ` +
      'one. Click to reload.';
}

/** True while an update run is in flight — a second click must not start a
 *  parallel download of the same package. */
let updating = false;

/**
 * The one-click path: check → download (progress on the chip) → install, which
 * quits and relaunches the app. Every failure — including "this build cannot
 * self-update" — re-arms the chip and explains itself in its tooltip, so the
 * reason survives being read later.
 */
async function onClick(): Promise<void> {
  if (!isDesktop()) {
    reloadApp();
    return;
  }
  if (updating || !chip || !label) return;
  updating = true;
  chip.disabled = true;

  const fail = (message: string): void => {
    if (!chip || !label) return;
    label.textContent = 'Update';
    chip.title = `${message} — click to try again.`;
    chip.disabled = false;
    updating = false;
  };

  // Null on a desktop build older than the updater itself (its bundle ships
  // inside the shell, so normally the two match).
  const api = updatesApi();
  if (!api) {
    fail('This app version cannot update itself yet');
    return;
  }

  const off = api.onEvent((ev) => {
    if (ev.t === 'progress' && label) label.textContent = `${Math.round(ev.percent)} %`;
  });
  try {
    label.textContent = 'Checking…';
    const found = await api.check();
    if (found.status === 'unsupported') return fail(`Not possible here: ${found.reason}`);
    if (found.status === 'error') return fail(`Update check failed: ${found.error}`);
    if (found.status === 'none') {
      // The feed has nothing newer although the protocol mismatches — a build
      // for the new protocol simply is not published yet.
      return fail(`No newer package published yet (the feed offers ${found.version})`);
    }
    label.textContent = 'Downloading…';
    const dl = await api.download();
    if (!dl.ok) return fail(`Download failed: ${dl.error ?? 'unknown error'}`);
    label.textContent = 'Restarting…';
    await api.install();
    // From here the main process quits and relaunches; nothing left to do.
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  } finally {
    off();
  }
}
