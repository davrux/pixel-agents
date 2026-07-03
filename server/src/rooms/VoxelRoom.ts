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
import { StateView } from '@colyseus/schema';

import {
  VOXEL_ROOM,
  VIEW_CHUNKS,
  VIEW_CHUNKS_Y,
  toChunk,
  chunkKey,
  packChunk,
  isWaterId,
  isLavaId,
  WATER_SOURCE,
  LAVA_SOURCE,
  WATER_FLUID,
  FLUIDS,
  fluidOf,
} from '@pixel/shared';
import { VoxelPlayerSync, VoxelNpcSync, VoxelItemSync, VoxelRoomState } from '@pixel/shared/schema';
import { findPath } from '../voxel/pathfind.js';
import { settleAround } from '../voxel/fluid.js';
import { MOB_DEFS_LIST, type MobDef } from '../voxel/mobs.js';

import { hasValidSession, userIdFromCookie, hasValidBearerSession, userIdFromBearer } from '../auth.js';
import { userStore, UserStore } from '../userStore.js';
import { VoxelServerWorld } from '../voxel/world.js';
import { listWorlds } from '../voxel/chunkStore.js';
import { voxelSettings } from '../voxel/settingsStore.js';
import { voxelPositions } from '../voxel/positionStore.js';
import { portals, cleanDest } from '../voxel/portalStore.js';

interface AuthInfo {
  userId: string;
  username: string;
  isAdmin: boolean;
}
interface ClientView {
  sent: Set<string>; // chunk keys already streamed to this client
  view: StateView; // entity AOI: only nearby players/npcs are synced to this client
  aoiSet: Set<object>; // entities currently added to `view` (to diff each AOI pass)
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

// Mobs (Luanti mobs_redo-style, server-authoritative). Spawning: try near players,
// but never within SPAWN_MIN of one, on dry ground, capped, day/night-gated; despawn
// when far from every player or when the lifetimer runs out (respawn = the spawner
// refilling over time). Behaviour FSM per mob: stand/walk/runaway/attack.
const MOB_CAP = 10; // active_object_count — max mobs in the world
const SPAWN_INTERVAL = 4; // seconds between spawn attempts
const SPAWN_MIN = 12; // never spawn within this of a player (mobs_redo rule)
const SPAWN_MAX = 34; // ...nor beyond this
const DESPAWN_DIST = 64; // remove when farther than this from every player
const MOB_LIFETIME = 300; // seconds before a mob despawns (unless something resets it)
const WANDER_R = 8; // random wander-target radius
const MELEE_REACH = 3.4; // player↔mob melee distance (player's hits)
const PLAYER_HP = 20;
const PLAYER_DMG = 5; // damage a player melee hit deals to a mob
const MOB_ATTACK_CD = 1.0; // seconds between a monster's hits
const RUNAWAY_TIME = 4; // seconds an animal flees after being hit
const LAVA_TICK = 0.5; // seconds between lava burn ticks
const LAVA_DMG = 4; // damage per lava tick to a player standing in lava
const OBSIDIAN = 15; // lava SOURCE cooled by water (Luanti default cool_lava) — solid obsidian, not obsidian-glass (16)
const STONE = 3; // flowing lava cooled by water
const PICKUP_DIST = 1.6; // walk within this of a drop to collect it
const DROP_LIFETIME = 180; // seconds a dropped item lingers before despawning
const STACK_MAX = 99; // max of one block id in a stack

interface NpcBrain {
  sync: VoxelNpcSync;
  def: MobDef;
  path: { x: number; y: number; z: number }[];
  pi: number; // index of the next path node
  think: number; // seconds until the next stand→walk decision
  mode: 'stand' | 'walk' | 'runaway' | 'attack';
  repath: number; // seconds until a chase/flee re-path is allowed
  attackCd: number; // seconds until this mob can hit again
  runawayT: number; // seconds left fleeing (animals)
  fleeFrom: { x: number; z: number }; // point to flee away from
  life: number; // seconds left before despawn
}

export class VoxelRoom extends Room<VoxelRoomState> {
  private authRequired = false;
  private world!: VoxelServerWorld;
  private readonly views = new Map<string, ClientView>();
  private readonly npcs = new Map<string, NpcBrain>(); // npc id → brain (AI state is server-only)
  private npcSeq = 0;
  private spawnAcc = 0; // seconds accumulated toward the next spawn attempt
  private peaceful = false; // no monsters spawn while true (shared-world toggle)
  private aoiAcc = 0; // seconds accumulated toward the next entity-AOI refresh
  private lavaAcc = 0; // seconds accumulated toward the next lava burn tick
  private itemSeq = 0; // id counter for dropped items
  private readonly drops = new Map<string, { sync: VoxelItemSync; life: number }>(); // key → drop
  private readonly inv = new Map<string, Map<number, number>>(); // sid → (block id → count)
  private readonly creative = new Set<string>(); // sids with unlimited-block placing

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
    this.onMessage('setArmor', (client, m: { defense?: number }) => {
      const p = this.state.players.get(client.sessionId);
      if (p && Number.isFinite(m?.defense)) p.armor = Math.max(0, Math.min(40, Math.floor(m.defense!)));
    });
    this.onMessage('setPeaceful', (_client, m: { on?: boolean }) => {
      this.peaceful = !!m?.on; // shared-world flag; when on, no monsters spawn
      if (this.peaceful) for (const key of [...this.npcs.keys()]) this.removeMob(key);
    });
    this.onMessage('setCreative', (client, m: { on?: boolean }) => {
      if (m?.on) this.creative.add(client.sessionId); // unlimited-block placing for this client
      else this.creative.delete(client.sessionId);
    });
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

    this.setSimulationInterval((dt) => this.tick(dt / 1000), 100); // 10 Hz sim + AI
  }

  // ── Mobs (Luanti mobs_redo-style spawn/despawn + FSM) ────────────────────────
  /** Server time of day (0..1), shared clock; day ≈ 0.25..0.75. */
  private isDay(): boolean {
    const tod = (Date.now() / DAY_LENGTH_MS) % 1;
    return tod >= 0.23 && tod <= 0.8;
  }

  private tick(dt: number): void {
    // Spawn attempts on an interval; despawn + run the behaviour FSM every step.
    this.spawnAcc += dt;
    if (this.spawnAcc >= SPAWN_INTERVAL) {
      this.spawnAcc = 0;
      this.trySpawn();
    }
    this.aoiAcc += dt;
    if (this.aoiAcc >= 0.4) {
      this.aoiAcc = 0;
      this.updateAoi();
    }
    this.lavaAcc += dt;
    if (this.lavaAcc >= LAVA_TICK) {
      this.lavaAcc = 0;
      this.burnPlayersInLava();
    }
    // Dropped items: age out, then let nearby players collect them.
    for (const [key, d] of this.drops) {
      d.life -= dt;
      if (d.life <= 0) this.removeDrop(key);
    }
    this.collectDrops();
    for (const [key, b] of this.npcs) {
      b.life -= dt;
      const far = this.minPlayerDist(b.sync.x, b.sync.z);
      if (b.life <= 0 || far > DESPAWN_DIST) {
        this.removeMob(key);
        continue;
      }
      this.tickMob(b, dt);
    }
  }

  /** Try to spawn one mob near a random player: dry ground, outside SPAWN_MIN,
   *  under the cap, matching the day/night type. */
  private trySpawn(): void {
    if (this.peaceful || this.npcs.size >= MOB_CAP) return;
    const players = [...this.state.players.values()].filter((p) => p.hp > 0);
    if (!players.length) return;
    const day = this.isDay();
    const defs = MOB_DEFS_LIST.filter((d) => d.spawnByDay === day);
    if (!defs.length) return;
    const p = players[Math.floor(Math.random() * players.length)];
    const ang = Math.random() * Math.PI * 2;
    const dist = SPAWN_MIN + Math.random() * (SPAWN_MAX - SPAWN_MIN);
    const sx = Math.floor(p.x + Math.cos(ang) * dist);
    const sz = Math.floor(p.z + Math.sin(ang) * dist);
    const top = this.world.columnTop(sx, sz);
    // Suitable: solid dry ground with two air cells above, and not right next to a player.
    const ground = this.world.getBlock(sx, top, sz);
    if (ground === 0 || isWaterId(ground)) return;
    if (this.world.getBlock(sx, top + 1, sz) !== 0 || this.world.getBlock(sx, top + 2, sz) !== 0) return;
    if (this.minPlayerDist(sx, sz) < SPAWN_MIN) return;
    this.spawnMob(defs[Math.floor(Math.random() * defs.length)], sx, top + 1, sz);
  }

  private spawnMob(def: MobDef, x: number, y: number, z: number): void {
    const n = new VoxelNpcSync();
    n.id = ++this.npcSeq;
    n.x = x + 0.5;
    n.y = y;
    n.z = z + 0.5;
    n.skin = def.skin;
    n.kind = def.kind;
    n.hp = def.hp;
    n.state = 'idle';
    const key = `n${n.id}`;
    this.state.npcs.set(key, n);
    this.npcs.set(key, {
      sync: n,
      def,
      path: [],
      pi: 0,
      think: Math.random() * 2,
      mode: 'stand',
      repath: 0,
      attackCd: 0,
      runawayT: 0,
      fleeFrom: { x, z },
      life: MOB_LIFETIME,
    });
  }

  private removeMob(key: string): void {
    const b = this.npcs.get(key);
    if (b) this.dropFromViews(b.sync);
    this.state.npcs.delete(key);
    this.npcs.delete(key);
  }

  /** Spawn a dropped item at a broken block's cell (rests at the cell centre). */
  private spawnDrop(block: number, x: number, y: number, z: number): void {
    const it = new VoxelItemSync();
    it.id = ++this.itemSeq;
    it.x = x + 0.5;
    it.y = y + 0.25;
    it.z = z + 0.5;
    it.block = block;
    it.count = 1;
    const key = `i${it.id}`;
    this.state.items.set(key, it);
    this.drops.set(key, { sync: it, life: DROP_LIFETIME });
  }

  private removeDrop(key: string): void {
    const d = this.drops.get(key);
    if (d) this.dropFromViews(d.sync);
    this.state.items.delete(key);
    this.drops.delete(key);
  }

  /** Collect drops within PICKUP_DIST of a living player: add to that player's stack
   *  inventory and tell the client. Runs on the entity tick. */
  private collectDrops(): void {
    if (!this.drops.size) return;
    for (const [key, d] of this.drops) {
      let taker: { sid: string; p: VoxelPlayerSync } | null = null;
      this.state.players.forEach((p, sid) => {
        if (p.hp <= 0 || taker) return;
        if (Math.hypot(p.x - d.sync.x, p.z - d.sync.z) <= PICKUP_DIST && Math.abs(p.y - d.sync.y) <= 2) taker = { sid, p };
      });
      if (!taker) continue;
      const { sid } = taker as { sid: string };
      const bag = this.inv.get(sid) ?? new Map<number, number>();
      const total = Math.min(STACK_MAX, (bag.get(d.sync.block) ?? 0) + d.sync.count);
      bag.set(d.sync.block, total);
      this.inv.set(sid, bag);
      const client = this.clients.find((c) => c.sessionId === sid);
      client?.send('pickup', { block: d.sync.block, count: d.sync.count, total });
      this.removeDrop(key);
    }
  }

  /** Remove an entity from every client's AOI view (on despawn / leave). */
  private dropFromViews(entity: object): void {
    this.views.forEach((v) => {
      if (v.aoiSet.has(entity)) {
        v.view.remove(entity as never);
        v.aoiSet.delete(entity);
      }
    });
  }

  /** Entity AOI: each client's view holds only its own player + players/npcs within
   *  AOI_ENTITY blocks. Diffed against the client's aoiSet so we only add/remove on
   *  transitions (no per-tick re-encode churn). */
  private updateAoi(): void {
    const AOI = 64;
    this.views.forEach((v, sid) => {
      const self = this.state.players.get(sid);
      if (!self) return;
      const want = new Set<object>([self]);
      this.state.players.forEach((p) => {
        if (Math.hypot(p.x - self.x, p.z - self.z) <= AOI) want.add(p);
      });
      this.state.npcs.forEach((n) => {
        if (Math.hypot(n.x - self.x, n.z - self.z) <= AOI) want.add(n);
      });
      this.state.items.forEach((it) => {
        if (Math.hypot(it.x - self.x, it.z - self.z) <= AOI) want.add(it);
      });
      for (const e of want) if (!v.aoiSet.has(e)) ((v.view.add(e as never), v.aoiSet.add(e)));
      for (const e of v.aoiSet) if (!want.has(e)) ((v.view.remove(e as never), v.aoiSet.delete(e)));
    });
  }

  /** Distance from (x,z) to the nearest living player (Infinity if none). */
  private minPlayerDist(x: number, z: number): number {
    let best = Infinity;
    this.state.players.forEach((p) => {
      if (p.hp <= 0) return;
      best = Math.min(best, Math.hypot(p.x - x, p.z - z));
    });
    return best;
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

  /** Player melee hit on a mob: damage it; animals flee (runaway); dead → removed
   *  (the spawner refills the population over time). */
  private onAttack(client: Client, m: { npc?: string }): void {
    const p = this.state.players.get(client.sessionId);
    const key = m?.npc;
    const b = key ? this.npcs.get(key) : undefined;
    if (!p || !b || !key) return;
    const n = b.sync;
    if (Math.hypot(n.x - p.x, n.z - p.z) > MELEE_REACH + 1) return; // reach (+slack)
    n.hp = Math.max(0, n.hp - PLAYER_DMG);
    if (n.hp <= 0) {
      this.removeMob(key);
      return;
    }
    if (b.def.runaway) {
      // Animals bolt away from the attacker for a few seconds.
      b.mode = 'runaway';
      b.runawayT = RUNAWAY_TIME;
      b.fleeFrom = { x: p.x, z: p.z };
      b.path = [];
      b.repath = 0;
    }
    b.life = MOB_LIFETIME; // interacting with a mob keeps it around
  }

  /** Burn any player whose feet or head cell is lava (server-authoritative hazard). */
  private burnPlayersInLava(): void {
    this.state.players.forEach((p, sid) => {
      if (p.hp <= 0) return;
      const fx = Math.floor(p.x),
        fz = Math.floor(p.z),
        fy = Math.floor(p.y);
      if (isLavaId(this.world.getBlock(fx, fy, fz)) || isLavaId(this.world.getBlock(fx, fy + 1, fz))) {
        this.damagePlayer(sid, p, LAVA_DMG);
      }
    });
  }

  /** Apply damage to a player, mitigated by equipped armour (defence points). */
  private damagePlayer(sid: string, p: VoxelPlayerSync, dmg: number): void {
    if (p.hp <= 0) return;
    const mitigated = Math.max(1, dmg - Math.floor(p.armor / 5)); // armour softens hits
    p.hp = Math.max(0, p.hp - mitigated);
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

  /** One mob's behaviour step: runaway (fleeing animal) > attack (hostile monster) >
   *  wander/stand. Movement runs the current path at walk or run velocity. */
  private tickMob(b: NpcBrain, dt: number): void {
    const n = b.sync;
    const def = b.def;
    b.think -= dt;
    b.repath -= dt;
    b.attackCd -= dt;
    b.runawayT -= dt;

    if (b.runawayT > 0) {
      // Runaway: path to a reachable spot away from the threat; run velocity. Try the
      // straight-away direction first, then spread out, so a blocked flee still moves.
      b.mode = 'runaway';
      if (b.repath <= 0 || b.pi >= b.path.length) {
        const base = Math.atan2(n.z - b.fleeFrom.z, n.x - b.fleeFrom.x); // away from threat
        for (const off of [0, 0.6, -0.6, 1.2, -1.2, Math.PI]) {
          const a = base + off;
          const tx = Math.floor(n.x + Math.cos(a) * 8),
            tz = Math.floor(n.z + Math.sin(a) * 8);
          const p = findPath(this.world, { x: n.x, y: n.y, z: n.z }, { x: tx, y: this.world.columnTop(tx, tz) + 1, z: tz }, 500);
          if (p && p.length) {
            b.path = p;
            b.pi = 0;
            break;
          }
        }
        b.repath = 0.4;
      }
      this.advance(b, def.runVel, dt);
      return;
    }

    const prey = def.type === 'monster' ? this.nearestPlayer(n.x, n.z, def.viewRange) : null;
    if (prey) {
      // Attack: chase the player; hit on a cooldown when in reach; run velocity.
      b.mode = 'attack';
      b.life = MOB_LIFETIME;
      const t = prey.p;
      const dist = Math.hypot(t.x - n.x, t.z - n.z);
      n.yaw = Math.atan2(-(t.x - n.x), -(t.z - n.z));
      if (dist <= def.reach) {
        b.path = [];
        n.state = 'idle';
        if (b.attackCd <= 0) {
          b.attackCd = MOB_ATTACK_CD;
          this.damagePlayer(prey.sid, t, def.damage);
        }
        return;
      }
      if (b.repath <= 0 || b.pi >= b.path.length) {
        b.path = findPath(this.world, { x: n.x, y: n.y, z: n.z }, { x: t.x, y: t.y, z: t.z }, 900) ?? [];
        b.pi = 0;
        b.repath = 0.5;
      }
      this.advance(b, def.runVel, dt);
      return;
    }

    // Idle wander: from stand, occasionally pick a reachable spot and walk there.
    if ((b.mode === 'attack' || b.mode === 'runaway') && b.pi >= b.path.length) {
      b.mode = 'stand';
      b.think = 1 + Math.random() * 2;
    }
    if (b.mode === 'stand' && b.think <= 0) {
      const tx = Math.floor(n.x + (Math.random() * 2 - 1) * WANDER_R),
        tz = Math.floor(n.z + (Math.random() * 2 - 1) * WANDER_R);
      const p = findPath(this.world, { x: n.x, y: n.y, z: n.z }, { x: tx, y: this.world.columnTop(tx, tz) + 1, z: tz }, 900);
      if (p && p.length) {
        b.path = p;
        b.pi = 0;
        b.mode = 'walk';
      } else b.think = 1 + Math.random() * 2;
    }
    this.advance(b, def.walkVel, dt);
  }

  /** Move a mob along its path at `vel`; sets walk/idle state. Ends → stand. */
  private advance(b: NpcBrain, vel: number, dt: number): void {
    const n = b.sync;
    if (b.pi >= b.path.length) {
      if (b.mode === 'walk' || b.mode === 'runaway') {
        b.mode = 'stand';
        b.think = 1 + Math.random() * 2;
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
    const step = vel * dt;
    if (d <= step) {
      n.x = tx;
      n.z = tz;
      n.y = ty;
      b.pi++;
    } else {
      n.x += (dx / d) * step;
      n.z += (dz / d) * step;
      n.y += (ty - n.y) * Math.min(1, dt * 8);
      n.yaw = Math.atan2(-dx, -dz);
    }
    n.state = 'walk';
  }

  onJoin(client: Client, options?: { name?: string; skin?: string }): void {
    const auth = client.auth as AuthInfo | undefined;
    const p = new VoxelPlayerSync();
    p.id = Math.floor(Math.random() * 0x7fffffff);
    // Spawn at the player's last saved position in this world (logged-in), else on the
    // surface at the world origin.
    const last = auth?.userId ? voxelPositions.get(auth.userId, this.state.worldId) : null;
    if (last) {
      p.x = last.x;
      p.y = last.y;
      p.z = last.z;
    } else {
      p.x = 0.5;
      p.y = this.world.columnTop(0, 0) + 1;
      p.z = 0.5;
    }
    p.name = auth?.username || options?.name || 'player';
    p.hp = PLAYER_HP;
    p.hpMax = PLAYER_HP;
    if (typeof options?.skin === 'string') p.skin = options.skin.slice(0, 40);
    this.state.players.set(client.sessionId, p);
    // Entity AOI: give the client a StateView and always include its own player (so it
    // gets its own HP/position). Nearby players/npcs are added/removed in updateAoi().
    const stateView = new StateView();
    stateView.add(p);
    client.view = stateView;
    this.views.set(client.sessionId, {
      sent: new Set(),
      view: stateView,
      aoiSet: new Set([p]),
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
    // Remember where the player left off (logged-in), so they respawn there.
    const auth = client.auth as AuthInfo | undefined;
    const p = this.state.players.get(client.sessionId);
    if (auth?.userId && p) voxelPositions.set(auth.userId, this.state.worldId, p.x, p.y, p.z);
    if (p) this.dropFromViews(p); // drop the leaver from other clients' views
    this.state.players.delete(client.sessionId);
    this.views.delete(client.sessionId);
    this.inv.delete(client.sessionId);
    this.creative.delete(client.sessionId);
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
    const prev = this.world.getBlock(x, y, z);
    const sid = client.sessionId;
    // Survival: placing a normal node into air consumes one from the stack inventory.
    // Fluids + the portal marker (27/28/29) are exempt build tools; creative skips it.
    const consumes = id !== 0 && prev === 0 && id !== WATER_SOURCE && id !== LAVA_SOURCE && id !== 28;
    if (consumes && !this.creative.has(sid)) {
      const bag = this.inv.get(sid);
      if ((bag?.get(id) ?? 0) <= 0) {
        client.send('inv', { block: id, total: 0 }); // nothing to place — correct the client
        return;
      }
    }
    if (!this.world.setBlock(x, y, z, id)) return; // no change
    this.broadcastEdit(x, y, z, id);
    if (consumes && !this.creative.has(sid)) {
      const bag = this.inv.get(sid)!;
      const total = Math.max(0, (bag.get(id) ?? 0) - 1);
      total > 0 ? bag.set(id, total) : bag.delete(id);
      client.send('inv', { block: id, total });
    }
    // Breaking a real (non-fluid) block drops it as a collectible item (Luanti-style).
    if (id === 0 && prev !== 0 && !isWaterId(prev) && !isLavaId(prev)) this.spawnDrop(prev, x, y, z);
    // Fluid flow: if this edit touches a liquid, recompute the local pool of THAT fluid
    // to equilibrium (pours in / floods / recedes) and broadcast every resulting change.
    // Water and lava settle independently (each treats the other as a wall).
    const NB = [
      [0, 0, 0],
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ];
    for (const fluid of FLUIDS) {
      const touches = NB.some(([a, b, c]) => fluidOf(this.world.getBlock(x + a, y + b, z + c)) === fluid);
      if (!touches) continue;
      const changes = settleAround(this.world, x, y, z, fluid);
      if (changes.length) {
        this.world.setBlocks(changes);
        for (const ch of changes) this.broadcastEdit(ch.x, ch.y, ch.z, ch.id);
      }
    }
    // Luanti cool_lava: lava meeting water hardens — a source → obsidian, flow → stone.
    this.coolLavaAround(x, y, z);
  }

  /** After a fluid settle, harden any lava now touching water (Luanti default rule):
   *  lava SOURCE → obsidian, flowing lava → stone. Then re-settle water once, since the
   *  fresh solids may open or block its path. Bounded to a box around the edit. */
  private coolLavaAround(ex: number, ey: number, ez: number): void {
    const R = 6,
      DY = 8;
    const NB6 = [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ];
    const conv: { x: number; y: number; z: number; id: number }[] = [];
    for (let y = ey - DY; y <= ey + 2; y++)
      for (let z = ez - R; z <= ez + R; z++)
        for (let x = ex - R; x <= ex + R; x++) {
          const id = this.world.getBlock(x, y, z);
          if (!isLavaId(id)) continue;
          if (NB6.some(([a, b, c]) => isWaterId(this.world.getBlock(x + a, y + b, z + c)))) {
            conv.push({ x, y, z, id: id === LAVA_SOURCE ? OBSIDIAN : STONE });
          }
        }
    if (!conv.length) return;
    this.world.setBlocks(conv);
    for (const ch of conv) this.broadcastEdit(ch.x, ch.y, ch.z, ch.id);
    const wc = settleAround(this.world, ex, ey, ez, WATER_FLUID);
    if (wc.length) {
      this.world.setBlocks(wc);
      for (const ch of wc) this.broadcastEdit(ch.x, ch.y, ch.z, ch.id);
    }
  }

  /** Send a block change to everyone who has that chunk loaded. */
  private broadcastEdit(x: number, y: number, z: number, id: number): void {
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
