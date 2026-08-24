/**
 * The Tiled properties an Action is read from (`<prefix>Kind`/`Video`/`Url`/
 * `Pose`, plus `meetingRoomName`) — shared by mapBridge.ts
 * (FurnitureObject/ActionArea instances, tile actions) and tiledFurniture.ts
 * (FurnitureTile catalog definitions, e.g. the coffee machine's own default
 * action), so a FurnitureTile's action and a placed instance's override use
 * exactly the same fields and the same parsing.
 *
 * The write side is gone with the exporter (see mapBridge.ts): a .tmj is only
 * ever read now, so there is nothing to emit and nothing to compare for
 * equality.
 */
import type { Action, ApplianceKind } from '@pixel/shared/office/types.js';
import { cleanName, MAX_NAME_LEN } from '@pixel/shared';

export type TiledProp = { name: string; type: string; value: string | number | boolean; propertytype?: string };
export type PropBag = Record<string, string | number | boolean>;

export function actionFromProps(props: PropBag, prefix = 'action'): Action | null {
  const kind = props[`${prefix}Kind`];
  if (typeof kind !== 'string') return null;
  switch (kind) {
    case 'meetingRoom': {
      // Named for the action kind that owns it, like actionKind/Video/Url/Pose
      // beside it — it is not `roomName`, because "room" alone is ambiguous in
      // this codebase (LiveKit rooms, Colyseus rooms, Matrix rooms) and a Tiled
      // object's own `name` field is already spoken for by furniture instance
      // names. Trimmed/capped on the way in as well as server-side, so a
      // hand-edited map can't smuggle a 4 KB title onto a call window.
      const meetingRoomName = cleanName(props.meetingRoomName, MAX_NAME_LEN);
      return { kind, video: props[`${prefix}Video`] === true, ...(meetingRoomName ? { meetingRoomName } : {}) };
    }
    case 'meetingManager':
    case 'arcade':
    case 'timeClock':
    case 'portal':
    case 'toggle':
    case 'spawnPoint':
    // A talking object says the hour, and quotes, by itself and takes no
    // configuration — see Action. It sits with the payload-less kinds because
    // the map has nothing to state about it, not because it behaves like them.
    case 'talkingObject':
      return { kind };
    case 'iframe':
      return { kind, url: typeof props[`${prefix}Url`] === 'string' ? (props[`${prefix}Url`] as string) : '' };
    case 'appliance':
      return { kind, pose: (typeof props[`${prefix}Pose`] === 'string' ? props[`${prefix}Pose`] : 'coffee') as ApplianceKind };
    default:
      return null;
  }
}

