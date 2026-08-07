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
import { setFloorSprites } from '@pixel/shared/office/floorTiles.js';
import { setWallSprites } from '@pixel/shared/office/wallTiles.js';
import { buildDynamicCatalog } from '@pixel/shared/office/layout/furnitureCatalog.js';
import { migrateLayoutColors } from '@pixel/shared/office/layout/layoutSerializer.js';

type Msg = Record<string, any>;

/**
 * Handles the server's asset/layout "m" messages so the client can render:
 * sprite templates, floor/wall tiles, furniture catalog and the office layout.
 * Agent/pet/furniture *state* no longer arrives here — it is synced
 * authoritatively via the Colyseus schema (see OfficeScene).
 */
export function createAssetBridge(
  os: OfficeState,
  onLayout: (layout: OfficeLayout, activeLayout: string) => void,
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
      case 'floorTilesLoaded':
        setFloorSprites(msg.sprites);
        break;
      case 'wallTilesLoaded':
        setWallSprites(msg.sets);
        break;
      case 'furnitureAssetsLoaded':
        buildDynamicCatalog({ catalog: msg.catalog, sprites: msg.sprites });
        break;
      case 'layoutLoaded': {
        const raw = msg.layout as OfficeLayout | null;
        const layout = raw && raw.version === 1 ? migrateLayoutColors(raw) : null;
        if (layout) {
          os.rebuildFromLayout(layout);
          onLayout(os.getLayout(), typeof msg.activeLayout === 'string' ? msg.activeLayout : 'Default');
        }
        break;
      }
    }
  };
}
