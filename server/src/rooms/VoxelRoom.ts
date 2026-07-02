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
import { VoxelPlayerSync, VoxelNpcSync, VoxelRoomState } from '@pixel/shared/schema';
import { findPath } from '../voxel/pathfind.js';

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
const DAY_LENGTH_MS = 20 * 60 * 1000; // full day/night cycle (Minecraft-like 20 min)

// NPCs: server-authoritative creatures with an A*-driven idle/wander/chase FSM.
const NPC_COUNT = 3;
const NPC_SPEED = 3.0; // blocks/s
const NPC_WANDER_R = 10; // random-target radius around home
const NPC_CHASE_R = 14; // start chasing a player within this
const NPC_KEEP_R = 2.0; // stop this close to the chased player
const NPC_SKINS = ['character_2', 'character_5', 'character_8'];
// Combat.
const MELEE_REACH = 3.4; // player↔npc melee distance
const PLAYER_HP = 20;
const NPC_HP = 20;
const PLAYER_DMG = 5; // damage a player melee hit deals to an NPC
const NPC_DMG = 2; // damage an NPC hit deals to a player (before armour)
const NPC_ATTACK_CD = 1.0; // seconds between an NPC's hits

interface NpcBrain {
  sync: VoxelNpcSync;
  home: { x: number; z: number };
  path: { x: number; y: number; z: number }[];
  pi: number; // index of the next path node
  think: number; // seconds until the next idle decision
  mode: 'idle' | 'wander' | 'chase';
  repath: number; // seconds until a chase re-path is allowed
  attackCd: number; // seconds until this NPC can hit again
}

export class VoxelRoom extends Room<VoxelRoomState> {
  private authRequired = false;
  private world!: VoxelServerWorld;
  private readonly views = new Map<string, ClientView>();
  private readonly npcs = new Map<string, NpcBrain>(); // npc id → brain (AI state is server-only)
  private npcSeq = 0;

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
    this.onMessage('teleport', (client, m: { x: number; z: number }) => this.onTeleport(client, m));
    this.onMessage('attack', (client, m: { npc?: string }) => this.onAttack(client, m));
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

    this.spawnNpcs();
    this.setSimulationInterval((dt) => this.tickNpcs(dt / 1000), 100); // 10 Hz AI
  }

  // ── NPCs (server-authoritative A* + idle/wander/chase FSM) ───────────────────
  private spawnNpcs(): void {
    for (let i = 0; i < NPC_COUNT; i++) {
      // Spawn on dry land near (but not in) the spawn area; the default world's
      // lake is at +x, so fan out on the -x side and snap to a standable cell.
      const cand = { x: -8 - i * 3, z: (i - 1) * 7 };
      const home = this.findNpcSpawn(cand.x, cand.z);
      const n = new VoxelNpcSync();
      n.id = ++this.npcSeq;
      n.x = home.x + 0.5;
      n.z = home.z + 0.5;
      n.y = this.world.columnTop(home.x, home.z) + 1;
      n.skin = NPC_SKINS[i % NPC_SKINS.length];
      n.state = 'idle';
      const key = `n${n.id}`;
      this.state.npcs.set(key, n);
      n.hp = NPC_HP;
      this.npcs.set(key, { sync: n, home, path: [], pi: 0, think: 0.4 + i * 0.5, mode: 'idle', repath: 0, attackCd: 0 });
    }
  }

  /** Nearest dry-land column to (cx,cz) whose surface is standable (not water). */
  private findNpcSpawn(cx: number, cz: number): { x: number; z: number } {
    for (let r = 0; r <= 8; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue; // ring only
          const x = cx + dx,
            z = cz + dz;
          const top = this.world.columnTop(x, z);
          if (this.world.getBlock(x, top, z) !== 27 && this.world.getBlock(x, top + 1, z) === 0) return { x, z };
        }
      }
    }
    return { x: cx, z: cz };
  }

  private nearestPlayer(x: number, z: number, within: number): { sid: string; p: VoxelPlayerSync } | null {
    let best: { sid: string; p: VoxelPlayerSync } | null = null;
    let bestD = within * within;
    this.state.players.forEach((p, sid) => {
      if (p.hp <= 0) return;
      const d = (p.x - x) ** 2 + (p.z - z) ** 2;
      if (d < bestD) ((bestD = d), (best = { sid, p }));
    });
    return best;
  }

  /** Player melee hit on an NPC (client sends the npc key + must be in reach). */
  private onAttack(client: Client, m: { npc?: string }): void {
    const p = this.state.players.get(client.sessionId);
    const b = m?.npc ? this.npcs.get(m.npc) : undefined;
    if (!p || !b) return;
    const n = b.sync;
    if (Math.hypot(n.x - p.x, n.z - p.z) > MELEE_REACH + 1) return; // reach (+slack)
    n.hp = Math.max(0, n.hp - PLAYER_DMG);
    if (n.hp <= 0) this.respawnNpc(b); // "dies" and a fresh one returns home
  }

  private respawnNpc(b: NpcBrain): void {
    const n = b.sync;
    n.x = b.home.x + 0.5;
    n.z = b.home.z + 0.5;
    n.y = this.world.columnTop(b.home.x, b.home.z) + 1;
    n.hp = NPC_HP;
    n.state = 'idle';
    b.path = [];
    b.pi = 0;
    b.mode = 'idle';
    b.think = 1.5;
  }

  /** Apply damage to a player (armour mitigation lands with the armour step). */
  private damagePlayer(sid: string, p: VoxelPlayerSync, dmg: number): void {
    if (p.hp <= 0) return;
    p.hp = Math.max(0, p.hp - dmg);
    if (p.hp <= 0) this.respawnPlayer(sid, p);
  }

  private respawnPlayer(sid: string, p: VoxelPlayerSync): void {
    const top = this.world.columnTop(0, 0);
    p.x = 0.5;
    p.y = top + 1;
    p.z = 0.5;
    p.hp = p.hpMax || PLAYER_HP;
    const client = this.clients.find((c) => c.sessionId === sid);
    const v = this.views.get(sid);
    if (v) {
      v.px = p.x;
      v.py = p.y;
      v.pz = p.z;
    }
    if (client) {
      this.streamAround(client, p.x, p.y, p.z);
      client.send('tp', { x: p.x, y: p.y, z: p.z });
    }
  }

  private tickNpcs(dt: number): void {
    for (const b of this.npcs.values()) {
      const n = b.sync;
      b.think -= dt;
      b.repath -= dt;
      b.attackCd -= dt;
      const prey = this.nearestPlayer(n.x, n.z, NPC_CHASE_R);
      if (prey) {
        // Chase: re-path toward the player; when in reach, hit on a cooldown.
        b.mode = 'chase';
        const target = prey.p;
        const dist = Math.hypot(target.x - n.x, target.z - n.z);
        n.yaw = Math.atan2(-(target.x - n.x), -(target.z - n.z)); // face the player
        if (dist <= MELEE_REACH) {
          if (b.attackCd <= 0) {
            b.attackCd = NPC_ATTACK_CD;
            this.damagePlayer(prey.sid, target, NPC_DMG);
          }
        }
        if (dist <= NPC_KEEP_R) {
          b.path = [];
          n.state = 'idle';
          continue;
        }
        if (b.repath <= 0 || b.pi >= b.path.length) {
          const p = findPath(this.world, { x: n.x, y: n.y, z: n.z }, { x: target.x, y: target.y, z: target.z }, 900);
          b.path = p ?? [];
          b.pi = 0;
          b.repath = 0.5;
        }
      } else if (b.mode === 'chase') {
        b.mode = 'idle';
        b.path = [];
        b.think = 1;
      } else if (b.mode === 'idle' && b.think <= 0) {
        // Pick a random reachable spot around home and wander to it.
        const tx = b.home.x + Math.round((this.rand() * 2 - 1) * NPC_WANDER_R);
        const tz = b.home.z + Math.round((this.rand() * 2 - 1) * NPC_WANDER_R);
        const ty = this.world.columnTop(tx, tz) + 1;
        const p = findPath(this.world, { x: n.x, y: n.y, z: n.z }, { x: tx, y: ty, z: tz }, 1000);
        if (p && p.length) {
          b.path = p;
          b.pi = 0;
          b.mode = 'wander';
        } else {
          b.think = 1 + this.rand() * 2;
        }
      }
      this.advanceNpc(b, dt);
    }
  }

  /** Move an NPC along its path; update transform + walk/idle state. */
  private advanceNpc(b: NpcBrain, dt: number): void {
    const n = b.sync;
    if (b.pi >= b.path.length) {
      if (b.mode === 'wander') {
        b.mode = 'idle';
        b.think = 1 + this.rand() * 2;
      }
      if (n.state !== 'idle') n.state = 'idle';
      return;
    }
    const node = b.path[b.pi];
    const tx = node.x + 0.5,
      tz = node.z + 0.5,
      ty = node.y;
    const dx = tx - n.x,
      dz = tz - n.z;
    const d = Math.hypot(dx, dz);
    const step = NPC_SPEED * dt;
    if (d <= step) {
      n.x = tx;
      n.z = tz;
      n.y = ty;
      b.pi++;
    } else {
      n.x += (dx / d) * step;
      n.z += (dz / d) * step;
      n.y += (ty - n.y) * Math.min(1, dt * 8); // ease vertical toward the node
      n.yaw = Math.atan2(-dx, -dz); // 0 faces -Z
    }
    n.state = 'walk';
  }

  private rand(): number {
    return Math.random();
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
    p.hp = PLAYER_HP;
    p.hpMax = PLAYER_HP;
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
    // `now` + `dayLengthMs` give the client the server-aligned day clock so every
    // player sees the same time of day (the client advances it locally from here).
    client.send('welcome', {
      id: p.id,
      seed: this.world.seed,
      spawn: { x: p.x, y: p.y, z: p.z },
      worldId: this.state.worldId,
      now: Date.now(),
      dayLengthMs: DAY_LENGTH_MS,
    });
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

  /** Travel (map click): teleport within this world to a column top. Authoritative
   *  — the server picks the safe Y, moves the player, re-streams, and echoes 'tp'. */
  private onTeleport(client: Client, m: { x: number; z: number }): void {
    const v = this.views.get(client.sessionId);
    const p = this.state.players.get(client.sessionId);
    if (!v || !p) return;
    if (![m?.x, m?.z].every((n) => Number.isFinite(n))) return;
    const x = Math.max(-4000, Math.min(4000, Math.floor(m.x))) + 0.5;
    const z = Math.max(-4000, Math.min(4000, Math.floor(m.z))) + 0.5;
    const y = this.world.columnTop(Math.floor(x), Math.floor(z)) + 1;
    p.x = x;
    p.y = y;
    p.z = z;
    v.px = x;
    v.py = y;
    v.pz = z;
    v.lastPortalKey = null;
    this.streamAround(client, x, y, z);
    client.send('tp', { x, y, z });
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
