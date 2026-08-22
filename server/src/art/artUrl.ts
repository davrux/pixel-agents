/**
 * Addressing art: the hash, the URL, and turning an entry's pixels into a link.
 *
 * Deliberately pure — no bundle, no store, no imports that read the world. The route
 * that SERVES the art needs both (see ../artApi.ts), but the entry-rewriting half runs
 * INSIDE the bundle build, and asking the bundle for anything from there recurses:
 * buildMerged → withArtUrl → getMergedBundle → buildMerged, which is a stack overflow
 * on the first join and how this file came to exist.
 */
import { createHash } from 'node:crypto';

/**
 * The direction rows, which is what the encoder draws from. Named here so the hash and any
 * future reader agree on it, and so the four names live in one place.
 */
const ART_ROWS = ['down', 'up', 'right', 'left'] as const;

/**
 * Content hash of the ART in an entry — the URL's `v` and the route's ETag, so changed art
 * is a changed URL and unchanged art revalidates to a 304.
 *
 * It takes a whole entry and picks out what the served PNG is actually made of: the four
 * direction rows, plus the frame size `encodeDirectionalSheet` lays them out with. It used
 * to hash the entry as it stood, and naming the bundled roster showed what that costs — every
 * skin's and pet's URL and ETag changed while the images stayed byte-identical, because a
 * label was part of the hash. Hashing the rows ALONE would be wrong the other way round: the
 * encoder is handed the frame size, so an entry whose spec changed is a different image even
 * with the same pixels. Everything else an entry carries — name, NPC config — never reaches
 * the encoder, so it must not reach this.
 */
export function artHash(entry: unknown): string {
  const d = entry as Record<string, unknown> | null | undefined;
  const art = d
    ? {
        ...Object.fromEntries(ART_ROWS.map((row) => [row, d[row] ?? null])),
        frame: (d.spec as { frame?: unknown } | undefined)?.frame ?? null,
      }
    : null;
  return createHash('sha1').update(JSON.stringify(art)).digest('hex').slice(0, 12);
}

/** The URL for one piece of art, or null when there is nothing to serve. */
export function artUrl(kind: 'character' | 'pet', id: string, entry: unknown): string | null {
  if (!entry) return null;
  return `/art/${kind}/${encodeURIComponent(id)}?v=${artHash(entry)}`;
}

/**
 * The same entry with its pixels replaced by a URL to fetch them as PNG.
 *
 * Name, spec and NPC config stay in the message: they are a few dozen bytes and a sheet
 * is not decodable without the spec (columns per track vary). Only the pixel arrays
 * move — that is the 24× (measured: 831 KB of a 1527 KB join).
 *
 * `fallbackFrame` is the frame size for an entry that carries no spec of its own, which
 * every BUNDLED pet sheet is: without it the client would slice a 16×16 pet on the
 * character default of 16×32. The caller knows which kind it is holding, so it says.
 *
 * An entry whose art cannot be addressed (no pixels at all) is passed through untouched,
 * so a broken row still renders as whatever it was.
 */
export function withArtUrl(
  kind: 'character' | 'pet',
  id: string,
  data: unknown,
  fallbackFrame: { w: number; h: number },
): unknown {
  const d = data as Record<string, unknown> | null;
  const url = artUrl(kind, id, d && d.down ? d : null);
  if (!url) return data;
  const { down: _d, up: _u, right: _r, left: _l, ...meta } = d as Record<string, unknown>;
  const frame = (d?.spec as { frame?: { w?: number; h?: number } } | undefined)?.frame;
  return { ...meta, url, artFrame: { w: frame?.w ?? fallbackFrame.w, h: frame?.h ?? fallbackFrame.h } };
}
