/**
 * OIDC login, end to end against a fake provider: who gets in, who does not, and which account
 * they land in.
 *
 * The properties worth pinning are the ones a reader of the code has to take on trust otherwise:
 *
 *  • A callback only completes with a state this server MADE, in the browser that started the
 *    flow (the cookie), and only once — a replayed code is worth nothing.
 *  • Every claim acted on comes from the token/userinfo exchange this server performed, never
 *    from the query string; a callback that carries claims of its own cannot influence anything.
 *  • The account is keyed by the immutable `sub`, so a renamed user comes back to the same
 *    account, and two subjects never collapse into one login id.
 *  • The desktop pairing hands its bearer over exactly once.
 *  • The provider's roles decide admin when configured — except that they may not revoke the
 *    last usable admin, which is the one failure that would need the admin panel to fix.
 *
 * TEST BOUNDARIES:
 *   @real-dependency: express + the real routes + SQLite + a real HTTP identity provider on
 *       loopback -- Mock? NO. The claim is "this flow authenticates", and the flow is three HTTP
 *       exchanges; stubbing the provider would leave the test asserting my own fixtures. The
 *       fake provider is a real server that speaks discovery/token/userinfo, so the client half
 *       (URL building, PKCE, Basic auth, the ID-token cross-checks) is exercised for real.
 *       A throwaway PIXEL_STREAM_DATA_DIR keeps it off a developer's world.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server as HttpServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

const CLIENT_ID = 'pixel-test-client';
const CLIENT_SECRET = 'pixel-test-secret';
const ADMIN_ROLE = 'pixel-admin';

let dataDir: string;
let idp: HttpServer;
let idpBase: string;
let app: HttpServer;
let base: string;
let userStore: typeof import('../userStore.js').userStore;
let appStore: typeof import('../appStore.js').appStore;
let oauthIdentityStore: typeof import('./identityStore.js').oauthIdentityStore;

/** What the fake provider will report for the next login, and what it saw. */
const idp_ = {
  claims: {} as Record<string, unknown>,
  /** Extra claims for the ID TOKEN only — Zitadel asserts project roles there by default. */
  idTokenClaims: {} as Record<string, unknown>,
  nonce: '',
  /** Authorization requests seen, so the test can assert what was sent. */
  lastAuthorize: null as URLSearchParams | null,
  /** Codes the provider has issued and not yet redeemed. */
  codes: new Set<string>(),
  /** Basic credentials seen on the token endpoint. */
  lastBasic: '' as string,
};

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

/** An unsigned JWT: the flow reads the payload of a token it fetched itself and never verifies a
 *  signature (see routes.ts / idTokenClaims), so the signature segment is deliberately garbage. */
function fakeIdToken(payload: Record<string, unknown>): string {
  return `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url(payload)}.not-a-signature`;
}

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
        authorization_endpoint: `${idpBase}/oauth/v2/authorize`,
        token_endpoint: `${idpBase}/oauth/v2/token`,
        userinfo_endpoint: `${idpBase}/oidc/v1/userinfo`,
        end_session_endpoint: `${idpBase}/oidc/v1/end_session`,
      });
    }
    if (url.pathname === '/oauth/v2/authorize') {
      idp_.lastAuthorize = url.searchParams;
      return json(200, { ok: true });
    }
    if (url.pathname === '/oauth/v2/token' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += String(c)));
      req.on('end', () => {
        const form = new URLSearchParams(body);
        idp_.lastBasic = String(req.headers.authorization ?? '');
        const code = form.get('code') ?? '';
        if (!idp_.codes.has(code)) return json(400, { error: 'invalid_grant' });
        if (!form.get('code_verifier')) return json(400, { error: 'invalid_request', detail: 'no PKCE verifier' });
        idp_.codes.delete(code);
        return json(200, {
          access_token: `at-${code}`,
          token_type: 'Bearer',
          id_token: fakeIdToken({ sub: String(idp_.claims.sub ?? ''), nonce: idp_.nonce, ...idp_.idTokenClaims }),
        });
      });
      return;
    }
    if (url.pathname === '/oidc/v1/userinfo') {
      if (!String(req.headers.authorization ?? '').startsWith('Bearer at-')) return json(401, { error: 'unauthorized' });
      return json(200, idp_.claims);
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
  dataDir = mkdtempSync(join(tmpdir(), 'pixel-oidc-test-'));
  process.env.PIXEL_STREAM_DATA_DIR = dataDir;
  await startIdp();

  // The server is configured with NO admin token on purpose: a deployment that authenticates
  // only through its provider is the interesting one, and it must still gate and still refuse to
  // create local accounts.
  process.env.PIXEL_OIDC_ISSUER = idpBase;
  process.env.PIXEL_OIDC_CLIENT_ID = CLIENT_ID;
  process.env.PIXEL_OIDC_CLIENT_SECRET = CLIENT_SECRET;
  process.env.PIXEL_OIDC_ADMIN_ROLE = ADMIN_ROLE;
  process.env.PIXEL_OIDC_END_SESSION = '1';

  const express = (await import('express')).default;
  const { resetOidcConfig } = await import('./config.js');
  resetOidcConfig();
  ({ userStore } = await import('../userStore.js'));
  ({ appStore } = await import('../appStore.js'));
  ({ oauthIdentityStore } = await import('./identityStore.js'));
  const { registerOidcAuth } = await import('./routes.js');
  const { registerAuth } = await import('../auth.js');

  const server = express();
  // PIXEL_OIDC_REDIRECT_URI has to name the port we are about to get, so the app is built after
  // the listen — which is also how a deployment does it (the URI is registered with the
  // provider, never derived from a request).
  app = createServer(server);
  await new Promise<void>((resolve) => app!.listen(0, '127.0.0.1', () => resolve()));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  process.env.PIXEL_OIDC_REDIRECT_URI = `${base}/auth/oauth/callback`;
  resetOidcConfig();
  registerOidcAuth(server);
  registerAuth(server, null);
});

after(() => {
  app?.close();
  idp?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(async () => {
  const { clearPending } = await import('./pending.js');
  clearPending();
  idp_.codes.clear();
  idp_.lastAuthorize = null;
  idp_.idTokenClaims = {};
});

/** Start a browser flow: returns the state, the cookie to send back, and the authorize params. */
async function startBrowserFlow(): Promise<{ state: string; cookie: string; params: URLSearchParams }> {
  const res = await fetch(`${base}/auth/oauth/start`, { redirect: 'manual' });
  assert.equal(res.status, 302, 'start must redirect to the provider');
  const location = res.headers.get('location') ?? '';
  const params = new URL(location).searchParams;
  const setCookie = res.headers.get('set-cookie') ?? '';
  const cookie = setCookie.split(';')[0];
  return { state: params.get('state') ?? '', cookie, params };
}

/** Play the provider's part: remember the nonce, mint a code, and answer the callback. */
async function completeCallback(
  state: string,
  cookie: string | null,
  claims: Record<string, unknown>,
  nonce: string,
): Promise<Response> {
  idp_.claims = claims;
  idp_.nonce = nonce;
  const code = `code-${Math.floor(Math.random() * 1e9)}`;
  idp_.codes.add(code);
  return fetch(`${base}/auth/oauth/callback?code=${code}&state=${encodeURIComponent(state)}`, {
    redirect: 'manual',
    headers: cookie ? { cookie } : {},
  });
}

const sessionCookie = (res: Response): string | undefined =>
  (res.headers.getSetCookie?.() ?? [])
    .find((c) => c.startsWith('pixel_stream_sid=') && !c.includes('Max-Age=0'))
    ?.split(';')[0];

test('the authorize request carries PKCE, the configured client and a state', async () => {
  const { params } = await startBrowserFlow();
  assert.equal(params.get('client_id'), CLIENT_ID);
  assert.equal(params.get('response_type'), 'code');
  assert.equal(params.get('code_challenge_method'), 'S256');
  assert.ok((params.get('code_challenge') ?? '').length >= 43, 'a code challenge must be sent');
  assert.ok((params.get('state') ?? '').length >= 20, 'state must be unguessable');
  assert.equal(params.get('redirect_uri'), `${base}/auth/oauth/callback`);
  assert.match(params.get('scope') ?? '', /\bopenid\b/);
});

test('a first login provisions an account, keyed by sub, and signs it in', async () => {
  const { state, cookie, params } = await startBrowserFlow();
  const res = await completeCallback(
    state,
    cookie,
    { sub: 'sub-alice', preferred_username: 'alice@corp.example', name: 'Alice Example', email: 'alice@corp.example' },
    params.get('nonce') ?? '',
  );
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/');

  const sid = sessionCookie(res);
  assert.ok(sid, 'a session cookie must be set');
  const user = userStore.get('alice');
  assert.ok(user, 'the login id comes from the local part of preferred_username');
  assert.equal(user.username, 'Alice Example');
  assert.equal(user.hasPassword, false, 'a provisioned account has no password to guess');
  assert.equal(oauthIdentityStore.userIdFor('oidc', 'sub-alice'), 'alice');

  // The session really works: a gated GET is answered with data, not with the login page.
  const gated = await fetch(`${base}/assets/tiled/anything.png`, { headers: { cookie: sid! } });
  assert.notEqual(gated.status, 401, 'the issued session must pass the gate');

  // The token endpoint was authenticated as a confidential client.
  assert.match(idp_.lastBasic, /^Basic /);
  assert.equal(
    Buffer.from(idp_.lastBasic.slice('Basic '.length), 'base64').toString('utf8'),
    `${CLIENT_ID}:${CLIENT_SECRET}`,
  );
});

test('a renamed user comes back to the same account (sub is the identity)', async () => {
  const { state, cookie, params } = await startBrowserFlow();
  await completeCallback(
    state,
    cookie,
    { sub: 'sub-alice', preferred_username: 'alice.example@corp.example', name: 'Alice Renamed' },
    params.get('nonce') ?? '',
  );
  assert.equal(oauthIdentityStore.userIdFor('oidc', 'sub-alice'), 'alice');
  assert.equal(userStore.get('alice')?.username, 'Alice Renamed', 'the display name follows the directory');
  assert.equal(userStore.exists('alice.example'), false, 'no second account for the new username');
});

test('a different subject with a colliding login id gets its own account', async () => {
  const { state, cookie, params } = await startBrowserFlow();
  await completeCallback(
    state,
    cookie,
    { sub: 'sub-other-alice', preferred_username: 'alice@other.example', name: 'Other Alice' },
    params.get('nonce') ?? '',
  );
  const userId = oauthIdentityStore.userIdFor('oidc', 'sub-other-alice');
  assert.ok(userId && userId !== 'alice', `a second subject must not adopt "alice", got ${userId}`);
  assert.equal(userStore.get('alice')?.username, 'Alice Renamed', "the first account is untouched");
});

test('a login id that matches an existing LOCAL account adopts it (PIXEL_OIDC_CLAIM_EXISTING)', async () => {
  userStore.createUser('legacy', 'password-123', {});
  const { state, cookie, params } = await startBrowserFlow();
  await completeCallback(state, cookie, { sub: 'sub-legacy', preferred_username: 'legacy' }, params.get('nonce') ?? '');
  assert.equal(oauthIdentityStore.userIdFor('oidc', 'sub-legacy'), 'legacy');
  assert.equal(userStore.get('legacy')?.hasPassword, true, 'adoption must not drop the local password');
});

test('a state this server did not issue is refused, and issues no session', async () => {
  const res = await completeCallback('a-state-nobody-minted', null, { sub: 'sub-attacker' }, 'n');
  assert.equal(res.status, 400);
  assert.equal(sessionCookie(res), undefined);
  assert.equal(oauthIdentityStore.userIdFor('oidc', 'sub-attacker'), undefined);
});

test('a callback in the wrong browser is refused (the state cookie must match)', async () => {
  const { state, params } = await startBrowserFlow();
  const res = await completeCallback(state, 'pixel_oauth_state=someone-elses', { sub: 'sub-csrf' }, params.get('nonce') ?? '');
  assert.equal(res.status, 400);
  assert.equal(sessionCookie(res), undefined);
  assert.equal(oauthIdentityStore.userIdFor('oidc', 'sub-csrf'), undefined);
});

test('a code cannot be replayed: the flow is consumed', async () => {
  const { state, cookie, params } = await startBrowserFlow();
  const nonce = params.get('nonce') ?? '';
  const first = await completeCallback(state, cookie, { sub: 'sub-replay', preferred_username: 'replay' }, nonce);
  assert.equal(first.status, 303);
  const second = await completeCallback(state, cookie, { sub: 'sub-replay', preferred_username: 'replay' }, nonce);
  assert.equal(second.status, 400, 'the second use of the same state must fail');
  assert.equal(sessionCookie(second), undefined);
});

test('an ID token whose nonce is not the flow’s is refused', async () => {
  const { state, cookie } = await startBrowserFlow();
  const res = await completeCallback(state, cookie, { sub: 'sub-nonce', preferred_username: 'noncey' }, 'a-different-nonce');
  assert.equal(res.status, 400);
  assert.equal(userStore.exists('noncey'), false);
});

test('a disabled account cannot come back through the provider', async () => {
  userStore.setDisabled('replay', true);
  const { state, cookie, params } = await startBrowserFlow();
  const res = await completeCallback(state, cookie, { sub: 'sub-replay' }, params.get('nonce') ?? '');
  assert.equal(res.status, 403);
  assert.equal(sessionCookie(res), undefined);
  userStore.setDisabled('replay', false);
});

test('the provider’s roles grant admin, and cannot revoke the last usable admin', async () => {
  // Grant: the role appears in Zitadel's object-shaped project-roles claim.
  const grant = await startBrowserFlow();
  await completeCallback(
    grant.state,
    grant.cookie,
    {
      sub: 'sub-boss',
      preferred_username: 'boss',
      'urn:zitadel:iam:org:project:roles': { [ADMIN_ROLE]: { orgid: 'corp.example' } },
    },
    grant.params.get('nonce') ?? '',
  );
  assert.equal(userStore.get('boss')?.isAdmin, true, 'the role must grant admin');

  // Revoke, while another admin exists: it takes effect.
  userStore.createUser('otheradmin', 'password-123', { isAdmin: true });
  const revoke = await startBrowserFlow();
  await completeCallback(revoke.state, revoke.cookie, { sub: 'sub-boss', preferred_username: 'boss' }, revoke.params.get('nonce') ?? '');
  assert.equal(userStore.get('boss')?.isAdmin, false, 'losing the role must revoke admin');

  // Revoke the LAST usable admin: refused, so a bad role mapping cannot close the admin panel.
  userStore.setAdmin('boss', true);
  userStore.setAdmin('otheradmin', false);
  const last = await startBrowserFlow();
  await completeCallback(last.state, last.cookie, { sub: 'sub-boss', preferred_username: 'boss' }, last.params.get('nonce') ?? '');
  assert.equal(userStore.get('boss')?.isAdmin, true, 'the last usable admin must keep the flag');
});

test('the desktop pairing hands over its bearer exactly once', async () => {
  const startRes = await fetch(`${base}/desktop/oauth/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(startRes.status, 200);
  const pairing = (await startRes.json()) as { authUrl: string; deviceCode: string };
  assert.ok(pairing.deviceCode.length >= 20);
  const state = new URL(pairing.authUrl).searchParams.get('state') ?? '';
  const nonce = new URL(pairing.authUrl).searchParams.get('nonce') ?? '';

  const poll = async (): Promise<Response> =>
    fetch(`${base}/desktop/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceCode: pairing.deviceCode }),
    });

  assert.equal((await poll()).status, 202, 'pending until the browser finishes');

  // The provider comes back — no cookie at all, which is the whole point of the pairing.
  const cb = await completeCallback(state, null, { sub: 'sub-desktop', preferred_username: 'deskuser' }, nonce);
  assert.equal(cb.status, 200);
  assert.equal(sessionCookie(cb), undefined, 'the desktop callback sets no session cookie');

  const ready = await poll();
  assert.equal(ready.status, 200);
  const { token } = (await ready.json()) as { token: string };
  assert.equal(appStore.getSession(token)?.userId, 'deskuser', 'the bearer is a live session for that account');
  assert.equal((await poll()).status, 401, 'the pairing is consumed: a leaked device code is worthless after use');
});

test('an unknown device code never yields a token', async () => {
  const res = await fetch(`${base}/desktop/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceCode: 'x'.repeat(43) }),
  });
  assert.equal(res.status, 401);
});

test('with no admin token, local account creation is refused but the provider button is offered', async () => {
  const res = await fetch(`${base}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'sneaky', password: 'password-123', token: 'guess' }).toString(),
    redirect: 'manual',
  });
  assert.equal(res.status, 403);
  assert.equal(userStore.exists('sneaky'), false);

  const page = await (await fetch(`${base}/login`)).text();
  assert.match(page, /\/auth\/oauth\/start/, 'the login page offers the provider');
});

test('a role asserted only in the ID TOKEN grants admin', async () => {
  // The shape a default Zitadel project produces: "Assert Roles on Authentication" writes the
  // roles into the ID token, and userinfo carries none. Reading userinfo alone — which this server
  // did at first — saw an empty role set and revoked admin instead of granting it.
  idp_.idTokenClaims = { 'urn:zitadel:iam:org:project:roles': { [ADMIN_ROLE]: { orgid: 'corp.example' } } };
  const f = await startBrowserFlow();
  await completeCallback(f.state, f.cookie, { sub: 'sub-idrole', preferred_username: 'idrole' }, f.params.get('nonce') ?? '');
  assert.equal(userStore.get('idrole')?.isAdmin, true, 'the role was in the ID token, so it counts');
});

test("Zitadel's project-scoped roles claim is read as well", async () => {
  // The other spelling the same provider emits, depending on how the roles are asserted:
  // urn:zitadel:iam:org:project:<projectId>:roles. Neither is the configured claim name, and a
  // deployment cannot tell in advance which one its tokens will carry.
  idp_.idTokenClaims = { 'urn:zitadel:iam:org:project:298374:roles': { [ADMIN_ROLE]: { orgid: 'corp.example' } } };
  const f = await startBrowserFlow();
  await completeCallback(f.state, f.cookie, { sub: 'sub-projrole', preferred_username: 'projrole' }, f.params.get('nonce') ?? '');
  assert.equal(userStore.get('projrole')?.isAdmin, true);
});

test('a claim that is not a roles claim never grants admin', async () => {
  // `groups` is deliberately NOT consulted: a directory fills it with things that are not
  // authorization for this world, and a group called "admin" elsewhere must not become one here.
  idp_.idTokenClaims = { groups: [ADMIN_ROLE], roles: [ADMIN_ROLE] };
  const f = await startBrowserFlow();
  await completeCallback(f.state, f.cookie, { sub: 'sub-groups', preferred_username: 'groupy' }, f.params.get('nonce') ?? '');
  assert.equal(userStore.get('groupy')?.isAdmin, false);
});
