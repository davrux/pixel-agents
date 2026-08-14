/**
 * Receive a zone map pushed from a mapper's machine.
 *
 * `assets/tiled/zones/*.tmj` is gitignored, so zone edits ride along with no
 * deploy — the deploy server has the tilesets (committed) but never the maps.
 * This is the one way a map gets there. The dev server no longer watches its
 * own zones directory either: pushing to 127.0.0.1 is the same command, so
 * local and deploy behave alike instead of local having a magic path.
 *
 * ── Authentication ──
 *
 * A shared secret in `X-Pixel-Admin-Token`, compared in constant time against
 * PIXEL_ADMIN_TOKEN. Deliberately NOT the session bearer the admin REST API
 * uses: a deploy script has no browser session, and making it log in first
 * would mean storing a real account's password in CI.
 *
 * That this grants no new privilege is the reason it is acceptable: anyone
 * holding this token can already create themselves an admin account through the
 * login form (see auth.ts), so accepting it here widens nothing. The route is
 * not mounted at all when no token is configured, so an unauthenticated server
 * cannot be pushed to by anyone who can reach it.
 */
import type { Express, Request, Response } from 'express';
import crypto from 'node:crypto';
import express from 'express';

import { LayoutStore } from '../layoutStore.js';
import { ZoneStore } from '../zoneStore.js';
import { controlBus, ZONE_LAYOUT_CHANGED_EVENT } from '../controlBus.js';
import { loadDefaultLayout } from '../assetLoader.js';
import { loadTiledRegistry } from './tiledRegistry.js';
import { DEFAULT_TILED_IMPORT_LAYOUT_NAME, importZoneTmj, NO_IMPORT_SUFFIX } from './zoneImport.js';

/** A .tmj is a few hundred KB of JSON, plus any images it carries — well past
 *  express.json's 100kb default, which would reject a real map outright. */
const MAX_PUSH_BYTES = 32 * 1024 * 1024;

function tokenEquals(provided: string, expected: string): boolean {
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

interface PushBody {
  /** Zone to import into. Sent explicitly rather than re-derived here, so the
   *  pusher and the server cannot disagree about which zone a file belongs to. */
  zoneId?: unknown;
  layoutName?: unknown;
  tmj?: unknown;
  /** Files the map references, relative to assets/tiled, base64-encoded —
   *  images a mapper added in Tiled live under a gitignored directory, so the
   *  server has no copy to read. */
  files?: unknown;
}

export function registerZonePushApi(app: Express, adminToken: string | null, assetsRoot: string): void {
  if (!adminToken) {
    console.warn('[zone-push] disabled: no PIXEL_ADMIN_TOKEN configured');
    return;
  }
  const json = express.json({ limit: MAX_PUSH_BYTES });
  const layoutStore = new LayoutStore(loadDefaultLayout(assetsRoot));
  const zones = new ZoneStore();

  app.post('/tiled/zone', json, (req: Request, res: Response) => {
    const presented = req.header('x-pixel-admin-token') ?? '';
    if (!presented || !tokenEquals(presented, adminToken)) {
      return void res.status(401).json({ error: 'unauthorized' });
    }
    void handlePush(req, res, layoutStore, zones, assetsRoot);
  });
  console.log('[zone-push] POST /tiled/zone ready (X-Pixel-Admin-Token)');
}

async function handlePush(req: Request, res: Response, layoutStore: LayoutStore, zones: ZoneStore, assetsRoot: string): Promise<void> {
  const body = (req.body ?? {}) as PushBody;
  const zoneId = typeof body.zoneId === 'string' ? body.zoneId.trim().toLowerCase() : '';
  if (!zoneId || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(zoneId)) {
    return void res.status(400).json({ error: 'invalid zoneId' });
  }
  // The scratch-copy rule travels with the push: a map named *-noimport is one
  // a mapper is experimenting in, and pushing it would overwrite the real zone
  // it was copied from (see isNoImportMap).
  if (zoneId.endsWith(NO_IMPORT_SUFFIX)) {
    return void res.status(400).json({ error: `zone ids ending in ${NO_IMPORT_SUFFIX} are never imported` });
  }
  if (!body.tmj || typeof body.tmj !== 'object') {
    return void res.status(400).json({ error: 'missing tmj' });
  }

  const files = new Map<string, Buffer>();
  if (body.files && typeof body.files === 'object') {
    for (const [rel, b64] of Object.entries(body.files as Record<string, unknown>)) {
      // Contained to assets/tiled: a pushed path is attacker-controlled, and
      // this one is only ever used as a lookup key, but a traversal-shaped key
      // has no business existing here either.
      if (typeof b64 !== 'string' || rel.includes('..') || rel.startsWith('/')) {
        return void res.status(400).json({ error: `invalid file path: ${rel}` });
      }
      files.set(rel, Buffer.from(b64, 'base64'));
    }
  }

  const layoutName = typeof body.layoutName === 'string' && body.layoutName ? body.layoutName : DEFAULT_TILED_IMPORT_LAYOUT_NAME;
  try {
    // Reloaded per push, not cached at boot, so a tileset added since the
    // server started still resolves — matches the furniture watcher's reasoning.
    const registry = loadTiledRegistry(assetsRoot);
    const result = await importZoneTmj(body.tmj as Record<string, unknown>, registry, zoneId, layoutName, layoutStore, zones, files);
    controlBus.emit(ZONE_LAYOUT_CHANGED_EVENT, zoneId);
    console.log(
      `[zone-push] "${zoneId}" ← ${result.cols}×${result.rows}, ${result.furnitureCount} furniture, ${result.imageCount} image(s)` +
        (result.unresolvedCount ? `, ${result.unresolvedCount} UNRESOLVED` : ''),
    );
    res.json({ ok: true, zoneId, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[zone-push] "${zoneId}" failed: ${message}`);
    res.status(400).json({ error: message });
  }
}
