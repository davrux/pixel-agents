/**
 * The television dialog: what opens when you walk up to one (Action `tvScreen`).
 *
 * A dialog, not a file picker opened straight away, and that is not a style choice: a browser
 * opens a file chooser only from a USER GESTURE, and "you arrived at the television" is a server
 * message, not a click. So the arrival opens this, and its button — a real click — opens the
 * chooser. Same in Chrome, Firefox and Electron.
 *
 * The ticket is what the room handed this client for this one television (see the server's
 * tvTickets.ts); the upload names nothing else, so there is nothing here a client could point at a
 * television it is not standing at.
 */
import { TV_UPLOAD_HEADER } from '@pixel/shared/office/tvScreen.js';

import { packTvPicture } from '../media/tvPicture.js';
import { openPaDialog } from './paDialog.js';

export function openTvDialog(opts: {
  ticket: string;
  /** Is a picture on this television right now? Offers "Switch off" when it is. */
  showing: boolean;
  /** `serverFetch` — the desktop app needs its bearer, and the server is not `location`. */
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
}): void {
  const body = document.createElement('div');
  const hint = document.createElement('p');
  hint.style.cssText = 'margin:0 0 .6rem;color:#adb0b2;font-size:.85rem;';
  hint.textContent = 'Put a picture or an animated GIF on this screen. Everyone in this zone will see it.';
  const status = document.createElement('div');
  status.style.cssText = 'min-height:1.1rem;font-size:.85rem;';
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*,.gif';
  input.style.display = 'none';
  body.append(hint, status, input);

  let busy = false;
  const say = (text: string, kind: 'info' | 'error' = 'info'): void => {
    status.textContent = text;
    // Muted for progress, the warn accent for a refusal (AGENTS.md § UI tokens).
    status.style.color = kind === 'error' ? '#e2585a' : '#adb0b2';
  };

  const header = (): Record<string, string> => ({ [TV_UPLOAD_HEADER]: JSON.stringify({ ticket: opts.ticket }) });
  const reason = async (res: Response): Promise<string> => {
    const j = (await res.json().catch(() => null)) as { error?: unknown } | null;
    return typeof j?.error === 'string' ? j.error : `HTTP ${res.status}`;
  };

  input.onchange = async () => {
    const file = input.files?.[0];
    input.value = '';
    if (!file || busy) return;
    busy = true;
    try {
      say('Preparing…');
      const pic = await packTvPicture(file);
      say(pic.delays.length > 1 ? `Uploading ${pic.delays.length} frames…` : 'Uploading…');
      const res = await opts.fetch('/tv/screen', {
        method: 'POST',
        headers: {
          'content-type': 'image/png',
          [TV_UPLOAD_HEADER]: JSON.stringify({ ticket: opts.ticket, frameW: pic.frameW, frameH: pic.frameH, delays: pic.delays }),
        },
        body: pic.png,
      });
      if (!res.ok) {
        say(`Refused: ${await reason(res)}`, 'error');
        return;
      }
      close();
    } catch (err) {
      say(err instanceof Error ? err.message : 'That did not work.', 'error');
    } finally {
      busy = false;
    }
  };

  const close = openPaDialog({
    title: 'Television',
    body,
    buttons: [
      ...(opts.showing
        ? [
            {
              label: 'Switch off',
              kind: 'danger' as const,
              onClick: () => {
                if (busy) return false;
                busy = true;
                void opts
                  .fetch('/tv/screen/clear', { method: 'POST', headers: header() })
                  .then(async (res) => (res.ok ? close() : say(`Refused: ${await reason(res)}`, 'error')))
                  .catch(() => say('The server did not answer.', 'error'))
                  .finally(() => (busy = false));
                return false;
              },
            },
          ]
        : []),
      {
        label: 'Choose picture…',
        kind: 'primary' as const,
        onClick: () => {
          // Inside the click handler on purpose: this is the user gesture the chooser needs.
          if (!busy) input.click();
          return false;
        },
      },
    ],
  });
}
