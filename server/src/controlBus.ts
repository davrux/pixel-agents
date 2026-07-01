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
