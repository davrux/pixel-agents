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
  sendEdit(x: number, y: number, z: number, id: number, tool?: number): void;
  sendMove(x: number, y: number, z: number, yaw: number, pitch: number, state: string): void;
  setPortal(x: number, y: number, z: number, dest: unknown): void;
  sendTeleport(x: number, z: number): void;
  sendAttack(npc: string): void;
  sendArmor(defense: number): void;
  setPeaceful(on: boolean): void;
  setCreative(on: boolean): void;
  setDurability(on: boolean): void;
  setHunger(on: boolean): void;
  setKeepInv(on: boolean): void;
  eat(): void;
  craft(i: number): void;
  smelt(i: number): void;
  use(x: number, y: number, z: number, held?: number): void;
  boatPlace(x: number, y: number, z: number): void;
  boatMount(id: string): void;
  boatSteer(forward: number, turn: number): void;
  boatDismount(): void;
  chestMove(x: number, y: number, z: number, id: number, dir: 'take' | 'put'): void;
  setSign(x: number, y: number, z: number, text: string): void;
  sendChat(text: string): void;
  sendCommand(name: string, args: string): void;
  sendZoneVoiceToken(): void;
  sendVoiceEvent(event: string): void;
  deleteWorld(world: string): void;
  leave(): Promise<void>;
}

export interface ChatMsg {
  type: string; // 'chat' | 'system' | …
  from?: string;
  text?: string;
  at?: number;
}

export interface SignMsg {
  x: number;
  y: number;
  z: number;
  text: string;
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
  onFurnaceOpen?: () => void;
  onDurability?: (m: { tool: number; left: number; max: number }) => void;
  onBoom?: (m: { x: number; y: number; z: number }) => void;
  onSign?: (m: SignMsg) => void;
  onSigns?: (list: SignMsg[]) => void;
  onTime?: (m: { now: number; dayLengthMs: number }) => void;
  onNote?: (m: { text: string }) => void;
  onLeave?: (code: number) => void; // socket dropped (server restart / network) → show offline
  onMsg?: (m: ChatMsg) => void; // chat / system lines (the shared 'm' channel)
  onCrafted?: (m: { block: number; count: number }) => void; // craft/smelt success feedback
}

export interface JoinOpts {
  skin?: string;
  seed?: number; // only used when this join CREATES the world
  size?: number; // square world edge in blocks; only used when this join CREATES the world
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
    room = await client.joinOrCreate(VOXEL_ROOM, { world, skin: opts.skin, seed: opts.seed, size: opts.size });
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
  room.onMessage('furnaceOpen', () => handlers.onFurnaceOpen?.());
  room.onMessage('durability', (m: { tool: number; left: number; max: number }) => handlers.onDurability?.(m));
  room.onMessage('boom', (m: { x: number; y: number; z: number }) => handlers.onBoom?.(m));
  room.onMessage('sign', (m: SignMsg) => handlers.onSign?.(m));
  room.onMessage('signs', (list: SignMsg[]) => handlers.onSigns?.(list));
  room.onMessage('time', (m: { now: number; dayLengthMs: number }) => handlers.onTime?.(m));
  room.onMessage('note', (m: { text: string }) => handlers.onNote?.(m));
  room.onMessage('m', (m: ChatMsg) => handlers.onMsg?.(m));
  room.onMessage('crafted', (m: { block: number; count: number }) => handlers.onCrafted?.(m));
  room.onLeave((code: number) => handlers.onLeave?.(code));
  return {
    room,
    sessionId: room.sessionId,
    saveSettings: (obj: unknown) => room.send('saveSettings', obj),
    sendEdit: (x, y, z, id, tool = 0) => room.send('edit', { x, y, z, id, tool }),
    sendMove: (x, y, z, yaw, pitch, state) => room.send('move', { x, y, z, yaw, pitch, state }),
    setPortal: (x, y, z, dest) => room.send('setPortal', { x, y, z, dest }),
    sendTeleport: (x, z) => room.send('teleport', { x, z }),
    sendAttack: (npc) => room.send('attack', { npc }),
    sendArmor: (defense) => room.send('setArmor', { defense }),
    setPeaceful: (on) => room.send('setPeaceful', { on }),
    setCreative: (on) => room.send('setCreative', { on }),
    setDurability: (on) => room.send('setDurability', { on }),
    setHunger: (on) => room.send('setHunger', { on }),
    setKeepInv: (on) => room.send('setKeepInv', { on }),
    eat: () => room.send('eat', {}),
    craft: (i) => room.send('craft', { i }),
    smelt: (i) => room.send('smelt', { i }),
    use: (x, y, z, held = 0) => room.send('use', { x, y, z, held }),
    boatPlace: (x, y, z) => room.send('boatPlace', { x, y, z }),
    boatMount: (id) => room.send('boatMount', { id }),
    boatSteer: (forward, turn) => room.send('boatSteer', { forward, turn }),
    boatDismount: () => room.send('boatDismount'),
    chestMove: (x, y, z, id, dir) => room.send('chestMove', { x, y, z, id, dir }),
    setSign: (x, y, z, text) => room.send('setSign', { x, y, z, text }),
    sendChat: (text) => room.send('chat', { text }),
    sendCommand: (name, args) => room.send('command', { name, args }),
    sendZoneVoiceToken: () => room.send('zoneVoiceToken'),
    sendVoiceEvent: (event) => room.send('voiceEvent', { event }),
    deleteWorld: (world) => room.send('deleteWorld', { world }),
    leave: async () => {
      await room.leave();
    },
  };
}
