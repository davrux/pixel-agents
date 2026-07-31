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
