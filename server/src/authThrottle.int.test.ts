/**
 * Guessing the admin token, and what stops it.
 *
 * Presenting the admin token on /register creates an account and makes it an ADMIN, so that
 * token is the one secret worth brute-forcing. There was a throttle, and it did not cover this:
 * it is keyed by login id, which is right for a password guess (a burst against one account
 * cannot lock out everybody else) but useless here, because on the register form the attacker
 * chooses the login id — `a1`, `a2`, `a3` … each arriving with a fresh budget of ten.
 *
 * So the property is about the SECRET, not the account: wrong tokens are counted for the whole
 * server, and the count does not reset by varying anything the caller controls. The test walks
 * the real route, because the throttle lives between the route and the store and a unit test of
 * a private function would not prove the route consults it.
 *
 * TEST BOUNDARIES:
 *   @real-dependency: express + the real registerAuth routes + SQLite -- Mock? NO. The claim is
 *       "this route refuses", and the throttle sits in the route's own path. A throwaway
 *       PIXEL_STREAM_DATA_DIR keeps it off a developer's world; the stores are imported
 *       dynamically because db.ts resolves that path at module load.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

const ADMIN_TOKEN = 'the-real-admin-token';
let dataDir: string;
let server: Server;
let base: string;

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'pixel-throttle-test-'));
  process.env.PIXEL_STREAM_DATA_DIR = dataDir;
  const express = (await import('express')).default;
  const { registerAuth } = await import('./auth.js');
  const app = express();
  registerAuth(app, ADMIN_TOKEN);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

/** One register attempt, as the form submits it. */
async function attempt(loginId: string, token: string, password = 'password-123'): Promise<number> {
  const res = await fetch(`${base}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: loginId, password, token }).toString(),
    redirect: 'manual',
  });
  return res.status;
}

// Order matters here, and it is part of what is being tested: the honest cases run FIRST,
// because the burst below deliberately leaves the server in its cooldown window — a minute is
// too long for a test to wait out, and pretending otherwise would need a clock injection for
// no gain. Read top to bottom: it works, a blank field is not punished, and only then the
// attack.

test('the real token creates an admin — the throttle bounds guesses, not the feature', async () => {
  const status = await attempt('legit-admin', ADMIN_TOKEN);
  assert.ok(status === 302 || status === 303 || status === 200, `a correct token was refused with ${status}`);
  const { userStore } = await import('./userStore.js');
  const u = userStore.get('legit-admin');
  assert.ok(u, 'the account was not created');
  assert.equal(u.isAdmin, true, 'the admin token must create an admin');
});

test('a blank token is an error, not a guess — an empty form does not spend the budget', async () => {
  assert.equal(await attempt('no-token-user', ''), 401);
  // Proof that it was not counted: a correct token still goes through right afterwards.
  assert.ok([302, 303, 200].includes(await attempt('second-admin', ADMIN_TOKEN)));
});

test('guessing the admin token is bounded even when every attempt uses a new login id', async () => {
  // The bypass, stated as the test: a fresh id per guess. Without a server-wide count these all
  // answer 401 for ever, which is an unlimited oracle on the one secret that grants admin.
  let refused429 = 0;
  for (let i = 0; i < 40; i++) {
    const status = await attempt(`guesser${i}`, `wrong-token-${i}`);
    if (status === 429) refused429++;
    else assert.equal(status, 401, `attempt ${i} answered ${status}`);
  }
  assert.ok(refused429 > 0, 'forty guesses with forty different ids were all answered — the token is unbounded');
  // And it stays shut for the next new id, since the count is not keyed by anything the
  // caller picks.
  assert.equal(await attempt('yet-another-id', 'wrong-again'), 429);
  // Even a CORRECT token is refused while the window is open. Deliberate, and the reason is
  // written down in auth.ts: registering can wait a minute, unlimited guessing cannot.
  assert.equal(await attempt('admin-during-cooldown', ADMIN_TOKEN), 429);
});
