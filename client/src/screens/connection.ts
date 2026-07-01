/**
 * Desktop connection screen (`#pa-connect`): a DOM overlay — NOT a Phaser scene —
 * layered over the canvas the same way `#pa-menubar` / `#pa-modal` / `#status`
 * are. It is the first user-facing desktop surface: the user types a remote
 * server URL, which is validated (scheme + host) and probed via `/health`
 * before anything else connects. It mounts only in the desktop build.
 *
 * Flow (Design Doc § New UI Surface Design / § Error Handling):
 *   validate scheme+host → set the configured origin → probe `/health`
 *   → on ok: persist the URL (preload IPC) + resolve (caller shows SignIn)
 *   → on fail: inline error, stay on the screen, let the user retry.
 *
 * Security (ADR-0001 § Implementation Guidance): the URL is validated and
 * normalized to its origin BEFORE any fetch, so no arbitrary/injection origin
 * (e.g. `javascript:`, `file:`, `data:`) is ever probed or navigated to.
 */

import { desktop, getConfiguredServerOrigin, setConfiguredServerOrigin } from '../desktop/bridge';
import { isServerUp } from '../net/room';

const ALLOWED_SCHEMES = ['https:', 'http:'];

const INVALID_URL_MESSAGE = 'Enter a valid http(s) server URL';
const UNREACHABLE_MESSAGE = 'Server unreachable — check the URL';

/**
 * Validate a user-entered server URL and return its normalized origin, or null
 * when it is not a well-formed http(s) URL with a host. Normalizing to the
 * origin drops any path/query/fragment/embedded-credentials so only the bare
 * origin is ever probed or persisted.
 */
export function normalizeServerOrigin(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (!ALLOWED_SCHEMES.includes(parsed.protocol)) return null;
  if (parsed.hostname === '') return null;
  return parsed.origin;
}

let stylesInjected = false;
function ensureStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement('style');
  // Screen-local rules only; the palette/font come from the shared `.pa-ui`
  // convention (font `FS Pixel Sans`, canvas `#14161c`, panel `#0f1220`,
  // border `#05060b`, primary `#2f66b0`, danger `#7c2634`).
  style.textContent = `
    #pa-connect{position:fixed;inset:0;z-index:120;display:flex;align-items:center;justify-content:center;
      background:#14161c;font-family:'FS Pixel Sans',ui-monospace,monospace;}
    #pa-connect .box{width:26rem;max-width:92vw;background:#0f1220;border:2px solid #05060b;border-radius:0.6rem;
      color:#e9ecf7;padding:1.3rem 1.4rem 1.4rem;box-shadow:inset 0 2px 0 #232a44,inset 0 -3px 0 #080a14,0 12px 28px rgba(0,0,0,.55);}
    #pa-connect h1{margin:0 0 0.3rem;font-size:1.4rem;font-weight:600;letter-spacing:.3px;color:#eef1fb;}
    #pa-connect .hint{margin:0 0 1.1rem;font-size:0.9rem;color:#9aa0b8;line-height:1.4;}
    #pa-connect label{display:block;font-size:0.78rem;letter-spacing:1px;text-transform:uppercase;color:#8a90a8;margin:0 0.1rem 0.35rem;}
    #pa-connect input{width:100%;box-sizing:border-box;background:#171b2b;border:2px solid #05060b;color:#e9ecf7;
      border-radius:0.4rem;font:1.05rem 'FS Pixel Sans',ui-monospace,monospace;padding:0.6rem 0.7rem;
      box-shadow:inset 0 2px 0 #2b3252,inset 0 -3px 0 #090b16;}
    #pa-connect input:focus-visible{outline:3px solid #5a92d6;outline-offset:2px;}
    #pa-connect input:disabled{opacity:0.55;cursor:not-allowed;}
    #pa-connect .err{min-height:1.2rem;margin:0.55rem 0.1rem 0;font-size:0.9rem;color:#f1b0ba;}
    #pa-connect button{width:100%;margin-top:1.1rem;cursor:pointer;background:#2f66b0;color:#fff;border:2px solid #05060b;
      border-radius:0.45rem;font:1.05rem 'FS Pixel Sans',ui-monospace,monospace;padding:0.65rem;
      box-shadow:inset 0 2px 0 #5a92d6,inset 0 -3px 0 #163862;}
    #pa-connect button:hover:not(:disabled){background:#3a72c0;}
    #pa-connect button:focus-visible{outline:3px solid #5a92d6;outline-offset:2px;}
    #pa-connect button:disabled{opacity:0.6;cursor:progress;}
  `;
  document.head.appendChild(style);
}

interface ConnectionElements {
  overlay: HTMLDivElement;
  input: HTMLInputElement;
  errorEl: HTMLParagraphElement;
  submit: HTMLButtonElement;
}

function buildOverlay(prefill: string): ConnectionElements {
  ensureStyles();

  const overlay = document.createElement('div');
  overlay.id = 'pa-connect';
  overlay.className = 'pa-ui';

  const box = document.createElement('div');
  box.className = 'box';

  const title = document.createElement('h1');
  title.textContent = 'Connect to server';

  const hint = document.createElement('p');
  hint.className = 'hint';
  hint.textContent = 'Enter the address of the pixel-agents server you want to join.';

  const form = document.createElement('form');
  form.noValidate = true;

  const label = document.createElement('label');
  label.htmlFor = 'pa-connect-url';
  label.textContent = 'Server URL';

  const input = document.createElement('input');
  input.id = 'pa-connect-url';
  input.type = 'url';
  input.name = 'server-url';
  input.placeholder = 'https://server.example.com';
  input.setAttribute('autocomplete', 'url');
  input.value = prefill;
  input.setAttribute('aria-describedby', 'pa-connect-err');

  const errorEl = document.createElement('p');
  errorEl.className = 'err';
  errorEl.id = 'pa-connect-err';
  errorEl.setAttribute('role', 'alert');
  errorEl.setAttribute('aria-live', 'polite');

  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.textContent = 'Connect';

  form.append(label, input, errorEl, submit);
  box.append(title, hint, form);
  overlay.appendChild(box);

  return { overlay, input, errorEl, submit };
}

/**
 * Show the desktop connection screen and resolve once the user has entered a
 * server URL that validates and whose `/health` probe succeeds. The URL is
 * persisted (preload IPC) and the configured origin is set before resolving, so
 * the caller can proceed straight to sign-in. Never rejects: validation and
 * reachability failures are surfaced inline and the user retries in place.
 */
export function showConnectionScreen(): Promise<void> {
  return new Promise<void>((resolve) => {
    void (async () => {
      // Partial state: prefill from the saved URL when one exists (opened from
      // settings / a prior launch). Empty state (first launch) leaves it blank.
      let prefill = '';
      try {
        prefill = (await desktop().getServerUrl()) ?? '';
      } catch {
        prefill = '';
      }

      const { overlay, input, errorEl, submit } = buildOverlay(prefill);

      const setError = (message: string): void => {
        errorEl.textContent = message;
      };
      const clearError = (): void => {
        errorEl.textContent = '';
      };
      const setLoading = (loading: boolean): void => {
        input.disabled = loading;
        submit.disabled = loading;
        submit.textContent = loading ? 'Checking…' : 'Connect';
      };

      const submitUrl = async (): Promise<void> => {
        clearError();
        const origin = normalizeServerOrigin(input.value);
        if (origin === null) {
          setError(INVALID_URL_MESSAGE);
          input.focus();
          return;
        }

        // Only after validation do we point the origin holder at the entered
        // server and probe it — no unvalidated origin is ever fetched.
        const previousOrigin = getConfiguredServerOrigin();
        setLoading(true);
        setConfiguredServerOrigin(origin);
        const reachable = await isServerUp();
        if (!reachable) {
          setConfiguredServerOrigin(previousOrigin);
          setLoading(false);
          setError(UNREACHABLE_MESSAGE);
          input.focus();
          return;
        }

        try {
          await desktop().setServerUrl(origin);
        } catch {
          setConfiguredServerOrigin(previousOrigin);
          setLoading(false);
          setError(UNREACHABLE_MESSAGE);
          input.focus();
          return;
        }

        overlay.remove();
        resolve();
      };

      const form = submit.form;
      if (form) {
        form.addEventListener('submit', (e) => {
          e.preventDefault();
          void submitUrl();
        });
      }

      document.body.appendChild(overlay);
      // Empty/partial focus: focus the input on mount; select prefilled text so
      // the user can overwrite it in one keystroke.
      input.focus();
      if (prefill !== '') input.select();
    })();
  });
}
