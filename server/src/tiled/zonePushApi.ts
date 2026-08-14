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

import * as fs from 'node:fs';
import * as path from 'node:path';

import { reloadFurnitureCatalog } from '../assets.js';
import { ZoneMapStore } from '../zoneMapStore.js';
import { ZoneStore } from '../zoneStore.js';
import { controlBus, ZONE_LAYOUT_CHANGED_EVENT } from '../controlBus.js';
import { loadTiledRegistry } from './tiledRegistry.js';
import { importZoneTmj, NO_IMPORT_SUFFIX } from './zoneImport.js';

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
  const mapStore = new ZoneMapStore();
  const zones = new ZoneStore();

  /**
   * What the server has, so a pusher can send only what differs.
   *
   * Assets ARE committed and do arrive with a deploy — this exists so a mapper
   * who added a tile does not have to wait for one. A pushed file therefore
   * lives exactly as long as the directory does: on a container with no volume
   * mounted at the assets path, the next redeploy replaces it with the
   * committed version, which is the right outcome rather than a loss.
   */
  app.get('/tiled/assets', (req: Request, res: Response) => {
    if (!authorized(req, res, adminToken)) return;
    const files: Record<string, string> = {};
    for (const rel of listPushableAssets(assetsRoot)) {
      files[rel] = hashFile(path.join(assetsRoot, 'assets', 'tiled', rel));
    }
    res.json({ files });
  });

  app.post('/tiled/assets', json, (req: Request, res: Response) => {
    if (!authorized(req, res, adminToken)) return;
    void handleAssetPush(req, res, assetsRoot);
  });

  app.post('/tiled/zone', json, (req: Request, res: Response) => {
    if (!authorized(req, res, adminToken)) return;
    void handlePush(req, res, mapStore, zones, assetsRoot);
  });
  console.log('[zone-push] POST /tiled/zone + /tiled/assets ready (X-Pixel-Admin-Token)');
}

function authorized(req: Request, res: Response, adminToken: string): boolean {
  const presented = req.header('x-pixel-admin-token') ?? '';
  if (presented && tokenEquals(presented, adminToken)) return true;
  res.status(401).json({ error: 'unauthorized' });
  return false;
}

/**
 * Which files a push may carry, as paths relative to assets/tiled.
 *
 * An allow-list by shape, not a denylist: a tileset at the top level, or a PNG
 * under png/. Everything else the server reads from that directory — the Tiled
 * project file, zone maps — is either editor-only or has its own route, and a
 * write primitive that accepts arbitrary paths under an app directory is worth
 * more to an attacker than the feature is to us.
 */
function isPushableAsset(rel: string): boolean {
  if (rel.includes('..') || rel.startsWith('/') || rel.includes('\\')) return false;
  if (/^[A-Za-z0-9._-]+\.tsj$/.test(rel)) return true;
  return /^png\/[A-Za-z0-9._\/-]+\.png$/.test(rel) && !rel.includes('//');
}

function listPushableAssets(assetsRoot: string): string[] {
  const base = path.join(assetsRoot, 'assets', 'tiled');
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
      else if (isPushableAsset(rel)) out.push(rel);
    }
  };
  walk(base, '');
  return out.sort();
}

/** Short content hash — only ever compared for equality, so 16 hex chars of
 *  sha256 is plenty and keeps the listing small over the wire. */
function hashFile(full: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex').slice(0, 16);
}

async function handleAssetPush(req: Request, res: Response, assetsRoot: string): Promise<void> {
  const body = (req.body ?? {}) as { files?: unknown };
  if (!body.files || typeof body.files !== 'object') {
    return void res.status(400).json({ error: 'missing files' });
  }
  const base = path.join(assetsRoot, 'assets', 'tiled');
  const written: string[] = [];
  try {
    for (const [rel, b64] of Object.entries(body.files as Record<string, unknown>)) {
      if (typeof b64 !== 'string' || !isPushableAsset(rel)) {
        return void res.status(400).json({ error: `refused: ${rel}` });
      }
      const full = path.join(base, rel);
      // Belt and braces over isPushableAsset: whatever path.join made of it has
      // to still be inside the directory we meant.
      if (!full.startsWith(base + path.sep)) return void res.status(400).json({ error: `refused: ${rel}` });
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, Buffer.from(b64, 'base64'));
      written.push(rel);
    }
    // Explicitly, not via the fs watcher: that one only reacts to
    // furniture-*.tsj, and a pushed floor sheet or PNG would otherwise sit on
    // disk with the running process still serving the old catalog.
    const items = await reloadFurnitureCatalog();
    console.log(`[zone-push] ${written.length} asset(s) written, catalog reloaded (${items} items)`);
    res.json({ ok: true, written: written.length, catalogItems: items });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[zone-push] asset push failed: ${message}`);
    res.status(500).json({ error: message });
  }
}

async function handlePush(req: Request, res: Response, mapStore: ZoneMapStore, zones: ZoneStore, assetsRoot: string): Promise<void> {
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

  try {
    // Reloaded per push, not cached at boot, so a tileset added since the
    // server started still resolves — matches the furniture watcher's reasoning.
    const registry = loadTiledRegistry(assetsRoot);
    const result = await importZoneTmj(body.tmj as Record<string, unknown>, registry, zoneId, mapStore, zones, files);
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
