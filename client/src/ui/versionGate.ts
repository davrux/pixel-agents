/**
 * "This build no longer matches the server" — what a wire-incompatible client gets
 * instead of a world that silently renders wrong.
 *
 * Why it exists: the browser gets its bundle from the same deployment it talks to, so
 * a mismatch there is a stale cache and a reload fixes it. The desktop app is the real
 * case — invariant #10, it runs its OWN bundle from an `app://` origin against a
 * remote server, and it has no auto-updater. Removing one synced schema field shifts
 * every field index after it, and an older desktop build then decodes characters into
 * nonsense with no error anywhere. That is the failure this replaces.
 *
 * What it can NOT do: warn builds that shipped before it existed. A client too old to
 * know about `protocol` also cannot be told about it — the gate covers every break
 * from here on, not the one that introduced it.
 *
 * Not dismissable on purpose (`dismissable: false` — no Cancel, no ✕, Esc and
 * backdrop do nothing): behind it is a world whose entities decode wrongly, so
 * "carry on anyway" is not a state worth offering.
 */
import { isDesktop, reloadApp } from '../desktop/bridge';
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
 */
export function checkProtocol(serverProtocol: unknown, ownProtocol: number, serverVersion?: string): void {
  if (shown) return;
  if (typeof serverProtocol !== 'number' || serverProtocol === ownProtocol) return;
  shown = true;
  open(serverProtocol, ownProtocol, serverVersion);
}

function open(serverProtocol: number, ownProtocol: number, serverVersion?: string): void {
  const body = document.createElement('div');

  const why = document.createElement('p');
  why.style.cssText = 'margin:0 0 0.75rem;line-height:1.45;';
  why.textContent = isDesktop()
    ? 'Der Server spricht eine neuere Fassung des Protokolls. Diese App würde Figuren und Möbel ' +
      'falsch darstellen, ohne es zu melden — deshalb bitte erst aktualisieren.'
    : 'Dieses Fenster läuft mit einem älteren Programmstand als der Server (meist ein ' +
      'zwischengespeicherter Stand). Ein Neuladen holt den passenden.';
  body.appendChild(why);

  const detail = document.createElement('div');
  detail.style.cssText = 'color:#818586;font-size:0.85rem;margin:0 0 0.9rem;';
  detail.textContent =
    `Protokoll: Server ${serverProtocol}, diese Version ${ownProtocol}` +
    (serverVersion ? ` · Serverstand ${serverVersion}` : '');
  body.appendChild(detail);

  let copyBtn: { label: string } | null = null;
  if (isDesktop()) {
    const label = document.createElement('div');
    label.style.cssText = 'color:#adb0b2;font-size:0.85rem;margin:0 0 0.35rem;';
    label.textContent = 'Im Terminal ausführen, dann die App neu starten:';
    body.appendChild(label);

    const cmd = document.createElement('pre');
    cmd.textContent = UPDATE_COMMAND;
    // Deep-inset surface + 2px border, like every other inset field in the skin.
    cmd.style.cssText =
      'margin:0;padding:0.6rem;background:#141312;border:2px solid #0a0908;border-radius:0.35rem;' +
      "color:#f1efec;font:0.8rem/1.5 'FS Pixel Sans', ui-monospace, monospace;" +
      'white-space:pre-wrap;word-break:break-all;user-select:text;';
    body.appendChild(cmd);
    copyBtn = { label: 'Befehl kopieren' };
  }

  const buttons = isDesktop()
    ? [
        {
          label: copyBtn!.label,
          kind: 'primary' as const,
          // false keeps the dialog open — copying is not "done with this".
          onClick: () => {
            const btn = document.querySelector<HTMLButtonElement>('#pa-dialog-back .pa-b.primary');
            void navigator.clipboard?.writeText(UPDATE_COMMAND).then(
              () => btn && (btn.textContent = 'Kopiert ✓'),
              () => btn && (btn.textContent = 'Text markieren'),
            );
            return false;
          },
        },
        { label: 'Erneut verbinden', onClick: () => reloadApp() },
      ]
    : [{ label: 'Neu laden', kind: 'primary' as const, onClick: () => reloadApp() }];

  openPaDialog({ title: '⚠ Diese Version passt nicht zum Server', body, buttons, dismissable: false });
}
