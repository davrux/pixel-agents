/**
 * Character, NPC and avatar art as PNG over HTTP, instead of pixels over the wire.
 *
 * Why: the art the client needs is images — bundled skins and pets already ARE PNG
 * files on disk — but a join used to ship them as SpriteData, one hex string per pixel.
 * Measured on the dev world: 831 KB of a 1527 KB join, and 77 KB per player avatar,
 * against 39 KB for the same art as PNG sheets (24×). A URL is also cacheable, so the
 * second join costs nothing at all for art, which no message can do.
 *
 * One path for everything: whatever the merged bundle holds as SpriteData is encoded on
 * demand and kept by content hash. Serving the bundled FILES directly would be a second
 * path with its own bugs (an override shadows a file, some ids have no file at all), and
 * the encode is a few milliseconds once per sheet.
 *
 * Caching: the URL carries a content hash, so the response is `immutable` and a second
 * join costs nothing. One measured caveat for development: a browser does not use its
 * HTTP cache for an origin with a certificate error, so behind the dev server's
 * self-signed cert every load re-downloads (verified: over plain HTTP the second fetch
 * transfers 0 bytes). Nothing to fix — a deployment terminates TLS with a real
 * certificate.
 *
 * Access: the URL carries no extension, so the session gate in auth.ts covers it — this
 * route is deliberately NOT under /assets/ and does not end in .png, because that
 * exemption is by extension and would serve every player's avatar to anyone. Any
 * signed-in viewer may fetch any avatar: players see each other in the world, so the art
 * is as public as standing in a room. Writing one stays owner-only (saveAvatar).
 *
 * Ids are resolved against what the bundle actually offers, never used as a path, so a
 * crafted id can only miss.
 */
import { createHash } from 'node:crypto';

import type { Express, Request, Response } from 'express';

import { appStore } from './appStore.js';
import { getMergedBundle } from './assetOverrides.js';
import {
  CHARACTER_DIRECTIONS,
  CHAR_FRAME_H,
  CHAR_FRAME_W,
  PET_DIRECTIONS,
  PET_FRAMES_PER_ROW,
  PET_FRAME_H,
  PET_FRAME_W,
} from './core/assets/constants.js';
import { encodeDirectionalSheet } from './core/assets/pngEncoder.js';
import { packedPng, rowsPresent } from './art/artStore.js';
import { artBytes, artHash } from './art/artUrl.js';
import { PLAYER_AVATAR_SKIN_PREFIX } from '@pixel/shared';

/**
 * What is needed to answer for one piece of art: the entry it comes from (the hash for the
 * URL's `v` and the ETag are taken from that, in one place, so the two cannot disagree), plus
 * either the bytes to send or the pixels to encode.
 *
 * `png` is the case where the art already IS an image and nothing has to be built: a bundled
 * sheet, kept as the file it is (see assetLoader's BundledCharacterSheet). `sprites` is the
 * other case — a stored override arrives as SpriteData, because that is what a client sends and
 * what the validator checks.
 */
interface ArtSource {
  /** The bundle entry, for hashing. */
  entry: unknown;
  /** The sheet as bytes, when the art is already an image. */
  png?: Buffer;
  sprites?: Record<string, string[][][]>;
  dirs?: readonly string[];
  frameW?: number;
  frameH?: number;
  /** Fixed column count, for a reader that slices a fixed grid (pets). */
  cols?: number;
}

type CharEntry = { id: string; data?: { down?: unknown; spec?: { frame?: { w?: number; h?: number } } } };
type PetEntry = { name?: string; spec?: { frame?: { w?: number; h?: number } } };

/** The pet id scheme is kind + index, matching the roster keys and the sheet files. */
function petSource(id: string): ArtSource | null {
  const m = /^(dog|cat|duck)_(\d+)$/.exec(id);
  if (!m) return null;
  const raw = getMergedBundle().raw as Record<string, unknown>;
  const arr = raw[`${m[1]}s`] as PetEntry[] | undefined;
  const entry = arr?.[Number(m[2])] as (PetEntry & Record<string, unknown>) | undefined;
  if (!entry) return null;
  // A bundled sheet was never decoded — it is the file on disk (assetLoader's BundledPetSheet).
  if (Buffer.isBuffer(entry.png)) return { entry, png: entry.png };
  return {
    entry,
    sprites: entry as unknown as Record<string, string[][][]>,
    dirs: rowsPresent(entry as unknown as Record<string, unknown>, PET_DIRECTIONS),
    frameW: entry.spec?.frame?.w ?? PET_FRAME_W,
    frameH: entry.spec?.frame?.h ?? PET_FRAME_H,
    cols: PET_FRAMES_PER_ROW,
  };
}

/** The stored sheet's bytes for an id, when the row is already a PNG — nothing to
 *  encode then, and nothing to cache either. */
function storedPng(kind: string, id: string): Buffer | null {
  if (kind === 'pet') return packedPng(appStore.assetRow('pet', id));
  if (kind !== 'character') return null;
  const type = id.startsWith(PLAYER_AVATAR_SKIN_PREFIX) ? 'playerAvatar' : 'character';
  const name = type === 'playerAvatar' ? id.slice(PLAYER_AVATAR_SKIN_PREFIX.length) : id;
  return packedPng(appStore.assetRow(type, name));
}

/** A gallery skin (char_N or a user-added one) or a player's own avatar (pa:<user>). */
function characterSource(id: string): ArtSource | null {
  let data: Record<string, unknown> | undefined;
  if (id.startsWith(PLAYER_AVATAR_SKIN_PREFIX)) {
    // The row AS STORED, not unpacked: the URL's `v` comes from the same row (SimRoom announces
    // it from `avatarData`), and hashing one shape here and the other there would make the two
    // disagree — a 304 that never matches, or a cache key that changes without the art doing so.
    // It also saves decoding a sheet for a request that only needs to hash and stream it.
    data = appStore.assetRow('playerAvatar', id.slice(PLAYER_AVATAR_SKIN_PREFIX.length)) as
      | Record<string, unknown>
      | undefined;
  } else {
    const chars = (getMergedBundle().raw as { characters?: CharEntry[] }).characters ?? [];
    data = chars.find((c) => c.id === id)?.data as Record<string, unknown> | undefined;
  }
  if (!data) return null;
  const frame =
    (data.spec as { frame?: { w?: number; h?: number } } | undefined)?.frame ??
    (data.frame as { w?: number; h?: number } | undefined);
  // Art that is already an image is served as it lies — a bundled sheet (the file on disk) or a
  // stored row (base64 in the database). Neither is decoded to answer a GET.
  const bytes = artBytes(data);
  if (bytes) return { entry: data, png: bytes };
  if (!Array.isArray(data.down)) return null;
  return {
    entry: data,
    sprites: data as unknown as Record<string, string[][][]>,
    // Exactly the rows the art has — an empty row would draw an invisible character in
    // that direction (see rowsPresent).
    dirs: rowsPresent(data, CHARACTER_DIRECTIONS),
    frameW: frame?.w ?? CHAR_FRAME_W,
    frameH: frame?.h ?? CHAR_FRAME_H,
  };
}

function sourceFor(kind: string, id: string): ArtSource | null {
  return kind === 'pet' ? petSource(id) : kind === 'character' ? characterSource(id) : null;
}

/** Encoded sheets by `kind/id/hash`. Bounded: the roster is small and an entry is
 *  a few KB, but a long-running server sees a new hash on every avatar edit. */
const cache = new Map<string, Buffer>();
const MAX_CACHED = 256;

export function registerArtApi(app: Express): void {
  app.get('/art/:kind/:id', (req: Request, res: Response) => {
    const kind = String(req.params.kind);
    const id = String(req.params.id);
    const src = sourceFor(kind, id);
    if (!src) return void res.status(404).json({ error: 'not found' });

    const etag = `"${artHash(src.entry)}"`;
    if (req.headers['if-none-match'] === etag) return void res.status(304).end();

    const key = `${kind}/${id}/${etag}`;
    // A row that is stored as a PNG is served as it lies — the encode below is for
    // bundled art (files decoded at boot) and for rows an older world never repacked.
    let png = storedPng(kind, id) ?? src.png ?? cache.get(key);
    if (!png) {
      if (!src.sprites || !src.dirs) return void res.status(404).json({ error: 'not found' });
      png = encodeDirectionalSheet(src.sprites, src.dirs, src.frameW ?? CHAR_FRAME_W, src.frameH ?? CHAR_FRAME_H, src.cols);
      if (cache.size >= MAX_CACHED) cache.clear(); // simplest bound that cannot leak
      cache.set(key, png);
    }
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('ETag', etag);
    // The URL carries the content hash, so a hit is immutable by construction. A
    // request without `v` (hand-typed) still validates via ETag.
    res.setHeader('Cache-Control', req.query.v ? 'private, max-age=31536000, immutable' : 'private, no-cache');
    res.end(png);
  });
}
