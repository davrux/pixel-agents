/**
 * Public REST API for ad-hoc meeting rooms (see meetingRoomStore.ts). Reachable
 * WITHOUT a pixel-agents session — a guest with the link only needs a display
 * name and, if the room is locked, its password. Registered BEFORE registerAuth
 * installs its login gate (same pattern as /arcade/catalog, /voxel/worlds in
 * index.ts) — public by design, not by gate-bypass accident.
 *
 * A logged-in pixel-agents viewer (cookie or desktop bearer) skips the name
 * prompt entirely — the client's GET /info call reports `authenticatedAs`, and
 * POST /join ignores any submitted name in favour of the account's display name.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import express, { type Express, type Request } from 'express';

import { hasValidBearerSession, hasValidSession, userIdFromBearer, userIdFromCookie } from './auth.js';
import { userStore, UserStore } from './userStore.js';
import { meetingRoomStore } from './meetingRoomStore.js';
import { mintVoiceToken, voiceConfigured, voiceRoomName, voiceUrl } from './voice/livekit.js';
import { appStore } from './appStore.js';
import { isThrottled, noteFail, clearFails } from './throttle.js';

/** Per-deployment LiveKit room-name namespace, same convention as SimRoom/VoxelRoom. */
const voiceNs = process.env.PIXEL_VOICE_PREFIX?.trim() || appStore.getVoiceNs();

/** The display name of an already-signed-in viewer (cookie or desktop bearer), else null. */
function authedDisplayName(req: Request): string | null {
  const cookie = req.headers.cookie;
  if (hasValidSession(cookie)) {
    const userId = userIdFromCookie(cookie);
    const user = userId ? userStore.get(userId) : undefined;
    if (user) return UserStore.displayName(user);
  }
  const authHeader = req.headers.authorization;
  if (hasValidBearerSession(authHeader)) {
    const userId = userIdFromBearer(authHeader);
    const user = userId ? userStore.get(userId) : undefined;
    if (user) return UserStore.displayName(user);
  }
  return null;
}

export function registerMeetingRoomApi(app: Express, clientDist: string): void {
  const json = express.json({ limit: '4kb' });

  // Room existence + gate shape, so the join page knows what to ask for (name
  // only, name + password, or nothing at all for an already-signed-in viewer)
  // before the guest types anything.
  app.get('/meet/:slug/info', (req, res) => {
    const room = meetingRoomStore.get(req.params.slug);
    if (!room || meetingRoomStore.isExpired(room)) return void res.json({ exists: false });
    res.json({ exists: true, needsPassword: room.hasPassword, authenticatedAs: authedDisplayName(req) });
  });

  app.post('/meet/:slug/join', json, (req, res) => {
    const slug = req.params.slug;
    const room = meetingRoomStore.get(slug);
    if (!room || meetingRoomStore.isExpired(room)) return void res.status(404).json({ error: 'not found' });
    const body = (req.body ?? {}) as { name?: unknown; password?: unknown };
    const name = authedDisplayName(req) ?? (typeof body.name === 'string' ? body.name.trim().slice(0, 32) : '');
    if (!name) return void res.status(400).json({ error: 'name required' });
    if (room.hasPassword) {
      // Throttle wrong guesses (each does a full scrypt) to bound brute-force + CPU-DoS.
      // Keyed by IP (guests have no account) — coarser than the per-user zone/monitor
      // throttle, but the same defence-in-depth intent.
      const tkey = `meet:${slug}:${req.ip}`;
      const password = typeof body.password === 'string' ? body.password : '';
      if (isThrottled(tkey) || !meetingRoomStore.verifyPassword(slug, password)) {
        noteFail(tkey);
        return void res.status(401).json({ error: 'wrong password' });
      }
      clearFails(tkey);
    }
    if (!voiceConfigured()) return void res.status(503).json({ error: 'not-configured' });
    const roomName = voiceRoomName(voiceNs, `meet-${slug}`);
    // A random per-connection identity — guests have no stable userId, and two
    // tabs of the "same" guest are just two participants. Crypto-random (not
    // Math.random): LiveKit disconnects the older connection when a second
    // participant joins with the same identity, so a guessable id would let an
    // attacker hijack another guest's connection mid-call.
    const identity = `meet-${randomUUID()}`;
    mintVoiceToken(identity, name, roomName)
      .then((token) => {
        if (!token) return void res.status(503).json({ error: 'not-configured' });
        res.json({ token, url: voiceUrl(), room: roomName, name });
      })
      .catch(() => res.status(500).json({ error: 'token mint failed' }));
  });

  // The standalone join page for any slug — the client reads the slug from
  // location.pathname, so one static file serves every room. Registered
  // pre-gate (see module docstring): public by design.
  const meetHtmlPath = resolve(clientDist, 'meet.html');
  app.get('/meet/:slug', (_req, res) => {
    if (!existsSync(meetHtmlPath)) return void res.status(404).send('not built');
    res.type('html').send(readFileSync(meetHtmlPath, 'utf8'));
  });
}
