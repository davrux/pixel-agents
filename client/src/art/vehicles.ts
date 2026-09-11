/**
 * The vehicle sheets — a kart's art, fetched the way the effect sheets are.
 *
 * The id is a constant of the build (`shared/office/race/kartArt.ts`), so nothing about this
 * travels on the wire: the client fetches `/art/vehicle/<id>` during its loading phase and
 * registers the strip in the same sheet store the character and pet art goes through, which is
 * what puts it in the shared atlas instead of giving it a texture of its own.
 *
 * A failure is deliberately not fatal: without the sheet the renderer draws the driver walking
 * along at the kart's position, which is wrong-looking but still shows where everybody is.
 */
import { VEHICLE_SHEETS } from '@pixel/shared/office/race/kartArt.js';

import { fetchSheetBitmap } from './sheet.js';
import { registerSheet } from './sheetStore.js';

/** The sheet-store key for a vehicle id. Prefixed so it can never collide with `dog_0` or `fx:…`. */
export function vehicleSheetId(id: string): string {
  return `veh:${id}`;
}

/** Fetch and register every vehicle sheet. Returns how many arrived. */
export async function loadVehicleSheets(): Promise<number> {
  let loaded = 0;
  await Promise.all(
    VEHICLE_SHEETS.map(async (sheet) => {
      try {
        // A path, not a full URL: serverFetch inside fetchSheetBitmap resolves it against the
        // server, which is what makes this work from the desktop app's `app://` origin too.
        const bitmap = await fetchSheetBitmap(`/art/vehicle/${sheet.id}`);
        registerSheet(vehicleSheetId(sheet.id), bitmap, sheet.frameW, sheet.frameH);
        loaded++;
      } catch (err) {
        console.warn(`[vehicles] could not load ${sheet.id}:`, err instanceof Error ? err.message : err);
      }
    }),
  );
  return loaded;
}
