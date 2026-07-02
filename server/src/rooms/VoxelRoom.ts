/**
 * Authoritative voxel world room (one instance per world id, matchmade by
 * `world`). Reuses the project's account/session auth (cookie + desktop bearer,
 * same store as SimRoom). Responsibilities:
 *  - stream chunks around each player (AOI): send on join + when a player crosses
 *    a chunk boundary; unload chunks that fall out of range;
 *  - validate + apply + persist block edits, then broadcast them to the room;
 *  - keep player transforms in schema state (VoxelPlayerSync) for other clients;
 *  - basic chat (broadcast), reusing the 'm'/'chat' message shape.
 * Chunks go out as binary (client.sendBytes 'c'); everything else is small JSON.
 */
import { Room, type AuthContext, type Client } from '@colyseus/core';

import {
  VOXEL_ROOM,
  VIEW_CHUNKS,
  VIEW_CHUNKS_Y,
  toChunk,
  chunkKey,
  packChunk,
} from '@pixel/shared';
import { VoxelPlayerSync, VoxelRoomState } from '@pixel/shared/schema';

import { hasValidSession, userIdFromCookie, hasValidBearerSession, userIdFromBearer } from '../auth.js';
import { userStore, UserStore } from '../userStore.js';
import { VoxelServerWorld } from '../voxel/world.js';
import { listWorlds } from '../voxel/chunkStore.js';
import { voxelSettings } from '../voxel/settingsStore.js';
import { portals, cleanDest } from '../voxel/portalStore.js';

interface AuthInfo {
  userId: string;
  username: string;
  isAdmin: boolean;
}
interface ClientView {
  sent: Set<string>; // chunk keys already streamed to this client
  cx: number;
  cy: number;
  cz: number; // last chunk the player was in (-9999 = unset)
  px: number;
  py: number;
  pz: number; // last known feet position (for edit reach checks)
  lastMove: number;
  lastEdit: number;
  lastPortalKey: string | null; // portal cell we last fired on (fire only on enter)
}

const REACH = 8; // max edit distance from the player's eye (blocks)
const MOVE_MIN_MS = 40; // ~25 moves/s cap

export class VoxelRoom extends Room<VoxelRoomState> {
  private authRequired = false;
  private world!: VoxelServerWorld;
  private readonly views = new Map<string, ClientView>();

  onAuth(_client: Client, _options: unknown, context: AuthContext): AuthInfo {
    if (!this.authRequired) return { userId: '', username: '', isAdmin: false };
    const cookie = (context?.headers as Record<string, string | undefined> | undefined)?.cookie;
    if (hasValidSession(cookie)) {
      const userId = userIdFromCookie(cookie) ?? '';
      const user = userId ? userStore.get(userId) : undefined;
      if (!user) throw new Error('unauthorized');
      return { userId: user.userId, username: UserStore.displayName(user), isAdmin: user.isAdmin };
    }
    const authHeader = context?.token ? `Bearer ${context.token}` : undefined;
    if (hasValidBearerSession(authHeader)) {
      const userId = userIdFromBearer(authHeader) ?? '';
      const user = userId ? userStore.get(userId) : undefined;
      if (!user) throw new Error('unauthorized');
      return { userId: user.userId, username: UserStore.displayName(user), isAdmin: user.isAdmin };
    }
    throw new Error('unauthorized');
  }

  onCreate(options: { world?: string; authRequired?: boolean; version?: string; seed?: number }): void {
    this.authRequired = options.authRequired ?? false;
    const worldId = (options.world || 'default').slice(0, 40);
    // The creating client may request a seed (used only for a brand-new world).
    this.world = new VoxelServerWorld(worldId, Number.isFinite(options.seed) ? options.seed : undefined);
    this.setState(new VoxelRoomState());
    this.state.worldId = worldId;

    this.onMessage('move', (client, m: { x: number; y: number; z: number; yaw?: number; pitch?: number; state?: string }) =>
      this.onMove(client, m),
    );
    this.onMessage('edit', (client, m: { x: number; y: number; z: number; id: number }) => this.onEdit(client, m));
    this.onMessage('chat', (client, m: { text?: string }) => this.onChat(client, m));
    // Per-user client settings persisted server-side (requires login; anonymous
    // is a no-op). The client owns the shape; we just store/return the blob.
    this.onMessage('saveSettings', (client, obj: unknown) => {
      const uid = (client.auth as AuthInfo | undefined)?.userId;
      if (uid) voxelSettings.set(uid, obj);
    });
    this.onMessage('setSkin', (client, skin: unknown) => {
      const p = this.state.players.get(client.sessionId);
      if (p && typeof skin === 'string' && skin.length <= 40) p.skin = skin;
    });
    // Mark a block as a portal to another world / 2D zone (dest cleaned server-side).
    this.onMessage('setPortal', (_client, m: { x: number; y: number; z: number; dest: unknown }) => {
      const dest = cleanDest(m?.dest);
      if (!dest) return;
      const x = Math.floor(m.x),
        y = Math.floor(m.y),
        z = Math.floor(m.z);
      if ([x, y, z].every(Number.isFinite)) portals.set(this.state.worldId, x, y, z, dest);
    });
  }

  onJoin(client: Client, options?: { name?: string; skin?: string }): void {
    const auth = client.auth as AuthInfo | undefined;
    const p = new VoxelPlayerSync();
    p.id = Math.floor(Math.random() * 0x7fffffff);
    // Spawn on the surface at the world origin.
    const top = this.world.columnTop(0, 0);
    p.x = 0.5;
    p.y = top + 1;
    p.z = 0.5;
    p.name = auth?.username || options?.name || 'player';
    if (typeof options?.skin === 'string') p.skin = options.skin.slice(0, 40);
    this.state.players.set(client.sessionId, p);
    this.views.set(client.sessionId, {
      sent: new Set(),
      cx: -9999,
      cy: -9999,
      cz: -9999,
      px: p.x,
      py: p.y,
      pz: p.z,
      lastMove: 0,
      lastEdit: 0,
      lastPortalKey: null,
    });
    client.send('welcome', { id: p.id, seed: this.world.seed, spawn: { x: p.x, y: p.y, z: p.z }, worldId: this.state.worldId });
    client.send('worlds', listWorlds()); // for the client's world dropdown
    // Server-side per-user settings (camera/auto-switch/wield transforms). Only
    // for logged-in users; anonymous clients keep their local settings.
    if (auth?.userId) {
      const saved = voxelSettings.get(auth.userId);
      if (saved) client.send('settings', saved);
    }
    this.streamAround(client, p.x, p.y, p.z);
  }

  onLeave(client: Client): void {
    this.state.players.delete(client.sessionId);
    this.views.delete(client.sessionId);
  }

  onDispose(): void {
    this.world?.close();
  }

  private onMove(client: Client, m: { x: number; y: number; z: number; yaw?: number; pitch?: number; state?: string }): void {
    const v = this.views.get(client.sessionId);
    const p = this.state.players.get(client.sessionId);
    if (!v || !p) return;
    const now = Date.now();
    if (now - v.lastMove < MOVE_MIN_MS) return;
    v.lastMove = now;
    if (![m.x, m.y, m.z].every((n) => Number.isFinite(n))) return;
    p.x = m.x;
    p.y = m.y;
    p.z = m.z;
    if (Number.isFinite(m.yaw)) p.yaw = m.yaw!;
    if (Number.isFinite(m.pitch)) p.pitch = m.pitch!;
    if (typeof m.state === 'string') p.state = m.state.slice(0, 16);
    v.px = m.x;
    v.py = m.y;
    v.pz = m.z;
    // Re-stream only when the player crosses into a new chunk.
    if (toChunk(m.x) !== v.cx || toChunk(m.y) !== v.cy || toChunk(m.z) !== v.cz) {
      this.streamAround(client, m.x, m.y, m.z);
    }
    // Portal: the block directly under the feet. Fire only when stepping ON (the
    // cell changed to a portal), so standing still doesn't repeat the jump.
    const ux = Math.floor(m.x),
      uy = Math.floor(m.y) - 1,
      uz = Math.floor(m.z);
    const pkey = `${ux},${uy},${uz}`;
    const dest = portals.get(this.state.worldId, ux, uy, uz);
    if (dest && v.lastPortalKey !== pkey) {
      v.lastPortalKey = pkey;
      client.send('portal', dest);
    } else if (!dest) {
      v.lastPortalKey = null;
    }
  }

  private onEdit(client: Client, m: { x: number; y: number; z: number; id: number }): void {
    const v = this.views.get(client.sessionId);
    if (!v) return;
    const now = Date.now();
    if (now - v.lastEdit < 30) return; // light anti-spam
    v.lastEdit = now;
    const x = Math.floor(m.x),
      y = Math.floor(m.y),
      z = Math.floor(m.z);
    const id = m.id | 0;
    if (![x, y, z].every(Number.isFinite) || id < 0 || id > 255) return;
    // Reach: within REACH of the player's eye (feet + ~1.6).
    const dx = x + 0.5 - v.px;
    const dy = y + 0.5 - (v.py + 1.6);
    const dz = z + 0.5 - v.pz;
    if (dx * dx + dy * dy + dz * dz > REACH * REACH) return;
    if (!this.world.setBlock(x, y, z, id)) return; // no change
    // Broadcast to everyone who has that chunk loaded.
    const key = chunkKey(toChunk(x), toChunk(y), toChunk(z));
    for (const c of this.clients) {
      if (this.views.get(c.sessionId)?.sent.has(key)) c.send('edit', { x, y, z, id });
    }
  }

  private onChat(client: Client, m: { text?: string }): void {
    const text = (typeof m?.text === 'string' ? m.text : '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!text) return;
    const from = this.state.players.get(client.sessionId)?.name || 'player';
    this.broadcast('m', { type: 'chat', from, text, at: Date.now() });
  }

  /** Send every in-range chunk not yet sent, and unload those now out of range. */
  private streamAround(client: Client, x: number, y: number, z: number): void {
    const v = this.views.get(client.sessionId);
    if (!v) return;
    const ccx = toChunk(x),
      ccy = toChunk(y),
      ccz = toChunk(z);
    v.cx = ccx;
    v.cy = ccy;
    v.cz = ccz;
    const want = new Set<string>();
    for (let dcy = -VIEW_CHUNKS_Y; dcy <= VIEW_CHUNKS_Y; dcy++) {
      for (let dcz = -VIEW_CHUNKS; dcz <= VIEW_CHUNKS; dcz++) {
        for (let dcx = -VIEW_CHUNKS; dcx <= VIEW_CHUNKS; dcx++) {
          const cx = ccx + dcx,
            cy = ccy + dcy,
            cz = ccz + dcz;
          const key = chunkKey(cx, cy, cz);
          want.add(key);
          if (!v.sent.has(key)) {
            client.sendBytes('c', packChunk(cx, cy, cz, this.world.chunk(cx, cy, cz)));
            v.sent.add(key);
          }
        }
      }
    }
    // Unload chunks that dropped out of range.
    for (const key of v.sent) {
      if (!want.has(key)) {
        const [cx, cy, cz] = key.split(',').map(Number);
        client.send('u', { cx, cy, cz });
        v.sent.delete(key);
      }
    }
  }
}

export { VOXEL_ROOM };
