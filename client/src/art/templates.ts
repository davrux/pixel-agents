/**
 * Templates WITH pixels, for the surfaces that need them: the character editor and the
 * thumbnails in the menus.
 *
 * The sprite store holds only metadata now — name, spec, NPC config — because the art is
 * a PNG the renderer draws cells of (see sheetStore.ts). Everything that paints or
 * previews pixels goes through here, which keeps "who still needs pixels" to a list one
 * can read: the editor, a gallery thumbnail, the avatar preview. Nothing on the drawing
 * path.
 */
import {
  getCharacterTemplates,
  getNpcRoster,
  type CharacterTemplate,
  type LoadedCharacterData,
} from '@pixel/shared/office/sprites/spriteData.js';
import type { SpriteData } from '@pixel/shared/office/types.js';

import { Direction } from '@pixel/shared/office/types.js';

import { sheetCellPixels, sheetTemplate } from './sheetStore';

/** One template's metadata plus the pixels of its sheet, or null when no art arrived. */
export function templateWithArt(id: string, meta: LoadedCharacterData | undefined): LoadedCharacterData | null {
  const rows = sheetTemplate(id);
  if (!rows) return meta && Array.isArray(meta.down) ? meta : null;
  return { ...(meta ?? ({} as LoadedCharacterData)), ...rows };
}

/** The gallery: every skin the editor can open, with pixels. */
export function characterTemplatesWithArt(): CharacterTemplate[] {
  return (getCharacterTemplates() ?? [])
    .map((c) => ({ id: c.id, data: templateWithArt(c.id, c.data) }))
    .filter((c): c is CharacterTemplate => c.data !== null);
}

/** The NPC roster, with pixels — same shape the editor's category expects. */
export function npcRosterWithArt(): Array<{ kind: string; variant: number; data: LoadedCharacterData }> {
  const out: Array<{ kind: string; variant: number; data: LoadedCharacterData }> = [];
  for (const r of getNpcRoster()) {
    const data = templateWithArt(`${r.kind}_${r.variant}`, r.data);
    if (data) out.push({ kind: r.kind, variant: r.variant, data });
  }
  return out;
}

/** The frame a thumbnail shows: the neutral standing pose, facing the camera. */
export function thumbFrame(id: string): SpriteData | undefined {
  return sheetCellPixels(id, Direction.DOWN, 1) ?? sheetCellPixels(id, Direction.DOWN, 0) ?? undefined;
}
