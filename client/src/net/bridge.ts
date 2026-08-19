import type { OfficeState } from '@pixel/shared/office/engine/index.js';
import type { OfficeLayout } from '@pixel/shared/office/types.js';
import { setProviderCapabilities } from '@pixel/shared/office/toolUtils.js';
import {
  setCharacterTemplates,
  setPetTemplates,
  upsertCharacterTemplate,
  removeCharacterTemplate,
  type LoadedCharacterData,
} from '@pixel/shared/office/sprites/spriteData.js';
import { setImageAssets } from '@pixel/shared/office/imageAssets.js';
import { buildDynamicCatalog, onSpriteRefs } from '@pixel/shared/office/layout/furnitureCatalog.js';
import { setSpriteRefs } from '../render/sprites.js';
import { fetchSheet } from '../art/sheet';

/** Fallback frame size for a sheet whose entry names no spec (the historical
 *  16×32 character; pets always carry one). */
const CHAR_FRAME_W = 16;
const CHAR_FRAME_H = 32;

type Msg = Record<string, any>;

/**
 * Handles the server's asset/layout "m" messages so the client can render:
 * sprite templates, furniture catalog and the office layout. Floor/wall
 * tiles are NOT among these — they're pre-baked, closed-palette sheets
 * fetched once via plain HTTP (see net/tiledSheets.ts), not a Colyseus
 * message. Agent/pet/furniture *state* no longer arrives here either — it is
 * synced authoritatively via the Colyseus schema (see OfficeScene).
 */
// The catalog hands over the id → image+rect table as it arrives; the renderer is
// what needs it. Wired once here rather than passed through every call site.
onSpriteRefs((refs) => setSpriteRefs(refs));


/**
 * Fill in an entry's pixels when the server sent a URL instead of them.
 *
 * The entry keeps its shape — name, spec and NPC config travel in the message, because
 * a sheet is not decodable without the spec (columns per track vary) and those few
 * bytes are not what made the message big. Only `down/up/right/left` come from the PNG.
 *
 * A fetch that fails leaves the entry as it arrived rather than dropping it: without
 * pixels the renderer falls back to its empty-sprite placeholder, which is a visible
 * gap rather than a character that silently ceases to exist.
 */
async function withPixels<T extends Record<string, any>>(entry: T): Promise<T> {
  const url = entry?.url as string | undefined;
  if (!url) return entry;
  // The server states the frame size (artFrame); an entry's own spec is the fallback
  // for a server that predates it, and 16×32 the last resort.
  const frame = (entry.artFrame ?? (entry.spec as { frame?: unknown } | undefined)?.frame) as
    | { w?: number; h?: number }
    | undefined;
  try {
    const dirs = await fetchSheet(url, frame?.w ?? CHAR_FRAME_W, frame?.h ?? CHAR_FRAME_H);
    return { ...entry, ...dirs };
  } catch (err) {
    console.warn('[bridge] could not load art', url, err instanceof Error ? err.message : err);
    return entry;
  }
}

/** Same, for a list of entries — one round of fetches, in parallel. */
const allWithPixels = <T extends Record<string, any>>(list: T[] | undefined): Promise<T[]> =>
  Promise.all((list ?? []).map(withPixels));

export function createAssetBridge(
  os: OfficeState,
  onLayout: (layout: OfficeLayout) => void,
): (msg: Msg) => void | Promise<void> {
  // Owned avatars (pa:<user>) of the players in the current zone, kept so they
  // can be re-applied after a gallery reload (setCharacterTemplates rebuilds the
  // skin store from the gallery alone, which would otherwise drop them).
  const avatars = new Map<string, LoadedCharacterData>();
  return function apply(msg: Msg): void | Promise<void> {
    switch (msg.type) {
      case 'providerCapabilities':
        setProviderCapabilities({ readingTools: msg.readingTools, subagentToolNames: msg.subagentToolNames });
        break;
      case 'characterSpritesLoaded':
        // Art arrives as PNG URLs (see server/src/artApi.ts), so this is the one
        // asset message that has to wait for a fetch before the store is right.
        return (async () => {
          const list = await Promise.all(
            (msg.characters as Array<{ id: string; data: Record<string, any> }>).map(async (c) => ({
              id: c.id,
              data: await withPixels(c.data ?? {}),
            })),
          );
          setCharacterTemplates(list as never);
          // Re-apply zone avatars on top of the refreshed gallery.
          for (const [id, data] of avatars) upsertCharacterTemplate(id, data);
        })();
      case 'playerAvatar':
        return (async () => {
          // With a url the message IS the entry (url + name/spec/npc); without one it
          // carries the pixels in `data`, as it always did.
          const { type: _t, id: _i, data: legacy, ...entry } = msg;
          const data = (await withPixels(msg.url ? entry : legacy)) as LoadedCharacterData;
          avatars.set(msg.id, data);
          upsertCharacterTemplate(msg.id, data);
        })();
      case 'playerAvatarGone':
        avatars.delete(msg.id);
        removeCharacterTemplate(msg.id);
        break;
      case 'petSpritesLoaded':
        return (async () => {
          const [dogs, cats, ducks] = await Promise.all([
            allWithPixels(msg.dogs),
            allWithPixels(msg.cats),
            allWithPixels(msg.ducks),
          ]);
          setPetTemplates(dogs as never, cats as never, ducks as never);
        })();
      case 'imagesLoaded':
        setImageAssets(msg.images ?? []);
        break;
      case 'furnitureAssetsLoaded':
        // `spriteRefs` says which image and rect each id is drawn from; `sprites`
        // carries pixels only for ids no image covers. Both are optional, so an
        // older server (pixels only) and a newer one (refs) both work.
        buildDynamicCatalog({ catalog: msg.catalog, sprites: msg.sprites, spriteRefs: msg.spriteRefs });
        break;
      case 'layoutLoaded': {
        const raw = msg.layout as OfficeLayout | null;
        // Version 2 only, and deliberately not "1 or 2": a v1 ground cell holds a
        // floor pattern where a v2 cell holds a tile id, so accepting both would
        // draw one as the other. The server migrates before sending, and refuses
        // to when it cannot (see ZoneMapStore.get) — in that case nothing is drawn
        // and the reason is on the server's console, which beats a wrong map.
        const layout = raw && raw.version === 2 ? raw : null;
        if (layout) {
          os.rebuildFromLayout(layout);
          onLayout(os.getLayout());
        } else if (raw) {
          console.error(`[bridge] ignoring a layout of version ${raw.version} — this client draws version 2`);
        }
        break;
      }
    }
  };
}
