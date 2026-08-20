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
import { buildDynamicCatalog, onSpriteRefs } from '@pixel/shared/office/layout/furnitureCatalog.js';
import { setSpriteRefs } from '../render/sprites.js';
import { fetchSheetBitmap } from '../art/sheet';
import { forgetSheet, registerSheet } from '../art/sheetStore';

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
 * Register an entry's sheet as an IMAGE, and keep only its metadata in the sprite store.
 *
 * The renderer draws cells of the sheet out of the atlas (art/sheetStore.ts), so nothing
 * here decodes pixels any more — that decode was the last place hex strings existed
 * outside the editor. An entry keeps its name, spec and NPC config, because a sheet
 * cannot carry them and a pose cannot be resolved to a column without the spec.
 *
 * A fetch that fails leaves the entry without art: the renderer then skips that
 * character rather than drawing a wrong frame, and the console says which URL failed.
 */
async function withSheet<T extends Record<string, any>>(id: string, entry: T): Promise<T> {
  const url = entry?.url as string | undefined;
  if (!url) return entry;
  const frame = (entry.artFrame ?? (entry.spec as { frame?: unknown } | undefined)?.frame) as
    | { w?: number; h?: number }
    | undefined;
  try {
    const bitmap = await fetchSheetBitmap(url);
    registerSheet(id, bitmap, frame?.w ?? CHAR_FRAME_W, frame?.h ?? CHAR_FRAME_H);
  } catch (err) {
    console.warn('[bridge] could not load art', url, err instanceof Error ? err.message : err);
  }
  return entry;
}

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
        // Art arrives as PNG URLs (see server/src/artApi.ts), so this is the one asset
        // message that has to wait for a fetch before the world can draw.
        return (async () => {
          const list = await Promise.all(
            (msg.characters as Array<{ id: string; data: Record<string, any> }>).map(async (c) => ({
              id: c.id,
              data: await withSheet(c.id, c.data ?? {}),
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
          const data = (await withSheet(msg.id, msg.url ? entry : legacy)) as LoadedCharacterData;
          avatars.set(msg.id, data);
          upsertCharacterTemplate(msg.id, data);
        })();
      case 'playerAvatarGone':
        avatars.delete(msg.id);
        removeCharacterTemplate(msg.id);
        forgetSheet(msg.id);
        break;
      case 'petSpritesLoaded':
        return (async () => {
          // Sheet ids are kind + index, the same key the roster and /art use.
          const kind = (name: string, list: unknown[] | undefined) =>
            Promise.all((list ?? []).map((e, i) => withSheet(`${name}_${i}`, e as Record<string, any>)));
          const [dogs, cats, ducks] = await Promise.all([
            kind('dog', msg.dogs),
            kind('cat', msg.cats),
            kind('duck', msg.ducks),
          ]);
          setPetTemplates(dogs as never, cats as never, ducks as never);
        })();
      case 'furnitureAssetsLoaded':
        // `spriteRefs` says which image and rect each id is drawn from; `sprites`
        // carries pixels only for ids no image covers. Both are optional, so an
        // older server (pixels only) and a newer one (refs) both work.
        buildDynamicCatalog({ catalog: msg.catalog, sprites: msg.sprites, spriteRefs: msg.spriteRefs });
        break;
      case 'layoutLoaded': {
        const raw = msg.layout as OfficeLayout | null;
        // Version 3 only, and deliberately not "any of them": a v1 ground cell holds a
        // floor pattern where a v2 cell holds a tile id, and a v3 image placement carries
        // the path to its file where a v2 one carried only an id — accepting an older
        // version would draw one as the other, or draw nothing where a picture belongs.
        // The server migrates before sending and refuses when it cannot (see
        // ZoneMapStore.get); nothing is drawn then, and the reason is on its console.
        const layout = raw && raw.version === 3 ? raw : null;
        if (layout) {
          os.rebuildFromLayout(layout);
          onLayout(os.getLayout());
        } else if (raw) {
          console.error(`[bridge] ignoring a layout of version ${raw.version} — this client draws version 3`);
        }
        break;
      }
    }
  };
}
