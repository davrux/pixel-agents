/**
 * The admin panel's single-sign-on settings: what an admin may change, and — the half that
 * matters — what they may not.
 *
 * The claim this file exists to keep true is the split in `presentation.ts`. Presentation is
 * writable over HTTP; everything that decides who gets in and who becomes an admin is not. A
 * plausible-looking PUT carrying `issuer`, `adminRole` or `claimExisting` has to be a no-op, or a
 * stolen admin session becomes a way to repoint this world at an identity provider the attacker
 * controls — which is a permanent compromise, not a session-long one. Beside that:
 *
 *  • only an admin can read or write these settings at all;
 *  • the client secret never reaches the page, not even as a masked value;
 *  • the three settings that ARE writable really take effect (label, button, auto-redirect), and
 *    a label somebody typed is escaped where it lands in HTML;
 *  • with the redirect on, `/login` still renders the password form — the break-glass path.
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
let setOidcPresentation: typeof import('./presentation.js').setOidcPresentation;

interface Settings {
  configured: boolean;
  presentation: { label: string | null; showButton: boolean; autoRedirect: boolean };
  maxLabelLength: number;
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
  ({ setOidcPresentation } = await import('./presentation.js'));
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
  const data = JSON.parse(text) as Settings;
  assert.equal(data.configured, true);
  assert.equal(data.environment?.hasClientSecret, true);
  assert.equal('clientSecret' in (data.environment ?? {}), false, 'not even as a key');
  assert.equal(data.environment?.issuer, 'https://idp.invalid');
  assert.equal(data.environment?.adminRole, 'pixel-admin');
});

test('a PUT carrying the security-relevant fields changes none of them', async () => {
  const before = await getSettings();
  const res = await putSettings({
    // Everything an attacker with an admin session would want to move:
    issuer: 'https://evil.example',
    clientId: 'attacker-client',
    clientSecret: 'attacker-secret',
    redirectUri: 'https://evil.example/callback',
    scopes: 'openid profile email offline_access',
    adminRole: 'everyone',
    rolesClaim: 'groups',
    claimExisting: true,
    endSession: true,
    configured: false,
    // …plus one field that IS writable, so the request is not rejected wholesale.
    label: 'Still Fine',
  });
  assert.equal(res.status, 200);
  const after = await getSettings();
  assert.deepEqual(after.environment, before.environment, 'the environment half must be untouched');
  assert.equal(after.presentation.label, 'Still Fine', 'the writable field still applies');
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
  // The row is written by this server, but it is a JSON blob in a table a restore or a hand-edit
  // can reach — so the reader has to be total.
  const { appStore } = await import('../appStore.js');
  appStore.setSetting('oidcPresentation', { label: 42, showButton: 'yes', autoRedirect: null, issuer: 'https://evil' });
  const { presentation, environment } = await getSettings();
  assert.deepEqual(presentation, { label: null, showButton: true, autoRedirect: false });
  assert.equal(environment?.issuer, 'https://idp.invalid', 'a junk row cannot smuggle in configuration');
  setOidcPresentation({});
});
