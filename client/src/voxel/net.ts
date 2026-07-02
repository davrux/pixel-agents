/**
 * Voxel client networking — connects the voxel page to the authoritative
 * VoxelRoom. For now it carries the per-user settings sync (load on join, save
 * on change); chunk streaming + edits + player rendering are wired here later.
 * Reuses the office net helpers for the endpoint, desktop bearer token, auth-
 * error → login redirect. If the server is unreachable (offline dev), returns
 * null and the caller keeps its local (localStorage) settings.
 */
import { Client, type Room } from 'colyseus.js';
import { VOXEL_ROOM } from '@pixel/shared';

import { getServerHttpOrigin, isAuthError, redirectToLogin } from '../net/room';
import { isDesktop, desktop } from '../desktop/bridge';

export interface VoxelNet {
  room: Room;
  saveSettings(obj: unknown): void;
}

export interface VoxelHandlers {
  onWelcome?: (m: unknown) => void;
  onSettings?: (s: unknown) => void;
}

export async function connectVoxel(world: string, handlers: VoxelHandlers): Promise<VoxelNet | null> {
  const client = new Client(getServerHttpOrigin().replace(/^http/, 'ws'));
  // Desktop attaches the bearer session; browser uses the same-origin cookie.
  if (isDesktop()) {
    const token = await desktop().getToken();
    if (token) client.auth.token = token;
  }
  let room: Room;
  try {
    room = await client.joinOrCreate(VOXEL_ROOM, { world });
  } catch (err) {
    if (isAuthError(err)) {
      redirectToLogin(); // login required — the server gate serves the form
      return null;
    }
    console.warn('[voxel] offline — keeping local settings:', (err as Error)?.message);
    return null;
  }
  console.info('[voxel] connected to world', world, 'as', room.sessionId);
  if (handlers.onWelcome) room.onMessage('welcome', handlers.onWelcome);
  if (handlers.onSettings) room.onMessage('settings', handlers.onSettings);
  // Chunk/edit/player streams arrive already; ignore them until the client world
  // is chunk-based (keeps colyseus.js from warning about unhandled types).
  room.onMessage('c', () => {});
  room.onMessage('u', () => {});
  room.onMessage('edit', () => {});
  return {
    room,
    saveSettings: (obj: unknown) => room.send('saveSettings', obj),
  };
}
