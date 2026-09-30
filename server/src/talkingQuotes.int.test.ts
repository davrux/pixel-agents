/**
 * The quote pool as an admin edits it: `GET`/`PUT /admin/talking-quotes`.
 *
 * What has to hold, and why each is its own test:
 *   - only a global admin reaches it — the pool is spoken to every viewer in
 *     every zone, so it is world data, not a preference;
 *   - the text comes back exactly as it was saved (comments and blank lines are
 *     the author's, not noise), in the one stored form;
 *   - a save with one bad line stores NOTHING and names the line — a partial
 *     save would report success about a quote nobody will ever hear;
 *   - a save reaches the running rooms (the bus event) and the next
 *     `loadQuotes()` — the cache is replaced, not left stale until a restart;
 *   - a hand-edited row is read with the same rules, so a restore cannot put a
 *     line into a bubble that a save would have refused.
 * The format rules themselves are in talkingObject.int.test.ts.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';

const ADMIN_TOKEN = 'talking-quotes-admin-token';

let app: HttpServer;
let base: string;
let adminBearer: string;
let userBearer: string;
let quotes: typeof import('./quotes.js');
let bus: typeof import('./controlBus.js');
let appStore: typeof import('./appStore.js').appStore;

interface Pool {
  text: string;
  count: number;
  maxQuoteLength: number;
  maxTextLength: number;
}

const authed = (bearer: string): Record<string, string> => ({ authorization: `Bearer ${bearer}` });

async function put(body: unknown, bearer = adminBearer): Promise<Response> {
  return fetch(`${base}/admin/talking-quotes`, {
    method: 'PUT',
    headers: { ...authed(bearer), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function get(): Promise<Pool> {
  const res = await fetch(`${base}/admin/talking-quotes`, { headers: authed(adminBearer) });
  assert.equal(res.status, 200);
  return (await res.json()) as Pool;
}

before(async () => {
  const express = (await import('express')).default;
  quotes = await import('./quotes.js');
  bus = await import('./controlBus.js');
  ({ appStore } = await import('./appStore.js'));
  const { userStore } = await import('./userStore.js');
  const { registerAuth } = await import('./auth.js');
  const { registerAdminApi } = await import('./adminApi.js');

  const server = express();
  registerAuth(server, ADMIN_TOKEN);
  registerAdminApi(server);
  app = createServer(server);
  await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', () => resolve()));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;

  userStore.createUser('quoteadmin', 'password-123', { isAdmin: true });
  userStore.createUser('quoteuser', 'password-123', {});
  adminBearer = appStore.createSession('quoteadmin');
  userBearer = appStore.createSession('quoteuser');
});

after(() => {
  app?.close();
});

test('only a global admin may read or write the pool', async () => {
  const path = `${base}/admin/talking-quotes`;
  assert.equal((await fetch(path)).status, 401, 'anonymous must be refused');
  assert.equal((await fetch(path, { headers: authed(userBearer) })).status, 403, 'a plain user too');
  assert.equal((await put({ text: 'Hijacked.' }, userBearer)).status, 403);
  assert.deepEqual(quotes.loadQuotes(), [], 'and the refused write stored nothing');
});

test('an empty world has no quotes, and says what the limits are', async () => {
  const pool = await get();
  assert.equal(pool.text, '');
  assert.equal(pool.count, 0);
  assert.equal(pool.maxQuoteLength, quotes.MAX_QUOTE_LEN);
  assert.equal(pool.maxTextLength, quotes.MAX_QUOTES_TEXT);
});

test('a save keeps the text as typed, reaches every room and the next load', async () => {
  let events = 0;
  const onChange = (): void => void events++;
  bus.controlBus.on(bus.QUOTES_CHANGED_EVENT, onChange);
  try {
    const text = '﻿# the office\r\nFirst.\r\n\r\n  Second.  \r\n# the end';
    const res = await put({ text });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { text: string; count: number };
    assert.equal(body.count, 2);
    // One stored form: no BOM, \n line ends — and nothing else touched.
    assert.equal(body.text, '# the office\nFirst.\n\n  Second.  \n# the end');
    assert.equal((await get()).text, body.text, 'what GET answers is what was stored');
    assert.equal(events, 1, 'the running rooms are told');
    assert.deepEqual(quotes.loadQuotes(), ['First.', 'Second.'], 'and the cache is the new pool');
  } finally {
    bus.controlBus.off(bus.QUOTES_CHANGED_EVENT, onChange);
  }
});

test('one bad line refuses the whole save, by line number, and stores nothing', async () => {
  await put({ text: 'Kept.' });
  let events = 0;
  const onChange = (): void => void events++;
  bus.controlBus.on(bus.QUOTES_CHANGED_EVENT, onChange);
  try {
    const long = 'x'.repeat(quotes.MAX_QUOTE_LEN + 1);
    const res = await put({ text: `Fine.\n${long}\nFine.\nBell\u0007.` });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string; rejected: { line: number; why: string }[] };
    assert.deepEqual(
      body.rejected.map((r) => r.line),
      [2, 3, 4],
      'every bad line, where the author can find it',
    );
    assert.match(body.error, /nothing was saved/);
    assert.equal((await get()).text, 'Kept.');
    assert.deepEqual(quotes.loadQuotes(), ['Kept.']);
    assert.equal(events, 0, 'a refused save tells no room anything');
  } finally {
    bus.controlBus.off(bus.QUOTES_CHANGED_EVENT, onChange);
  }
});

test('the input is bounded: not a string, or longer than the cap, is refused', async () => {
  await put({ text: 'Kept.' });
  for (const body of [{}, { text: 42 }, { text: ['a'] }, { text: `${'a\n'.repeat(quotes.MAX_QUOTES_TEXT / 2)}b` }]) {
    const res = await put(body);
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 40));
  }
  assert.deepEqual(quotes.loadQuotes(), ['Kept.']);
  // Clearing the pool is a legal save: the whales go back to telling the time.
  assert.equal((await put({ text: '' })).status, 200);
  assert.deepEqual(quotes.loadQuotes(), []);
});

test('a stored row is read with the same rules — a restore cannot bypass the save check', async () => {
  // Written behind the API's back, the way a hand-edit or an old backup would.
  // loadQuotes reads exactly this — getQuotesText through parseQuotes — once per
  // process (a restart), so the pair is what is asserted here.
  appStore.setSetting(quotes.QUOTES_SETTING, `Good.\n${'y'.repeat(quotes.MAX_QUOTE_LEN + 1)}\nGood.`);
  const { quotes: pool, rejected } = quotes.parseQuotes(quotes.getQuotesText());
  assert.deepEqual(pool, ['Good.'], 'the good line survives a bad neighbour on read');
  assert.deepEqual(rejected.map((r) => r.line), [2, 3]);
  // A non-string row is no pool at all rather than a crash.
  appStore.setSetting(quotes.QUOTES_SETTING, { not: 'text' });
  assert.equal(quotes.getQuotesText(), '');
});
