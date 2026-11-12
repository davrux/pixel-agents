/**
 * Two-factor sign-in, from the profile (Settings → Account): set it up, confirm it, turn it off,
 * replace the recovery codes.
 *
 * Every route resolves the caller from its session (cookie in the browser, bearer on the desktop)
 * and acts on THAT account — no route takes an account id. The call stays in each route body, as
 * in oidc/routes.ts, so the gate is visible to a reader and to mmo-readiness's route check.
 *
 * What protects what:
 *  • Starting an enrolment needs only the session — it shows a secret and changes nothing about
 *    how the account signs in.
 *  • Finishing one needs the PASSWORD plus a code from the app: the code proves the app has the
 *    secret (so nobody is locked out by a mistyped scan), the password proves it is the owner (so
 *    a stolen cookie cannot enrol the thief's phone and lock the owner out).
 *  • Turning it off and new recovery codes need the password AND a current code (or a recovery
 *    code) — the factor being removed must be presented to remove it.
 *
 * Two-factor guards the PASSWORD sign-in. An account with no password (provisioned by the identity
 * provider) has nothing for it to guard, so it is refused there; the provider runs its own MFA.
 */
import type { Express, Request, Response } from 'express';
import express from 'express';
import QRCode from 'qrcode';

import { reauthenticate, userIdFromBearer, userIdFromCookie } from './auth.js';
import { totpStore } from './totpStore.js';
import { userStore } from './userStore.js';
import { otpauthUri } from './totp.js';

const ISSUER = 'pixel-agents';

export function registerTotpApi(app: Express): void {
  const json = express.json({ limit: '2kb' });
  const reqUserId = (req: Request): string | undefined =>
    userIdFromCookie(req.headers.cookie) ?? userIdFromBearer(req.headers.authorization);
  const unauthorized = (res: Response): void => void res.status(401).json({ error: 'unauthorized' });
  const body = (req: Request): Record<string, unknown> => (req.body ?? {}) as Record<string, unknown>;

  /** The enrolment payload: the secret as text (for typing in by hand), the URI and a QR of it. */
  const enrolment = async (req: Request, userId: string, secret: string) => {
    const account = `${userId}@${req.hostname || 'localhost'}`;
    const uri = otpauthUri(secret, ISSUER, account);
    const qrSvg = await QRCode.toString(uri, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' });
    return { secret, uri, qrSvg };
  };

  app.get('/account/totp', (req: Request, res: Response) => {
    const userId = reqUserId(req);
    if (!userId) return unauthorized(res);
    const user = userStore.get(userId);
    res.set('Cache-Control', 'no-store').json({ ...totpStore.status(userId), hasPassword: user?.hasPassword === true });
  });

  // Begin (or restart) setting up. Answers the secret to scan; nothing about sign-in changes yet.
  app.post('/account/totp/setup', json, (req: Request, res: Response) => {
    void (async () => {
      const userId = reqUserId(req);
      if (!userId) return unauthorized(res);
      if (!userStore.get(userId)?.hasPassword) {
        return void res.status(409).json({ error: 'Set a password first — two-factor protects signing in with it.' });
      }
      const secret = totpStore.beginEnrolment(userId);
      if (!secret) return void res.status(409).json({ error: 'Two-factor sign-in is already on.' });
      res.set('Cache-Control', 'no-store').json(await enrolment(req, userId, secret));
    })().catch(() => res.status(500).json({ error: 'Could not start the setup.' }));
  });

  // Finish setting up: password + a code from the app. Answers the recovery codes, once.
  app.post('/account/totp/enable', json, (req: Request, res: Response) => {
    const userId = reqUserId(req);
    if (!userId) return unauthorized(res);
    if (!totpStore.pendingSecret(userId)) return void res.status(409).json({ error: 'Start the setup first.' });
    const denied = reauthenticate(userId, body(req).password);
    if (denied) return void res.status(denied.status).json({ error: denied.error });
    const codes = totpStore.confirmEnrolment(userId, body(req).code);
    if (!codes) return void res.status(400).json({ error: 'That code is not right — check the time on your phone and try the next one.' });
    res.set('Cache-Control', 'no-store').json({ ok: true, recoveryCodes: codes });
  });

  // Abandon an enrolment that was never confirmed. Cannot touch an enabled one.
  app.post('/account/totp/cancel', json, (req: Request, res: Response) => {
    const userId = reqUserId(req);
    if (!userId) return unauthorized(res);
    if (totpStore.pendingSecret(userId)) totpStore.disable(userId);
    res.json({ ok: true });
  });

  app.post('/account/totp/disable', json, (req: Request, res: Response) => {
    const userId = reqUserId(req);
    if (!userId) return unauthorized(res);
    if (!totpStore.isEnabled(userId)) return void res.status(409).json({ error: 'Two-factor sign-in is not on.' });
    const denied = reauthenticate(userId, body(req).password, String(body(req).code ?? ''));
    if (denied) return void res.status(denied.status).json({ error: denied.error });
    totpStore.disable(userId);
    res.json({ ok: true });
  });

  app.post('/account/totp/recovery', json, (req: Request, res: Response) => {
    const userId = reqUserId(req);
    if (!userId) return unauthorized(res);
    if (!totpStore.isEnabled(userId)) return void res.status(409).json({ error: 'Two-factor sign-in is not on.' });
    const denied = reauthenticate(userId, body(req).password, String(body(req).code ?? ''));
    if (denied) return void res.status(denied.status).json({ error: denied.error });
    res.set('Cache-Control', 'no-store').json({ ok: true, recoveryCodes: totpStore.regenerateRecoveryCodes(userId) });
  });
}
