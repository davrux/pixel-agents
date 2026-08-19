/**
 * Process-wide control bus for admin actions that must reach a user regardless
 * of which zone (SimRoom) they're in. Every SimRoom subscribes; e.g. `/kick`
 * emits here and whichever room holds that user's client disconnects it.
 */
import { EventEmitter } from 'node:events';

class ControlBus extends EventEmitter {}

export const controlBus = new ControlBus();
// One listener per live SimRoom → uncap to avoid the default max-listeners warning.
controlBus.setMaxListeners(0);

/** Emitted with the target user_id; rooms disconnect that user's clients. */
export const KICK_EVENT = 'kick';

/** A zone owner invites someone into their private zone — same cross-room
 *  reach as /kick, since the invitee may be in a different zone's room
 *  instance. Payload: { targetUserId, fromUserId, fromName, zoneId, zoneLabel }. */
export const ZONE_INVITE_EVENT = 'zoneInvite';

/** The invitee's accept/decline, routed back to the inviter (who may since have
 *  moved to yet another zone). Payload: { toUserId, accepted, byName, zoneLabel }. */
export const ZONE_INVITE_RESULT_EVENT = 'zoneInviteResult';

/** A zone was deleted — emitted with its id. The room instance that actually
 *  hosts that zone (if any; the delete may have been issued from elsewhere)
 *  reroutes every one of its clients to the office, since their zone no
 *  longer exists. */
export const ZONE_DELETED_EVENT = 'zoneDeleted';

/** A shared asset (character/pet/floor/wall/furniture) was saved or reset via
 *  the in-game Assets editor. Assets are global, but each zone's SimRoom
 *  caches its own merged bundle — without this, only the room the edit was
 *  made FROM re-reads the DB; every other already-running zone keeps serving
 *  its stale in-memory catalog until it empties out and recycles. Every
 *  SimRoom re-merges + re-broadcasts on this, regardless of which room (if
 *  any) the edit actually came from. Payload: the AssetType string. */
export const ASSET_CHANGED_EVENT = 'assetChanged';

/** A zone's saved layout changed on disk via Tiled (see
 *  tiled/zonePushApi.ts's push endpoint) rather than through this room's own
 *  save/save-as messages — so unlike those, nothing already told THIS room
 *  to reload. Payload: the zone id. The room hosting that zone (if any is
 *  currently live) rebuilds from the newly active layout and rebroadcasts,
 *  same as after a normal loadLayout; every other room ignores it. */
export const ZONE_LAYOUT_CHANGED_EVENT = 'zoneLayoutChanged';

/** The set of online users changed (someone joined a zone, switched zone or
 *  left). Emitted by presence.ts, which is the only place that knows; every
 *  SimRoom listens and pushes the refreshed roster to its own clients, since
 *  the online list is world-wide and a room only ever sees its own joins. No
 *  payload — a listener reads `presence.list()`. */
export const PRESENCE_EVENT = 'presence';
