/**
 * The four Tiled properties (`<prefix>Kind`/`Video`/`Url`/`Pose`) an Action
 * round-trips through — shared by mapBridge.ts (FurnitureObject/ActionArea
 * instances, tile actions) and tiledFurniture.ts (FurnitureTile catalog
 * definitions, e.g. the coffee machine's own default action), so a
 * FurnitureTile's action and a placed instance's override use exactly the
 * same four fields and the same parsing.
 */
import type { Action, ApplianceKind } from '@pixel/shared/office/types.js';

export type TiledProp = { name: string; type: string; value: string | number | boolean; propertytype?: string };
export type PropBag = Record<string, string | number | boolean>;

export function prop(name: string, value: string | number | boolean, propertyType?: string): TiledProp {
  const type = typeof value === 'boolean' ? 'bool' : typeof value === 'number' ? 'int' : 'string';
  return propertyType ? { name, type, value, propertytype: propertyType } : { name, type, value };
}

/** Always emits all four action-related properties (kind/video/url/pose),
 *  even when empty/inapplicable for this action's kind — so opening the
 *  .tsj/.tmj in Tiled shows every settable field up front instead of only
 *  whichever ones happened to be set on the item being exported (there's no
 *  other way to discover "oh, I can set actionUrl here" from the file).
 *  `actionKind`/`actionPose` carry `propertytype` so Tiled shows them as
 *  dropdowns (see Pixels.tiled-project's ActionKind/ApplianceKind enums) —
 *  Tiled reads this per-property, independent of the object's own class. */
export function actionProps(action: Action | null, prefix = 'action'): TiledProp[] {
  return [
    prop(`${prefix}Kind`, action?.kind ?? '', 'ActionKind'),
    prop(`${prefix}Video`, action?.kind === 'meetingRoom' ? action.video : false),
    prop(`${prefix}Url`, action?.kind === 'iframe' ? action.url : ''),
    prop(`${prefix}Pose`, action?.kind === 'appliance' ? action.pose : '', 'ApplianceKind'),
  ];
}

export function actionFromProps(props: PropBag, prefix = 'action'): Action | null {
  const kind = props[`${prefix}Kind`];
  if (typeof kind !== 'string') return null;
  switch (kind) {
    case 'meetingRoom':
      return { kind, video: props[`${prefix}Video`] === true };
    case 'linkManager':
    case 'arcade':
    case 'portal':
    case 'toggle':
      return { kind };
    case 'iframe':
      return { kind, url: typeof props[`${prefix}Url`] === 'string' ? (props[`${prefix}Url`] as string) : '' };
    case 'appliance':
      return { kind, pose: (typeof props[`${prefix}Pose`] === 'string' ? props[`${prefix}Pose`] : 'coffee') as ApplianceKind };
    default:
      return null;
  }
}

/** Deep-equal for Action — used to group tileActions into same-value blocks
 *  for export (see mapBridge.ts's Actions export block). `kind` alone isn't
 *  enough: two 'meetingRoom' tiles with different `video` are NOT the same
 *  action and must not merge into one exported shape. */
export function actionsEqual(a: Action | null, b: Action | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'meetingRoom':
      return b.kind === 'meetingRoom' && a.video === b.video;
    case 'iframe':
      return b.kind === 'iframe' && a.url === b.url;
    case 'appliance':
      return b.kind === 'appliance' && a.pose === b.pose;
    default:
      return true; // linkManager/arcade/portal/toggle carry no other fields
  }
}
