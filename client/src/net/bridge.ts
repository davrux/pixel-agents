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
import { buildDynamicCatalog } from '@pixel/shared/office/layout/furnitureCatalog.js';

type Msg = Record<string, any>;

/**
 * Handles the server's asset/layout "m" messages so the client can render:
 * sprite templates, furniture catalog and the office layout. Floor/wall
 * tiles are NOT among these — they're pre-baked, closed-palette sheets
 * fetched once via plain HTTP (see net/tiledSheets.ts), not a Colyseus
 * message. Agent/pet/furniture *state* no longer arrives here either — it is
 * synced authoritatively via the Colyseus schema (see OfficeScene).
 */
export function createAssetBridge(
  os: OfficeState,
  onLayout: (layout: OfficeLayout) => void,
): (msg: Msg) => void {
  // Owned avatars (pa:<user>) of the players in the current zone, kept so they
  // can be re-applied after a gallery reload (setCharacterTemplates rebuilds the
  // skin store from the gallery alone, which would otherwise drop them).
  const avatars = new Map<string, LoadedCharacterData>();
  return function apply(msg: Msg): void {
    switch (msg.type) {
      case 'providerCapabilities':
        setProviderCapabilities({ readingTools: msg.readingTools, subagentToolNames: msg.subagentToolNames });
        break;
      case 'characterSpritesLoaded':
        setCharacterTemplates(msg.characters);
        // Re-apply zone avatars on top of the refreshed gallery.
        for (const [id, data] of avatars) upsertCharacterTemplate(id, data);
        break;
      case 'playerAvatar':
        avatars.set(msg.id, msg.data);
        upsertCharacterTemplate(msg.id, msg.data);
        break;
      case 'playerAvatarGone':
        avatars.delete(msg.id);
        removeCharacterTemplate(msg.id);
        break;
      case 'petSpritesLoaded':
        setPetTemplates(msg.dogs ?? [], msg.cats ?? [], msg.ducks ?? []);
        break;
      case 'imagesLoaded':
        setImageAssets(msg.images ?? []);
        break;
      case 'furnitureAssetsLoaded':
        buildDynamicCatalog({ catalog: msg.catalog, sprites: msg.sprites });
        break;
      case 'layoutLoaded': {
        const raw = msg.layout as OfficeLayout | null;
        const layout = raw && raw.version === 1 ? raw : null;
        if (layout) {
          os.rebuildFromLayout(layout);
          onLayout(os.getLayout());
        }
        break;
      }
    }
  };
}
