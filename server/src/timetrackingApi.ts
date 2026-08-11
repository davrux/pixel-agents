/**
 * REST API the client uses to configure and drive its own TimeTracking account.
 *
 * Registered after registerAuth, so it sits behind the login gate like the
 * admin API; each route still resolves *which* user is calling, because every
 * route acts on that caller's own row and nothing else. There is deliberately
 * no way to read or book someone else's working time through here — the world
 * shows other people's coarse status (see service.ts / SimRoom), and that is
 * the whole extent of what anyone learns about anyone else.
 *
 * The credentials themselves only travel inbound: PUT /settings takes a
 * password, nothing ever returns one.
 */
import express, { type Express, type Request, type Response } from 'express';

import type { WorkAction } from '@pixel/shared';

import { userIdFromBearer, userIdFromCookie } from './auth.js';
import { clearFails, isThrottled, noteFail } from './throttle.js';
import { timeTracking } from './timetracking/service.js';
import { normalizeBaseUrl, timeTrackingStore } from './timetracking/store.js';

const MAX_CREDENTIAL_LEN = 200;
const ACTIONS: readonly WorkAction[] = ['start', 'pause', 'end'];

/** Optional deployment default, offered in the settings form so nobody has to
 *  type the company's server address (suggestion only — same idea as
 *  MUMBLE_HOST, and just as non-authoritative). */
const SUGGESTED_URL = process.env.TIMETRACKING_URL?.trim() ?? '';

export function registerTimeTrackingApi(app: Express): void {
  const json = express.json({ limit: '4kb' });

  const caller = (req: Request, res: Response): string | null => {
    const uid = userIdFromCookie(req.headers.cookie) ?? userIdFromBearer(req.headers.authorization);
    if (!uid) {
      res.status(401).json({ error: 'unauthorized' });
      return null;
    }
    return uid;
  };

  // What this user has configured — never the password.
  app.get('/timetracking/settings', (req, res) => {
    const uid = caller(req, res);
    if (!uid) return;
    res.json({ ...timeTrackingStore.view(uid), suggestedBaseUrl: SUGGESTED_URL });
  });

  // Save (or replace) the connection. The credentials are proven against the
  // real server before anything is stored, so a typo fails here loudly rather
  // than silently as a status that never appears.
  app.put('/timetracking/settings', json, async (req, res) => {
    const uid = caller(req, res);
    if (!uid) return;

    // A wrong password costs a round trip to someone else's server; throttle it
    // so this can't be used to hammer a third party (or brute-force through us).
    const tkey = `tt:${uid}`;
    if (isThrottled(tkey)) {
      return void res.status(429).json({ error: 'Too many failed attempts — wait a minute and try again.' });
    }

    const body = (req.body ?? {}) as { baseUrl?: unknown; username?: unknown; password?: unknown };
    const baseUrl = normalizeBaseUrl(body.baseUrl);
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!baseUrl) return void res.status(400).json({ error: 'Enter the TimeTracking server address as a full http(s) URL.' });
    if (!username || username.length > MAX_CREDENTIAL_LEN) return void res.status(400).json({ error: 'Enter your TimeTracking username.' });
    if (!password || password.length > MAX_CREDENTIAL_LEN) return void res.status(400).json({ error: 'Enter your TimeTracking password.' });

    const check = await timeTracking.verify({ baseUrl, username, password });
    if (!check.ok) {
      noteFail(tkey);
      return void res.status(400).json({ error: check.error });
    }

    clearFails(tkey); // a working login resets the cooldown, as everywhere else
    timeTrackingStore.set(uid, { baseUrl, username, password });
    timeTracking.forget(uid); // drop tokens minted for the previous credentials
    const snapshot = await timeTracking.refresh(uid);
    res.json({ ...timeTrackingStore.view(uid), displayName: check.displayName, status: snapshot });
  });

  app.delete('/timetracking/settings', (req, res) => {
    const uid = caller(req, res);
    if (!uid) return;
    timeTrackingStore.clear(uid);
    timeTracking.forget(uid);
    res.json({ configured: false, baseUrl: '', username: '' });
  });

  // Current status + today's total. The client polls this while its panel is
  // open and ticks the clock locally in between (see runningSince).
  app.get('/timetracking/status', async (req, res) => {
    const uid = caller(req, res);
    if (!uid) return;
    res.json(await timeTracking.snapshot(uid));
  });

  // Start / pause / end. Which booking that becomes is decided server-side from
  // what the TimeTracking install currently allows.
  app.post('/timetracking/book', json, async (req, res) => {
    const uid = caller(req, res);
    if (!uid) return;
    const action = (req.body ?? {}).action as unknown;
    if (typeof action !== 'string' || !ACTIONS.includes(action as WorkAction)) {
      return void res.status(400).json({ error: 'Unknown action.' });
    }
    const result = await timeTracking.book(uid, action as WorkAction);
    if (!result.ok) return void res.status(400).json({ error: result.error });
    res.json(result.snapshot);
  });
}
