import type { Action } from '@pixel/shared/office/types.js';
import { promptDialog } from '../ui/dialog.js';

/** Grid-overlay colour per tile-action kind (see Action) — 'meetingRoom'
 *  keeps the original teal (video on) so existing meeting areas look mostly
 *  unchanged; audio-only gets its own blue so the two read as visibly
 *  distinct at a glance, not just "the same teal, trust me". */
export const ACTION_TILE_COLOR: Record<Action['kind'], number> = {
  meetingRoom: 0x2ac9c9,
  meetingManager: 0x9b6bd8,
  iframe: 0xd89b3a,
  appliance: 0x6bd89b,
  arcade: 0xd83a6b,
  portal: 0x3ad8a0,
  // Not in TILE_ACTION_CHOICES (see below) — a light-switch isn't something
  // you pick from the generic list, it's implied by an on/off pair's own
  // Trigger setting (FurnitureEditor). Colour defined anyway so this map
  // stays exhaustive over Action['kind'].
  toggle: 0xd8d83a,
  // Also not in TILE_ACTION_CHOICES — a zone has exactly one arrival point,
  // so it's not something you'd pick per-tile from a generic list; only
  // meaningful set directly in Tiled (see Action['spawnPoint']'s own doc).
  spawnPoint: 0xd83aa0,
};
export const MEETING_ROOM_NO_VIDEO_COLOR = 0x3a7fd8;
/** Colour for one specific action, distinguishing meetingRoom's video/no-video
 *  split (both otherwise share 'meetingRoom' in ACTION_TILE_COLOR). */
export function actionTileColor(action: Action): number {
  if (action.kind === 'meetingRoom' && !action.video) return MEETING_ROOM_NO_VIDEO_COLOR;
  return ACTION_TILE_COLOR[action.kind];
}

/** Menu of action kinds pickable wherever an Action is chosen — the
 *  LayoutEditor's tile-tool palette and furniture popup, AND the
 *  FurnitureEditor's catalog-level default (same list everywhere, so a
 *  per-instance override and a catalog default are never out of sync with
 *  what's actually choosable). 'iframe' needs a URL, prompted for when
 *  picked (not per tile/item). `swatch` is the exact colour that kind paints
 *  onto the grid (see actionTileColor) — shown next to the label so a
 *  choice's colour is known before picking it, not just after. */
export const TILE_ACTION_CHOICES: Array<{ label: string; swatch: number; make: () => Action | Promise<Action | null> }> = [
  { label: 'Meeting (video)', swatch: actionTileColor({ kind: 'meetingRoom', video: true }), make: () => ({ kind: 'meetingRoom', video: true }) },
  { label: 'Meeting (audio only)', swatch: actionTileColor({ kind: 'meetingRoom', video: false }), make: () => ({ kind: 'meetingRoom', video: false }) },
  { label: 'AdHoc Meeting Kiosk', swatch: actionTileColor({ kind: 'meetingManager' }), make: () => ({ kind: 'meetingManager' }) },
  {
    label: 'Open link (iframe)',
    swatch: actionTileColor({ kind: 'iframe', url: '' }),
    make: async () => {
      const url = await promptDialog('Page to open (https:// only):', 'https://');
      return url && url.startsWith('https://') ? { kind: 'iframe', url: url.trim() } : null;
    },
  },
  { label: 'Arcade cabinet', swatch: actionTileColor({ kind: 'arcade' }), make: () => ({ kind: 'arcade' }) },
  { label: 'Appliance (coffee)', swatch: actionTileColor({ kind: 'appliance', pose: 'coffee' }), make: () => ({ kind: 'appliance', pose: 'coffee' }) },
  { label: 'Portal (zone travel)', swatch: actionTileColor({ kind: 'portal' }), make: () => ({ kind: 'portal' }) },
];

/** '#rrggbb' for a swatch colour — same numbers drawGrid paints with. */
export function swatchHex(n: number): string {
  return `#${n.toString(16).padStart(6, '0')}`;
}

/** The TILE_ACTION_CHOICES label matching a given Action — used to highlight
 *  "this one is currently active" wherever a choice list is shown, so
 *  picking isn't blind trial and error. */
export function actionChoiceLabel(a: Action): string {
  switch (a.kind) {
    case 'meetingRoom':
      return a.video ? 'Meeting (video)' : 'Meeting (audio only)';
    case 'meetingManager':
      return 'AdHoc Meeting Kiosk';
    case 'iframe':
      return 'Open link (iframe)';
    case 'arcade':
      return 'Arcade cabinet';
    case 'appliance':
      return 'Appliance (coffee)';
    case 'portal':
      return 'Portal (zone travel)';
    case 'toggle':
      return 'Toggle on/off';
    case 'spawnPoint':
      return 'Zone arrival point';
  }
}
