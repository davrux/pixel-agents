/**
 * Saving art over HTTP, so a sheet never travels through the room.
 *
 * It used to be two room messages. That worked, and after the decode path was rewritten it cost
 * 13 ms rather than 48 — but it still ran inside the room's own handler, on the thread the
 * simulation ticks on, with the WebSocket's global 12 MB ceiling as its only size bound and no
 * way to answer the client at all: a refused save was indistinguishable from a lost one.
 *
 * Being an HTTP route changes four things, and it is worth being precise about which:
 *
 *  • It has its OWN size limit (`MAX_SHEET_PNG_BYTES`), stated per route instead of inherited
 *    from the transport, and Express refuses a bigger body before a byte reaches this code.
 *  • It ANSWERS. A rejected sheet comes back as 400 with a reason the editor can show, where a
 *    room message could only be silently dropped.
 *  • It removes two message types from the room's surface, which is two fewer places for a
 *    write path to outlive its caller.
 *  • It makes the decode MOVABLE. This is the honest limit of the change: HTTP and the room share
 *    one process and one thread, so the 13 ms still lands in the same event loop today. What the
 *    move buys is that nothing in the room refers to it any more, so putting the decode in a
 *    worker (or pngjs's chunked parse) is a change to this file alone.
 *
 * Authorisation is resolved from the session, never from the payload: `/art/avatar` writes the
 * CALLER's avatar and takes no id, and `/art/asset/...` requires an admin, which is what
 * `gallery.edit` means today. The rooms hear about a save through the control bus, exactly as
 * they already do for an asset edit.
 */
import express, { type Express, type Request, type Response } from 'express';

import { ASSET_TYPES, invalidateMergedBundle, type AssetType } from './assetOverrides.js';
import { appStore } from './appStore.js';
import { userIdFromBearer, userIdFromCookie } from './auth.js';
import { ASSET_CHANGED_EVENT, AVATAR_CHANGED_EVENT, controlBus } from './controlBus.js';
import { CHAR_FRAME_H, CHAR_FRAME_W, PET_FRAME_H, PET_FRAME_W } from './core/assets/constants.js';
import { validSheetMeta } from './art/characterDataGuard.js';
import { MAX_SHEET_PNG_BYTES, sheetFromPng } from './art/sheetPng.js';
import { userStore } from './userStore.js';

/** The metadata a sheet cannot carry, as JSON in a header — see `sheetRowFrom`. */
const META_HEADER = 'x-pixel-sheet';
/** Bound on that header. A spec with every track named is a few hundred bytes; anything
 *  approaching this is not a sheet's metadata, and headers are parsed before any limit of ours. */
const MAX_META_BYTES = 4096;

/**
 * One upload turned into the row the store keeps, or a reason it was refused.
 *
 * The PNG is the body and the metadata is a header, rather than one JSON object with the image
 * base64'd inside it: base64 would add a third to every save and make the parse walk the whole
 * sheet as a string, which is the shape this whole change is getting away from.
 */
function sheetRowFrom(
  body: unknown,
  metaRaw: string | undefined,
  fallbackFrame: { w: number; h: number },
): { ok: true; row: Record<string, unknown> } | { ok: false; reason: string } {
  if (typeof metaRaw !== 'string' || metaRaw.length === 0) return { ok: false, reason: 'missing sheet metadata' };
  if (Buffer.byteLength(metaRaw) > MAX_META_BYTES) return { ok: false, reason: 'sheet metadata too long' };
  let meta: { name?: unknown; spec?: unknown; npc?: unknown };
  try {
    meta = JSON.parse(metaRaw) as typeof meta;
  } catch {
    return { ok: false, reason: 'sheet metadata is not JSON' };
  }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return { ok: false, reason: 'sheet metadata is not an object' };

  // The frame size the sheet claims. Bounded only enough to slice with here; the spec itself is
  // validated below, together with the rule that its tracks sum to the frame count.
  const claimed = (meta.spec as { frame?: { w?: unknown; h?: unknown } } | undefined)?.frame;
  const dim = (v: unknown, dflt: number): number => (Number.isInteger(v) ? (v as number) : dflt);
  const frame = { w: dim(claimed?.w, fallbackFrame.w), h: dim(claimed?.h, fallbackFrame.h) };

  const sheet = sheetFromPng(body, frame);
  if (!sheet.ok) return { ok: false, reason: sheet.reason };
  const kept = {
    name: meta.name,
    ...(meta.spec !== undefined ? { spec: meta.spec } : {}),
    ...(meta.npc !== undefined ? { npc: meta.npc } : {}),
  };
  if (!validSheetMeta(kept, sheet.frames)) return { ok: false, reason: 'invalid name, spec or npc config' };
  return { ok: true, row: { ...kept, png: sheet.png.toString('base64'), frame, dirs: sheet.dirs } };
}

export function registerArtSaveApi(app: Express): void {
  // The PNG arrives as bytes. `type: () => true` because a browser's fetch and the desktop set
  // different content types for a Blob and neither is worth arguing with; what decides whether
  // this is a sheet is the signature and header check in sheetFromPng, not a declared type.
  const rawPng = express.raw({ type: () => true, limit: MAX_SHEET_PNG_BYTES });

  /** The signed-in caller, cookie in a browser or bearer on the desktop. Named as adminApi
   *  names it, deliberately: one word for "resolve the caller from the request" across the whole
   *  HTTP surface, and it is the shape mmo-readiness recognises as a gate. */
  const reqUserId = (req: Request): string | undefined =>
    userIdFromCookie(req.headers.cookie) ?? userIdFromBearer(req.headers.authorization);

  /** A viewer's own avatar. No id in the path or the payload: it is whoever is signed in. */
  app.post('/art/avatar', rawPng, (req: Request, res: Response) => {
    const userId = reqUserId(req);
    if (!userId) return void res.status(401).json({ error: 'unauthorized' });
    const out = sheetRowFrom(req.body, req.header(META_HEADER), { w: CHAR_FRAME_W, h: CHAR_FRAME_H });
    if (!out.ok) return void res.status(400).json({ error: out.reason });
    appStore.setPlayerAvatar(userId, out.row);
    controlBus.emit(AVATAR_CHANGED_EVENT, userId);
    res.json({ ok: true });
  });

  /** A gallery skin or an NPC. Admin only — that is what `gallery.edit` resolves to. */
  app.post('/art/asset/:type/:name', rawPng, (req: Request, res: Response) => {
    const userId = reqUserId(req);
    if (!userId) return void res.status(401).json({ error: 'unauthorized' });
    if (!userStore.get(userId)?.isAdmin) return void res.status(403).json({ error: 'forbidden' });
    const type = String(req.params.type);
    if (!(ASSET_TYPES as readonly string[]).includes(type)) return void res.status(400).json({ error: 'unknown type' });
    const name = String(req.params.name);
    // Asset ids are safe identifiers (char_0, dog_1, …), the same rule the room message had.
    if (!/^[A-Za-z0-9_:-]{1,40}$/.test(name)) return void res.status(400).json({ error: 'bad name' });
    const frame = type === 'pet' ? { w: PET_FRAME_W, h: PET_FRAME_H } : { w: CHAR_FRAME_W, h: CHAR_FRAME_H };
    const out = sheetRowFrom(req.body, req.header(META_HEADER), frame);
    if (!out.ok) return void res.status(400).json({ error: out.reason });
    appStore.saveAsset(type as AssetType, name, out.row);
    invalidateMergedBundle();
    controlBus.emit(ASSET_CHANGED_EVENT, type);
    res.json({ ok: true });
  });
}
