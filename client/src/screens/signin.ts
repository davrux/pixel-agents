/**
 * Desktop sign-in screen (`#pa-signin`): a DOM overlay — NOT a Phaser scene —
 * layered over the canvas the same way `#pa-connect` / `#pa-menubar` / `#status`
 * are. It is the second desktop surface (after the connection screen): the user
 * enters the same credentials as the browser login (login id + password) and the
 * screen exchanges them for a bearer token at the configured server. It mounts
 * only in the desktop build.
 *
 * Two modes, one overlay — the same split the browser has as `/login` and
 * `/register`. Signing in asks for a login id and a password and nothing else;
 * the admin token is only on the register mode, which is where an account is
 * created (still NO self-registration: the server demands the token, so this
 * moved where the field is typed, not who may create an account). One overlay
 * rather than two screens because the box, the styles, the server line and the
 * token exchange are identical — only the fields and the wording differ.
 *
 * Flow (Design Doc § New UI Surface Design / § Data Contracts → Token issuance):
 *   normalize login id → POST `${origin}/desktop/token` { username, password, token? }
 *   (`token` only in register mode — the server reads its presence as "this is a
 *    registration", which is what keeps one endpoint serving both modes)
 *   → on 200 { token }: store the token via preload IPC (safeStorage-backed) + resolve
 *     (the caller then drives `connect()`, which reads the token as a bearer)
 *   → on 401 { error }: surface the server error message inline, stay on the screen
 *   → on network/other failure: generic inline error, stay on the screen.
 *
 * Security: the token is handed to the preload IPC (encrypted at rest via
 * safeStorage) and never logged, never placed in error text, and never held in
 * the renderer beyond this exchange. The login id is normalized with the same
 * rules as the server (`normalizeLoginId`) so the value sent matches the key the
 * server verifies against.
 */

import { desktop } from '../desktop/bridge';
import { getServerHttpOrigin } from '../net/room';
import { showConnectionScreen } from './connection';

/** Max login id length — mirrors the server's `normalizeLoginId` slice and the
 *  `loginHtml` input `maxlength` (`server/src/userStore.ts`, `server/src/auth.ts`). */
const MAX_LOGIN_ID_LEN = 32;
/** Min password length — mirrors the server's `MIN_PASSWORD_LEN`, which is what
 *  actually rejects a short one (`server/src/userStore.ts`). Stated here only so
 *  the register field can say the rule before the server has to. */
const MIN_PASSWORD_LEN = 6;

const NETWORK_ERROR_MESSAGE = 'Sign-in failed — check your connection and try again.';
const MISSING_LOGIN_MESSAGE = 'Enter a login id.';
/** Register mode with an empty token. The server would otherwise read a
 *  token-less request as a sign-in and answer "Invalid login id or password",
 *  which is a confusing thing to be told while creating an account. UX only —
 *  the server is still the authority on whether the token is right. */
const MISSING_TOKEN_MESSAGE = 'An admin token is required to create an account.';
/** Shown when the credentials were accepted but the token cannot be stored: with
 *  no OS keychain, `setToken` refuses to write the token in plaintext, so the
 *  sign-in cannot complete. Blaming the connection here (as this path used to)
 *  sends the user off debugging a network that is demonstrably fine. */
const NO_KEYCHAIN_MESSAGE =
  'No system keyring available, so your sign-in cannot be stored securely. ' +
  'On Linux, start a keyring service (gnome-keyring or KWallet) and try again.';

/**
 * Normalize a raw login id with the same rules the server applies
 * (`normalizeLoginId`): trim, lowercase, strip non-printable-ASCII, cap length.
 * Applying it client-side means the value sent is byte-identical to the key the
 * server verifies, so what the user sees is what authenticates.
 */
export function normalizeLoginId(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^\x21-\x7e]/g, '')
    .slice(0, MAX_LOGIN_ID_LEN);
}

let stylesInjected = false;
function ensureStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement('style');
  // Screen-local rules only; the palette/font come from the shared `.pa-ui`
  // convention (font `FS Pixel Sans`, canvas `#14161c`, panel `#0f1220`,
  // border `#05060b`, primary `#2f66b0`, danger `#7c2634`) — the same rules the
  // connection screen uses, keyed to `#pa-signin`.
  style.textContent = `
    #pa-signin{position:fixed;inset:0;z-index:120;display:flex;align-items:center;justify-content:center;
      background:#14161c;font-family:'FS Pixel Sans',ui-monospace,monospace;}
    #pa-signin .box{width:26rem;max-width:92vw;background:#0f1220;border:2px solid #05060b;border-radius:0.6rem;
      color:#e9ecf7;padding:1.3rem 1.4rem 1.4rem;box-shadow:inset 0 2px 0 #232a44,inset 0 -3px 0 #080a14,0 12px 28px rgba(0,0,0,.55);}
    #pa-signin h1{margin:0 0 0.3rem;font-size:1.4rem;font-weight:600;letter-spacing:.3px;color:#eef1fb;}
    #pa-signin .hint{margin:0 0 1.1rem;font-size:0.9rem;color:#9aa0b8;line-height:1.4;}
    #pa-signin label{display:block;font-size:0.78rem;letter-spacing:1px;text-transform:uppercase;color:#8a90a8;margin:0.9rem 0.1rem 0.35rem;}
    #pa-signin label:first-of-type{margin-top:0;}
    #pa-signin input{width:100%;box-sizing:border-box;background:#171b2b;border:2px solid #05060b;color:#e9ecf7;
      border-radius:0.4rem;font:1.05rem 'FS Pixel Sans',ui-monospace,monospace;padding:0.6rem 0.7rem;
      box-shadow:inset 0 2px 0 #2b3252,inset 0 -3px 0 #090b16;}
    #pa-signin input:focus-visible{outline:3px solid #5a92d6;outline-offset:2px;}
    #pa-signin input:disabled{opacity:0.55;cursor:not-allowed;}
    #pa-signin .err{min-height:1.2rem;margin:0.55rem 0.1rem 0;font-size:0.9rem;color:#f1b0ba;}
    #pa-signin button{width:100%;margin-top:1.1rem;cursor:pointer;background:#2f66b0;color:#fff;border:2px solid #05060b;
      border-radius:0.45rem;font:1.05rem 'FS Pixel Sans',ui-monospace,monospace;padding:0.65rem;
      box-shadow:inset 0 2px 0 #5a92d6,inset 0 -3px 0 #163862;}
    #pa-signin button:hover:not(:disabled){background:#3a72c0;}
    #pa-signin button:focus-visible{outline:3px solid #5a92d6;outline-offset:2px;}
    #pa-signin button:disabled{opacity:0.6;cursor:progress;}
    #pa-signin .server{margin:0.9rem 0.1rem 0;font-size:0.8rem;color:#8a90a8;text-align:center;
      overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
    #pa-signin .server code{color:#c7ccdf;}
    #pa-signin .alt{margin:0.35rem 0 0;text-align:center;}
    /* Reset the primary-button rules for the secondary "change server" link. */
    #pa-signin .alt button{width:auto;margin:0;padding:0.3rem 0.4rem;background:none;border:none;box-shadow:none;
      color:#7fa7e0;font-size:0.85rem;text-decoration:underline;cursor:pointer;}
    #pa-signin .alt button:hover:not(:disabled){background:none;color:#a9c6f0;}
    #pa-signin .alt button:disabled{opacity:0.5;cursor:not-allowed;}
    #pa-signin .alt .sep{color:#4a5070;font-size:0.85rem;margin:0 0.2rem;}
    /* Register mode shows the admin token row; sign-in mode hides it outright,
       so a returning user is never asked to decide whether it applies. */
    #pa-signin [hidden]{display:none;}
  `;
  document.head.appendChild(style);
}

/** Which screen the overlay is currently showing — see `applyMode`. */
type Mode = 'signin' | 'register';

interface SignInElements {
  overlay: HTMLDivElement;
  titleEl: HTMLHeadingElement;
  hintEl: HTMLParagraphElement;
  loginInput: HTMLInputElement;
  passwordInput: HTMLInputElement;
  tokenLabel: HTMLLabelElement;
  tokenInput: HTMLInputElement;
  errorEl: HTMLParagraphElement;
  submit: HTMLButtonElement;
  serverEl: HTMLParagraphElement;
  changeServer: HTMLButtonElement;
  toggleMode: HTMLButtonElement;
  devTools: HTMLButtonElement;
}

/** Set the "signing in to <origin>" line from the currently configured server.
 *  Register mode says "creating an account on" instead: which server the account
 *  is created ON is what makes an admin token the right or the wrong one. */
function renderServerLine(el: HTMLParagraphElement, mode: Mode = 'signin'): void {
  el.replaceChildren(document.createTextNode(mode === 'register' ? 'Creating an account on ' : 'Signing in to '));
  const code = document.createElement('code');
  code.textContent = getServerHttpOrigin();
  el.appendChild(code);
}

function buildOverlay(): SignInElements {
  ensureStyles();

  const overlay = document.createElement('div');
  overlay.id = 'pa-signin';
  overlay.className = 'pa-ui';

  const box = document.createElement('div');
  box.className = 'box';

  // Title and hint are the mode's wording; `applyMode` sets both (and everything
  // else that differs) so there is one place that says what each mode looks like.
  const titleEl = document.createElement('h1');

  const hintEl = document.createElement('p');
  hintEl.className = 'hint';

  const form = document.createElement('form');
  form.noValidate = true;

  const loginLabel = document.createElement('label');
  loginLabel.htmlFor = 'pa-signin-login';
  loginLabel.textContent = 'Login id';

  const loginInput = document.createElement('input');
  loginInput.id = 'pa-signin-login';
  loginInput.type = 'text';
  loginInput.name = 'username';
  loginInput.placeholder = 'your login id';
  loginInput.maxLength = MAX_LOGIN_ID_LEN;
  loginInput.setAttribute('autocomplete', 'username');
  loginInput.setAttribute('aria-describedby', 'pa-signin-err');

  const passwordLabel = document.createElement('label');
  passwordLabel.htmlFor = 'pa-signin-password';
  passwordLabel.textContent = 'Password';

  const passwordInput = document.createElement('input');
  passwordInput.id = 'pa-signin-password';
  passwordInput.type = 'password';
  passwordInput.name = 'password';
  passwordInput.placeholder = 'password';
  passwordInput.setAttribute('autocomplete', 'current-password');
  passwordInput.setAttribute('aria-describedby', 'pa-signin-err');

  // Register-mode only: hidden (and not sent) while signing in.
  const tokenLabel = document.createElement('label');
  tokenLabel.htmlFor = 'pa-signin-token';
  tokenLabel.textContent = 'Admin token';

  const tokenInput = document.createElement('input');
  tokenInput.id = 'pa-signin-token';
  tokenInput.type = 'password';
  tokenInput.name = 'token';
  tokenInput.placeholder = "the server's admin token";
  tokenInput.setAttribute('autocomplete', 'off');
  tokenInput.setAttribute('aria-describedby', 'pa-signin-err');

  const errorEl = document.createElement('p');
  errorEl.className = 'err';
  errorEl.id = 'pa-signin-err';
  errorEl.setAttribute('role', 'alert');
  errorEl.setAttribute('aria-live', 'polite');

  const submit = document.createElement('button');
  submit.type = 'submit';

  // Which server these credentials go to, + a way back to the connection screen
  // to point at a different one (the sign-in screen is desktop-only).
  // The wording depends on the mode, so `applyMode` fills this in (and refills it
  // after a detour to the connection screen changes which server it names).
  const serverEl = document.createElement('p');
  serverEl.className = 'server';

  const alt = document.createElement('p');
  alt.className = 'alt';
  const changeServer = document.createElement('button');
  changeServer.type = 'button';
  changeServer.textContent = 'Change server';

  // The Electron shell hides the native menu bar, and the in-world HUD's 🛠
  // toggle only exists once the world has booted — so a sign-in that never
  // succeeds would otherwise have no way to reach DevTools. Offer the same
  // toggle here, on the last screen before the world.
  const sep = document.createElement('span');
  sep.className = 'sep';
  sep.textContent = '·';
  const devTools = document.createElement('button');
  devTools.type = 'button';
  devTools.textContent = 'Developer tools';
  devTools.title = 'Toggle developer tools';

  // Switch between signing in and creating an account, in place — the browser's
  // /login ⇄ /register link, on the one overlay the desktop has.
  const toggleMode = document.createElement('button');
  toggleMode.type = 'button';

  const sep2 = document.createElement('span');
  sep2.className = 'sep';
  sep2.textContent = '·';
  alt.append(toggleMode, sep, changeServer, sep2, devTools);

  form.append(
    loginLabel,
    loginInput,
    passwordLabel,
    passwordInput,
    tokenLabel,
    tokenInput,
    errorEl,
    submit,
    serverEl,
    alt,
  );
  box.append(titleEl, hintEl, form);
  overlay.appendChild(box);

  return {
    overlay,
    titleEl,
    hintEl,
    loginInput,
    passwordInput,
    tokenLabel,
    tokenInput,
    errorEl,
    submit,
    serverEl,
    changeServer,
    toggleMode,
    devTools,
  };
}

/**
 * Dress the overlay for one mode: wording, the admin-token row's presence, and
 * the password field's autocomplete hint (`current-password` vs `new-password`,
 * so a password manager offers to fill on one and to save on the other). Called
 * once at mount and on every toggle, so the two modes cannot drift out of sync
 * with each other the way two copies of this screen would.
 */
function applyMode(el: SignInElements, mode: Mode): void {
  const registering = mode === 'register';
  el.titleEl.textContent = registering ? 'Create account' : 'Sign in';
  el.hintEl.textContent = registering
    ? "Pick a login id and password, and enter the server's admin token. The account it creates is an admin."
    : 'Enter your login id and password.';
  el.tokenLabel.hidden = !registering;
  el.tokenInput.hidden = !registering;
  el.passwordInput.placeholder = registering ? `at least ${MIN_PASSWORD_LEN} characters` : 'password';
  renderServerLine(el.serverEl, mode);
  el.submit.textContent = registering ? 'Create account' : 'Sign in';
  el.toggleMode.textContent = registering ? 'Back to sign in' : 'Create an account';
  el.passwordInput.setAttribute('autocomplete', registering ? 'new-password' : 'current-password');
}

/** Outcome of the token exchange: a token to store, or an inline error message. */
type TokenResult = { token: string } | { error: string };

/**
 * Exchange credentials for a bearer token at the configured server. Sends the
 * same field set the server verifies (`username`, `password`, and `token` only
 * when registering — its presence is how the one endpoint tells a registration
 * from a sign-in). A 200 yields `{ token }`; a 401 yields the server's inline
 * `error`; any network/parse/other failure yields a generic connection error.
 * Never returns or logs token material on the error paths.
 */
async function requestToken(
  loginId: string,
  password: string,
  adminToken: string,
): Promise<TokenResult> {
  const body: { username: string; password: string; token?: string } = {
    username: loginId,
    password,
  };
  if (adminToken !== '') body.token = adminToken;

  let res: Response;
  try {
    res = await fetch(`${getServerHttpOrigin()}/desktop/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
    });
  } catch {
    return { error: NETWORK_ERROR_MESSAGE };
  }

  if (res.status === 401) {
    const data = (await res.json().catch(() => null)) as { error?: unknown } | null;
    const message = typeof data?.error === 'string' ? data.error : NETWORK_ERROR_MESSAGE;
    return { error: message };
  }

  if (!res.ok) return { error: NETWORK_ERROR_MESSAGE };

  const data = (await res.json().catch(() => null)) as { token?: unknown } | null;
  if (typeof data?.token !== 'string' || data.token === '') return { error: NETWORK_ERROR_MESSAGE };
  return { token: data.token };
}

/**
 * Show the desktop sign-in screen and resolve once credentials have been
 * exchanged for a bearer token AND that token has been stored via the preload
 * IPC (safeStorage-backed). The caller then drives `connect()`, which reads the
 * stored token as a bearer. Never rejects: credential and network failures are
 * surfaced inline and the user retries in place.
 */
export function showSignInScreen(): Promise<void> {
  return new Promise<void>((resolve) => {
    const el = buildOverlay();
    const { overlay, loginInput, passwordInput, tokenInput, errorEl, submit, changeServer, devTools } = el;
    let mode: Mode = 'signin';
    applyMode(el, mode);

    const setError = (message: string): void => {
      errorEl.textContent = message;
    };
    const clearError = (): void => {
      errorEl.textContent = '';
    };
    const setLoading = (loading: boolean): void => {
      loginInput.disabled = loading;
      passwordInput.disabled = loading;
      tokenInput.disabled = loading;
      submit.disabled = loading;
      changeServer.disabled = loading;
      el.toggleMode.disabled = loading;
      // `devTools` is deliberately left enabled: an in-flight sign-in is exactly
      // when you want to open the console and watch the request.
      if (loading) submit.textContent = mode === 'register' ? 'Creating account…' : 'Signing in…';
      else applyMode(el, mode);
    };

    // Switch modes in place. The typed login id and password carry over (the same
    // pair is usually what you meant either way); the admin token is cleared on
    // the way out of register mode so it is never sent by the next sign-in.
    const setMode = (next: Mode): void => {
      mode = next;
      if (next === 'signin') tokenInput.value = '';
      clearError();
      applyMode(el, mode);
      (next === 'register' && loginInput.value !== '' ? tokenInput : loginInput).focus();
    };
    el.toggleMode.onclick = () => setMode(mode === 'register' ? 'signin' : 'register');

    devTools.onclick = () => void desktop().toggleDevTools();

    const submitCredentials = async (): Promise<void> => {
      clearError();
      const loginId = normalizeLoginId(loginInput.value);
      if (loginId === '') {
        setError(MISSING_LOGIN_MESSAGE);
        loginInput.focus();
        return;
      }

      const adminToken = mode === 'register' ? tokenInput.value.trim() : '';
      if (mode === 'register' && adminToken === '') {
        setError(MISSING_TOKEN_MESSAGE);
        tokenInput.focus();
        return;
      }

      setLoading(true);
      const result = await requestToken(loginId, passwordInput.value, adminToken);
      if ('error' in result) {
        setLoading(false);
        setError(result.error);
        loginInput.focus();
        return;
      }

      try {
        await desktop().setToken(result.token);
      } catch {
        // The token exchange already succeeded, so the server and the network are
        // fine — the only way storing it fails is an unavailable keychain. Ask
        // main which it was instead of guessing, and fall back to the generic
        // message if even that call fails.
        let hasKeychain = true;
        try {
          hasKeychain = await desktop().keychainAvailable();
        } catch {
          hasKeychain = true;
        }
        setLoading(false);
        setError(hasKeychain ? NETWORK_ERROR_MESSAGE : NO_KEYCHAIN_MESSAGE);
        return;
      }

      overlay.remove();
      resolve();
    };

    // "Change server": detour back to the connection screen (prefilled with the
    // current URL), then return here pointed at the chosen server. The connection
    // screen persists the new URL and updates the configured origin before it
    // resolves, so the credentials entered next go to the right server.
    const changeServerFlow = async (): Promise<void> => {
      clearError();
      overlay.remove();
      await showConnectionScreen();
      // setLoading(false) runs applyMode, which re-renders the server line with
      // whichever origin the connection screen settled on.
      setLoading(false);
      document.body.appendChild(overlay);
      loginInput.focus();
    };
    changeServer.onclick = () => void changeServerFlow();

    const form = submit.form;
    if (form) {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        void submitCredentials();
      });
    }

    document.body.appendChild(overlay);
    // Empty state (fresh sign-in): blank inputs, login id focused.
    loginInput.focus();
  });
}
