/**
 * The effect sheets — art that belongs to the world but to no pawn.
 *
 * There is one today, the scuffle cloud. It needs no message on the wire: the ids are constants of
 * the build (`shared/office/effects.ts`), so the client simply fetches each one during its loading
 * phase and registers it in the same sheet store the character and pet art goes through — one
 * atlas, one code path, no texture of its own (AGENTS.md § Conventions).
 *
 * A failure here is deliberately not fatal. Without the cloud the renderer draws the two animals
 * standing still, which is what the world looked like before this existed — worse than the effect,
 * far better than a hole where two pets should be.
 */
import { EFFECT_SHEETS } from '@pixel/shared/office/effects.js';

import { fetchSheetBitmap } from './sheet.js';
import { registerSheet } from './sheetStore.js';

/** The sheet-store key for an effect id. Prefixed so it can never collide with `dog_0`. */
export function effectSheetId(id: string): string {
  return `fx:${id}`;
}

/** Fetch and register every effect sheet. Returns how many arrived. */
export async function loadEffectSheets(): Promise<number> {
  let loaded = 0;
  await Promise.all(
    EFFECT_SHEETS.map(async (sheet) => {
      try {
        // A path, not a full URL: serverFetch inside fetchSheetBitmap resolves it against the
        // server, which is what makes this work from the desktop app's `app://` origin too.
        const bitmap = await fetchSheetBitmap(`/art/effect/${sheet.id}`);
        registerSheet(effectSheetId(sheet.id), bitmap, sheet.frameW, sheet.frameH);
        loaded++;
      } catch (err) {
        console.warn(`[effects] could not load ${sheet.id}:`, err instanceof Error ? err.message : err);
      }
    }),
  );
  return loaded;
}
