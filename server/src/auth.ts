/**
 * Account login (cookie session). Users sign in with a login id + password
 * (scrypt-verified). Additionally presenting the admin token makes that user an
 * admin and creates the account if it doesn't exist yet (the only way to create
 * a user for now — there is no open self-registration). The server stores a
 * session in SQLite keyed by user_id and sets an opaque HttpOnly cookie. Active
 * only when an admin token is configured (PIXEL_ADMIN_TOKEN / --token).
 */
import * as crypto from 'node:crypto';
import type { Express, Request, Response, NextFunction } from 'express';
import express from 'express';

import { appStore } from './appStore.js';
import { userStore, normalizeLoginId, isValidPassword, MIN_PASSWORD_LEN } from './userStore.js';

const VIEWER_COOKIE = 'pixel_stream_sid';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function tokenEquals(provided: string, expected: string): boolean {
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

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

/** Resolve the logged-in user id for a request's cookie (or undefined). */
export function userIdFromCookie(cookieHeader: string | undefined): string | undefined {
  const sid = parseCookies(cookieHeader)[VIEWER_COOKIE];
  return appStore.getSession(sid)?.userId || undefined;
}

export function hasValidSession(cookieHeader: string | undefined): boolean {
  const sid = parseCookies(cookieHeader)[VIEWER_COOKIE];
  return appStore.getSession(sid) !== undefined;
}

/** Extract the opaque session sid from an `Authorization: Bearer <sid>` header.
 *  Mirrors Colyseus `getBearerToken` (which populates `AuthContext.token`), so a
 *  token validated here resolves the same session the room sees at onAuth. */
function bearerToken(authHeader: string | undefined): string | undefined {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return undefined;
  return authHeader.slice('Bearer '.length) || undefined;
}

/** Resolve the logged-in user id for a bearer `Authorization` header (or undefined).
 *  The desktop counterpart to `userIdFromCookie` — same session store/TTL. */
export function userIdFromBearer(authHeader: string | undefined): string | undefined {
  return appStore.getSession(bearerToken(authHeader))?.userId || undefined;
}

export function hasValidBearerSession(authHeader: string | undefined): boolean {
  return appStore.getSession(bearerToken(authHeader)) !== undefined;
}

function loginHtml(err = ''): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>pixel-agents — Login</title>
<style>html,body{height:100%;margin:0}body{background:#14161c;color:#e6e9ef;
font-family:ui-monospace,monospace;display:flex;align-items:center;justify-content:center}
form{background:#1b1f2a;border:2px solid #3a4150;border-radius:8px;padding:24px 28px}
h3{margin:0 0 14px}.err{color:#ff8888;min-height:1.2em;margin:6px 0}
label{font-size:12px;color:#9aa3b2;display:block;margin:8px 0 2px}
input{background:#14161c;color:#e6e9ef;border:2px solid #3a4150;border-radius:5px;padding:9px;width:300px;
font:14px ui-monospace,monospace;display:block}
.hint{color:#6b7280;font-size:11px;margin-top:4px;max-width:320px}
button{margin-top:14px;background:#3a6df0;color:#fff;border:0;border-radius:5px;padding:10px 18px;
font:bold 14px ui-monospace,monospace;cursor:pointer}</style></head><body>
<form method="post" action="/login"><h3>pixel-agents</h3><div class="err">${err}</div>
<label for="u">Login id</label>
<input id="u" name="username" type="text" placeholder="your login id" maxlength="32" autofocus autocomplete="username">
<label for="p">Password</label>
<input id="p" name="password" type="password" placeholder="password" autocomplete="current-password">
<label for="t">Admin token (optional)</label>
<input id="t" name="token" type="password" placeholder="only to create / become admin" autocomplete="off">
<div class="hint">First time? Enter the admin token with a new login id + password to create an admin account.</div>
<div><button type="submit">Sign in</button></div></form></body></html>`;
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

/** Verify credentials with the shared login logic (used by both `/login` and
 *  `POST /desktop/token`). Returns the authenticated `userId` on success, or an
 *  `{ error, status? }` on failure — never logs the password/token. The admin
 *  token path creates/marks-admin the account; the normal path requires an
 *  existing user (no self-registration). A per-account throttle returns 429
 *  before any scrypt/token work once an account sees too many recent failures. */
function verifyCredentials(
  body: Record<string, unknown>,
  adminToken: string,
): { userId: string } | { error: string; status?: number } {
  const loginId = normalizeLoginId(body.username);
  // Cap lengths on this unauthenticated path (shared by /login and
  // /desktop/token) so a huge password can't turn scrypt verification into a CPU
  // DoS, and the token compare stays bounded.
  const password = String(body.password ?? '').slice(0, 256);
  const token = String(body.token ?? '').slice(0, 512);

  if (!loginId) return { error: 'Enter a login id.' };
  if (loginThrottled(loginId)) return { error: 'Too many attempts — wait a minute and try again.', status: 429 };

  if (token) {
    // Admin path: the token must be exact; it grants admin and creates the
    // account if new (a password — min length — is required to create one).
    if (!tokenEquals(token, adminToken)) {
      noteLoginFail(loginId);
      return { error: 'Invalid admin token.' };
    }
    const existing = userStore.get(loginId);
    if (existing) {
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

  // Normal path: an existing user with the right password. No self-registration.
  if (!userStore.exists(loginId) || !userStore.verifyPassword(loginId, password)) {
    noteLoginFail(loginId);
    return { error: 'Invalid login id or password.' };
  }
  loginFails.delete(loginId);
  return { userId: loginId };
}

/** Register login + the HTML auth gate. `adminToken` is required (caller only
 *  mounts this when one is configured). */
export function registerAuth(app: Express, adminToken: string): void {
  app.use(express.urlencoded({ extended: false }));

  const setSession = (res: Response, userId: string): void => {
    const sid = appStore.createSession(userId);
    res.setHeader(
      'Set-Cookie',
      `${VIEWER_COOKIE}=${sid}; Path=/; Max-Age=${SESSION_TTL_MS / 1000}; HttpOnly; SameSite=Lax`,
    );
    // Land customers in the rooms portal (they can't use the internal Pixels world);
    // everyone else goes to the Pixels client at the root.
    const dest = userStore.get(userId)?.role === 'customer' ? '/rooms.html' : '/';
    res.redirect(303, dest);
  };

  app.post('/login', (req: Request, res: Response) => {
    const result = verifyCredentials((req.body ?? {}) as Record<string, unknown>, adminToken);
    if ('error' in result) return void res.status(result.status ?? 401).type('html').send(loginHtml(result.error));
    return setSession(res, result.userId);
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

  // Gate the SPA document; assets, /health, /login and Colyseus matchmaking pass
  // through (the room validates the session cookie itself via onAuth).
  app.use((req: Request, res: Response, next: NextFunction) => {
    const p = req.path;
    // .jsdos bundles are served like any other static asset (the desktop app
    // fetches them cross-origin, cookie-less). NOTE: doom/doom2 now bundle the
    // operator's LICENSED IWADs — if public exposure of those bytes matters, gate
    // these two bundle URLs behind auth (see docs/dev-notes.md).
    const isAsset = p.startsWith('/assets/') || /\.(js|mjs|css|png|jpe?g|gif|svg|ico|webp|woff2?|ttf|map|json|webmanifest|wasm|jsdos)$/i.test(p);
    const isApi = p === '/health' || p === '/login' || p.startsWith('/matchmake');
    const needsAuth = req.method === 'GET' && !isAsset && !isApi;
    if (needsAuth && !hasValidSession(req.headers.cookie)) {
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
