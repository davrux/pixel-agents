/**
 * Two-factor sign-in (TOTP): the algorithm against RFC 6238's own vectors, and the routes end to end
 * — enrol from the profile, then sign in through the browser form and through the desktop exchange.
 *
 * TEST BOUNDARIES:
 *   @real-dependency: express + the real registerAuth and registerTotpApi routes + SQLite -- Mock?
 *       NO. The claims are "a password alone no longer signs in" and "the profile routes refuse
 *       without proof", and both live in the route bodies. The clock is NOT injected into the
 *       routes, so codes are computed from the same secret at Date.now(), the way an app would.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { base32Decode, base32Encode, hotp, stepAt, verifyTotp } from './totp.js';

// ── The algorithm ───────────────────────────────────────────────────────────────────────────────

// RFC 6238 Appendix B, SHA-1 column, truncated to six digits (the RFC prints eight).
const RFC_KEY = Buffer.from('12345678901234567890', 'ascii');
const RFC_VECTORS: Array<[number, string]> = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
];

test('hotp matches the RFC 6238 SHA-1 vectors', () => {
  for (const [t, eight] of RFC_VECTORS) assert.equal(hotp(RFC_KEY, stepAt(t * 1000)), eight.slice(2), `T=${t}`);
});

test('base32 round-trips and refuses junk', () => {
  const b = Buffer.from([0, 1, 2, 250, 251, 255, 7]);
  assert.deepEqual(base32Decode(base32Encode(b)), b);
  assert.deepEqual(base32Decode('gezd gnbv'), base32Decode('GEZDGNBV'));
  assert.equal(base32Decode('not!base32'), null);
});

test('verifyTotp accepts one step of drift and refuses replays', () => {
  const secret = base32Encode(RFC_KEY);
  const now = 1111111111 * 1000;
  const step = stepAt(now);
  assert.equal(verifyTotp(secret, hotp(RFC_KEY, step), now), step);
  assert.equal(verifyTotp(secret, hotp(RFC_KEY, step - 1), now), step - 1);
  assert.equal(verifyTotp(secret, hotp(RFC_KEY, step + 1), now), step + 1);
  assert.equal(verifyTotp(secret, hotp(RFC_KEY, step - 2), now), null, 'two steps back is outside the window');
  assert.equal(verifyTotp(secret, hotp(RFC_KEY, step), now, step), null, 'the same step twice is a replay');
  assert.equal(verifyTotp(secret, 'abcdef', now), null);
});

// ── The routes ──────────────────────────────────────────────────────────────────────────────────

const PASSWORD = 'correct-horse';
let dataDir: string;
let server: Server;
let base: string;

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'pixel-totp-test-'));
  process.env.PIXEL_STREAM_DATA_DIR = dataDir;
  const express = (await import('express')).default;
  const { registerAuth } = await import('./auth.js');
  const { registerTotpApi } = await import('./totpApi.js');
  const { userStore } = await import('./userStore.js');
  for (const id of ['alice', 'bob', 'carol']) userStore.createUser(id, PASSWORD);
  userStore.createProvisionedUser('sso-only');
  const app = express();
  registerAuth(app, 'admin-token');
  registerTotpApi(app);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const codeFor = (secret: string, offsetSteps = 0): string => hotp(base32Decode(secret)!, stepAt(Date.now()) + offsetSteps);

async function sessionCookie(userId: string): Promise<string> {
  const { appStore } = await import('./appStore.js');
  return `pixel_stream_sid=${appStore.createSession(userId)}`;
}

async function api(path: string, cookie: string | null, body?: Record<string, unknown>): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

async function form(path: string, fields: Record<string, string>): Promise<{ status: number; html: string; cookie: string | null }> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
    redirect: 'manual',
  });
  return { status: res.status, html: await res.text(), cookie: res.headers.get('set-cookie') };
}

/** Enrol `userId` through the profile routes; returns the secret and the recovery codes. */
async function enrol(userId: string): Promise<{ secret: string; codes: string[] }> {
  const cookie = await sessionCookie(userId);
  const setup = await api('/account/totp/setup', cookie, {});
  assert.equal(setup.status, 200);
  const secret = setup.data.secret as string;
  assert.match(String(setup.data.uri), /^otpauth:\/\/totp\//);
  assert.match(String(setup.data.qrSvg), /^<svg/);
  const done = await api('/account/totp/enable', cookie, { password: PASSWORD, code: codeFor(secret) });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  return { secret, codes: done.data.recoveryCodes as string[] };
}

test('the profile routes need a session and act on its account only', async () => {
  assert.equal((await api('/account/totp', null)).status, 401);
  assert.equal((await api('/account/totp/setup', null, {})).status, 401);
  const status = await api('/account/totp', await sessionCookie('carol'));
  assert.deepEqual(status.data, { enabled: false, pending: false, recoveryCodesLeft: 0, hasPassword: true });
});

test('an account with no password cannot enrol — there is nothing for the code to guard', async () => {
  const res = await api('/account/totp/setup', await sessionCookie('sso-only'), {});
  assert.equal(res.status, 409);
});

test('confirming needs the password, not just the session', async () => {
  const cookie = await sessionCookie('carol');
  const setup = await api('/account/totp/setup', cookie, {});
  const secret = setup.data.secret as string;
  const wrongPw = await api('/account/totp/enable', cookie, { password: 'nope', code: codeFor(secret) });
  assert.equal(wrongPw.status, 403);
  const wrongCode = await api('/account/totp/enable', cookie, { password: PASSWORD, code: '000000' === codeFor(secret) ? '111111' : '000000' });
  assert.equal(wrongCode.status, 400);
  assert.equal((await api('/account/totp', cookie)).data.enabled, false, 'a failed confirm must leave 2FA off');
  await api('/account/totp/cancel', cookie, {});
  assert.equal((await api('/account/totp', cookie)).data.pending, false);
});

test('browser: with 2FA on, a password alone gets the code page instead of a session', async () => {
  const { secret } = await enrol('alice');
  const first = await form('/login', { username: 'alice', password: PASSWORD });
  assert.equal(first.status, 200);
  assert.equal(first.cookie, null, 'the password step must not set a session');
  const ticket = /name="ticket" value="([^"]+)"/.exec(first.html)?.[1];
  assert.ok(ticket, 'the code page carries a ticket');
  assert.ok(!first.html.includes(PASSWORD), 'the password must not be carried into the second page');

  const wrong = await form('/login/totp', { ticket, code: '12345' });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.cookie, null);

  // The step just used in enrolment cannot be reused, so take the next one (inside the drift window).
  const ok = await form('/login/totp', { ticket, code: codeFor(secret, 1) });
  assert.equal(ok.status, 303);
  assert.match(String(ok.cookie), /pixel_stream_sid=/);

  const again = await form('/login/totp', { ticket, code: codeFor(secret, 1) });
  assert.equal(again.status, 401, 'a ticket is spent by a successful sign-in');
  assert.equal(again.cookie, null);
});

test('desktop: the token exchange asks for the code, and a recovery code works exactly once', async () => {
  const { codes } = await enrol('bob');
  assert.equal(codes.length, 10);
  const first = await fetch(`${base}/desktop/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'bob', password: PASSWORD }),
  });
  assert.equal(first.status, 401);
  const body = (await first.json()) as { totpRequired?: boolean; ticket?: string; token?: string };
  assert.equal(body.totpRequired, true);
  assert.equal(body.token, undefined);

  const exchange = async (ticket: string, code: string) =>
    fetch(`${base}/desktop/token/totp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ticket, code }),
    });
  const ok = await exchange(body.ticket!, codes[0]!.toUpperCase());
  assert.equal(ok.status, 200);
  assert.equal(typeof ((await ok.json()) as { token?: string }).token, 'string');

  // Same recovery code, fresh ticket: spent.
  const second = (await (
    await fetch(`${base}/desktop/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'bob', password: PASSWORD }),
    })
  ).json()) as { ticket: string };
  assert.equal((await exchange(second.ticket, codes[0]!)).status, 401);
  assert.equal((await api('/account/totp', await sessionCookie('bob'))).data.recoveryCodesLeft, 9);
});

test('turning it off needs the password AND a current factor', async () => {
  const cookie = await sessionCookie('bob');
  const { totpStore } = await import('./totpStore.js');
  assert.equal(totpStore.isEnabled('bob'), true);
  assert.equal((await api('/account/totp/disable', cookie, { password: PASSWORD })).status, 403, 'no code, no change');
  assert.equal(totpStore.isEnabled('bob'), true);
  // A setup cannot be restarted over an enabled factor either.
  assert.equal((await api('/account/totp/setup', cookie, {})).status, 409);
  // The secret the app holds; read off the store's private row the way the phone would hold it.
  const secret = (totpStore as unknown as { row(id: string): { secret: string } }).row('bob').secret;
  assert.equal((await api('/account/totp/disable', cookie, { password: PASSWORD, code: codeFor(secret, 1) })).status, 200);
  assert.equal(totpStore.isEnabled('bob'), false);
  // And the password alone signs in again.
  const res = await form('/login', { username: 'bob', password: PASSWORD });
  assert.equal(res.status, 303);
});

test('deleting the account takes its 2FA row with it (cascade)', async () => {
  const { userStore } = await import('./userStore.js');
  const { totpStore } = await import('./totpStore.js');
  assert.equal(totpStore.isEnabled('alice'), true);
  userStore.deleteUser('alice');
  assert.equal(totpStore.status('alice').enabled, false);
});
