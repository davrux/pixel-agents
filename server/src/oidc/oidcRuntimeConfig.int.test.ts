/**
 * Turning single sign-on ON from the admin panel, on a server whose environment names no provider
 * at all — the reason the connection fields are editable.
 *
 * This is the end-to-end version of what `oidcAdminSettings.int.test.ts` checks field by field: an
 * admin types an issuer, a client id and a redirect URI into the panel, and a real login through a
 * real provider works on the next request, with nothing restarted. Three things it pins that
 * nothing else can:
 *
 *  • before the connection exists the routes are REGISTERED but answer 404 — the surface has to be
 *    there for the panel to complete, and answering "no provider" is not the same as not existing;
 *  • the values the panel stored are the ones actually used, checked at the provider (the
 *    client_id and redirect_uri the authorize request carries) rather than by reading them back;
 *  • no client secret is sent, because none exists — the flow authenticates with PKCE alone, which
 *    is what a connection configured here always is (see `adminSettings.ts`).
 *
 * TEST BOUNDARIES:
 *   @real-dependency: express + the real routes + SQLite + a real HTTP identity provider on
 *       loopback -- Mock? NO. The claim is "an admin can switch this on without a restart", and
 *       every part of it is HTTP: the panel's PUT, the provider's discovery, the token exchange.
 *       A throwaway PIXEL_STREAM_DATA_DIR keeps it off a developer's world.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server as HttpServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

const ADMIN_TOKEN = 'oidc-runtime-config-token';
const CLIENT_ID = 'typed-into-the-panel';

let dataDir: string;
let idp: HttpServer;
let idpBase: string;
let app: HttpServer;
let base: string;
let adminBearer: string;
let userStore: typeof import('../userStore.js').userStore;

/** What the fake provider saw and will answer with. */
const seen = {
  authorize: null as URLSearchParams | null,
  tokenAuthHeader: 'unset' as string,
  nonce: '',
  codes: new Set<string>(),
};

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
    if (url.pathname === '/authorize') {
      seen.authorize = url.searchParams;
      return json(200, { ok: true });
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += String(c)));
      req.on('end', () => {
        // 'unset' vs '' matters: this is the assertion that no secret was sent.
        seen.tokenAuthHeader = String(req.headers.authorization ?? '');
        const form = new URLSearchParams(body);
        const code = form.get('code') ?? '';
        if (!seen.codes.has(code)) return json(400, { error: 'invalid_grant' });
        if (!form.get('code_verifier')) return json(400, { error: 'invalid_request' });
        seen.codes.delete(code);
        return json(200, {
          access_token: `at-${code}`,
          id_token: `${b64url({ alg: 'none' })}.${b64url({ sub: 'runtime-sub', nonce: seen.nonce })}.sig`,
        });
      });
      return;
    }
    if (url.pathname === '/userinfo') {
      if (!String(req.headers.authorization ?? '').startsWith('Bearer at-')) return json(401, { error: 'unauthorized' });
      return json(200, { sub: 'runtime-sub', preferred_username: 'panelsetup@corp.example', name: 'Panel Setup' });
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
  dataDir = mkdtempSync(join(tmpdir(), 'pixel-oidc-runtime-'));
  process.env.PIXEL_STREAM_DATA_DIR = dataDir;
  // The point of this file: NOTHING is configured in the environment.
  for (const key of Object.keys(process.env)) if (key.startsWith('PIXEL_OIDC_')) delete process.env[key];
  await startIdp();

  const express = (await import('express')).default;
  const { resetOidcConfig } = await import('./config.js');
  resetOidcConfig();
  ({ userStore } = await import('../userStore.js'));
  const { appStore } = await import('../appStore.js');
  const { registerOidcAuth } = await import('./routes.js');
  const { registerAuth } = await import('../auth.js');
  const { registerAdminApi } = await import('../adminApi.js');

  const server = express();
  registerOidcAuth(server);
  registerAuth(server, ADMIN_TOKEN);
  registerAdminApi(server);
  app = createServer(server);
  await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', () => resolve()));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;

  userStore.createUser('runtimeadmin', 'password-123', { isAdmin: true });
  adminBearer = appStore.createSession('runtimeadmin');
});

after(() => {
  app?.close();
  idp?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('with nothing configured the routes exist and say so, and no button is offered', async () => {
  const cfg = (await (await fetch(`${base}/auth/oauth/config`)).json()) as { enabled: boolean };
  assert.equal(cfg.enabled, false);

  // Registered, but with nothing to talk to: 404 rather than a crash or an HTML login page.
  assert.equal((await fetch(`${base}/auth/oauth/start`, { redirect: 'manual' })).status, 404);
  assert.equal((await fetch(`${base}/desktop/oauth/start`, { method: 'POST' })).status, 404);

  const page = await (await fetch(`${base}/login`)).text();
  assert.equal(page.includes('/auth/oauth/start'), false, 'the login page offers only the password form');

  const settings = (await (await fetch(`${base}/admin/oidc`, { headers: { authorization: `Bearer ${adminBearer}` } })).json()) as {
    configured: boolean;
    connection: { issuer: { source: string } };
    environment: unknown;
  };
  assert.equal(settings.configured, false);
  assert.equal(settings.connection.issuer.source, 'unset');
  assert.equal(settings.environment, null, 'the panel still renders with no deployment settings at all');
});

test('an admin types the connection into the panel and single sign-on comes up', async () => {
  const res = await fetch(`${base}/admin/oidc`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${adminBearer}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      issuer: idpBase,
      clientId: CLIENT_ID,
      redirectUri: `${base}/auth/oauth/callback`,
      label: 'Corp Directory',
    }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, presentation: { label: 'Corp Directory', showButton: true, autoRedirect: false }, configured: true, secretActive: false });

  // Immediately, with nothing restarted: the button appears and the flow starts.
  const cfg = (await (await fetch(`${base}/auth/oauth/config`)).json()) as { enabled: boolean; label: string };
  assert.deepEqual(cfg, { enabled: true, label: 'Corp Directory' });
  assert.match(await (await fetch(`${base}/login`)).text(), /Sign in with Corp Directory/);
});

test('a real login goes through the provider the panel named, as a public client', async () => {
  const start = await fetch(`${base}/auth/oauth/start`, { redirect: 'manual' });
  assert.equal(start.status, 302);
  const authorizeUrl = new URL(start.headers.get('location') ?? '');
  const cookie = (start.headers.get('set-cookie') ?? '').split(';')[0];

  // The values typed into the panel are the ones on the wire — asked of the URL the browser is
  // actually sent to, not read back out of the settings.
  assert.equal(authorizeUrl.origin, new URL(idpBase).origin);
  assert.equal(authorizeUrl.searchParams.get('client_id'), CLIENT_ID);
  assert.equal(authorizeUrl.searchParams.get('redirect_uri'), `${base}/auth/oauth/callback`);
  assert.equal(authorizeUrl.searchParams.get('code_challenge_method'), 'S256');

  const state = authorizeUrl.searchParams.get('state') ?? '';
  seen.nonce = authorizeUrl.searchParams.get('nonce') ?? '';
  const code = 'runtime-code';
  seen.codes.add(code);

  const cb = await fetch(`${base}/auth/oauth/callback?code=${code}&state=${encodeURIComponent(state)}`, {
    redirect: 'manual',
    headers: { cookie },
  });
  assert.equal(cb.status, 303);
  assert.equal(cb.headers.get('location'), '/');
  assert.ok(
    (cb.headers.getSetCookie?.() ?? []).some((c) => c.startsWith('pixel_stream_sid=') && !c.includes('Max-Age=0')),
    'the login issued a session',
  );

  // No secret exists here, so none may be sent: the exchange is PKCE-only.
  assert.equal(seen.tokenAuthHeader, '', 'the token request must carry no Authorization header');

  const user = userStore.get('panelsetup');
  assert.ok(user, 'the account was provisioned from the claims');
  assert.equal(user.username, 'Panel Setup');
  assert.equal(user.hasPassword, false);
});

test('clearing the connection turns single sign-on back off', async () => {
  const res = await fetch(`${base}/admin/oidc`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${adminBearer}`, 'content-type': 'application/json' },
    body: JSON.stringify({ issuer: '' }),
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json() as { configured: boolean }).configured, false, 'an incomplete connection is no connection');
  assert.equal((await fetch(`${base}/auth/oauth/start`, { redirect: 'manual' })).status, 404);
  const page = await (await fetch(`${base}/login`)).text();
  assert.match(page, /name="password"/, 'and the password form is still the way in');
});
