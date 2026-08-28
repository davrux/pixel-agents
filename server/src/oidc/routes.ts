/**
 * The OIDC login routes: two for the browser, two for the desktop app, one to say whether any of
 * this exists.
 *
 *   GET  /auth/oauth/config          → { enabled, label }  — what the sign-in button should say
 *   GET  /auth/oauth/start           → 302 to the provider
 *   GET  /auth/oauth/callback        → the login itself: exchange, provision, set the session cookie
 *   POST /desktop/oauth/start        → { authUrl, deviceCode, … } — begins a desktop pairing
 *   POST /desktop/oauth/token        → { token } | { status:'pending' } — collects its bearer
 *   GET  /auth/oauth/link/status     → is this account connected, and may it be disconnected
 *   POST /auth/oauth/link/start      → begins connecting THIS account to a provider identity
 *   POST /auth/oauth/link/poll       → { status:'pending' | 'linked' } — watches that finish
 *   POST /auth/oauth/link/confirm    → the human's yes, from the page the flow ends on
 *   POST /auth/oauth/link/disconnect → drops the link
 *
 * All five are registered BEFORE the session gate in `auth.ts` (like `/meet/:slug` and
 * `/mumble/config`), because a caller on their way IN has no session yet. Each one is on
 * `mmo-readiness`'s PUBLIC_ROUTES list with the reason it may be reached anonymously; the short
 * version is that the credential check IS the route: `/auth/oauth/callback` authorizes itself by
 * exchanging a code it can only have if the provider issued it for a `state` this server made
 * moments ago, and `/desktop/oauth/token` by holding a device code this server minted.
 *
 * **Why the desktop app pairs instead of following a redirect.** It has no cookie jar the
 * callback could set, and the system browser is where MFA and passkeys work properly (an
 * embedded webview is refused outright by several upstream identity providers). So the app takes
 * a one-time device code, opens the real browser, and polls: the callback parks the issued
 * session id on the pairing and the next poll collects it, once. Nothing sensitive ever travels
 * in a URL — the token goes over the app's own POST response, not through a redirect.
 *
 * **What a browser is never trusted with.** The code verifier, the nonce and the pairing all
 * live server-side (`pending.ts`); the browser carries only an opaque `state`, and the callback
 * additionally requires the matching short-lived cookie, so a link somebody else's browser is
 * tricked into following cannot complete a login into this world (login CSRF).
 *
 * **Connecting an existing account, and why it ends in a confirmation page.** A signed-in user can
 * attach their provider identity to the account they already have. The account is taken from the
 * session at START time and kept server-side, so the callback cannot redirect the link somewhere
 * else — but that alone does not settle it: whoever starts a flow can pass its authorize URL to
 * somebody ELSE, and if that person authenticates, their directory identity would attach to the
 * starter's account, quietly making the starter's account the one they sign into from then on.
 * The same shape as login CSRF, and the same fix the device flow uses: the exchange stops one step
 * short and the page names BOTH identities — this directory account, that pixel-agents account —
 * and asks for a click. Nothing is written until that POST arrives with a token only that page
 * carries. A browser-mode sign-in keeps using the state cookie for the same job; a link cannot,
 * because it may finish in the system browser of a desktop user who has no session there.
 */
import express from 'express';

import type { Express, Request, Response } from 'express';

import { appStore } from '../appStore.js';
import { loginPageHtml, setSessionCookie, userIdFromBearer, userIdFromCookie } from '../auth.js';
import { discover, fetchJsonBounded, oidcConfig, type OidcConfig, type OidcEndpoints } from './config.js';
import {
  PAIRING_POLL_INTERVAL_S,
  PAIRING_TTL_MS,
  codeChallenge,
  completePairing,
  createFlow,
  createPairing,
  createPendingLink,
  pollPairing,
  takeFlow,
  takePendingLink,
} from './pending.js';
import { oidcButtonVisible, oidcLabel } from './presentation.js';
import {
  PROVIDER,
  linkOidcAccount,
  readClaims,
  resolveOidcUser,
  unlinkOidcAccount,
  type OidcClaims,
} from './provision.js';
import { oauthIdentityStore } from './identityStore.js';
import { userStore } from '../userStore.js';

/** The cookie that binds a callback to the browser that started the flow. */
const STATE_COOKIE = 'pixel_oauth_state';
/** Long enough for a real sign-in (including an MFA prompt), short enough to be worthless later. */
const STATE_COOKIE_MAX_AGE_S = 10 * 60;

/** What a user is told when the provider or the exchange failed. The detail is logged, not shown:
 *  a token endpoint's error body can name client ids and redirect URIs. */
const GENERIC_FAILURE = 'Signing in with the identity provider failed. Try again, or use a password.';

function parseCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

function setStateCookie(req: Request, res: Response, state: string): void {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader(
    'Set-Cookie',
    `${STATE_COOKIE}=${state}; Path=/auth/oauth; Max-Age=${STATE_COOKIE_MAX_AGE_S}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`,
  );
}

function clearStateCookie(res: Response, extra: string[] = []): void {
  res.setHeader('Set-Cookie', [`${STATE_COOKIE}=; Path=/auth/oauth; Max-Age=0; HttpOnly; SameSite=Lax`, ...extra]);
}

/** The provider URL a browser is sent to. */
function authorizeUrl(cfg: OidcConfig, endpoints: OidcEndpoints, state: string, nonce: string, verifier: string): string {
  const url = new URL(endpoints.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', cfg.clientId);
  url.searchParams.set('redirect_uri', cfg.redirectUri);
  url.searchParams.set('scope', cfg.scopes);
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);
  // PKCE regardless of whether there is a client secret: it binds the code to THIS flow, which a
  // secret does not (a stolen code plus the secret is still a login; a stolen code without the
  // verifier is not).
  url.searchParams.set('code_challenge', codeChallenge(verifier));
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

interface TokenResponse {
  accessToken: string;
  idToken: string | null;
}

/**
 * Exchange the authorization code for tokens.
 *
 * A confidential client authenticates with HTTP Basic (`client_secret_basic`, which is what
 * Zitadel gives a web application by default); a public client sends only its id and relies on
 * PKCE. Either way the request goes from this server to the token endpoint the issuer's own
 * discovery document named, over TLS — which is what makes the response trustworthy without
 * verifying a JWT signature here.
 */
async function exchangeCode(cfg: OidcConfig, endpoints: OidcEndpoints, code: string, verifier: string): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: cfg.redirectUri,
    code_verifier: verifier,
    client_id: cfg.clientId,
  });
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  if (cfg.clientSecret) {
    const basic = Buffer.from(`${encodeURIComponent(cfg.clientId)}:${encodeURIComponent(cfg.clientSecret)}`).toString('base64');
    headers.authorization = `Basic ${basic}`;
  }
  const json = (await fetchJsonBounded(endpoints.tokenEndpoint, { method: 'POST', headers, body })) as Record<string, unknown>;
  const accessToken = typeof json.access_token === 'string' ? json.access_token : '';
  if (!accessToken) throw new Error('the token endpoint returned no access_token');
  return { accessToken, idToken: typeof json.id_token === 'string' ? json.id_token : null };
}

/**
 * The payload of a JWT, WITHOUT verifying its signature — and only ever of an ID token that came
 * back in the token response above.
 *
 * That is what OIDC allows for the code flow (§3.1.3.7: a token received directly from the token
 * endpoint over TLS needs no signature check), and it is used for exactly two cross-checks that
 * are worth having: the nonce this server generated, and that the subject matches the one
 * userinfo reports. Anything that fails to parse yields null and the checks are skipped — the
 * access token from the same response is what actually authorizes the userinfo call.
 */
function idTokenClaims(idToken: string | null): Record<string, unknown> | null {
  if (!idToken) return null;
  const parts = idToken.split('.');
  if (parts.length !== 3 || parts[1].length > 8192) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Register the routes.
 *
 * Registered whenever there is any way to log in, NOT only when a provider is configured — and the
 * configuration is resolved per request instead of being captured here. That is what lets an admin
 * complete or change the connection from the panel and have it work on the next request, with
 * nothing to restart (`adminSettings.ts`). With no provider configured, each route answers 404:
 * the surface exists, but it has nothing to talk to.
 */
export function registerOidcAuth(app: Express): void {
  /** The provider in force right now, or null. Every handler starts here. */
  const configured = (res: Response): OidcConfig | null => {
    const cfg = oidcConfig();
    if (!cfg) {
      res.status(404).json({ error: 'no identity provider is configured' });
      return null;
    }
    return cfg;
  };

  // What the sign-in surfaces need to know before anybody is signed in: whether to show the
  // button and what to call it. Public, and deliberately nothing else — no issuer, no client id,
  // no endpoint: a client never talks to the provider directly, so it needs none of them.
  // `enabled` is "offer the button", not "the routes exist": an admin can hide the button while
  // the flow keeps working for anybody holding the URL (see presentation.ts).
  // Answers even with nothing configured (enabled:false) — this is the route a sign-in screen asks
  // before it knows whether there is a provider at all, so a 404 here would be an error to handle
  // rather than an answer.
  app.get('/auth/oauth/config', (_req: Request, res: Response) => {
    res.json({ enabled: oidcButtonVisible(), label: oidcLabel() });
  });

  // Begin a browser login. A GET because it is a navigation (the login page links to it), and it
  // creates nothing but a short-lived flow record.
  app.get('/auth/oauth/start', (req: Request, res: Response) => {
    void (async () => {
      const cfg = configured(res);
      if (!cfg) return;
      try {
        const endpoints = await discover(cfg);
        const flow = createFlow(null);
        setStateCookie(req, res, flow.state);
        res.redirect(302, authorizeUrl(cfg, endpoints, flow.state, flow.nonce, flow.verifier));
      } catch (err) {
        console.error(`[oidc] cannot start a login: ${(err as Error)?.message}`);
        res.status(502).type('html').send(loginPageHtml(GENERIC_FAILURE));
      }
    })();
  });

  // The login itself. See the file header for why this is reachable without a session.
  app.get('/auth/oauth/callback', (req: Request, res: Response) => {
    const cfg = configured(res);
    if (cfg) void handleCallback(cfg, req, res);
  });

  // Begin a desktop pairing: the app gets a URL to open in the real browser and a one-time code
  // to collect the result with. Anonymous by necessity (this is how the app signs in) and it
  // hands out nothing: the code is worthless until somebody completes a login at the provider.
  app.post('/desktop/oauth/start', express.json({ limit: '1kb' }), (_req: Request, res: Response) => {
    void (async () => {
      const cfg = configured(res);
      if (!cfg) return;
      try {
        const endpoints = await discover(cfg);
        const pairing = createPairing();
        const flow = createFlow(pairing.deviceCode);
        res.json({
          authUrl: authorizeUrl(cfg, endpoints, flow.state, flow.nonce, flow.verifier),
          deviceCode: pairing.deviceCode,
          intervalSeconds: PAIRING_POLL_INTERVAL_S,
          expiresInSeconds: Math.floor(PAIRING_TTL_MS / 1000),
          label: cfg.label,
        });
      } catch (err) {
        console.error(`[oidc] cannot start a desktop login: ${(err as Error)?.message}`);
        res.status(502).json({ error: GENERIC_FAILURE });
      }
    })();
  });

  // Collect the bearer for a completed pairing. The device code is the credential; it is
  // consumed on success, so this answers with a token exactly once.
  app.post('/desktop/oauth/token', express.json({ limit: '1kb' }), (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const deviceCode = typeof body.deviceCode === 'string' ? body.deviceCode.slice(0, 128) : '';
    const result = pollPairing(deviceCode || undefined);
    if (result.status === 'pending') return void res.status(202).json({ status: 'pending' });
    if (result.status === 'error') return void res.status(401).json({ error: result.error });
    // 'linked' cannot appear here: a link is polled on its own route, which hands out no token.
    if (result.status !== 'ready') return void res.status(400).json({ error: 'that request is not a sign-in' });
    return void res.status(200).json({ token: result.sid });
  });

  // ── Connecting an existing account ────────────────────────────────────────
  //
  // All four resolve the caller from their session (cookie in the browser, bearer on the desktop)
  // and act on THAT account — never on an id in the payload. The confirm route is the exception
  // and says why on its own line.
  //
  // The resolution is one helper, but the CALL stays in each route body rather than behind a
  // `signedIn(req, res)` wrapper: a gate that only a helper can see is one a reader — and
  // mmo-readiness's route check, which is a grep — cannot confirm from the route itself.
  const reqUserId = (req: Request): string | undefined =>
    userIdFromCookie(req.headers.cookie) ?? userIdFromBearer(req.headers.authorization);
  const unauthorized = (res: Response): void => void res.status(401).json({ error: 'unauthorized' });

  // What the settings panel renders: whether this account is connected, and whether it may be
  // disconnected (an account with no password would lose its only way in).
  app.get('/auth/oauth/link/status', (req: Request, res: Response) => {
    const userId = reqUserId(req);
    if (!userId) return unauthorized(res);
    const cfg = oidcConfig();
    const link = oauthIdentityStore.linkFor(PROVIDER, userId);
    const user = userStore.get(userId);
    res.json({
      enabled: cfg !== null && oidcButtonVisible(),
      label: oidcLabel(),
      linked: link !== undefined,
      connectedAt: link?.createdAt ?? null,
      canDisconnect: link !== undefined && user?.hasPassword === true,
      // Said here rather than only on the refusal, so the button can explain itself before it is
      // pressed instead of failing when it is.
      disconnectBlockedReason:
        link !== undefined && user?.hasPassword !== true
          ? `${oidcLabel()} is the only way into this account. Set a password first.`
          : null,
    });
  });

  // Begin connecting. Answers a pairing rather than a redirect: the same shape serves the browser
  // (a second tab) and the desktop (the system browser), and neither needs this page to navigate.
  app.post('/auth/oauth/link/start', express.json({ limit: '1kb' }), (req: Request, res: Response) => {
    void (async () => {
      const userId = reqUserId(req);
      if (!userId) return unauthorized(res);
      const cfg = configured(res);
      if (!cfg) return;
      if (oauthIdentityStore.linkFor(PROVIDER, userId)) {
        return void res.status(409).json({ error: `This account is already connected to ${oidcLabel()}.` });
      }
      try {
        const endpoints = await discover(cfg);
        const pairing = createPairing();
        const flow = createFlow(pairing.deviceCode, userId);
        res.json({
          authUrl: authorizeUrl(cfg, endpoints, flow.state, flow.nonce, flow.verifier),
          deviceCode: pairing.deviceCode,
          intervalSeconds: PAIRING_POLL_INTERVAL_S,
          expiresInSeconds: Math.floor(PAIRING_TTL_MS / 1000),
          label: oidcLabel(),
        });
      } catch (err) {
        console.error(`[oidc] cannot start a link: ${(err as Error)?.message}`);
        res.status(502).json({ error: GENERIC_FAILURE });
      }
    })();
  });

  // Watch it finish. Hands out nothing — the caller already has a session — so a 200 here means
  // only "the link now exists".
  app.post('/auth/oauth/link/poll', express.json({ limit: '1kb' }), (req: Request, res: Response) => {
    const userId = reqUserId(req);
    if (!userId) return unauthorized(res);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const deviceCode = typeof body.deviceCode === 'string' ? body.deviceCode.slice(0, 128) : '';
    const result = pollPairing(deviceCode || undefined);
    if (result.status === 'pending') return void res.status(202).json({ status: 'pending' });
    if (result.status === 'linked') return void res.status(200).json({ status: 'linked' });
    if (result.status === 'error') return void res.status(400).json({ error: result.error });
    return void res.status(400).json({ error: 'that request is not a link' });
  });

  // The human's yes, posted by the page the flow ends on. Authorized by the one-time token that
  // page carries and nothing else — deliberately: it may be submitted from a system browser that
  // has no session with this server at all, which is the whole reason the desktop pairs. The token
  // is unguessable, single-use, short-lived, and useless without having just completed an exchange.
  app.post('/auth/oauth/link/confirm', express.urlencoded({ extended: false }), (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const token = typeof body.token === 'string' ? body.token.slice(0, 256) : '';
    const pending = takePendingLink(token || undefined);
    if (!pending) {
      return void res.status(400).type('html').send(resultPage('This confirmation has expired — start again from Settings.', false));
    }
    const claims = { sub: pending.subject, preferredUsername: pending.providerName, email: '', name: '', roles: [] };
    const result = linkOidcAccount(pending.userId, claims as OidcClaims, oidcLabel());
    if ('error' in result) {
      if (pending.deviceCode) completePairing(pending.deviceCode, { error: result.error });
      return void res.status(409).type('html').send(resultPage(result.error, false));
    }
    if (pending.deviceCode) completePairing(pending.deviceCode, { linked: true });
    res
      .status(200)
      .type('html')
      .send(resultPage(`Connected. You can close this tab — ${oidcLabel()} now signs you in as "${pending.userId}".`, true));
  });

  app.post('/auth/oauth/link/disconnect', express.json({ limit: '1kb' }), (req: Request, res: Response) => {
    const userId = reqUserId(req);
    if (!userId) return unauthorized(res);
    const result = unlinkOidcAccount(userId, oidcLabel());
    if ('error' in result) return void res.status(400).json({ error: result.error });
    res.json({ ok: true });
  });
}

/**
 * Finish a login: validate the callback, exchange the code, read the claims, resolve the account,
 * and hand out a session — as a cookie for a browser, or parked on the pairing for the desktop.
 *
 * Order matters: nothing is exchanged until the state has been matched against BOTH the
 * server-side flow (which is consumed, so a code cannot be replayed) and the cookie set when the
 * flow started.
 */
async function handleCallback(cfg: OidcConfig, req: Request, res: Response): Promise<void> {
  const query = req.query as Record<string, unknown>;
  const state = typeof query.state === 'string' ? query.state.slice(0, 256) : '';
  const code = typeof query.code === 'string' ? query.code.slice(0, 4096) : '';
  const providerError = typeof query.error === 'string' ? query.error.slice(0, 128) : '';
  const cookieState = parseCookie(req.headers.cookie, STATE_COOKIE);

  const flow = takeFlow(state || undefined);
  const fail = (userMessage: string, logLine: string, status = 400): void => {
    console.warn(`[oidc] login failed: ${logLine}`);
    if (flow?.deviceCode) {
      completePairing(flow.deviceCode, { error: userMessage });
      clearStateCookie(res);
      res.status(status).type('html').send(resultPage(userMessage, false));
      return;
    }
    clearStateCookie(res);
    res.status(status).type('html').send(loginPageHtml(userMessage));
  };

  if (!flow) return fail(GENERIC_FAILURE, `unknown or expired state (${state ? 'not found' : 'absent'})`);
  // The cookie is what makes this browser's callback its own: without it, a login could be
  // completed in somebody else's browser by handing them a callback URL (login CSRF).
  if (!flow.deviceCode && cookieState !== flow.state) {
    return fail(GENERIC_FAILURE, 'the state cookie does not match the callback state');
  }
  if (providerError) {
    const denied = providerError === 'access_denied';
    return fail(
      denied ? 'The identity provider refused this sign-in.' : GENERIC_FAILURE,
      `the provider answered error=${providerError}`,
      denied ? 403 : 400,
    );
  }
  if (!code) return fail(GENERIC_FAILURE, 'the callback carried no code');

  let tokens: TokenResponse;
  let claimsPayload: unknown;
  try {
    const endpoints = await discover(cfg);
    tokens = await exchangeCode(cfg, endpoints, code, flow.verifier);
    claimsPayload = await fetchJsonBounded(endpoints.userinfoEndpoint, {
      headers: { authorization: `Bearer ${tokens.accessToken}` },
    });
  } catch (err) {
    return fail(GENERIC_FAILURE, (err as Error)?.message ?? 'unknown error', 502);
  }

  const claims = readClaims(claimsPayload, cfg);
  if ('error' in claims) return fail(claims.error, `unusable claims: ${claims.error}`);

  // The two cross-checks the ID token is good for (see idTokenClaims).
  const idClaims = idTokenClaims(tokens.idToken);
  if (idClaims) {
    if (typeof idClaims.nonce === 'string' && idClaims.nonce !== flow.nonce) {
      return fail(GENERIC_FAILURE, 'the ID token nonce does not match the flow');
    }
    if (typeof idClaims.sub === 'string' && idClaims.sub !== claims.sub) {
      return fail(GENERIC_FAILURE, 'the ID token subject does not match the userinfo subject');
    }
  }

  // A link stops one step short of writing anything: the page that comes next names both
  // identities and asks. See the file header for the attack that makes this more than ceremony.
  if (flow.linkUserId) {
    const owner = userStore.get(flow.linkUserId);
    if (!owner) return fail('That account no longer exists.', `link target "${flow.linkUserId}" is gone`, 404);
    const pending = createPendingLink({
      userId: owner.userId,
      subject: claims.sub,
      providerName: claims.preferredUsername || claims.email || claims.name || claims.sub,
      deviceCode: flow.deviceCode,
    });
    clearStateCookie(res);
    res.status(200).type('html').send(confirmLinkPage(pending.token, pending.providerName, owner.userId, oidcLabel()));
    return;
  }

  const resolved = resolveOidcUser(claims, cfg);
  if ('error' in resolved) return fail(resolved.error, `provisioning refused: ${resolved.error}`, resolved.status ?? 403);

  console.log(`[oidc] signed in "${resolved.userId}"${resolved.created ? ' (new account)' : ''}`);
  if (flow.deviceCode) {
    // Desktop: the app is waiting on its own poll, so the session goes there and this tab only
    // says so. The token never touches the URL.
    completePairing(flow.deviceCode, { sid: appStore.createSession(resolved.userId) });
    clearStateCookie(res);
    res.status(200).type('html').send(resultPage('You are signed in — you can close this tab and return to the app.', true));
    return;
  }
  // Browser: the same opaque session cookie the password form sets, then into the world.
  clearStateCookie(res);
  setSessionCookie(req, res, resolved.userId, { append: true });
  res.redirect(303, '/');
}

/**
 * The page a flow that cannot set a cookie is left on — a desktop sign-in, and every link. In the
 * house chrome and self-contained: this is served to a browser that may have no session with this
 * server at all, so it fetches nothing, not even the font.
 */
function resultPage(message: string, ok: boolean): string {
  const escaped = message.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] ?? c);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>pixel-agents — sign-in</title>
<style>html,body{height:100%;margin:0}body{background:#141312;color:#f1efec;
font-family:ui-monospace,monospace;display:flex;align-items:center;justify-content:center;text-align:center}
div{background:#1c1a19;border:2px solid #0a0908;border-radius:0.6rem;padding:24px 28px;max-width:26rem;
box-shadow:inset 0 2px 0 #292725,inset 0 -3px 0 #030303,0 12px 28px rgba(0,0,0,.55)}
h3{margin:0 0 10px;color:#f5f3f0}p{margin:0;color:${ok ? '#adb0b2' : '#f6cdd4'};line-height:1.5}</style>
</head><body><div><h3>pixel-agents</h3><p>${escaped}</p></div></body></html>`;
}

/**
 * "Connect <directory account> to <pixel-agents account>?" — the one page in this flow that asks
 * instead of telling.
 *
 * Both names are on it because that is what makes it a real check: somebody who was handed
 * a link they did not start sees an account name that is not theirs and stops. No script and no
 * fetched asset, for the same reason as `resultPage`.
 */
function confirmLinkPage(token: string, providerName: string, accountId: string, label: string): string {
  const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>pixel-agents — connect account</title>
<style>html,body{height:100%;margin:0}body{background:#141312;color:#f1efec;
font-family:ui-monospace,monospace;display:flex;align-items:center;justify-content:center;text-align:center}
form{background:#1c1a19;border:2px solid #0a0908;border-radius:0.6rem;padding:24px 28px;max-width:28rem;
box-shadow:inset 0 2px 0 #292725,inset 0 -3px 0 #030303,0 12px 28px rgba(0,0,0,.55)}
h3{margin:0 0 10px;color:#f5f3f0}p{margin:0 0 16px;color:#adb0b2;line-height:1.55}
b{color:#f1efec}
button{background:#c51a1b;color:#fff;border:2px solid #0a0908;border-radius:0.45rem;padding:10px 18px;
font:bold 14px ui-monospace,monospace;cursor:pointer;box-shadow:inset 0 2px 0 #e2585a,inset 0 -3px 0 #5c0f10}
button:hover{background:#d42021}
.warn{color:#e6c48f;font-size:13px;margin:14px 0 0;line-height:1.5}</style></head><body>
<form method="post" action="/auth/oauth/link/confirm"><h3>pixel-agents</h3>
<p>Connect the ${esc(label)} account <b>${esc(providerName)}</b> to the pixel-agents account
<b>${esc(accountId)}</b>?<br>After this, signing in with ${esc(label)} signs you in as
<b>${esc(accountId)}</b>.</p>
<input type="hidden" name="token" value="${esc(token)}">
<div><button type="submit">Connect</button></div>
<p class="warn">If <b>${esc(accountId)}</b> is not your account, close this tab instead — somebody
else would be signing in as you.</p></form></body></html>`;
}
