/**
 * Putting a picture on a television, and fetching it again — see Action `tvScreen`.
 *
 * Three routes, each deciding from the session and never from the payload:
 *
 *  • `POST /tv/screen` — the PNG is the body (packed by the client, see `shared/office/tvScreen.ts`)
 *    and `X-Pixel-Tv` carries `{ ticket, frameW, frameH, delays }`. WHICH television is not in the
 *    payload at all: it is whatever the ticket names, and the ticket was issued by the room to the
 *    account that walked up to it (tvTickets.ts) and is honoured only for that same account.
 *  • `POST /tv/screen/clear` — switches it off, by the same ticket.
 *  • `GET /tv/:zone/:screen/:hash` — the stored picture. Behind the session gate like every other
 *    non-public GET, and answered only for the CURRENT hash, so the URL is a capability handed out
 *    through the zone's synced state: a viewer who was never in a private zone cannot read its
 *    television by guessing a tile.
 *
 * The image goes through `screenFromPng` — byte cap, signature, header, declared dimensions
 * against the promised grid, all before decoding, then a re-encode — so what other viewers
 * download is a PNG this server wrote. Rooms learn of a change through the control bus.
 */
import express, { type Express, type Request, type Response } from 'express';

import {
  TV_MAX_FRAMES,
  TV_MAX_FRAME_H,
  TV_MAX_FRAME_W,
  TV_SCREEN_KEY_RE,
  TV_UPLOAD_HEADER,
  tvFrameDelay,
  tvGrid,
} from '@pixel/shared/office/tvScreen.js';

import { userIdFromBearer, userIdFromCookie } from './auth.js';
import { TV_SCREEN_CHANGED_EVENT, controlBus } from './controlBus.js';
import { MAX_TV_PNG_BYTES, screenFromPng } from './art/sheetPng.js';
import { tvScreenStore } from './tvScreenStore.js';
import { consumeTvTicket, tvTicketFor } from './tvTickets.js';

/** Bound on the metadata header: 48 delays of five digits plus a ticket is well under a kilobyte. */
const MAX_META_BYTES = 2048;

/** The largest packed sheet the bounds allow — what the header's dimensions are capped at. */
const LARGEST = tvGrid(TV_MAX_FRAME_W, TV_MAX_FRAME_H, TV_MAX_FRAMES);
const MAX_SHEET_PIXELS = LARGEST.width * LARGEST.height;

/** The payload a room hears on the bus: which television in which zone changed. */
export interface TvScreenChange {
  zoneId: string;
  screen: string;
}

function readMeta(raw: string | undefined): Record<string, unknown> | null {
  if (typeof raw !== 'string' || !raw || Buffer.byteLength(raw) > MAX_META_BYTES) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function registerTvScreenApi(app: Express): void {
  // As for art: the declared content type is not worth arguing with, the signature decides.
  const rawPng = express.raw({ type: () => true, limit: MAX_TV_PNG_BYTES });

  /** The signed-in caller, cookie in a browser or bearer on the desktop (see artSaveApi). */
  const reqUserId = (req: Request): string | undefined =>
    userIdFromCookie(req.headers.cookie) ?? userIdFromBearer(req.headers.authorization);

  app.post('/tv/screen', rawPng, async (req: Request, res: Response) => {
    const userId = reqUserId(req);
    if (!userId) return void res.status(401).json({ error: 'unauthorized' });
    const meta = readMeta(req.header(TV_UPLOAD_HEADER));
    if (!meta) return void res.status(400).json({ error: 'missing or malformed metadata' });
    const ticket = tvTicketFor(meta.ticket, userId);
    if (!ticket) return void res.status(403).json({ error: 'walk up to the television again' });

    const rawDelays = Array.isArray(meta.delays) ? meta.delays : null;
    if (!rawDelays || rawDelays.length < 1 || rawDelays.length > TV_MAX_FRAMES) {
      return void res.status(400).json({ error: 'bad frame count' });
    }
    const delays = rawDelays.map(tvFrameDelay);
    const frame = { w: Number(meta.frameW), h: Number(meta.frameH), frames: delays.length };
    const out = await screenFromPng(
      req.body,
      frame,
      {
        maxW: TV_MAX_FRAME_W,
        maxH: TV_MAX_FRAME_H,
        maxFrames: TV_MAX_FRAMES,
        maxPixels: MAX_SHEET_PIXELS,
      },
      tvGrid,
    );
    if (!out.ok) return void res.status(400).json({ error: out.reason });

    tvScreenStore.set(ticket.zoneId, ticket.screen, out.png, frame.w, frame.h, delays);
    consumeTvTicket(meta.ticket);
    // Who changed a picture everyone in the zone sees is worth a line: it is the only record.
    console.log(`[tv] ${userId} put ${delays.length} frame(s) on ${ticket.zoneId}/${ticket.screen}`);
    controlBus.emit(TV_SCREEN_CHANGED_EVENT, { zoneId: ticket.zoneId, screen: ticket.screen } satisfies TvScreenChange);
    res.json({ ok: true });
  });

  app.post('/tv/screen/clear', async (req: Request, res: Response) => {
    const userId = reqUserId(req);
    if (!userId) return void res.status(401).json({ error: 'unauthorized' });
    const meta = readMeta(req.header(TV_UPLOAD_HEADER));
    const ticket = meta ? tvTicketFor(meta.ticket, userId) : undefined;
    if (!ticket) return void res.status(403).json({ error: 'walk up to the television again' });
    tvScreenStore.clear(ticket.zoneId, ticket.screen);
    consumeTvTicket(meta!.ticket);
    console.log(`[tv] ${userId} switched off ${ticket.zoneId}/${ticket.screen}`);
    controlBus.emit(TV_SCREEN_CHANGED_EVENT, { zoneId: ticket.zoneId, screen: ticket.screen } satisfies TvScreenChange);
    res.json({ ok: true });
  });

  app.get('/tv/:zone/:screen/:hash', (req: Request, res: Response) => {
    if (!reqUserId(req)) return void res.status(401).json({ error: 'unauthorized' });
    const zone = String(req.params.zone).slice(0, 64);
    const screen = String(req.params.screen);
    const hash = String(req.params.hash);
    if (!TV_SCREEN_KEY_RE.test(screen) || !/^[0-9a-f]{24}$/.test(hash)) return void res.status(404).end();
    const tv = tvScreenStore.get(zone, screen);
    // Only the current picture: an old URL is a 404, not a way back to what was replaced.
    if (!tv || tv.hash !== hash) return void res.status(404).end();
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('ETag', `"${hash}"`);
    // The hash is in the path, so a hit is immutable by construction.
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.end(tv.png);
  });
}

/** The URL a room syncs for a stored picture. One place, because the GET route above parses it. */
export function tvScreenSrc(zoneId: string, screen: string, hash: string): string {
  return `/tv/${encodeURIComponent(zoneId)}/${encodeURIComponent(screen)}/${hash}`;
}
