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
 *
 * **A mismatch has a direction, and only one direction is this app's problem.** The
 * first version compared the two numbers for inequality and offered "Update" either
 * way, which is wrong half the time: when the SERVER is the older side, this build is
 * already the newest one that exists, no package is published that would change the
 * number, and clicking could only ever report "no newer package published yet". That
 * is the reported symptom — a chip that appears after a reconnect (a reconnect follows
 * a server restart, i.e. a deploy) with no update behind it. So `standing` records
 * which side is behind, and the chip only offers an update when the answer is "this
 * one". In the BROWSER both directions still resolve by reloading: the bundle comes
 * from the server being talked to, so a tab ahead of its server is a cached bundle
 * from a newer deployment and a reload fetches the matching one.
 *
 * **And the chip does not promise an action it has not checked.** Where this build is
 * the older side and can self-update, the feed is asked once, quietly, before the
 * label says "Update" — because a protocol bump lands in a deployment well before an
 * AppImage is published for it, and during that window "Update" is a button that
 * cannot do what it says.
 */
import { isDesktop, reloadApp, updatesApi } from '../desktop/bridge';

/** The chip in the top bar, once createUpdateIndicator has built it. */
let chip: HTMLButtonElement | null = null;
let label: HTMLElement | null = null;
/** Why this build is out of step, or null while it still matches. Kept even when
 *  no chip exists yet: the mismatch can be detected before the bar is built. */
let reason: string | null = null;

/**
 * Which side is the older one — the whole point being that they are not the same
 * problem.
 *  - `behind` — this build is older than the server. Updating it is the fix.
 *  - `ahead`  — the SERVER is older. Nothing this app can install changes that; the
 *               deployment is what needs updating.
 *  - `unknown` — the numbers agreed (or the server sent none) and the world arrived
 *               undecodable anyway, so there is nothing to compare. Treated like
 *               `behind`: a wire change that shipped without its bump is far more
 *               likely to be a new server than an old one.
 */
type Standing = 'behind' | 'ahead' | 'unknown';
let standing: Standing = 'unknown';

/** Whether the update feed actually offers a newer package, once asked. Only ever
 *  set for a `behind` desktop build — the one case where the answer changes what the
 *  chip should say. `null` = not asked / not applicable. */
let feedHasBuild: boolean | null = null;

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
  if (reason) paint(); // the mismatch landed before the bar existed
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
    // In the browser the bundle comes from this very server, so whichever number is
    // higher the resolution is the same reload — never tell a tab its server is at
    // fault for what a reload fixes.
    !isDesktop() || serverProtocol > ownProtocol ? 'behind' : 'ahead',
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
  flag(`undecodable state: ${what}`, 'unknown');
}

function flag(detail: string, which: Standing): void {
  reason = detail;
  standing = which;
  paint();
  // Only worth asking where the answer changes the label: a desktop build that is
  // the older side and could install something. One request, on a mismatch that has
  // already happened — not per join.
  if (which !== 'ahead') void askFeed();
}

/**
 * Ask the update feed, once, whether a newer package exists — so "Update" is only
 * offered when there is something to install. Silent by design: a failed or
 * unsupported check leaves the chip offering the update, whose click path already
 * explains itself, which is better than hiding a real incompatibility behind a
 * network error.
 */
async function askFeed(): Promise<void> {
  if (!isDesktop() || feedHasBuild !== null) return;
  const api = updatesApi();
  if (!api) return; // pre-updater build; its click says so
  try {
    const found = await api.check();
    if (found.status !== 'available' && found.status !== 'none') return;
    feedHasBuild = found.status === 'available';
    paint();
  } catch {
    // Leave the chip as it is; see above.
  }
}

/** True when clicking can actually resolve the mismatch. */
function actionable(): boolean {
  return standing !== 'ahead' && feedHasBuild !== false;
}

function paint(): void {
  if (!chip || !label) return;
  chip.style.display = '';
  // An update run owns the label while it lasts ('Checking…', a percentage,
  // 'Restarting…'). A feed answer arriving late must not overwrite that; `fail`
  // and the relaunch are what end it.
  if (updating) return;
  const detail = reason ?? '';

  if (!isDesktop()) {
    label.textContent = 'Update';
    chip.title =
      `This tab is running a different build than the server (${detail}), usually a cached ` +
      'one. Click to reload.';
    return;
  }

  if (standing === 'ahead') {
    // Nothing to install: this build is already newer than what it is talking to.
    // Say which side is behind, because "Update" here sends someone looking for a
    // release that does not exist.
    label.textContent = 'Server old';
    chip.title =
      `The server is running an older protocol than this app (${detail}). Characters and ` +
      'furniture may be drawn wrongly. This app is already the newer build — the server ' +
      'is what needs updating, so there is nothing to install here.';
    return;
  }

  if (feedHasBuild === false) {
    // The mismatch is real, but the matching build has not been published yet — the
    // window between deploying a server and releasing the app.
    label.textContent = 'Mismatch';
    chip.title =
      `This app and the server speak different protocol versions (${detail}). Characters and ` +
      'furniture may be drawn wrongly. No newer app package is published yet, so there is ' +
      'nothing to install — click to check again.';
    return;
  }

  label.textContent = 'Update';
  chip.title =
    `This app and the server speak different protocol versions (${detail}). Characters and ` +
    'furniture may be drawn wrongly — click to update and restart.';
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
  // The server is the older side: there is no package that would fix this, and the
  // tooltip already says who has to act. Better an inert chip than one that goes
  // looking for a release nobody published.
  if (standing === 'ahead') return;
  if (updating || !chip || !label) return;
  updating = true;
  chip.disabled = true;

  const fail = (message: string): void => {
    if (!chip || !label) return;
    // Not always "Update": once the feed has said it holds nothing newer, the label
    // must stop offering one (see paint).
    label.textContent = actionable() ? 'Update' : 'Mismatch';
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
      // for the new protocol simply is not published yet. Remembered, so the chip
      // stops advertising an update it has now been told does not exist.
      feedHasBuild = false;
      return fail(`No newer package published yet (the feed offers ${found.version})`);
    }
    feedHasBuild = true;
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
