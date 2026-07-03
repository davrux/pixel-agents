/**
 * Voxel client networking — connects the voxel page to the authoritative
 * VoxelRoom. For now it carries the per-user settings sync (load on join, save
 * on change); chunk streaming + edits + player rendering are wired here later.
 * Reuses the office net helpers for the endpoint, desktop bearer token, auth-
 * error → login redirect. If the server is unreachable (offline dev), returns
 * null and the caller keeps its local (localStorage) settings.
 */
import { Client, type Room } from 'colyseus.js';
import { VOXEL_ROOM, unpackChunk, type UnpackedChunk } from '@pixel/shared';

import { getServerHttpOrigin, isAuthError, redirectToLogin } from '../net/room';
import { isDesktop, desktop } from '../desktop/bridge';

export interface EditMsg {
  x: number;
  y: number;
  z: number;
  id: number;
}

export interface VoxelNet {
  room: Room;
  sessionId: string;
  saveSettings(obj: unknown): void;
  sendEdit(x: number, y: number, z: number, id: number): void;
  sendMove(x: number, y: number, z: number, yaw: number, pitch: number, state: string): void;
  setPortal(x: number, y: number, z: number, dest: unknown): void;
  sendTeleport(x: number, z: number): void;
  sendAttack(npc: string): void;
  sendArmor(defense: number): void;
  setPeaceful(on: boolean): void;
  setCreative(on: boolean): void;
  craft(i: number): void;
  smelt(i: number): void;
  use(x: number, y: number, z: number): void;
  chestMove(x: number, y: number, z: number, id: number, dir: 'take' | 'put'): void;
  leave(): Promise<void>;
}

export interface VoxelHandlers {
  onWelcome?: (m: unknown) => void;
  onSettings?: (s: unknown) => void;
  onChunk?: (c: UnpackedChunk) => void;
  onUnload?: (cx: number, cy: number, cz: number) => void;
  onEdit?: (e: EditMsg) => void;
  onPortal?: (dest: unknown) => void;
  onWorlds?: (list: unknown) => void;
  onTeleport?: (m: { x: number; y: number; z: number }) => void;
  onPickup?: (m: { block: number; count: number; total: number }) => void;
  onInv?: (m: { block: number; total: number }) => void;
  onInvAll?: (items: Record<string, number>) => void;
  onChestOpen?: (m: { x: number; y: number; z: number; items: Record<string, number> }) => void;
}

export interface JoinOpts {
  skin?: string;
  seed?: number; // only used when this join CREATES the world
}

export async function connectVoxel(world: string, handlers: VoxelHandlers, opts: JoinOpts = {}): Promise<VoxelNet | null> {
  const client = new Client(getServerHttpOrigin().replace(/^http/, 'ws'));
  // Desktop attaches the bearer session; browser uses the same-origin cookie.
  if (isDesktop()) {
    const token = await desktop().getToken();
    if (token) client.auth.token = token;
  }
  let room: Room;
  try {
    room = await client.joinOrCreate(VOXEL_ROOM, { world, skin: opts.skin, seed: opts.seed });
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
  room.onMessage('c', (bytes: ArrayBuffer | Uint8Array) => handlers.onChunk?.(unpackChunk(bytes)));
  room.onMessage('u', (m: { cx: number; cy: number; cz: number }) => handlers.onUnload?.(m.cx, m.cy, m.cz));
  room.onMessage('edit', (m: EditMsg) => handlers.onEdit?.(m));
  room.onMessage('portal', (dest: unknown) => handlers.onPortal?.(dest));
  room.onMessage('worlds', (list: unknown) => handlers.onWorlds?.(list));
  room.onMessage('tp', (m: { x: number; y: number; z: number }) => handlers.onTeleport?.(m));
  room.onMessage('pickup', (m: { block: number; count: number; total: number }) => handlers.onPickup?.(m));
  room.onMessage('inv', (m: { block: number; total: number }) => handlers.onInv?.(m));
  room.onMessage('invAll', (items: Record<string, number>) => handlers.onInvAll?.(items));
  room.onMessage('chestOpen', (m: { x: number; y: number; z: number; items: Record<string, number> }) => handlers.onChestOpen?.(m));
  return {
    room,
    sessionId: room.sessionId,
    saveSettings: (obj: unknown) => room.send('saveSettings', obj),
    sendEdit: (x, y, z, id) => room.send('edit', { x, y, z, id }),
    sendMove: (x, y, z, yaw, pitch, state) => room.send('move', { x, y, z, yaw, pitch, state }),
    setPortal: (x, y, z, dest) => room.send('setPortal', { x, y, z, dest }),
    sendTeleport: (x, z) => room.send('teleport', { x, z }),
    sendAttack: (npc) => room.send('attack', { npc }),
    sendArmor: (defense) => room.send('setArmor', { defense }),
    setPeaceful: (on) => room.send('setPeaceful', { on }),
    setCreative: (on) => room.send('setCreative', { on }),
    craft: (i) => room.send('craft', { i }),
    smelt: (i) => room.send('smelt', { i }),
    use: (x, y, z) => room.send('use', { x, y, z }),
    chestMove: (x, y, z, id, dir) => room.send('chestMove', { x, y, z, id, dir }),
    leave: async () => {
      await room.leave();
    },
  };
}
