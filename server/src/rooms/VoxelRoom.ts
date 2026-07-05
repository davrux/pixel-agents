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
  MAP_LIMIT,
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
  CRAFT_RECIPES,
  SMELT_RECIPES,
  FUEL_ITEMS,
  dropFor,
  TOOL_BASE,
  STARTER_TOOL,
  toolMaxUses,
  MAX_BLOCK_ID,
  CHEST_ID,
  FURNACE_ID,
  TNT_ID,
  DOOR_CLOSED,
  DOOR_OPEN,
  WHEAT_SEED,
  WHEAT_MATURE,
  APPLE,
  FOOD_VALUES,
  STICK,
  WHEAT,
  isCrop,
  SAPLING,
  SOIL,
  DESERT_SOIL,
  isSoil,
  isHoe,
  isBucket,
  BUCKET_EMPTY,
  BUCKET_WATER,
  BUCKET_LAVA,
  FIRE_ID,
  FLINT,
  FLINT_STEEL,
  isFlintSteel,
  isFlammable,
  SIGN_ID,
  FENCE_GATE_CLOSED,
  FENCE_GATE_OPEN,
  BED_ID,
  WOOL_WHITE,
  findCommand,
  mayRunCommand,
  KICK_CLOSE_CODE,
  needsGround,
} from '@pixel/shared';
import { VoxelPlayerSync, VoxelNpcSync, VoxelItemSync, VoxelRoomState } from '@pixel/shared/schema';
import { findPath } from '../voxel/pathfind.js';
import { settleAround } from '../voxel/fluid.js';
import { MOB_DEFS_LIST, type MobDef } from '../voxel/mobs.js';

import { hasValidSession, userIdFromCookie, hasValidBearerSession, userIdFromBearer } from '../auth.js';
import { userStore, UserStore, isValidPassword, normalizeLoginId, MIN_PASSWORD_LEN } from '../userStore.js';
import { VoxelServerWorld } from '../voxel/world.js';
import { listWorlds, deleteWorld } from '../voxel/chunkStore.js';
import { voxelSettings } from '../voxel/settingsStore.js';
import { voxelPositions } from '../voxel/positionStore.js';
import { voxelInventory, voxelDurability } from '../voxel/inventoryStore.js';
import { portals, cleanDest } from '../voxel/portalStore.js';
import { chests } from '../voxel/chestStore.js';
import { appStore } from '../appStore.js';
import { voiceConfigured, voiceUrl, voiceRoomName, mintVoiceToken } from '../voice/livekit.js';
import { signs, cleanSignText } from '../voxel/signStore.js';

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
const DROP_FALL = 9; // blocks/sec a dropped item falls under gravity
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
  private readonly wear = new Map<string, Map<number, number>>(); // sid → (tool id → uses left)
  private readonly noWear = new Set<string>(); // sids with tool durability turned OFF (tools stay max)
  private readonly crops = new Set<string>(); // planted crop cells "x,y,z" (grow over time)
  private readonly saplings = new Map<string, number>(); // planted sapling cell → age in ticks
  private fuses: { x: number; y: number; z: number; t: number }[] = []; // lit TNT (t = seconds to boom)
  private readonly fires = new Map<string, number>(); // burning cell "x,y,z" → age in fire ticks
  private fireAcc = 0; // seconds toward the next fire tick
  private readonly noHunger = new Set<string>(); // sids with hunger turned OFF (food stays full)
  private cropAcc = 0; // seconds toward the next crop-growth tick
  private readonly voiceNs = process.env.PIXEL_VOICE_PREFIX?.trim() || appStore.getVoiceNs();
  private readonly lastVoiceEventAt = new Map<string, number>(); // per-session throttle for voice announcements
  private readonly decayLeaves = new Set<string>(); // orphaned leaf cells to check for decay
  private decayAcc = 0; // seconds toward the next leaf-decay tick
  private hungerAcc = 0; // seconds toward the next hunger tick

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
    this.onMessage('edit', (client, m: { x: number; y: number; z: number; id: number; tool?: number }) => this.onEdit(client, m));
    this.onMessage('teleport', (client, m: { x: number; z: number }) => this.onTeleport(client, m));
    this.onMessage('attack', (client, m: { npc?: string }) => this.onAttack(client, m));
    this.onMessage('setArmor', (client, m: { defense?: number }) => {
      const p = this.state.players.get(client.sessionId);
      if (p && Number.isFinite(m?.defense)) p.armor = Math.max(0, Math.min(40, Math.floor(m.defense!)));
    });
    this.onMessage('setPeaceful', (_client, m: { on?: boolean }) => {
      this.peaceful = !!m?.on; // shared-world flag; when on, no monsters spawn
      // Clear existing MONSTERS only (animals stay — peaceful keeps passive mobs).
      if (this.peaceful) for (const [key, b] of this.npcs) if (b.def.type === 'monster') this.removeMob(key);
    });
    this.onMessage('setCreative', (client, m: { on?: boolean }) => {
      if (m?.on) this.creative.add(client.sessionId); // unlimited-block placing for this client
      else this.creative.delete(client.sessionId);
    });
    this.onMessage('setDurability', (client, m: { on?: boolean }) => {
      // on = tools wear (default); off = tools never break (stay at max).
      if (m?.on === false) this.noWear.add(client.sessionId);
      else this.noWear.delete(client.sessionId);
    });
    this.onMessage('setHunger', (client, m: { on?: boolean }) => {
      // on = hunger drains + can starve (default); off = food stays full.
      if (m?.on === false) this.noHunger.add(client.sessionId);
      else this.noHunger.delete(client.sessionId);
    });
    this.onMessage('eat', (client) => this.onEat(client));
    this.onMessage('craft', (client, m: { i?: number }) => this.onCraft(client, m?.i ?? -1));
    this.onMessage('smelt', (client, m: { i?: number }) => this.onSmelt(client, m?.i ?? -1));
    this.onMessage('use', (client, m: { x: number; y: number; z: number; held?: number }) => this.onUse(client, m));
    this.onMessage('chestMove', (client, m: { x: number; y: number; z: number; id: number; dir: string }) => this.onChestMove(client, m));
    this.onMessage('setSign', (client, m: { x: number; y: number; z: number; text?: string }) => this.onSetSign(client, m));
    this.onMessage('chat', (client, m: { text?: string }) => this.onChat(client, m));
    this.onMessage('command', (client, m: { name?: string; args?: string }) => this.onCommand(client, m));
    this.onMessage('deleteWorld', (client, m: { world?: string }) => this.onDeleteWorld(client, m));
    // Zone voice (per-world) — same LiveKit flow as the 2D office (shared helper).
    this.onMessage('zoneVoiceToken', (client) => void this.onZoneVoiceToken(client));
    this.onMessage('voiceEvent', (client, m: { event?: string }) => this.onVoiceEvent(client, m));
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

  // Shared day clock. `timeShiftMs` is bumped when someone sleeps in a bed so the whole
  // world jumps to morning; every client is realigned via a 'time' broadcast.
  private timeShiftMs = 0;
  private serverNow(): number {
    return Date.now() + this.timeShiftMs;
  }
  private tod(): number {
    return ((this.serverNow() / DAY_LENGTH_MS) % 1 + 1) % 1;
  }

  // ── Mobs (Luanti mobs_redo-style spawn/despawn + FSM) ────────────────────────
  /** Server time of day (0..1), shared clock; day ≈ 0.25..0.75. */
  private isDay(): boolean {
    const tod = this.tod();
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
    this.cropAcc += dt;
    if (this.cropAcc >= 3) {
      this.cropAcc = 0;
      this.growCrops();
      this.growSaplings();
    }
    if (this.decayLeaves.size) {
      this.decayAcc += dt;
      if (this.decayAcc >= 1) {
        this.decayAcc = 0;
        this.tickLeafDecay();
      }
    }
    if (this.fuses.length) this.tickFuses(dt);
    if (this.fires.size) {
      this.fireAcc += dt;
      if (this.fireAcc >= 1) {
        this.fireAcc = 0;
        this.tickFire();
      }
    }
    this.hungerAcc += dt;
    if (this.hungerAcc >= 4) {
      this.hungerAcc = 0;
      this.tickHunger();
    }
    // Dropped items: age out, fall to the ground (Minecraft-style — drops don't hang in
    // the air; break a tree and they drop down), then let nearby players collect them.
    for (const [key, d] of this.drops) {
      d.life -= dt;
      if (d.life <= 0) {
        this.removeDrop(key);
        continue;
      }
      this.settleDrop(d.sync, dt);
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
    if (this.npcs.size >= MOB_CAP) return;
    const players = [...this.state.players.values()].filter((p) => p.hp > 0);
    if (!players.length) return;
    // Animals (passive) spawn any time; monsters only at night, and never while peaceful.
    // (Minecraft-faithful: peaceful removes hostiles but keeps passive mobs around.)
    const night = !this.isDay();
    const defs = MOB_DEFS_LIST.filter((d) => (d.type === 'animal' ? true : night && !this.peaceful));
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

  /** Advance planted crops one growth stage (probabilistically), dropping cells that are
   *  no longer a crop (broken/replaced) from the registry. Registry is populated on plant;
   *  crops from a prior server run stay at their stored stage (not re-registered). */
  private growCrops(): void {
    if (!this.crops.size) return;
    for (const key of this.crops) {
      const [x, y, z] = key.split(',').map(Number);
      const b = this.world.getBlock(x, y, z);
      if (!isCrop(b)) {
        this.crops.delete(key);
        continue;
      }
      if (b >= WHEAT_MATURE) continue; // fully grown
      if (!isSoil(this.world.getBlock(x, y - 1, z))) continue; // crops only grow on tilled soil
      if (Math.random() < 0.5 && this.world.setBlock(x, y, z, b + 1)) this.broadcastEdit(x, y, z, b + 1);
    }
  }

  /** Age planted saplings; once mature (~4 ticks) replace them with a grown tree. */
  private growSaplings(): void {
    if (!this.saplings.size) return;
    for (const [key, age] of this.saplings) {
      const [x, y, z] = key.split(',').map(Number);
      if (this.world.getBlock(x, y, z) !== SAPLING) {
        this.saplings.delete(key);
        continue;
      }
      if (age >= 4 && Math.random() < 0.5) {
        this.saplings.delete(key);
        this.growTree(x, y, z);
      } else this.saplings.set(key, age + 1);
    }
  }

  /** Luanti leaf decay: a leaf with no trunk within 2 blocks (its tree was chopped) fades
   *  away, occasionally dropping a sapling / apple / stick, and queues its leaf neighbours
   *  so the whole orphaned canopy decays outward over a few seconds. Bounded per tick. */
  private tickLeafDecay(): void {
    const nearTrunk = (x: number, y: number, z: number): boolean => {
      for (let dy = -2; dy <= 2; dy++)
        for (let dz = -2; dz <= 2; dz++)
          for (let dx = -2; dx <= 2; dx++) if (this.world.getBlock(x + dx, y + dy, z + dz) === 17) return true;
      return false;
    };
    let processed = 0;
    for (const key of [...this.decayLeaves]) {
      if (processed++ > 300) break; // cap work per tick
      this.decayLeaves.delete(key);
      const [x, y, z] = key.split(',').map(Number);
      if (this.world.getBlock(x, y, z) !== 21) continue; // no longer a leaf
      if (nearTrunk(x, y, z)) continue; // a trunk still supports it → stays
      if (Math.random() < 0.4) { // stagger so the canopy fades gradually, not all at once
        this.decayLeaves.add(key);
        continue;
      }
      if (this.world.setBlock(x, y, z, 0)) this.broadcastEdit(x, y, z, 0);
      const r = Math.random();
      if (r < 0.1) this.spawnDrop(SAPLING, x, y, z, 1);
      else if (r < 0.2) this.spawnDrop(APPLE, x, y, z, 1);
      else if (r < 0.3) this.spawnDrop(STICK, x, y, z, 1);
      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]])
        if (this.world.getBlock(x + dx, y + dy, z + dz) === 21 && this.decayLeaves.size < 6000) this.decayLeaves.add(`${x + dx},${y + dy},${z + dz}`);
    }
  }

  /** Grow a small tree in the live world at a sapling cell (trunk + leaf blob), each
   *  changed cell broadcast to clients that have the chunk. */
  private growTree(x: number, y: number, z: number): void {
    const h = 4 + Math.floor(Math.random() * 2); // 4-5 trunk
    const put = (xx: number, yy: number, zz: number, id: number): void => {
      if (this.world.setBlock(xx, yy, zz, id)) this.broadcastEdit(xx, yy, zz, id);
    };
    for (let i = 0; i < h; i++) put(x, y + i, z, 17); // trunk (overwrites the sapling)
    const top = y + h - 1;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -2; dx <= 2; dx++)
        for (let dz = -2; dz <= 2; dz++) {
          if (dx * dx + dz * dz + dy * dy * 2 <= 5 && this.world.getBlock(x + dx, top + dy, z + dz) === 0) put(x + dx, top + dy, z + dz, 21);
        }
    put(x, top + 1, z, 21);
  }

  /** Hunger tick (~every 4s): drain food, starve at 0, regen HP when well-fed. Players
   *  with hunger OFF keep full food; creative never starves (damagePlayer skips it). */
  private tickHunger(): void {
    this.state.players.forEach((p, sid) => {
      if (p.hp <= 0) return;
      if (this.noHunger.has(sid)) {
        if (p.food !== 20) p.food = 20;
        return;
      }
      if (Math.random() < 0.4) p.food = Math.max(0, p.food - 1); // ~1 food / 10s
      if (p.food === 0) this.damagePlayer(sid, p, 1); // starving
      else if (p.food >= 18 && p.hp < (p.hpMax || PLAYER_HP)) p.hp = Math.min(p.hpMax || PLAYER_HP, p.hp + 1); // regen
    });
  }

  /** Eat one bread from the inventory (if hungry) → +6 food. */
  private onEat(client: Client): void {
    const p = this.state.players.get(client.sessionId);
    const bag = this.inv.get(client.sessionId);
    if (!p || !bag || p.food >= 20) return;
    // Eat the first food the player holds (apples before bread — see FOOD_VALUES).
    const food = FOOD_VALUES.find((f) => (bag.get(f.item) ?? 0) > 0);
    if (!food) return;
    const left = (bag.get(food.item) ?? 0) - 1;
    left > 0 ? bag.set(food.item, left) : bag.delete(food.item);
    client.send('inv', { block: food.item, total: Math.max(0, left) });
    p.food = Math.min(20, p.food + food.food);
  }

  /** Light a TNT block (from a use-action or a nearby blast). Ignores if already lit. */
  private igniteTnt(x: number, y: number, z: number, t = 2): void {
    if (this.world.getBlock(x, y, z) !== TNT_ID) return;
    if (this.fuses.some((f) => f.x === x && f.y === y && f.z === z)) return;
    if (this.fuses.length < 200) this.fuses.push({ x, y, z, t });
  }

  /** Count down lit fuses; detonate the ones that reach zero. */
  private tickFuses(dt: number): void {
    const ready = [];
    for (const f of this.fuses) {
      f.t -= dt;
      if (f.t <= 0) ready.push(f);
    }
    if (!ready.length) return;
    this.fuses = this.fuses.filter((f) => f.t > 0);
    for (const f of ready) this.explodeTnt(f.x, f.y, f.z);
  }

  /** TNT blast: clear solid blocks in a radius (skip bedrock + fluids), damage nearby
   *  players, and chain-ignite any other TNT caught in the blast. */
  private explodeTnt(x: number, y: number, z: number): void {
    const R = 3;
    const changes: { x: number; y: number; z: number; id: number }[] = [];
    for (let dx = -R; dx <= R; dx++)
      for (let dy = -R; dy <= R; dy++)
        for (let dz = -R; dz <= R; dz++) {
          if (dx * dx + dy * dy + dz * dz > R * R) continue;
          const bx = x + dx,
            by = y + dy,
            bz = z + dz;
          if (by < 0) continue; // keep the bedrock floor
          const b = this.world.getBlock(bx, by, bz);
          if (b === 0 || fluidOf(b)) continue;
          if (b === TNT_ID && !(dx === 0 && dy === 0 && dz === 0)) this.igniteTnt(bx, by, bz, 0.25); // chain reaction
          else changes.push({ x: bx, y: by, z: bz, id: 0 });
        }
    if (changes.length) {
      this.world.setBlocks(changes);
      for (const ch of changes) this.broadcastEdit(ch.x, ch.y, ch.z, ch.id);
    }
    this.broadcast('boom', { x: x + 0.5, y: y + 0.5, z: z + 0.5 }); // client flash/shake
    this.state.players.forEach((p, sid) => {
      const d = Math.hypot(p.x - (x + 0.5), p.y - (y + 0.5), p.z - (z + 0.5));
      if (d <= R + 1.5) this.damagePlayer(sid, p, Math.max(2, Math.round((R + 2 - d) * 4)));
    });
  }

  /** Flint & steel: light a fire in the aimed AIR cell if a flammable block is adjacent
   *  (or the cell sits on solid ground). Registers it for the fire tick (spread + burnout). */
  private igniteFire(client: Client, x: number, y: number, z: number): void {
    if (this.world.getBlock(x, y, z) !== 0) return; // only into air
    const NB = [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ];
    const nearFlammable = NB.some(([a, b, c]) => isFlammable(this.world.getBlock(x + a, y + b, z + c)));
    const onGround = this.world.getBlock(x, y - 1, z) !== 0 && !fluidOf(this.world.getBlock(x, y - 1, z));
    if (!nearFlammable && !onGround) return; // nothing to burn / no footing
    if (!this.world.setBlock(x, y, z, FIRE_ID)) return;
    this.broadcastEdit(x, y, z, FIRE_ID);
    if (this.fires.size < 4000) this.fires.set(`${x},${y},${z}`, 0);
    this.wearTool(client, client.sessionId, FLINT_STEEL); // flint & steel wears per use
  }

  /** Fire tick (~1 Hz): extinguish near water, spread to flammable neighbours, consume the
   *  flammable block it feeds on, and burn out over time (Luanti fire, server-authoritative). */
  private tickFire(): void {
    const NB = [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ];
    const kill = (kx: number, ky: number, kz: number): void => {
      if (this.world.setBlock(kx, ky, kz, 0)) this.broadcastEdit(kx, ky, kz, 0);
      this.fires.delete(`${kx},${ky},${kz}`);
    };
    for (const [key, age] of [...this.fires]) {
      const [x, y, z] = key.split(',').map(Number);
      if (this.world.getBlock(x, y, z) !== FIRE_ID) {
        this.fires.delete(key); // block was removed/overwritten elsewhere
        continue;
      }
      // Water anywhere adjacent snuffs it out.
      if (NB.some(([a, b, c]) => isWaterId(this.world.getBlock(x + a, y + b, z + c)))) {
        kill(x, y, z);
        continue;
      }
      const fuel = NB.filter(([a, b, c]) => isFlammable(this.world.getBlock(x + a, y + b, z + c)));
      // Spread: light an air cell next to a flammable block.
      if (fuel.length && Math.random() < 0.35 && this.fires.size < 4000) {
        for (const [a, b, c] of NB) {
          const ax = x + a,
            ay = y + b,
            az = z + c;
          if (this.world.getBlock(ax, ay, az) !== 0) continue;
          const nb = [
            [1, 0, 0],
            [-1, 0, 0],
            [0, 1, 0],
            [0, -1, 0],
            [0, 0, 1],
            [0, 0, -1],
          ];
          if (!nb.some(([i, j, k]) => isFlammable(this.world.getBlock(ax + i, ay + j, az + k)))) continue;
          if (this.world.setBlock(ax, ay, az, FIRE_ID)) {
            this.broadcastEdit(ax, ay, az, FIRE_ID);
            this.fires.set(`${ax},${ay},${az}`, 0);
          }
          break;
        }
      }
      // Consume fuel: occasionally burn away one adjacent flammable block.
      if (fuel.length && Math.random() < 0.25) {
        const [a, b, c] = fuel[Math.floor(Math.random() * fuel.length)];
        kill(x + a, y + b, z + c);
      }
      // Burn out: no fuel left dies fast; with fuel it lingers, then dies with age.
      const next = age + 1;
      if ((!fuel.length && Math.random() < 0.5) || next > 6 || (next > 2 && Math.random() < 0.3)) kill(x, y, z);
      else this.fires.set(key, next);
    }
    // Fire hurts players standing in a burning cell.
    this.state.players.forEach((p, sid) => {
      const fx = Math.floor(p.x),
        fz = Math.floor(p.z);
      if (this.fires.has(`${fx},${Math.floor(p.y)},${fz}`) || this.fires.has(`${fx},${Math.floor(p.y + 1)},${fz}`)) {
        this.damagePlayer(sid, p, 2);
      }
    });
  }

  /** Spawn a dropped item at a broken block's cell (rests at the cell centre). */
  private spawnDrop(block: number, x: number, y: number, z: number, count = 1): void {
    const it = new VoxelItemSync();
    it.id = ++this.itemSeq;
    it.x = x + 0.5;
    it.y = y + 0.25;
    it.z = z + 0.5;
    it.block = block;
    it.count = Math.max(1, Math.min(STACK_MAX, count | 0));
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

  /** Gravity for a dropped item: fall until it rests on solid ground (fluids don't
   *  support it). Minecraft-style — drops never hang in the air (break a treetop → they
   *  fall to the forest floor). Only writes y while actually falling (no idle churn). */
  private settleDrop(s: VoxelItemSync, dt: number): void {
    const fx = Math.floor(s.x),
      fz = Math.floor(s.z);
    const solid = (y: number): boolean => {
      const id = this.world.getBlock(fx, y, fz);
      return id !== 0 && fluidOf(id) === null;
    };
    let gy = Math.floor(s.y);
    while (gy > -64 && !solid(gy - 1)) gy--; // descend to the cell sitting on solid ground
    const restY = gy + 0.25;
    if (s.y > restY + 0.001) s.y = Math.max(restY, s.y - DROP_FALL * dt);
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
      // Loot: a slain sheep drops wool (the base for dyeing).
      if (b.def.kind === 'sheep') this.spawnDrop(WOOL_WHITE, Math.floor(n.x), Math.floor(n.y), Math.floor(n.z), 1 + Math.floor(Math.random() * 2));
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

  /** Server-authoritative craft: if the player's stack inventory holds every input of
   *  recipe `i`, consume them and grant the output. Broadcasts an 'inv' per changed block. */
  private onCraft(client: Client, i: number): void {
    const r = CRAFT_RECIPES[i];
    const sid = client.sessionId;
    const bag = this.inv.get(sid);
    if (!r || !bag) return;
    if (!r.in.every((ing) => (bag.get(ing.block) ?? 0) >= ing.count)) return; // can't afford
    for (const ing of r.in) {
      const left = (bag.get(ing.block) ?? 0) - ing.count;
      left > 0 ? bag.set(ing.block, left) : bag.delete(ing.block);
      client.send('inv', { block: ing.block, total: Math.max(0, left) });
    }
    const total = Math.min(STACK_MAX, (bag.get(r.out.block) ?? 0) + r.out.count);
    bag.set(r.out.block, total);
    client.send('inv', { block: r.out.block, total });
  }

  /** Server-authoritative smelt (furnace): needs one input item + one unit of fuel in
   *  the stack inventory. Consumes both, grants the output. Fuel is any FUEL_ITEMS id
   *  (prefers a non-input fuel so smelting sand with coal doesn't eat the sand as fuel).
   *  Broadcasts an 'inv' per changed item. */
  private onSmelt(client: Client, i: number): void {
    const r = SMELT_RECIPES[i];
    const sid = client.sessionId;
    const bag = this.inv.get(sid);
    if (!r || !bag) return;
    if ((bag.get(r.in) ?? 0) < 1) return; // no input to cook
    // Pick a fuel we actually hold, avoiding the input item itself when possible.
    const fuel = FUEL_ITEMS.find((f) => f !== r.in && (bag.get(f) ?? 0) >= 1) ?? FUEL_ITEMS.find((f) => (bag.get(f) ?? 0) >= 1);
    if (fuel === undefined) return; // no fuel
    const take = (item: number): void => {
      const left = (bag.get(item) ?? 0) - 1;
      left > 0 ? bag.set(item, left) : bag.delete(item);
      client.send('inv', { block: item, total: Math.max(0, left) });
    };
    take(r.in);
    take(fuel);
    const total = Math.min(STACK_MAX, (bag.get(r.out) ?? 0) + r.count);
    bag.set(r.out, total);
    client.send('inv', { block: r.out, total });
  }

  /** Set (or clear) a sign's text. Reach- + type-checked; persisted per world/pos and
   *  broadcast to everyone so the in-world text updates live. Empty text removes it. */
  private onSetSign(client: Client, m: { x: number; y: number; z: number; text?: string }): void {
    const v = this.views.get(client.sessionId);
    if (!v) return;
    const x = Math.floor(m.x),
      y = Math.floor(m.y),
      z = Math.floor(m.z);
    if (![x, y, z].every(Number.isFinite)) return;
    const dx = x + 0.5 - v.px,
      dy = y + 0.5 - (v.py + 1.6),
      dz = z + 0.5 - v.pz;
    if (dx * dx + dy * dy + dz * dz > REACH * REACH) return;
    if (this.world.getBlock(x, y, z) !== SIGN_ID) return;
    const text = cleanSignText(m.text);
    if (text) signs.set(this.state.worldId, x, y, z, text);
    else signs.delete(this.state.worldId, x, y, z);
    this.broadcast('sign', { x, y, z, text });
  }

  /** Wear the tool used for a break by one use; when it runs out, the tool shatters
   *  (removed from the inventory). Creative + the bare hand (tool 0) never wear.
   *  Durability is per-session (in-memory) — a reconnected tool comes back full. */
  private wearTool(client: Client, sid: string, tool: number): void {
    if (tool < TOOL_BASE || this.creative.has(sid) || this.noWear.has(sid)) return;
    const bag = this.inv.get(sid);
    if (!bag || (bag.get(tool) ?? 0) <= 0) return; // don't wear a tool they don't hold
    let byTool = this.wear.get(sid);
    if (!byTool) this.wear.set(sid, (byTool = new Map()));
    const max = toolMaxUses(tool);
    const left = (byTool.get(tool) ?? max) - 1;
    if (left <= 0) {
      byTool.delete(tool);
      const total = Math.max(0, (bag.get(tool) ?? 1) - 1); // shatter one tool
      total > 0 ? bag.set(tool, total) : bag.delete(tool);
      client.send('inv', { block: tool, total });
      client.send('durability', { tool, left: 0, max });
    } else {
      byTool.set(tool, left);
      client.send('durability', { tool, left, max });
    }
  }

  /** Generic "use node" action (right-clicking a node). Dispatch by block id — for now
   *  a chest opens its inventory; doors/furnace-nodes hook in here later. Reach-checked. */
  private onUse(client: Client, m: { x: number; y: number; z: number; held?: number }): void {
    const v = this.views.get(client.sessionId);
    if (!v) return;
    const x = Math.floor(m.x),
      y = Math.floor(m.y),
      z = Math.floor(m.z);
    if (![x, y, z].every(Number.isFinite)) return;
    const dx = x + 0.5 - v.px,
      dy = y + 0.5 - (v.py + 1.6),
      dz = z + 0.5 - v.pz;
    if (dx * dx + dy * dy + dz * dz > REACH * REACH) return;
    // A held bucket scoops/places liquids and ignores the block dispatch below.
    if (isBucket(m.held ?? 0)) {
      this.onBucket(client, x, y, z, m.held!);
      return;
    }
    // Flint & steel lights a fire in the aimed air cell (client sends the air cell,
    // like emptying a bucket) if a flammable block is next to it.
    if (isFlintSteel(m.held ?? 0)) {
      this.igniteFire(client, x, y, z);
      return;
    }
    const block = this.world.getBlock(x, y, z);
    if (block === CHEST_ID) this.sendChest(client, x, y, z);
    else if (block === DOOR_CLOSED || block === DOOR_OPEN) this.toggleDoor(x, y, z);
    else if (block === FENCE_GATE_CLOSED || block === FENCE_GATE_OPEN) this.toggleGate(x, y, z);
    else if (block === BED_ID) this.onSleep(client); // sleep → skip the night (shared clock)
    else if (block === FURNACE_ID) client.send('furnaceOpen', {}); // client opens the smelting UI
    else if (block === TNT_ID) this.igniteTnt(x, y, z); // light the fuse (2s → boom)
    // Hoe tills the ground into farmland so crops planted on top can grow: dirt/grass →
    // soil, sand/desert-sand → desert soil.
    else if (isHoe(m.held ?? 0)) {
      const soil = block === 2 || block === 1 ? SOIL : block === 7 || block === 8 ? DESERT_SOIL : 0;
      if (soil && this.world.setBlock(x, y, z, soil)) this.broadcastEdit(x, y, z, soil);
    }
  }

  /** Sleep in a bed: only at night. Advances the shared day clock to morning (Luanti /
   *  Minecraft) and realigns every client via a 'time' broadcast; day → a hint note. */
  private onSleep(client: Client): void {
    const tod = this.tod();
    if (tod >= 0.23 && tod <= 0.8) {
      client.send('note', { text: 'You can only sleep at night.' });
      return;
    }
    const target = 0.27; // just after dawn
    const frac = (((target - tod) % 1) + 1) % 1; // forward distance to morning
    this.timeShiftMs += frac * DAY_LENGTH_MS;
    this.broadcast('time', { now: this.serverNow(), dayLengthMs: DAY_LENGTH_MS });
    this.broadcast('note', { text: 'Good morning!' });
  }

  /** Toggle a fence gate open (non-solid, passable) ↔ closed (solid). Single cell. */
  private toggleGate(x: number, y: number, z: number): void {
    const to = this.world.getBlock(x, y, z) === FENCE_GATE_CLOSED ? FENCE_GATE_OPEN : FENCE_GATE_CLOSED;
    if (this.world.setBlock(x, y, z, to)) this.broadcastEdit(x, y, z, to);
  }

  /** Toggle a 2-tall door open/closed: flip every door cell in this vertical pair
   *  (the used cell + the one above/below) between DOOR_CLOSED and DOOR_OPEN. */
  private toggleDoor(x: number, y: number, z: number): void {
    const isDoor = (yy: number): boolean => {
      const b = this.world.getBlock(x, yy, z);
      return b === DOOR_CLOSED || b === DOOR_OPEN;
    };
    const to = this.world.getBlock(x, y, z) === DOOR_CLOSED ? DOOR_OPEN : DOOR_CLOSED;
    for (const yy of [y - 1, y, y + 1]) {
      if (isDoor(yy) && this.world.setBlock(x, yy, z, to)) this.broadcastEdit(x, yy, z, to);
    }
  }

  /** Bucket use: an empty bucket scoops a liquid SOURCE the player aims at (source→air,
   *  empty→filled bucket); a filled bucket pours its source into the aimed AIR cell
   *  (air→source, filled→empty bucket). Survival swaps the bucket item; creative is free. */
  private onBucket(client: Client, x: number, y: number, z: number, held: number): void {
    const sid = client.sessionId;
    const bag = this.inv.get(sid) ?? new Map<number, number>();
    this.inv.set(sid, bag);
    const creative = this.creative.has(sid);
    const have = (id: number): number => (creative ? Infinity : (bag.get(id) ?? 0));
    if (held === BUCKET_EMPTY) {
      const b = this.world.getBlock(x, y, z);
      const filled = b === WATER_SOURCE ? BUCKET_WATER : b === LAVA_SOURCE ? BUCKET_LAVA : 0;
      if (!filled || have(BUCKET_EMPTY) <= 0) return;
      if (!this.world.setBlock(x, y, z, 0)) return;
      this.broadcastEdit(x, y, z, 0);
      this.settleFluidsAt(x, y, z);
      if (!creative) this.swapItem(client, bag, BUCKET_EMPTY, filled);
    } else {
      if (this.world.getBlock(x, y, z) !== 0 || have(held) <= 0) return;
      const src = held === BUCKET_WATER ? WATER_SOURCE : LAVA_SOURCE;
      if (!this.world.setBlock(x, y, z, src)) return;
      this.broadcastEdit(x, y, z, src);
      this.settleFluidsAt(x, y, z);
      if (!creative) this.swapItem(client, bag, held, BUCKET_EMPTY);
    }
  }

  /** Consume one `from` item and add one `to` item, echoing both new counts (used by buckets). */
  private swapItem(client: Client, bag: Map<number, number>, from: number, to: number): void {
    const left = (bag.get(from) ?? 0) - 1;
    left > 0 ? bag.set(from, left) : bag.delete(from);
    client.send('inv', { block: from, total: Math.max(0, left) });
    const gained = (bag.get(to) ?? 0) + 1;
    bag.set(to, gained);
    client.send('inv', { block: to, total: gained });
  }

  /** Send a chest's current contents to the opening client (drives its chest UI). */
  private sendChest(client: Client, x: number, y: number, z: number): void {
    const c = chests.get(this.state.worldId, x, y, z);
    const items: Record<number, number> = {};
    c.forEach((count, id) => (items[id] = count));
    client.send('chestOpen', { x, y, z, items });
  }

  /** Move one whole stack of `id` between a chest and the player's inventory (dir
   *  'take' = chest→player, 'put' = player→chest). Reach- + type-checked, stack-capped,
   *  persisted; echoes the player's new count + the refreshed chest. */
  private onChestMove(client: Client, m: { x: number; y: number; z: number; id: number; dir: string }): void {
    const v = this.views.get(client.sessionId);
    const sid = client.sessionId;
    if (!v) return;
    const x = Math.floor(m.x),
      y = Math.floor(m.y),
      z = Math.floor(m.z);
    const id = m.id | 0;
    if (![x, y, z].every(Number.isFinite) || id <= 0) return;
    const dx = x + 0.5 - v.px,
      dy = y + 0.5 - (v.py + 1.6),
      dz = z + 0.5 - v.pz;
    if (dx * dx + dy * dy + dz * dz > REACH * REACH) return;
    if (this.world.getBlock(x, y, z) !== CHEST_ID) return;
    const bag = this.inv.get(sid) ?? new Map<number, number>();
    this.inv.set(sid, bag);
    const chest = chests.get(this.state.worldId, x, y, z);
    const move = (from: Map<number, number>, to: Map<number, number>): void => {
      const have = from.get(id) ?? 0;
      const room = STACK_MAX - (to.get(id) ?? 0);
      const n = Math.min(have, room);
      if (n <= 0) return;
      const left = have - n;
      left > 0 ? from.set(id, left) : from.delete(id);
      to.set(id, (to.get(id) ?? 0) + n);
    };
    if (m.dir === 'take') move(chest, bag);
    else if (m.dir === 'put') move(bag, chest);
    else return;
    chests.set(this.state.worldId, x, y, z, chest);
    client.send('inv', { block: id, total: bag.get(id) ?? 0 });
    this.sendChest(client, x, y, z);
  }

  /** Apply damage to a player, mitigated by equipped armour (defence points). */
  private damagePlayer(sid: string, p: VoxelPlayerSync, dmg: number): void {
    if (p.hp <= 0 || this.creative.has(sid)) return; // creative = invincible (no lava/mob/fall damage)
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
      now: this.serverNow(),
      dayLengthMs: DAY_LENGTH_MS,
      isAdmin: auth?.isAdmin ?? false, // gates the admin slash-commands in the chat /help
    });
    client.send('worlds', listWorlds()); // for the client's world dropdown
    client.send('signs', signs.all(this.state.worldId)); // all sign texts in this world (rendered in-world)
    // Server-side per-user settings (camera/auto-switch/wield transforms). Only
    // for logged-in users; anonymous clients keep their local settings.
    if (auth?.userId) {
      const saved = voxelSettings.get(auth.userId);
      if (saved) client.send('settings', saved);
      // Restore the player's persisted survival inventory (blocks/materials/tools).
      const bag = voxelInventory.get(auth.userId);
      if (bag && bag.size) {
        this.inv.set(client.sessionId, bag);
        const items: Record<number, number> = {};
        bag.forEach((c, id) => (items[id] = c));
        client.send('invAll', items);
      }
      // Restore per-tool durability + push it so the client shows the wear bars.
      const wear = voxelDurability.get(auth.userId);
      if (wear && wear.size) {
        this.wear.set(client.sessionId, wear);
        wear.forEach((left, tool) => client.send('durability', { tool, left, max: toolMaxUses(tool) }));
      }
    }
    // Everyone starts with a wooden pickaxe so they can bootstrap the tool progression
    // (hand-mine wood → planks → sticks → craft better tools). Only if they own no tool.
    const startBag = this.inv.get(client.sessionId) ?? new Map<number, number>();
    if (![...startBag.keys()].some((id) => id >= TOOL_BASE)) {
      startBag.set(STARTER_TOOL, 1);
      this.inv.set(client.sessionId, startBag);
      client.send('inv', { block: STARTER_TOOL, total: 1 });
    }
    this.streamAround(client, p.x, p.y, p.z);
  }

  onLeave(client: Client): void {
    // Remember where the player left off (logged-in), so they respawn there.
    const auth = client.auth as AuthInfo | undefined;
    const p = this.state.players.get(client.sessionId);
    if (auth?.userId && p) voxelPositions.set(auth.userId, this.state.worldId, p.x, p.y, p.z);
    // Persist the survival inventory so it survives reconnects (and carries across worlds).
    const bag = this.inv.get(client.sessionId);
    if (auth?.userId && bag) voxelInventory.set(auth.userId, bag);
    const wear = this.wear.get(client.sessionId);
    if (auth?.userId && wear) voxelDurability.set(auth.userId, wear); // persist half-worn tools
    if (p) this.dropFromViews(p); // drop the leaver from other clients' views
    this.state.players.delete(client.sessionId);
    this.views.delete(client.sessionId);
    this.inv.delete(client.sessionId);
    this.creative.delete(client.sessionId);
    this.wear.delete(client.sessionId);
    this.noWear.delete(client.sessionId);
    this.noHunger.delete(client.sessionId);
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
    const x = Math.max(-MAP_LIMIT, Math.min(MAP_LIMIT, Math.floor(m.x))) + 0.5; // Luanti map limit
    const z = Math.max(-MAP_LIMIT, Math.min(MAP_LIMIT, Math.floor(m.z))) + 0.5;
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

  private onEdit(client: Client, m: { x: number; y: number; z: number; id: number; tool?: number }): void {
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
    // Only placeable blocks (1..MAX_BLOCK_ID) or air (0). Materials/tools aren't placeable.
    if (id > MAX_BLOCK_ID) return;
    // Reach: within REACH of the player's eye (feet + ~1.6).
    const dx = x + 0.5 - v.px;
    const dy = y + 0.5 - (v.py + 1.6);
    const dz = z + 0.5 - v.pz;
    if (dx * dx + dy * dy + dz * dz > REACH * REACH) return;
    const prev = this.world.getBlock(x, y, z);
    const sid = client.sessionId;
    // Survival can't place liquid sources directly — that needs a filled bucket (see onBucket).
    // Creative keeps free water/lava placement as an ∞ build tool.
    if ((id === WATER_SOURCE || id === LAVA_SOURCE) && !this.creative.has(sid)) return;
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
    const key = `${x},${y},${z}`;
    // Planting a wheat seedling registers the cell so it grows over time.
    if (id === WHEAT_SEED && this.crops.size < 5000) this.crops.add(key);
    // Planting a sapling registers it (grows into a tree after a few ticks).
    if (id === SAPLING && this.saplings.size < 5000) this.saplings.set(key, 0);
    // Cutting a trunk (17): the tree does NOT fall (Luanti-faithful — everything stays
    // floating), but nearby leaves now check for a remaining trunk and decay if orphaned.
    if (id === 0 && prev === 17) {
      for (let dy = -3; dy <= 4; dy++)
        for (let dz = -3; dz <= 3; dz++)
          for (let dx = -3; dx <= 3; dx++) {
            if (this.world.getBlock(x + dx, y + dy, z + dz) === 21 && this.decayLeaves.size < 6000) this.decayLeaves.add(`${x + dx},${y + dy},${z + dz}`);
          }
    }
    // Cutting leaves (21) sometimes yields a sapling (Luanti-faithful).
    if (id === 0 && prev === 21 && Math.random() < 0.15) this.spawnDrop(SAPLING, x, y, z, 1);
    // Leaves sometimes yield an apple (Luanti apple trees → edible food).
    if (id === 0 && prev === 21 && Math.random() < 0.12) this.spawnDrop(APPLE, x, y, z, 1);
    // Breaking a real (non-fluid) block drops it as a collectible item (Luanti-style).
    // Ores drop a material item (coal/iron lump), not the ore block — see dropFor().
    // Crops are handled separately (custom harvest drops below), so skip them here.
    if (id === 0 && prev !== 0 && !isWaterId(prev) && !isLavaId(prev) && !isCrop(prev) && prev !== FIRE_ID) {
      const drop = prev === 6 && Math.random() < 0.15 ? FLINT : dropFor(prev); // gravel sometimes knaps flint (Luanti)
      this.spawnDrop(drop, x, y, z);
    }
    // Fire is transient state, not an item: putting it out (or overwriting it) unregisters it.
    if (prev === FIRE_ID && id !== FIRE_ID) this.fires.delete(key);
    // Breaking a sign clears its stored text (and the in-world label on every client).
    if (prev === SIGN_ID && id !== SIGN_ID) {
      signs.delete(this.state.worldId, x, y, z);
      this.broadcast('sign', { x, y, z, text: '' });
    }
    // Breaking a real block wears the tool used (one use); a depleted tool shatters.
    if (id === 0 && prev !== 0 && !isWaterId(prev) && !isLavaId(prev)) this.wearTool(client, sid, m.tool ?? 0);
    // Harvest wheat: mature (60) → 1-2 wheat + 1-2 seeds; immature → the seed back.
    if (id === 0 && isCrop(prev)) {
      this.crops.delete(key);
      if (prev === WHEAT_MATURE) {
        this.spawnDrop(WHEAT, x, y, z, 1 + Math.floor(Math.random() * 2));
        this.spawnDrop(WHEAT_SEED, x, y, z, 1 + Math.floor(Math.random() * 2));
      } else {
        this.spawnDrop(WHEAT_SEED, x, y, z, 1);
      }
    }
    // Cutting tall grass (51) sometimes yields a wheat seed (Luanti: grass → seeds).
    if (id === 0 && prev === 51 && Math.random() < 0.4) this.spawnDrop(WHEAT_SEED, x, y, z, 1);
    // A plant/crop/sapling resting on the block just broken loses its support → pops off
    // and drops (so decoration doesn't float when you mine the ground under it).
    if (id === 0 && prev !== 0) {
      const above = this.world.getBlock(x, y + 1, z);
      if (needsGround(above) && this.world.setBlock(x, y + 1, z, 0)) {
        this.broadcastEdit(x, y + 1, z, 0);
        this.spawnDrop(isCrop(above) ? WHEAT_SEED : dropFor(above), x, y + 1, z);
        const akey = `${x},${y + 1},${z}`;
        this.crops.delete(akey);
        this.saplings.delete(akey);
      }
    }
    // Breaking a chest spills its contents as drops, then clears the stored inventory.
    if (id === 0 && prev === CHEST_ID) {
      const c = chests.get(this.state.worldId, x, y, z);
      c.forEach((count, cid) => this.spawnDrop(cid, x, y, z, count));
      chests.delete(this.state.worldId, x, y, z);
    }
    // Placing a door: auto-add its top half (doors are 2-tall) if the cell above is air.
    if (id === DOOR_CLOSED && this.world.getBlock(x, y + 1, z) === 0) {
      this.world.setBlock(x, y + 1, z, DOOR_CLOSED);
      this.broadcastEdit(x, y + 1, z, DOOR_CLOSED);
    }
    // Breaking a door: remove its paired half too (the generic drop above already
    // dropped one door item, so the pair is removed silently).
    if (id === 0 && (prev === DOOR_CLOSED || prev === DOOR_OPEN)) {
      for (const dy of [-1, 1]) {
        const b = this.world.getBlock(x, y + dy, z);
        if ((b === DOOR_CLOSED || b === DOOR_OPEN) && this.world.setBlock(x, y + dy, z, 0)) this.broadcastEdit(x, y + dy, z, 0);
      }
    }
    this.settleFluidsAt(x, y, z);
  }

  /** Fluid flow: if a liquid touches this cell, recompute the local pool of THAT fluid
   *  to equilibrium (pours in / floods / recedes) and broadcast every resulting change.
   *  Water and lava settle independently (each treats the other as a wall). Then apply
   *  the Luanti cool_lava rule. Shared by block edits and bucket fill/empty. */
  private settleFluidsAt(x: number, y: number, z: number): void {
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

  /** Delete a persisted world (admin only; not the current world or the default). */
  private onDeleteWorld(client: Client, m: { world?: string }): void {
    const sys = (text: string): void => void client.send('m', { type: 'system', text });
    if (!(client.auth as AuthInfo).isAdmin) return sys('Deleting worlds is admin-only.');
    const id = (typeof m?.world === 'string' ? m.world : '').replace(/[^a-z0-9_-]/gi, '_').slice(0, 40);
    if (!id) return;
    if (id === this.state.worldId) return sys("You can't delete the world you're in.");
    if (id === 'default') return sys("The default world can't be deleted.");
    const ok = deleteWorld(id);
    sys(ok ? `Deleted world "${id}".` : `No such world: "${id}".`);
    this.broadcast('worlds', listWorlds()); // refresh everyone's world dropdown
  }

  /** Mint a per-world zone-voice LiveKit token (proximity identity `p<player.id>`). */
  private async onZoneVoiceToken(client: Client): Promise<void> {
    const p = this.state.players.get(client.sessionId);
    if (!p) return void client.send('m', { type: 'zoneVoiceToken', error: 'no-avatar' });
    if (!voiceConfigured()) return void client.send('m', { type: 'zoneVoiceToken', error: 'not-configured' });
    const room = voiceRoomName(this.voiceNs, `zv-vox-${this.state.worldId}`);
    const token = await mintVoiceToken(`p${p.id}`, p.name || 'player', room);
    if (token) client.send('m', { type: 'zoneVoiceToken', url: voiceUrl(), token, room });
  }

  /** Announce a voice state change (join/leave/mute/deafen) into the world chat. */
  private onVoiceEvent(client: Client, msg: { event?: string }): void {
    const p = this.state.players.get(client.sessionId);
    if (!p) return;
    const now = Date.now();
    if (now - (this.lastVoiceEventAt.get(client.sessionId) ?? 0) < 700) return; // rate-limit
    const name = p.name || 'player';
    const texts: Record<string, string> = {
      join: `${name} joined the voice chat.`,
      leave: `${name} left the voice chat.`,
      'mic-off': `${name} muted their mic.`,
      'mic-on': `${name} unmuted their mic.`,
      'deaf-on': `${name} muted sound.`,
      'deaf-off': `${name} unmuted sound.`,
    };
    const text = texts[msg?.event ?? ''];
    if (!text) return;
    this.lastVoiceEventAt.set(client.sessionId, now);
    this.broadcast('m', { type: 'system', text });
  }

  /** Slash commands — same registry/gating as the 2D world (shared `commands`). Client-only
   *  commands (/help) never reach here; account/admin ops use the shared user store. World-
   *  specific ones (afk) aren't modelled in the voxel world → a friendly note. */
  private onCommand(client: Client, msg: { name?: string; args?: string }): void {
    const sys = (text: string): void => void client.send('m', { type: 'system', text });
    const spec = findCommand(typeof msg?.name === 'string' ? msg.name : '');
    if (!spec) return sys('Unknown command. Try /help.');
    const me = client.auth as AuthInfo;
    if (!mayRunCommand(spec, me.isAdmin)) return sys(`/${spec.name} is for admins only.`);
    const args = (typeof msg?.args === 'string' ? msg.args : '').trim() ? msg.args!.trim().split(/\s+/) : [];
    const star = (uid: string): string => (userStore.get(uid)?.isAdmin ? ' ★' : '');
    switch (spec.name) {
      case 'afk':
        return sys('afk is only available in the 2D world.');
      case 'voxel':
        return sys('You are already in the voxel world.');
      case 'users': {
        if (args[0]?.toLowerCase() === 'all') {
          const users = userStore.list();
          return sys(users.length ? `All users (${users.length}):\n` + users.map((u) => `• ${UserStore.displayName(u)} (${u.userId})${star(u.userId)}`).join('\n') : 'No users registered.');
        }
        const here: string[] = [];
        this.state.players.forEach((p) => here.push(p.name));
        return sys(here.length ? `Players in this world (${here.length}):\n` + here.map((n) => `• ${n}`).join('\n') : 'No players here.');
      }
      case 'add': {
        const [loginId, password] = args;
        if (!loginId || !password) return sys(`Usage: ${spec.usage}`);
        if (!isValidPassword(password)) return sys(`Password must be at least ${MIN_PASSWORD_LEN} characters.`);
        if (userStore.exists(loginId)) return sys(`User "${normalizeLoginId(loginId)}" already exists.`);
        return sys(`Created user "${userStore.createUser(loginId, password).userId}".`);
      }
      case 'delete': {
        const loginId = normalizeLoginId(args[0]);
        if (!loginId) return sys(`Usage: ${spec.usage}`);
        if (loginId === me.userId) return sys(`You can't delete yourself.`);
        return sys(userStore.deleteUser(loginId) ? `Deleted user "${loginId}".` : `No such user: "${loginId}".`);
      }
      case 'set-admin':
      case 'remove-admin': {
        const loginId = normalizeLoginId(args[0]);
        if (!loginId) return sys(`Usage: ${spec.usage}`);
        if (!userStore.exists(loginId)) return sys(`No such user: "${loginId}".`);
        userStore.setAdmin(loginId, spec.name === 'set-admin');
        return sys(`"${loginId}" is ${spec.name === 'set-admin' ? 'now an admin' : 'no longer an admin'}.`);
      }
      case 'kick': {
        const loginId = normalizeLoginId(args[0]);
        if (!loginId) return sys(`Usage: ${spec.usage}`);
        let kicked = false;
        for (const c of this.clients) if ((c.auth as AuthInfo)?.userId === loginId) ((c.leave(KICK_CLOSE_CODE)), (kicked = true));
        return sys(kicked ? `Kicked "${loginId}".` : `"${loginId}" is not online in this world.`);
      }
    }
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
