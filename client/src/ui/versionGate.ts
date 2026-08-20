/**
 * "This build no longer matches the server" — what a wire-incompatible client gets
 * instead of a world that silently renders wrong.
 *
 * Why it exists: the browser gets its bundle from the same deployment it talks to, so
 * a mismatch there is a stale cache and a reload fixes it. The desktop app is the real
 * case — invariant #10, it runs its OWN bundle from an `app://` origin against a
 * remote server, and it only ever updates when the user lets it (the self-updater in
 * desktop/src/updater.ts never runs on its own). Removing one synced schema field
 * shifts every field index after it, and an older desktop build then decodes
 * characters into nonsense with no error anywhere. That is the failure this replaces.
 *
 * On desktop the primary button drives that self-updater: check, download (progress on
 * the button), install-and-relaunch. Where it cannot work — macOS refuses updates
 * without a real signature, a dev start, a build predating the updater — the flow says
 * so and the manual command below stays the way out, exactly as before.
 *
 * What it can NOT do: warn builds that shipped before it existed. A client too old to
 * know about `protocol` also cannot be told about it — the gate covers every break
 * from here on, not the one that introduced it.
 *
 * Not dismissable on purpose (`dismissable: false` — no Cancel, no ✕, Esc and
 * backdrop do nothing): behind it is a world whose entities decode wrongly, so
 * "carry on anyway" is not a state worth offering.
 */
import { isDesktop, reloadApp, updatesApi } from '../desktop/bridge';
import { openPaDialog } from './paDialog.js';

/** The one-liner that replaces the AppImage in place, as handed out with a release. */
const UPDATE_COMMAND =
  'curl -L -o ~/.local/share/AppImage/pixel-agents.AppImage ' +
  'https://github.com/davrux/pixel-agents/releases/download/latest/pixel-agents-latest-x86_64.AppImage ' +
  '&& chmod +x ~/.local/share/AppImage/pixel-agents.AppImage';

let shown = false;

/**
 * Show the gate if `serverProtocol` disagrees with what this build speaks. Idempotent
 * and silent when they match, so it can be called on every join.
 *
 * A server that sends no protocol number predates the field — treated as compatible,
 * because refusing to run against it would be worse than the mismatch it cannot have.
 * Such a server is instead caught by its own state, see `reportStateMismatch` below.
 */
export function checkProtocol(serverProtocol: unknown, ownProtocol: number, serverVersion?: string): void {
  if (shown) return;
  if (typeof serverProtocol !== 'number' || serverProtocol === ownProtocol) return;
  shown = true;
  open(
    `Protokoll: Server ${serverProtocol}, diese Version ${ownProtocol}` +
      (serverVersion ? ` · Serverstand ${serverVersion}` : ''),
  );
}

/**
 * Same gate, opened because the world arrived UNDECODABLE rather than because the two
 * numbers disagreed — a synced value the server cannot possibly have written (see the
 * callers in OfficeScene). That is proof of a schema this build doesn't share, and it
 * catches the two cases the number can't: a server OLDER than the gate, which sends no
 * protocol number at all and is therefore treated as compatible, and a wire change that
 * shipped without its PROTOCOL_VERSION bump. Idempotent, like checkProtocol — the
 * offending state repeats every tick.
 */
export function reportStateMismatch(what: string): void {
  if (shown) return;
  shown = true;
  open(`Unlesbarer Zustand: ${what}`);
}

function open(detailText: string): void {
  const body = document.createElement('div');

  const why = document.createElement('p');
  why.style.cssText = 'margin:0 0 0.75rem;line-height:1.45;';
  why.textContent = isDesktop()
    ? 'Diese App und der Server sprechen verschiedene Fassungen des Protokolls. Figuren und ' +
      'Möbel würden falsch dargestellt, ohne dass es jemand meldet — deshalb bitte erst aktualisieren.'
    : 'Dieses Fenster läuft mit einem anderen Programmstand als der Server (meist ein ' +
      'zwischengespeicherter Stand). Ein Neuladen holt den passenden.';
  body.appendChild(why);

  const detail = document.createElement('div');
  detail.style.cssText = 'color:#818586;font-size:0.85rem;margin:0 0 0.9rem;';
  detail.textContent = detailText;
  body.appendChild(detail);

  // Feedback line for the self-update flow (empty until something to say);
  // failures land here and the manual command below stays the way out.
  const status = document.createElement('div');
  status.style.cssText = 'color:#adb0b2;font-size:0.85rem;margin:0 0 0.9rem;white-space:pre-wrap;';

  if (isDesktop()) {
    body.appendChild(status);

    const label = document.createElement('div');
    label.style.cssText = 'color:#adb0b2;font-size:0.85rem;margin:0 0 0.35rem;';
    label.textContent = 'Oder von Hand: im Terminal ausführen, dann die App neu starten:';
    body.appendChild(label);

    const cmd = document.createElement('pre');
    cmd.textContent = UPDATE_COMMAND;
    // Deep-inset surface + 2px border, like every other inset field in the skin.
    cmd.style.cssText =
      'margin:0;padding:0.6rem;background:#141312;border:2px solid #0a0908;border-radius:0.35rem;' +
      "color:#f1efec;font:0.8rem/1.5 'FS Pixel Sans', ui-monospace, monospace;" +
      'white-space:pre-wrap;word-break:break-all;user-select:text;';
    body.appendChild(cmd);
  }

  // Resolved after openPaDialog below — dismissable:false means the foot holds
  // exactly our buttons, in order, with no injected Cancel ahead of them.
  let updateBtn: HTMLButtonElement | null = null;
  let copyBtn: HTMLButtonElement | null = null;

  const buttons = isDesktop()
    ? [
        {
          label: 'Automatisch aktualisieren',
          kind: 'primary' as const,
          // false keeps the dialog open — the flow reports into it, and on
          // success the app quits and relaunches out from under it anyway.
          onClick: () => {
            if (updateBtn) void runAutoUpdate(updateBtn, status);
            return false;
          },
        },
        {
          label: 'Befehl kopieren',
          // false keeps the dialog open — copying is not "done with this".
          onClick: () => {
            void navigator.clipboard?.writeText(UPDATE_COMMAND).then(
              () => copyBtn && (copyBtn.textContent = 'Kopiert ✓'),
              () => copyBtn && (copyBtn.textContent = 'Text markieren'),
            );
            return false;
          },
        },
        { label: 'Erneut verbinden', onClick: () => reloadApp() },
      ]
    : [{ label: 'Neu laden', kind: 'primary' as const, onClick: () => reloadApp() }];

  openPaDialog({ title: '⚠ Diese Version passt nicht zum Server', body, buttons, dismissable: false });

  if (isDesktop()) {
    const foot = document.querySelectorAll<HTMLButtonElement>('#pa-dialog-back .pa-foot .pa-b');
    updateBtn = foot[0] ?? null;
    copyBtn = foot[1] ?? null;
  }
}

/** True while an update run is in flight — a second click must not start a
 *  parallel download of the same package. */
let updating = false;

/**
 * The one-click path: check → download (progress on the button) → install,
 * which quits and relaunches the app. Every failure — including "this build
 * cannot self-update" — re-arms the button and explains itself in the status
 * line; the manual command stays visible below throughout.
 */
async function runAutoUpdate(btn: HTMLButtonElement, status: HTMLElement): Promise<void> {
  if (updating) return;
  updating = true;
  btn.disabled = true;
  status.textContent = '';

  const fail = (message: string): void => {
    status.textContent = `${message} — unten steht der manuelle Weg.`;
    btn.textContent = 'Automatisch aktualisieren';
    btn.disabled = false;
    updating = false;
  };

  // Null on a desktop build older than the updater itself (its bundle ships
  // inside the shell, so normally the two match).
  const api = updatesApi();
  if (!api) {
    fail('Diese App-Version kann sich noch nicht selbst aktualisieren');
    return;
  }

  const off = api.onEvent((ev) => {
    if (ev.t === 'progress') btn.textContent = `Lade… ${Math.round(ev.percent)} %`;
  });
  try {
    btn.textContent = 'Suche Update…';
    const found = await api.check();
    if (found.status === 'unsupported') return fail(`Hier nicht möglich: ${found.reason}`);
    if (found.status === 'error') return fail(`Updateprüfung fehlgeschlagen: ${found.error}`);
    if (found.status === 'none') {
      // The feed has nothing newer although the protocol mismatches — a build
      // for the new protocol simply is not published yet.
      return fail(`Noch kein neueres Paket veröffentlicht (Stand ${found.version})`);
    }
    btn.textContent = 'Lade…';
    const dl = await api.download();
    if (!dl.ok) return fail(`Download fehlgeschlagen: ${dl.error ?? 'unbekannter Fehler'}`);
    btn.textContent = 'Installiere & starte neu…';
    await api.install();
    // From here the main process quits and relaunches; nothing left to do.
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  } finally {
    off();
  }
}
