/**
 * The admin panel's single-sign-on settings: what an admin may change, and — the half that
 * matters — what they may not.
 *
 * The claim this file keeps true is the split in `adminSettings.ts`. Writable: the presentation
 * fields, and — by explicit request — the request this server makes (issuer, client id, redirect
 * URI, scopes). NOT writable: the client secret, the roles claim, the admin role,
 * `CLAIM_EXISTING` and `END_SESSION`, because those decide who becomes an admin and whose
 * existing account a directory username may take over.
 *
 * The connection being editable is what makes the rest of this file load-bearing rather than
 * pedantic:
 *
 *  • the client secret is withheld the moment the issuer or the client id is overridden, so the
 *    deployment's secret can never be POSTed to a directory the deployment did not name — the one
 *    thing an editable issuer would otherwise buy an attacker with an admin session;
 *  • every connection value is validated (https unless loopback, no query or fragment, the
 *    callback path exact), and a refusal refuses the WHOLE patch, so a mistake cannot leave half a
 *    connection behind;
 *  • the secret never reaches the page, not even as a masked value;
 *  • only an admin can read or write any of it;
 *  • the presentation fields still take effect, a typed label is escaped where it lands in HTML,
 *    and with the redirect on `/login` still renders the password form — the break-glass path.
 *
 * TEST BOUNDARIES:
 *   @real-dependency: express + the real routes + SQLite -- Mock? NO. Every claim here is about
 *       what a route does with a request, and the checks live in the routes. A throwaway
 *       PIXEL_STREAM_DATA_DIR keeps it off a developer's world.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server as HttpServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

const ADMIN_TOKEN = 'oidc-admin-settings-token';
const CLIENT_SECRET = 'super-secret-value-nobody-may-see';
const ENV_LABEL = 'Corp Directory';

let dataDir: string;
let app: HttpServer;
let base: string;
let adminBearer: string;
let userBearer: string;
let setOidcPresentation: typeof import('./adminSettings.js').setOidcPresentation;

interface ConnField {
  value: string;
  override: string;
  env: string;
  source: 'admin' | 'env' | 'unset';
}
interface Settings {
  configured: boolean;
  presentation: { label: string | null; showButton: boolean; autoRedirect: boolean };
  maxLabelLength: number;
  callbackPath: string;
  connection: { issuer: ConnField; clientId: ConnField; redirectUri: ConnField; scopes: ConnField; adminRole: ConnField };
  secret: { configured: boolean; active: boolean };
  environment: Record<string, unknown> | null;
}

const authed = (bearer: string): Record<string, string> => ({ authorization: `Bearer ${bearer}` });

async function getSettings(bearer = adminBearer): Promise<Settings> {
  const res = await fetch(`${base}/admin/oidc`, { headers: authed(bearer) });
  assert.equal(res.status, 200);
  return (await res.json()) as Settings;
}

async function putSettings(body: unknown, bearer = adminBearer): Promise<Response> {
  return fetch(`${base}/admin/oidc`, {
    method: 'PUT',
    headers: { ...authed(bearer), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'pixel-oidc-admin-'));
  process.env.PIXEL_STREAM_DATA_DIR = dataDir;
  // A provider that is configured but unreachable: none of these routes talks to it, and that is
  // itself worth having in the test — the admin panel has to work while the provider is down.
  process.env.PIXEL_OIDC_ISSUER = 'https://idp.invalid';
  process.env.PIXEL_OIDC_CLIENT_ID = 'client-42';
  process.env.PIXEL_OIDC_CLIENT_SECRET = CLIENT_SECRET;
  process.env.PIXEL_OIDC_REDIRECT_URI = 'https://pixel.invalid/auth/oauth/callback';
  process.env.PIXEL_OIDC_LABEL = ENV_LABEL;
  process.env.PIXEL_OIDC_ADMIN_ROLE = 'pixel-admin';

  const express = (await import('express')).default;
  const { resetOidcConfig } = await import('./config.js');
  resetOidcConfig();
  ({ setOidcPresentation } = await import('./adminSettings.js'));
  const { userStore } = await import('../userStore.js');
  const { appStore } = await import('../appStore.js');
  const { registerOidcAuth } = await import('./routes.js');
  const { registerAuth } = await import('../auth.js');
  const { registerAdminApi } = await import('../adminApi.js');

  const server = express();
  // Same order as index.ts: the OIDC routes ahead of the gate, the admin API behind it.
  registerOidcAuth(server);
  registerAuth(server, ADMIN_TOKEN);
  registerAdminApi(server);
  app = createServer(server);
  await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', () => resolve()));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;

  userStore.createUser('settingsadmin', 'password-123', { isAdmin: true });
  userStore.createUser('settingsuser', 'password-123', {});
  adminBearer = appStore.createSession('settingsadmin');
  userBearer = appStore.createSession('settingsuser');
});

after(() => {
  app?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('only an admin may read or write the sign-in settings', async () => {
  for (const path of ['/admin/oidc']) {
    assert.equal((await fetch(`${base}${path}`)).status, 401, 'anonymous must be refused');
    assert.equal((await fetch(`${base}${path}`, { headers: authed(userBearer) })).status, 403, 'a plain user too');
  }
  assert.equal((await putSettings({ showButton: false }, userBearer)).status, 403);
  // And the refusal was not a partial write.
  assert.equal((await getSettings()).presentation.showButton, true);
});

test('the client secret never reaches the page — only whether one is set', async () => {
  const res = await fetch(`${base}/admin/oidc`, { headers: authed(adminBearer) });
  const text = await res.text();
  assert.equal(text.includes(CLIENT_SECRET), false, 'the secret must not appear in the response at all');
  assert.equal(text.includes('clientSecret'), false, 'not even as a key');
  const data = JSON.parse(text) as Settings;
  assert.equal(data.configured, true);
  assert.equal(data.secret.configured, true, 'the deployment holds one');
  assert.equal(data.secret.active, true, 'and nothing is overridden yet, so it is in use');
  assert.equal(data.connection.issuer.value, 'https://idp.invalid');
  assert.equal(data.connection.issuer.source, 'env');
  assert.equal(data.connection.adminRole.value, 'pixel-admin', 'the deployment maps a role');
  assert.equal(data.connection.adminRole.source, 'env');
});

test('a PUT cannot write the fields that decide who becomes an admin', async () => {
  const before = await getSettings();
  const res = await putSettings({
    clientSecret: 'attacker-secret',
    adminRole: 'everyone',
    rolesClaim: 'groups',
    claimExisting: false,
    endSession: true,
    configured: false,
    // …plus one field that IS writable, so the request is not rejected wholesale and the test
    // cannot pass just because nothing was applied at all.
    label: 'Still Fine',
  });
  assert.equal(res.status, 200);
  const after = await getSettings();
  assert.deepEqual(after.environment, before.environment, 'the deployment half must be untouched');
  assert.deepEqual(after.secret, before.secret, 'and the secret cannot be set from a request');
  assert.equal(after.presentation.label, 'Still Fine', 'the writable field still applies');
  await putSettings({ label: null });
});

test('the connection is editable, says where each value comes from, and clears back to the deployment', async () => {
  const res = await putSettings({
    issuer: 'https://panel.example/realms/pixel/',
    clientId: 'panel-client',
    redirectUri: 'https://panel.example/auth/oauth/callback',
  });
  assert.equal(res.status, 200);
  const set = await getSettings();
  assert.equal(set.connection.issuer.value, 'https://panel.example/realms/pixel', 'a trailing slash is dropped');
  assert.equal(set.connection.issuer.source, 'admin');
  assert.equal(set.connection.issuer.env, 'https://idp.invalid', 'what clearing it would fall back to');
  assert.equal(set.connection.clientId.value, 'panel-client');
  assert.equal(set.connection.redirectUri.value, 'https://panel.example/auth/oauth/callback');
  assert.equal(set.configured, true);

  // Empty string = clear the override.
  await putSettings({ issuer: '', clientId: '', redirectUri: '' });
  const cleared = await getSettings();
  assert.equal(cleared.connection.issuer.value, 'https://idp.invalid');
  assert.equal(cleared.connection.issuer.source, 'env');
  assert.equal(cleared.connection.clientId.value, 'client-42');
});

test('overriding the connection withholds the deployment\'s client secret', async () => {
  const { oidcConfig } = await import('./config.js');
  assert.equal(oidcConfig()?.clientSecret, CLIENT_SECRET, 'in use while nothing is overridden');

  // Only the client id — the other half of the identity the secret belongs to.
  await putSettings({ clientId: 'somebody-elses-client' });
  assert.equal(oidcConfig()?.clientSecret, null, 'a secret must never reach a client it was not issued for');
  assert.equal((await getSettings()).secret.active, false, 'and the panel says so');

  // The issuer alone does it too — that is the case that would otherwise exfiltrate the secret.
  await putSettings({ clientId: '', issuer: 'https://somebody-elses-idp.example' });
  assert.equal(oidcConfig()?.clientSecret, null);

  await putSettings({ issuer: '' });
  assert.equal(oidcConfig()?.clientSecret, CLIENT_SECRET, 'back in use once the connection is the deployment\'s again');
  assert.equal((await getSettings()).secret.active, true);
});

test('a connection value that cannot be trusted is refused, with the field and the reason', async () => {
  const before = await getSettings();
  const cases: Array<[Record<string, unknown>, string, RegExp]> = [
    [{ issuer: 'http://idp.example' }, 'issuer', /https/],
    [{ issuer: 'not-a-url' }, 'issuer', /absolute URL/],
    [{ issuer: 'https://idp.example/?next=x' }, 'issuer', /query string/],
    [{ issuer: `https://idp.example/${'x'.repeat(600)}` }, 'issuer', /at most/],
    [{ clientId: 'has spaces' }, 'clientId', /printable ASCII/],
    [{ redirectUri: 'https://host.example/somewhere-else' }, 'redirectUri', /\/auth\/oauth\/callback/],
    [{ redirectUri: 'http://host.example/auth/oauth/callback' }, 'redirectUri', /https/],
    [{ redirectUri: 'https://host.example/auth/oauth/callback?x=1' }, 'redirectUri', /query string/],
  ];
  for (const [patch, field, reason] of cases) {
    const res = await putSettings(patch);
    assert.equal(res.status, 400, `${JSON.stringify(patch)} should be refused`);
    const body = (await res.json()) as { error: string; field: string };
    assert.equal(body.field, field);
    assert.match(body.error, reason);
  }
  assert.deepEqual(await getSettings(), before, 'a refused patch stores nothing');
});

test('a patch is refused whole, so half a connection is never what a mistake leaves behind', async () => {
  const res = await putSettings({
    issuer: 'https://good.example',
    clientId: 'good-client',
    redirectUri: 'https://good.example/wrong-path',
  });
  assert.equal(res.status, 400);
  const after = await getSettings();
  assert.equal(after.connection.issuer.source, 'env', 'the valid half of the patch was not applied either');
  assert.equal(after.connection.clientId.value, 'client-42');
});

test('plain http and a loopback host: allowed for localhost, refused anywhere else', async () => {
  const ok = await putSettings({ issuer: 'http://localhost:8080', redirectUri: 'http://127.0.0.1:2567/auth/oauth/callback' });
  assert.equal(ok.status, 200, 'a development provider on this machine is a legitimate setup');
  await putSettings({ issuer: '', redirectUri: '' });
});

test('the label is trimmed, stripped of control characters and capped', async () => {
  const res = await putSettings({ label: `  Uponu \u0000\tSSO ${'x'.repeat(80)}  ` });
  assert.equal(res.status, 200);
  const { presentation, maxLabelLength } = await getSettings();
  const label = presentation.label ?? '';
  assert.equal(label.length <= maxLabelLength, true, `"${label}" is longer than ${maxLabelLength}`);
  assert.equal(/[\u0000-\u001f]/.test(label), false, 'control characters must not survive');
  assert.match(label, /^Uponu SSO x+$/);

  // An empty label means "follow the environment", and the button says so.
  await putSettings({ label: '   ' });
  assert.equal((await getSettings()).presentation.label, null);
  const page = await (await fetch(`${base}/login`)).text();
  assert.match(page, new RegExp(`Sign in with ${ENV_LABEL}`));
});

test('a label somebody typed is escaped where it lands in HTML', async () => {
  await putSettings({ label: '<script>x</script>' });
  const page = await (await fetch(`${base}/login`)).text();
  assert.equal(page.includes('<script>x</script>'), false, 'the label must not be able to inject markup');
  assert.match(page, /&lt;script&gt;/);
  await putSettings({ label: null });
});

test('hiding the button removes it from every sign-in surface, without closing the flow', async () => {
  await putSettings({ showButton: false });
  const page = await (await fetch(`${base}/login`)).text();
  assert.equal(page.includes('/auth/oauth/start'), false, 'the login page must not offer it');
  assert.match(page, /name="password"/, 'the password form is still there');

  const desktopCfg = (await (await fetch(`${base}/auth/oauth/config`)).json()) as { enabled: boolean };
  assert.equal(desktopCfg.enabled, false, 'the desktop app hides its button too');

  // Hiding a button is presentation, not a gate: the route still exists (it fails here only
  // because the configured provider is unreachable, which is a 502 and not a 404).
  const start = await fetch(`${base}/auth/oauth/start`, { redirect: 'manual' });
  assert.notEqual(start.status, 404);

  await putSettings({ showButton: true });
  assert.match(await (await fetch(`${base}/login`)).text(), /\/auth\/oauth\/start/);
});

test('auto-redirect sends a navigation to the provider but leaves /login as the way back', async () => {
  await putSettings({ autoRedirect: true });

  const nav = await fetch(`${base}/`, { headers: { accept: 'text/html' }, redirect: 'manual' });
  assert.equal(nav.status, 302);
  assert.equal(nav.headers.get('location'), '/auth/oauth/start');

  // The break-glass path: /login still renders the password form, so a provider outage is one
  // URL away from being worked around rather than one deployment.
  const login = await fetch(`${base}/login`, { headers: { accept: 'text/html' } });
  assert.equal(login.status, 200);
  assert.match(await login.text(), /name="password"/);

  // A programmatic fetch is still answered with an honest 401, never a redirect.
  const api = await fetch(`${base}/assets/tiled/sets.json`, { redirect: 'manual' });
  assert.equal(api.status, 401);

  await putSettings({ autoRedirect: false });
  const after = await fetch(`${base}/`, { headers: { accept: 'text/html' }, redirect: 'manual' });
  assert.equal(after.status, 200, 'with the setting off, a navigation gets the login page again');
});

test('a stored blob with junk in it reads back as the defaults, not as a crash', async () => {
  // These rows are written by this server, but they are JSON blobs in a table a restore or a
  // hand-edit can reach — so both readers have to be total, and the connection one has to
  // RE-VALIDATE rather than trust what it finds: a bad value there would end up in a URL that
  // credentials travel to.
  const { appStore } = await import('../appStore.js');
  appStore.setSetting('oidcPresentation', { label: 42, showButton: 'yes', autoRedirect: null, issuer: 'https://evil' });
  appStore.setSetting('oidcConnection', { issuer: 'http://evil.example', clientId: { nested: 1 }, redirectUri: 'javascript:alert(1)' });
  const { presentation, connection } = await getSettings();
  assert.deepEqual(presentation, { label: null, showButton: true, autoRedirect: false });
  assert.equal(connection.issuer.value, 'https://idp.invalid', 'a plain-http issuer in the row is ignored, not used');
  assert.equal(connection.clientId.value, 'client-42');
  assert.equal(connection.redirectUri.value, 'https://pixel.invalid/auth/oauth/callback');
  setOidcPresentation({});
  appStore.setSetting('oidcConnection', { issuer: '', clientId: '', redirectUri: '' });
});

test('the scopes are editable, normalised, and always carry openid', async () => {
  const { oidcConfig } = await import('./config.js');
  assert.equal((await getSettings()).connection.scopes.source, 'env');

  const res = await putSettings({ scopes: '  profile   email  profile  ' });
  assert.equal(res.status, 200);
  const set = await getSettings();
  assert.equal(set.connection.scopes.override, 'profile email', 'collapsed and deduped as stored');
  assert.equal(set.connection.scopes.source, 'admin');
  assert.equal(
    oidcConfig()?.scopes,
    'openid profile email',
    'openid is added whichever side the scopes came from — this can never become a non-OIDC request',
  );

  // Written with openid already there, it is not doubled.
  await putSettings({ scopes: 'openid profile urn:zitadel:iam:org:project:id:12345:aud' });
  assert.equal(oidcConfig()?.scopes, 'openid profile urn:zitadel:iam:org:project:id:12345:aud');

  await putSettings({ scopes: '' });
  const cleared = await getSettings();
  assert.equal(cleared.connection.scopes.source, 'env', 'empty clears the override');
  assert.equal(oidcConfig()?.scopes, 'openid profile email');
});

test('a scope that would not survive a URL is refused', async () => {
  const before = await getSettings();
  const cases: Array<[string, RegExp]> = [
    ['openid "profile"', /not a valid scope/],
    ['openid pro\\file', /not a valid scope/],
    ['x'.repeat(600), /at most/],
    [Array.from({ length: 30 }, (_, i) => `s${i}`).join(' '), /At most/],
  ];
  for (const [scopes, reason] of cases) {
    const res = await putSettings({ scopes });
    assert.equal(res.status, 400, `"${scopes.slice(0, 30)}" should be refused`);
    const body = (await res.json()) as { error: string; field: string };
    assert.equal(body.field, 'scopes');
    assert.match(body.error, reason);
  }
  assert.deepEqual(await getSettings(), before, 'a refused patch stores nothing');
});

test('overriding the scopes does NOT withhold the client secret', async () => {
  // The secret belongs to the client the environment named, and scopes do not change who is
  // asking — only what is asked. Getting this wrong would silently turn a confidential client into
  // a public one the first time somebody edited the field.
  const { oidcConfig } = await import('./config.js');
  await putSettings({ scopes: 'openid profile' });
  assert.equal(oidcConfig()?.clientSecret, CLIENT_SECRET);
  assert.equal((await getSettings()).secret.active, true);
  await putSettings({ scopes: '' });
});

test('the admin role is settable from the panel and takes effect on the next sign-in', async () => {
  const { oidcConfig } = await import('./config.js');
  assert.equal(oidcConfig()?.adminRole, 'pixel-admin', 'the deployment\'s, to begin with');

  const res = await putSettings({ adminRole: 'admin' });
  assert.equal(res.status, 200);
  assert.equal(oidcConfig()?.adminRole, 'admin', 'a directory whose role is simply called "admin"');
  assert.equal((await getSettings()).connection.adminRole.source, 'admin');

  await putSettings({ adminRole: '' });
  assert.equal(oidcConfig()?.adminRole, 'pixel-admin', 'cleared, it follows the deployment again');
});

test('a role name that could never match is refused rather than stored', async () => {
  // The failure this prevents is the invisible one: a name with a stray space simply never equals
  // anything the provider sends, which looks exactly like "the role is not arriving".
  for (const [adminRole, reason] of [
    ['pixel admin', /printable ASCII/],
    ['x'.repeat(80), /at most/],
  ] as Array<[string, RegExp]>) {
    const res = await putSettings({ adminRole });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string; field: string };
    assert.equal(body.field, 'adminRole');
    assert.match(body.error, reason);
  }
  const { oidcConfig } = await import('./config.js');
  assert.equal(oidcConfig()?.adminRole, 'pixel-admin', 'nothing was stored');
});

test('the roles claim itself stays environment-only', async () => {
  const before = await getSettings();
  const res = await putSettings({ rolesClaim: 'groups', claimExisting: false });
  assert.equal(res.status, 200);
  assert.deepEqual((await getSettings()).environment, before.environment);
});
