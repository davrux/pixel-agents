/**
 * Account login (cookie session) and account creation, on two screens. `/login`
 * is a login id + password (scrypt-verified) and nothing else. `/register` is
 * where the admin token is typed: presenting it creates the account as an admin,
 * or makes an existing account one. That is still the only way a user comes into
 * existence — there is no open self-registration; the token simply stopped
 * sitting on the sign-in form, where it asked every returning user to decide
 * whether it applied to them. The server stores a session in SQLite keyed by
 * user_id and sets an opaque HttpOnly cookie. Active only when an admin token is
 * configured (PIXEL_ADMIN_TOKEN / --token).
 */
import type { Express, Request, Response, NextFunction } from 'express';
import express from 'express';

import { appStore } from './appStore.js';
import { userStore, normalizeLoginId, isValidPassword, MIN_PASSWORD_LEN } from './userStore.js';
import { secretEquals } from './secretCompare.js';

const VIEWER_COOKIE = 'pixel_stream_sid';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Resolve the logged-in user id for a request's cookie (or undefined). A
 *  disabled OR deleted account resolves to undefined here — the single choke
 *  point this and userIdFromBearer share means a suspension takes effect
 *  immediately for every caller (login gate, room onAuth, admin API, /meet
 *  authedDisplayName), not just on the next login. Requiring the account to
 *  still *exist* (not just "not disabled") also matters on its own: a
 *  deleted user's session otherwise keeps resolving as valid up to its
 *  normal TTL — `undefined?.disabled` is falsy, so a missing row used to
 *  pass the disabled check the same as a normal enabled account. Account
 *  deletion additionally kills sessions outright (see deleteSessionsForUser)
 *  so a recreated account with the same login id can't inherit one; this is
 *  the defense-in-depth backstop for any session that slips through anyway. */
export function userIdFromCookie(cookieHeader: string | undefined): string | undefined {
  const sid = parseCookies(cookieHeader)[VIEWER_COOKIE];
  const userId = appStore.getSession(sid)?.userId;
  if (!userId) return undefined;
  const user = userStore.get(userId);
  return user && !user.disabled ? userId : undefined;
}

export function hasValidSession(cookieHeader: string | undefined): boolean {
  return userIdFromCookie(cookieHeader) !== undefined;
}

/** Extract the opaque session sid from an `Authorization: Bearer <sid>` header.
 *  Mirrors Colyseus `getBearerToken` (which populates `AuthContext.token`), so a
 *  token validated here resolves the same session the room sees at onAuth. */
function bearerToken(authHeader: string | undefined): string | undefined {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return undefined;
  return authHeader.slice('Bearer '.length) || undefined;
}

/** Resolve the logged-in user id for a bearer `Authorization` header (or undefined).
 *  The desktop counterpart to `userIdFromCookie` — same session store/TTL, same
 *  immediate-disabled-check behaviour. */
export function userIdFromBearer(authHeader: string | undefined): string | undefined {
  const userId = appStore.getSession(bearerToken(authHeader))?.userId;
  if (!userId) return undefined;
  const user = userStore.get(userId);
  return user && !user.disabled ? userId : undefined;
}

export function hasValidBearerSession(authHeader: string | undefined): boolean {
  return userIdFromBearer(authHeader) !== undefined;
}

/** The shared chrome both auth pages are served with: one stylesheet, one form
 *  shell. Login and register differ only in their fields and their wording, so
 *  keeping the shell in one place is what stops the two screens drifting apart
 *  (and keeps them self-contained — no script, no stylesheet, no font to fetch,
 *  which is what lets `isPublicGet` answer an anonymous navigation with them). */
function authPageHtml(opts: {
  title: string;
  action: string;
  err: string;
  fields: string;
  submit: string;
  footer: string;
}): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>pixel-agents — ${opts.title}</title>
<style>
/* The house chrome (AGENTS.md "UI — one look for all chrome"), because this page is the FIRST
   thing anybody sees and it was the last surface still wearing the pre-restyle palette: panel
   #1b1f2a, 1px-ish borders #3a4150, accent #3a6df0 — all three are listed there under
   "Deprecated — do not use". Values copied from the canonical rules rather than re-picked, and
   kept in step with the desktop's own sign-in screen (client/src/screens/signin.ts), which the
   Electron app shows instead of this page.
   The font is declared here too: this page is served by the server, so it inherits no CSS from
   the client build — but /fonts/ is on the public allow-list, so the file is reachable. */
@font-face{font-family:'FS Pixel Sans';src:url('/fonts/FSPixelSansUnicode-Regular.ttf') format('truetype');
font-weight:400;font-display:swap}
html,body{height:100%;margin:0}body{background:#141312;color:#f1efec;
font-family:'FS Pixel Sans',ui-monospace,monospace;display:flex;align-items:center;justify-content:center}
form{background:#1c1a19;border:2px solid #0a0908;border-radius:0.6rem;padding:24px 28px;
box-shadow:inset 0 2px 0 #292725,inset 0 -3px 0 #030303,0 12px 28px rgba(0,0,0,.55)}
h3{margin:0 0 14px;color:#f5f3f0}.err{color:#f6cdd4;min-height:1.2em;margin:6px 0}
label{font-size:12px;color:#818586;display:block;margin:8px 0 2px;letter-spacing:1px;text-transform:uppercase}
input{background:#262422;color:#f1efec;border:2px solid #0a0908;border-radius:0.35rem;padding:9px;width:300px;
font:14px 'FS Pixel Sans',ui-monospace,monospace;display:block;
box-shadow:inset 0 2px 0 #4a4744,inset 0 -3px 0 #050505}
input:focus-visible{outline:3px solid #4998c0;outline-offset:2px}
.hint{color:#818586;font-size:11px;margin-top:4px;max-width:320px}
.alt{color:#adb0b2;font-size:11px;margin-top:14px;max-width:320px}
.alt a{color:#4998c0}
button{margin-top:14px;background:#c51a1b;color:#fff;border:2px solid #0a0908;border-radius:0.45rem;padding:10px 18px;
font:bold 14px 'FS Pixel Sans',ui-monospace,monospace;cursor:pointer;
box-shadow:inset 0 2px 0 #e2585a,inset 0 -3px 0 #5c0f10}
button:hover{background:#d42021}
button:focus-visible{outline:3px solid #4998c0;outline-offset:2px}</style></head><body>
<form method="post" action="${opts.action}"><h3>pixel-agents</h3><div class="err">${opts.err}</div>
${opts.fields}
<div><button type="submit">${opts.submit}</button></div>
<div class="alt">${opts.footer}</div></form></body></html>`;
}

const LOGIN_ID_FIELD = `<label for="u">Login id</label>
<input id="u" name="username" type="text" placeholder="your login id" maxlength="32" autofocus autocomplete="username">`;

function loginHtml(err = ''): string {
  return authPageHtml({
    title: 'Login',
    action: '/login',
    err,
    fields: `${LOGIN_ID_FIELD}
<label for="p">Password</label>
<input id="p" name="password" type="password" placeholder="password" autocomplete="current-password">`,
    submit: 'Sign in',
    footer: 'First time here? <a href="/register">Create an account</a>.',
  });
}

/** The register screen: the admin token lives HERE and nowhere else. It is the
 *  same rule as before (only somebody holding PIXEL_ADMIN_TOKEN can create an
 *  account — there is still no open self-registration), moved off the sign-in
 *  form where it invited every returning user to wonder whether they needed it.
 *  The page itself is reachable anonymously, exactly like /login: it has to be,
 *  since an account is what you come here to get — and reaching it grants
 *  nothing, because POST /register still verifies the token. */
function registerHtml(err = ''): string {
  return authPageHtml({
    title: 'Create account',
    action: '/register',
    err,
    fields: `${LOGIN_ID_FIELD}
<label for="p">Password</label>
<input id="p" name="password" type="password" placeholder="at least ${MIN_PASSWORD_LEN} characters" autocomplete="new-password">
<label for="t">Admin token</label>
<input id="t" name="token" type="password" placeholder="the server's admin token" autocomplete="off">
<div class="hint">Accounts are created with the server's admin token, and the account it
creates is an admin. Entering an existing login id with the token makes that account an admin.</div>`,
    submit: 'Create account',
    footer: 'Already have an account? <a href="/login">Sign in</a>.',
  });
}

// Per-account online-guess throttle — defense-in-depth on top of the length caps
// + scrypt cost. Keyed by login id (NOT IP) so a shared reverse-proxy address
// can't lock everyone out; a burst of failed attempts for one account cools down
// for a short, auto-expiring window (so it self-heals and can't be a lasting
// account-lockout DoS). Single-process, in-memory — see AGENTS.md "Single process".
const MAX_LOGIN_FAILS = 10;
const LOGIN_FAIL_WINDOW_MS = 60_000;
const loginFails = new Map<string, { count: number; until: number }>();
function loginThrottled(loginId: string): boolean {
  const e = loginFails.get(loginId);
  if (!e) return false;
  if (Date.now() > e.until) {
    loginFails.delete(loginId);
    return false;
  }
  return e.count >= MAX_LOGIN_FAILS;
}
/**
 * Wrong ADMIN TOKEN, counted globally — the guess the per-account throttle cannot see.
 *
 * `loginFails` is keyed by login id, which is right for a password: it stops a burst against
 * one account without letting anybody lock out everyone else. On the register form it is not
 * enough, and that is the hole this closes: the secret being guessed there is the server's ONE
 * admin token, and the attacker picks the login id, so `a1`, `a2`, `a3` … each brought a fresh
 * budget of ten. Whoever guesses the token becomes an admin.
 *
 * So token guesses are counted in one place for the whole server. That CAN be used to make the
 * register form unavailable for a minute — deliberately accepted: nobody needs it to be up at
 * that moment (signing in is untouched), and an admin token is not something to leave open to
 * unlimited guessing. The window auto-expires, so it self-heals like the per-account one.
 */
const MAX_TOKEN_FAILS = 20;
const tokenFails = { count: 0, until: 0 };
function tokenGuessThrottled(): boolean {
  if (Date.now() > tokenFails.until) {
    tokenFails.count = 0;
    return false;
  }
  return tokenFails.count >= MAX_TOKEN_FAILS;
}
function noteTokenFail(): void {
  const now = Date.now();
  if (now > tokenFails.until) tokenFails.count = 0;
  tokenFails.count += 1;
  tokenFails.until = now + LOGIN_FAIL_WINDOW_MS; // sliding, like the per-account window
}

function noteLoginFail(loginId: string): void {
  const now = Date.now();
  if (loginFails.size > 10_000) loginFails.clear(); // bound memory
  const e = loginFails.get(loginId);
  if (!e || now > e.until) loginFails.set(loginId, { count: 1, until: now + LOGIN_FAIL_WINDOW_MS });
  else {
    e.count += 1;
    e.until = now + LOGIN_FAIL_WINDOW_MS; // sliding: sustained attempts stay cooled down
  }
}

type AuthResult = { userId: string } | { error: string; status?: number };

/** The fields both paths read, with the length caps that make them safe to work
 *  on. Capping here (rather than at each use) is what keeps this unauthenticated
 *  surface from turning a huge password into a CPU DoS via scrypt, and keeps the
 *  token compare bounded. */
function readCredentials(body: Record<string, unknown>): { loginId: string; password: string; token: string } {
  return {
    loginId: normalizeLoginId(body.username),
    password: String(body.password ?? '').slice(0, 256),
    token: String(body.token ?? '').slice(0, 512),
  };
}

/** Sign in an existing account: login id + password, nothing else. No
 *  self-registration and no promotion — creating an account or becoming an admin
 *  is what `verifyRegistration` is for. A per-account throttle returns 429 before
 *  any scrypt work once an account sees too many recent failures. */
function verifyLogin(body: Record<string, unknown>): AuthResult {
  const { loginId, password } = readCredentials(body);

  if (!loginId) return { error: 'Enter a login id.' };
  if (loginThrottled(loginId)) return { error: 'Too many attempts — wait a minute and try again.', status: 429 };

  if (!userStore.exists(loginId) || !userStore.verifyPassword(loginId, password)) {
    noteLoginFail(loginId);
    return { error: 'Invalid login id or password.' };
  }
  // Checked after the password (not before): a wrong-password guess against a
  // disabled account must not reveal that the account exists/is disabled.
  if (userStore.get(loginId)?.disabled) return { error: 'This account has been disabled.', status: 403 };
  loginFails.delete(loginId);
  return { userId: loginId };
}

/** Create an account (or make an existing one an admin) with the admin token.
 *  The token must be exact; the account it creates is an admin. This is still the
 *  only way a user comes into existence — moving the field to its own screen
 *  changed where it is typed, not who may create an account. */
function verifyRegistration(body: Record<string, unknown>, adminToken: string): AuthResult {
  const { loginId, password, token } = readCredentials(body);

  if (!loginId) return { error: 'Enter a login id.' };
  if (loginThrottled(loginId)) return { error: 'Too many attempts — wait a minute and try again.', status: 429 };
  // Both throttles, and this one before the token is even looked at: the per-account one above
  // is bypassed here by varying the login id, since the id is the attacker's own choice.
  if (tokenGuessThrottled()) return { error: 'Too many attempts — wait a minute and try again.', status: 429 };
  // A blank token is not a guess — say what is missing rather than penalising it.
  if (!token) return { error: 'An admin token is required to create an account.' };

  if (!secretEquals(token, adminToken)) {
    noteLoginFail(loginId);
    noteTokenFail();
    return { error: 'Invalid admin token.' };
  }
  const existing = userStore.get(loginId);
  if (existing) {
    // Presenting the admin token doesn't override a suspension — re-enabling
    // is a deliberate admin-panel action, not something this form does
    // implicitly (that would let a disabled account escape it by knowing the
    // master token, same as promoting themselves to admin would).
    if (existing.disabled) return { error: 'This account has been disabled.', status: 403 };
    userStore.markAdmin(existing.userId);
    loginFails.delete(loginId);
    return { userId: existing.userId };
  }
  // Admin token was correct — a missing password isn't a guess, so no penalty.
  if (!isValidPassword(password)) {
    return { error: `A password (min ${MIN_PASSWORD_LEN} chars) is required to create a user.` };
  }
  const user = userStore.createUser(loginId, password, { isAdmin: true });
  loginFails.delete(loginId);
  return { userId: user.userId };
}

/** The credential check `POST /desktop/token` serves both screens with: a
 *  request carrying a token is a registration, one without it is a sign-in. The
 *  browser has a route per screen and doesn't need this — the desktop keeps one
 *  endpoint on purpose, so a shipped build that still posts an optional token
 *  from its sign-in form authenticates exactly as it did before (the desktop app
 *  updates only when its user triggers it — see AGENTS.md invariant 10). */
function verifyCredentials(body: Record<string, unknown>, adminToken: string): AuthResult {
  return String(body.token ?? '') !== '' ? verifyRegistration(body, adminToken) : verifyLogin(body);
}

/** Register login + the HTML auth gate. `adminToken` is required (caller only
 *  mounts this when one is configured). */
export function registerAuth(app: Express, adminToken: string): void {
  app.use(express.urlencoded({ extended: false }));

  const setSession = (req: Request, res: Response, userId: string): void => {
    const sid = appStore.createSession(userId);
    // Add Secure on HTTPS (direct TLS or behind a TLS-terminating proxy) so the
    // session cookie can never ride an accidental plain-http request. Omitted on
    // plain-http (local dev) so login still works there.
    const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
    res.setHeader(
      'Set-Cookie',
      `${VIEWER_COOKIE}=${sid}; Path=/; Max-Age=${SESSION_TTL_MS / 1000}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`,
    );
    res.redirect(303, '/');
  };

  // The sign-in page. An anonymous navigation to anything else is answered with
  // this same HTML by the gate below, so this route existed only implicitly until
  // the register page started linking to it BY NAME — an unauthenticated GET
  // /login fell through the gate's allow-list to a 404.
  app.get('/login', (_req: Request, res: Response) => {
    res.status(200).type('html').send(loginHtml());
  });

  app.post('/login', (req: Request, res: Response) => {
    const result = verifyLogin((req.body ?? {}) as Record<string, unknown>);
    if ('error' in result) return void res.status(result.status ?? 401).type('html').send(loginHtml(result.error));
    return setSession(req, res, result.userId);
  });

  // The register screen and its submission. The GET is on the anonymous
  // allow-list (see isPublicGet) because an account is what a caller comes here
  // to get; the POST is what actually gates it, on the admin token. A successful
  // registration signs the new account straight in — the credentials were just
  // typed, so bouncing back to /login to retype them adds nothing.
  app.get('/register', (_req: Request, res: Response) => {
    res.status(200).type('html').send(registerHtml());
  });

  app.post('/register', (req: Request, res: Response) => {
    const result = verifyRegistration((req.body ?? {}) as Record<string, unknown>, adminToken);
    if ('error' in result) return void res.status(result.status ?? 401).type('html').send(registerHtml(result.error));
    return setSession(req, res, result.userId);
  });

  // Desktop token issuance: same credentials as /login, but returns the opaque
  // session sid as a bearer token instead of setting a cookie (no Set-Cookie, no
  // cookie required). The token IS a live session row (createSession, 7-day TTL).
  app.post('/desktop/token', express.json(), (req: Request, res: Response) => {
    const result = verifyCredentials((req.body ?? {}) as Record<string, unknown>, adminToken);
    if ('error' in result) return void res.status(result.status ?? 401).json({ error: result.error });
    const sid = appStore.createSession(result.userId);
    return void res.status(200).json({ token: sid });
  });

  // Desktop sign-out: revoke the bearer session by sid. Idempotent — always 204,
  // never revealing whether the sid existed.
  app.post('/desktop/signout', (req: Request, res: Response) => {
    const sid = bearerToken(req.headers.authorization);
    if (sid) appStore.deleteSession(sid);
    res.status(204).end();
  });

  // Logout: drop the session + expire the cookie, then back to the login screen.
  app.get('/logout', (req: Request, res: Response) => {
    const sid = parseCookies(req.headers.cookie)[VIEWER_COOKIE];
    if (sid) appStore.deleteSession(sid);
    res.setHeader('Set-Cookie', `${VIEWER_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
    res.redirect(303, '/');
  });

  /**
   * What an anonymous GET may reach, and why each one is here.
   *
   * This used to be the other way round: anything under `/assets/` or ending in an asset
   * EXTENSION was public, on the grounds that "the desktop app fetches them cross-origin,
   * cookie-less". That was measured on 2026-08-20 and it made the whole world's art
   * readable to anybody who could reach the port — every tileset sheet, `sets.json`, and
   * every picture a pushed map brought with it (a map's images are written to disk by the
   * push, so they are not necessarily in git either). The desktop half of the reasoning had
   * also expired: it sends a bearer through serverFetch, which the gate below accepts, so
   * the client needed no exemption — only three of its fetches were still using a bare
   * `fetch` and had to be routed through it.
   *
   * The rule now: deny by default, and every entry below states what would break without it.
   */
  const isPublicGet = (p: string): boolean => {
    // The login page itself is what an ungated navigation is answered WITH (see below), and
    // it is self-contained: no script, no stylesheet, no font of its own to fetch.
    if (p === '/login' || p === '/health') return true;
    // The register page, for the same reason and one more: an account is what a caller comes
    // here to get, so requiring a session to reach it would make it unreachable. It shares the
    // login page's shell (no asset of its own to fetch) and it hands out nothing — POST
    // /register still demands the admin token, so this exposes a form, not an account.
    if (p === '/register') return true;
    // Colyseus seat reservation. The room authorizes for itself in onAuth — and this is
    // where a client that has just logged in arrives, before any document is served.
    if (p.startsWith('/matchmake')) return true;
    // The world's art shares a mount point with the client build, and it is DATA — every
    // tileset sheet, sets.json, and every picture a pushed map brought with it. Checked
    // before the build prefixes below, which is the whole point of the rewrite.
    if (p.startsWith('/assets/tiled/')) return false;
    // Operator-provided bundles and ROMs. Never anonymous; the launcher sends the session
    // (cookie in the browser, bearer on the desktop — see ArcadeUI).
    if (p.startsWith('/arcade/content/')) return false;
    // The client BUILD's own directories (client/dist): the app shell a browser needs to
    // boot, plus the fonts, sounds and part art it ships with. No world data and, by
    // contract, no secret — mmo-readiness fails a secret named anywhere in client/src. The
    // desktop needs none of this; it ships its own copy.
    //
    // A directory the build gains later is NOT here, and that is the safe direction: a
    // signed-in browser still gets it (same-origin, so the cookie rides along) and only an
    // anonymous first load would miss it.
    if (BUILD_DIRS.some((dir) => p.startsWith(dir))) return true;
    // Files at the build's root: the favicon and the manifest a browser asks for before
    // anything else. index.html is deliberately NOT here — an ungated navigation is
    // answered with the login page instead.
    return /\.(ico|webmanifest)$/i.test(p);
  };
  /** client/dist's own top-level directories — see isPublicGet. */
  const BUILD_DIRS = ['/assets/', '/fonts/', '/sounds/', '/charparts/', '/jsdos/', '/emulatorjs/'];

  // Gate every GET except what an anonymous caller demonstrably needs. See PUBLIC_GETS
  // for what that is and why each entry is there.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const p = req.path;
    const needsAuth = req.method === 'GET' && !isPublicGet(p);
    if (needsAuth && !hasValidSession(req.headers.cookie) && !hasValidBearerSession(req.headers.authorization)) {
      // Login page only for navigations; programmatic fetches get an honest 401 so a
      // gate miss can never hand HTML-as-200 to a client that will cache it as data
      // (js-dos persists any 200 body as bundle bytes).
      if (req.headers.accept?.includes('text/html')) {
        res.status(200).type('html').send(loginHtml());
      } else {
        res.status(401).json({ error: 'unauthorized' });
      }
      return;
    }
    next();
  });
}
