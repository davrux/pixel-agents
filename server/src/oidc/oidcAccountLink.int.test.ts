/**
 * Connecting a provider identity to an account that already exists, and disconnecting it again.
 *
 * The properties worth pinning are the ones that decide whose account a directory login ends up
 * signing into:
 *
 *  • the account being linked comes from the SESSION that started the flow, never from the
 *    callback or the claims — so a completed flow cannot be redirected onto somebody else;
 *  • nothing is written until the confirmation POST arrives with the one-time token from the page
 *    the flow ends on. That page is what stops the attack this shape otherwise has: whoever starts
 *    a flow can hand its URL to somebody else, and without the confirmation the victim's identity
 *    would silently attach to the starter's account;
 *  • a subject already signing in as another account is refused, and so is a second identity on an
 *    account that already has one — neither may be replaced silently;
 *  • disconnecting is refused when the provider is the account's ONLY way in, because the account
 *    would otherwise be locked out of a world its owner can still see;
 *  • after linking, a normal provider sign-in lands on that account — which is the whole point.
 *
 * TEST BOUNDARIES:
 *   @real-dependency: express + the real routes + SQLite + a real HTTP identity provider on
 *       loopback -- Mock? NO. Every claim is about what a sequence of HTTP requests does, and the
 *       checks live in the routes. A throwaway PIXEL_STREAM_DATA_DIR keeps it off a developer's
 *       world.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server as HttpServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

const ADMIN_TOKEN = 'oidc-link-test-token';

let dataDir: string;
let idp: HttpServer;
let idpBase: string;
let app: HttpServer;
let base: string;
let userStore: typeof import('../userStore.js').userStore;
let appStore: typeof import('../appStore.js').appStore;
let oauthIdentityStore: typeof import('./identityStore.js').oauthIdentityStore;
/** Bearer sessions: two ordinary accounts with passwords, and one provisioned (no password). */
let aliceBearer: string;
let bobBearer: string;
let carolBearer: string;
let ssoOnlyBearer: string;

const claims = { sub: '', name: '' };
const codes = new Set<string>();
let nonce = '';

const b64url = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');

function startIdp(): Promise<void> {
  idp = createServer((req, res) => {
    const url = new URL(req.url ?? '/', idpBase);
    const json = (code: number, body: unknown): void => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/.well-known/openid-configuration') {
      return json(200, {
        issuer: idpBase,
        authorization_endpoint: `${idpBase}/authorize`,
        token_endpoint: `${idpBase}/token`,
        userinfo_endpoint: `${idpBase}/userinfo`,
      });
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += String(c)));
      req.on('end', () => {
        const code = new URLSearchParams(body).get('code') ?? '';
        if (!codes.has(code)) return json(400, { error: 'invalid_grant' });
        codes.delete(code);
        return json(200, {
          access_token: `at-${code}`,
          id_token: `${b64url({ alg: 'none' })}.${b64url({ sub: claims.sub, nonce })}.sig`,
        });
      });
      return;
    }
    if (url.pathname === '/userinfo') {
      if (!String(req.headers.authorization ?? '').startsWith('Bearer at-')) return json(401, { error: 'unauthorized' });
      return json(200, { sub: claims.sub, preferred_username: claims.name, name: claims.name });
    }
    res.writeHead(404).end();
  });
  return new Promise<void>((resolve) => {
    idp.listen(0, '127.0.0.1', () => {
      idpBase = `http://127.0.0.1:${(idp.address() as AddressInfo).port}`;
      resolve();
    });
  });
}

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'pixel-oidc-link-'));
  process.env.PIXEL_STREAM_DATA_DIR = dataDir;
  await startIdp();
  process.env.PIXEL_OIDC_ISSUER = idpBase;
  process.env.PIXEL_OIDC_CLIENT_ID = 'link-test-client';
  process.env.PIXEL_OIDC_REDIRECT_URI = 'placeholder';
  delete process.env.PIXEL_OIDC_CLIENT_SECRET;
  delete process.env.PIXEL_OIDC_ADMIN_ROLE;
  // Off, so nothing links itself behind the test's back: this file is about the DELIBERATE link.
  process.env.PIXEL_OIDC_CLAIM_EXISTING = '0';

  const express = (await import('express')).default;
  const { resetOidcConfig } = await import('./config.js');
  ({ userStore } = await import('../userStore.js'));
  ({ appStore } = await import('../appStore.js'));
  ({ oauthIdentityStore } = await import('./identityStore.js'));
  const { registerOidcAuth } = await import('./routes.js');
  const { registerAuth } = await import('../auth.js');

  const server = express();
  app = createServer(server);
  await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', () => resolve()));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  process.env.PIXEL_OIDC_REDIRECT_URI = `${base}/auth/oauth/callback`;
  resetOidcConfig();
  registerOidcAuth(server);
  registerAuth(server, ADMIN_TOKEN);

  userStore.createUser('alice', 'password-123', {});
  userStore.createUser('bob', 'password-123', {});
  userStore.createUser('carol', 'password-123', {});
  userStore.createProvisionedUser('ssoonly', { username: 'SSO Only' });
  aliceBearer = appStore.createSession('alice');
  bobBearer = appStore.createSession('bob');
  carolBearer = appStore.createSession('carol');
  ssoOnlyBearer = appStore.createSession('ssoonly');
});

after(() => {
  app?.close();
  idp?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(async () => {
  const { clearPending } = await import('./pending.js');
  clearPending();
  codes.clear();
});

const authed = (bearer: string): Record<string, string> => ({ authorization: `Bearer ${bearer}` });

async function status(bearer: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${base}/auth/oauth/link/status`, { headers: authed(bearer) });
  assert.equal(res.status, 200);
  return (await res.json()) as Record<string, unknown>;
}

/** Start a link and play the provider's part up to (not through) the confirmation page. */
async function linkUpToConfirmation(
  bearer: string,
  subject: string,
  name: string,
): Promise<{ deviceCode: string; page: string; token: string | null; callbackStatus: number }> {
  const startRes = await fetch(`${base}/auth/oauth/link/start`, { method: 'POST', headers: authed(bearer) });
  // Read the body ONCE: a fetch Response is a stream, and passing `await res.text()` as an
  // assertion message consumes it before the parse.
  const startText = await startRes.text();
  assert.equal(startRes.status, 200, startText);
  const started = JSON.parse(startText) as { authUrl: string; deviceCode: string };
  const params = new URL(started.authUrl).searchParams;
  nonce = params.get('nonce') ?? '';
  claims.sub = subject;
  claims.name = name;
  const code = `link-code-${subject}-${Math.floor(Math.random() * 1e9)}`;
  codes.add(code);
  const cb = await fetch(`${base}/auth/oauth/callback?code=${code}&state=${encodeURIComponent(params.get('state') ?? '')}`, {
    redirect: 'manual',
  });
  const page = await cb.text();
  const token = /name="token" value="([^"]+)"/.exec(page)?.[1] ?? null;
  return { deviceCode: started.deviceCode, page, token, callbackStatus: cb.status };
}

async function confirm(token: string): Promise<Response> {
  return fetch(`${base}/auth/oauth/link/confirm`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }).toString(),
    redirect: 'manual',
  });
}

async function poll(bearer: string, deviceCode: string): Promise<Response> {
  return fetch(`${base}/auth/oauth/link/poll`, {
    method: 'POST',
    headers: { ...authed(bearer), 'content-type': 'application/json' },
    body: JSON.stringify({ deviceCode }),
  });
}

test('every link route refuses a caller with no session', async () => {
  assert.equal((await fetch(`${base}/auth/oauth/link/status`)).status, 401);
  assert.equal((await fetch(`${base}/auth/oauth/link/start`, { method: 'POST' })).status, 401);
  assert.equal((await fetch(`${base}/auth/oauth/link/poll`, { method: 'POST' })).status, 401);
  assert.equal((await fetch(`${base}/auth/oauth/link/disconnect`, { method: 'POST' })).status, 401);
});

test('an unconnected account is offered the connection', async () => {
  const s = await status(aliceBearer);
  assert.equal(s.enabled, true);
  assert.equal(s.linked, false);
  assert.equal(s.canDisconnect, false);
});

test('nothing is linked until the confirmation page is submitted', async () => {
  const { page, token, callbackStatus, deviceCode } = await linkUpToConfirmation(aliceBearer, 'sub-alice', 'alice@corp.example');
  assert.equal(callbackStatus, 200);
  assert.ok(token, 'the page carries a one-time token');

  // The page names BOTH identities — that is what makes it a real check rather than a click-through.
  assert.match(page, /alice@corp\.example/);
  assert.match(page, /<b>alice<\/b>/);

  // Not linked yet, and the client is still told "pending".
  assert.equal(oauthIdentityStore.userIdFor('oidc', 'sub-alice'), undefined);
  assert.equal((await status(aliceBearer)).linked, false);
  assert.equal((await poll(aliceBearer, deviceCode)).status, 202);

  const confirmed = await confirm(token!);
  assert.equal(confirmed.status, 200);
  assert.match(await confirmed.text(), /Connected/);
  assert.equal(oauthIdentityStore.userIdFor('oidc', 'sub-alice'), 'alice');

  // The panel's poll now completes, exactly once, and hands out no credential.
  const ready = await poll(aliceBearer, deviceCode);
  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), { status: 'linked' });
  assert.equal((await poll(aliceBearer, deviceCode)).status, 400, 'the pairing is consumed');

  const s = await status(aliceBearer);
  assert.equal(s.linked, true);
  assert.equal(s.canDisconnect, true, 'alice has a password to fall back on');
});

test('a confirmation token is single-use and cannot be guessed at', async () => {
  const { token } = await linkUpToConfirmation(bobBearer, 'sub-bob', 'bob@corp.example');
  assert.equal((await confirm(token!)).status, 200);
  const replay = await confirm(token!);
  assert.equal(replay.status, 400, 'the same token must not confirm twice');
  assert.equal((await confirm('a'.repeat(43))).status, 400, 'and an invented one confirms nothing');
});

test('after linking, a provider sign-in lands on that account', async () => {
  // A normal sign-in (not a link): no session anywhere, just the provider saying who this is.
  const start = await fetch(`${base}/auth/oauth/start`, { redirect: 'manual' });
  const params = new URL(start.headers.get('location') ?? '').searchParams;
  const cookie = (start.headers.get('set-cookie') ?? '').split(';')[0];
  nonce = params.get('nonce') ?? '';
  claims.sub = 'sub-alice';
  claims.name = 'alice@corp.example';
  const code = 'signin-after-link';
  codes.add(code);
  const cb = await fetch(`${base}/auth/oauth/callback?code=${code}&state=${encodeURIComponent(params.get('state') ?? '')}`, {
    redirect: 'manual',
    headers: { cookie },
  });
  assert.equal(cb.status, 303);
  const sid = (cb.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('pixel_stream_sid='))?.split('=')[1]?.split(';')[0];
  assert.ok(sid);
  assert.equal(appStore.getSession(sid!)?.userId, 'alice', 'the linked account, not a new one');
  assert.equal(userStore.exists('alice-2'), false, 'and no second account was provisioned');
});

test('a subject that already signs in as somebody else cannot be linked again', async () => {
  // Carol (connected to nothing) tries to attach Alice's directory identity to her own account.
  const { token } = await linkUpToConfirmation(carolBearer, 'sub-alice', 'alice@corp.example');
  const res = await confirm(token!);
  assert.equal(res.status, 409);
  assert.match(await res.text(), /already connected to another user/);
  assert.equal(oauthIdentityStore.userIdFor('oidc', 'sub-alice'), 'alice', 'still Alice');
  assert.equal((await status(carolBearer)).linked, false, 'and Carol got nothing');
});

test('an account that already has an identity is not silently given a second one', async () => {
  const start = await fetch(`${base}/auth/oauth/link/start`, { method: 'POST', headers: authed(aliceBearer) });
  assert.equal(start.status, 409, 'refused before the provider is even involved');
  assert.match(((await start.json()) as { error: string }).error, /already connected/);
});

test('disconnecting is refused while the provider is the only way in', async () => {
  const { token } = await linkUpToConfirmation(ssoOnlyBearer, 'sub-ssoonly', 'ssoonly@corp.example');
  assert.equal((await confirm(token!)).status, 200);

  const s = await status(ssoOnlyBearer);
  assert.equal(s.linked, true);
  assert.equal(s.canDisconnect, false);
  assert.match(String(s.disconnectBlockedReason), /only way into this account/);

  const res = await fetch(`${base}/auth/oauth/link/disconnect`, { method: 'POST', headers: authed(ssoOnlyBearer) });
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /Set a password first/);
  assert.equal(oauthIdentityStore.userIdFor('oidc', 'sub-ssoonly'), 'ssoonly', 'the link is still there');

  // With a password, the same call goes through — and the account keeps everything else.
  userStore.setPassword('ssoonly', 'password-123');
  const ok = await fetch(`${base}/auth/oauth/link/disconnect`, { method: 'POST', headers: authed(ssoOnlyBearer) });
  assert.equal(ok.status, 200);
  assert.equal(oauthIdentityStore.userIdFor('oidc', 'sub-ssoonly'), undefined);
  assert.equal(userStore.get('ssoonly')?.username, 'SSO Only', 'disconnecting is not a delete');
});

test('a disconnected account can be connected again', async () => {
  const { token } = await linkUpToConfirmation(ssoOnlyBearer, 'sub-ssoonly', 'ssoonly@corp.example');
  assert.equal((await confirm(token!)).status, 200);
  assert.equal(oauthIdentityStore.userIdFor('oidc', 'sub-ssoonly'), 'ssoonly');
});

test('every link action acts on the caller\'s own account and no other', async () => {
  // Bob and Alice are both connected by now, to their own subjects.
  assert.equal(oauthIdentityStore.userIdFor('oidc', 'sub-bob'), 'bob');
  assert.equal(oauthIdentityStore.userIdFor('oidc', 'sub-alice'), 'alice');

  // Bob disconnects: his link goes, Alice's stays. There is no id in the request to get wrong —
  // the account is the session's.
  const res = await fetch(`${base}/auth/oauth/link/disconnect`, { method: 'POST', headers: authed(bobBearer) });
  assert.equal(res.status, 200);
  assert.equal(oauthIdentityStore.userIdFor('oidc', 'sub-bob'), undefined);
  assert.equal(oauthIdentityStore.userIdFor('oidc', 'sub-alice'), 'alice', "Alice's link is untouched");
  assert.equal((await status(aliceBearer)).linked, true);

  // A device code the caller was never given is worth nothing.
  assert.equal((await poll(carolBearer, 'x'.repeat(43))).status, 400);
});
