/**
 * Voxel spike bootstrap — a browser Minecraft-style vertical slice, client-only:
 * a Three.js voxel world, three camera modes (isometric default · third · first
 * person), free AABB movement with gravity/jump, and break/place via a crosshair/
 * mouse raycast. Isolated behind its own page (voxel.html); the 2D game is
 * untouched. Server authority + multiplayer chunk sync are the next phase — this
 * is the foundation to evaluate the look and controls.
 */
import * as THREE from 'three';
import { CHUNK, chunkKey, toChunk, ZONES } from '@pixel/shared';
import { VoxelWorld } from './world.js';
import { buildChunkMesh } from './mesher.js';
import { Player, type MoveInput } from './player.js';
import { BLOCK_TEXTURES, PORTAL_ID } from './blocks.js';
import { type Item, ALL_ITEMS, TOOL_ITEMS, itemById, DEFAULT_HOTBAR } from './items.js';
import { loadBlockAtlas, SYNTHETIC, type Atlas } from './textures.js';
import { Avatar, type Wield, DEFAULT_WIELD } from './avatar.js';
import { makeCrackStages } from './crack.js';
import { connectVoxel, type VoxelNet } from './net.js';
import { gotoLogout } from '../net/room';
import { digTime } from './luanti.js';
import { openPicker, closePicker, pickerOpen } from './picker.js';

// The CC0 "Simple Skins" set staged under textures/player/skins/.
const SKINS = [...Array(31)].map((_, i) => `character_${i + 1}`).concat(['character_900']);
const itemTexUrl = (rel: string): string => new URL(`textures/${rel}.png`, document.baseURI).href;
const skinUrl = (name: string): string => new URL(`textures/player/skins/${name}.png`, document.baseURI).href;
const loadWield = (id: string): Wield => {
  try {
    return { ...DEFAULT_WIELD, ...(JSON.parse(localStorage.getItem('voxWield:' + id) ?? '{}') as Partial<Wield>) };
  } catch {
    return { ...DEFAULT_WIELD };
  }
};

type CamMode = 'iso' | 'third' | 'first';

const canvas = document.getElementById('gl') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x8fc7ff);
// Fog gives depth; all modes are perspective now (iso is a perspective 3/4 view).
const perspFog = new THREE.Fog(0x8fc7ff, 24, 120);

// World + per-chunk meshes. Chunks are streamed from the server (or the offline
// fallback); each loaded chunk is its own mesh under terrainGroup so an edit only
// rebuilds the affected chunk. Boundary faces are re-culled by remeshing loaded
// neighbours. A dirty-set is flushed (capped) each frame to smooth the join burst.
const world = new VoxelWorld();
const material = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, alphaTest: 0.5 });
let atlas: Atlas | null = null;
const terrainGroup = new THREE.Group();
scene.add(terrainGroup);
const chunkMeshes = new Map<string, THREE.Mesh>();
const dirty = new Set<string>();
const NEIGHBORS = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];
function markDirty(cx: number, cy: number, cz: number): void {
  dirty.add(chunkKey(cx, cy, cz));
  for (const [dx, dy, dz] of NEIGHBORS) if (world.hasChunk(cx + dx, cy + dy, cz + dz)) dirty.add(chunkKey(cx + dx, cy + dy, cz + dz));
}
function remeshChunk(cx: number, cy: number, cz: number): void {
  const key = chunkKey(cx, cy, cz);
  const existing = chunkMeshes.get(key);
  const geo = atlas ? buildChunkMesh(world, atlas, cx, cy, cz) : null;
  if (!geo) {
    if (existing) {
      terrainGroup.remove(existing);
      existing.geometry.dispose();
      chunkMeshes.delete(key);
    }
    return;
  }
  if (existing) {
    existing.geometry.dispose();
    existing.geometry = geo;
  } else {
    const m = new THREE.Mesh(geo, material);
    chunkMeshes.set(key, m);
    terrainGroup.add(m);
  }
}
/** Remesh up to `cap` dirty chunks per frame (rest wait for the next frame). */
function flushDirty(cap = 12): void {
  if (!atlas || dirty.size === 0) return;
  let n = 0;
  for (const key of dirty) {
    const [cx, cy, cz] = key.split(',').map(Number);
    remeshChunk(cx, cy, cz);
    dirty.delete(key);
    if (++n >= cap) break;
  }
}
void loadBlockAtlas(BLOCK_TEXTURES, SYNTHETIC).then((a) => {
  atlas = a;
  material.map = a.texture;
  material.needsUpdate = true;
  for (const key of world.keys()) dirty.add(key); // mesh everything already streamed
});

// Clouds: a big semi-transparent plane high above that follows the player and
// drifts slowly (cheap, always in view — no cloud blocks / extra streaming).
function makeCloudTexture(): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 256;
  const c = cv.getContext('2d')!;
  let seed = 20240607;
  const rnd = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 34; i++) {
    const x = rnd() * 256,
      y = rnd() * 256,
      r = 16 + rnd() * 40;
    const g = c.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(255,255,255,0.9)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g;
    c.fillRect(x - r, y - r, r * 2, r * 2);
  }
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(6, 6);
  return t;
}
const cloudTex = makeCloudTexture();
const clouds = new THREE.Mesh(
  new THREE.PlaneGeometry(600, 600),
  new THREE.MeshBasicMaterial({ map: cloudTex, transparent: true, opacity: 0.65, depthWrite: false }),
);
clouds.rotation.x = -Math.PI / 2;
clouds.position.y = 70;
clouds.renderOrder = -1;
scene.add(clouds);

// Player + avatar. Spawn comes from the server 'welcome' (or the offline
// fallback); physics is gated until the ground chunk under the feet has loaded.
const player = new Player(world);
player.yaw = -Math.PI / 4; // face into the iso view by default
let spawn = { x: 0.5, y: 24, z: 0.5 };
let ready = false; // don't simulate/fall until the spawn column is loaded
let playerSkin = 'character_1';
try {
  playerSkin = localStorage.getItem('voxSkin') || 'character_1';
} catch {
  /* ignore */
}
const avatar = new Avatar(playerSkin);
scene.add(avatar.group);

// ── Networking: server chunks + authoritative edits + remote players ──────────
interface RemotePlayer {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  skin: string;
}
interface RemoteState {
  players: { forEach(cb: (p: RemotePlayer, k: string) => void): void; get(k: string): RemotePlayer | undefined };
}
const remote = new Map<string, { avatar: Avatar; px: number; pz: number }>();

function onWelcome(m: unknown): void {
  const w = m as { spawn?: { x: number; y: number; z: number } };
  if (w.spawn) {
    spawn = w.spawn;
    ready = false; // re-gate until the new spawn column is loaded
  }
}
function onChunk(c: { cx: number; cy: number; cz: number; cells: Uint8Array }): void {
  world.setChunk(c.cx, c.cy, c.cz, c.cells);
  markDirty(c.cx, c.cy, c.cz);
}
function onUnload(cx: number, cy: number, cz: number): void {
  world.dropChunk(cx, cy, cz);
  const key = chunkKey(cx, cy, cz);
  const mesh = chunkMeshes.get(key);
  if (mesh) {
    terrainGroup.remove(mesh);
    mesh.geometry.dispose();
    chunkMeshes.delete(key);
  }
  dirty.delete(key);
}
function onServerEdit(e: { x: number; y: number; z: number; id: number }): void {
  world.set(e.x, e.y, e.z, e.id);
  markDirty(toChunk(e.x), toChunk(e.y), toChunk(e.z));
}
/** Reconcile remote-player avatars from the room state each frame. */
function syncRemotePlayers(dt: number): void {
  if (!net) return;
  const state = net.room.state as unknown as RemoteState;
  const mySid = net.sessionId;
  state.players.forEach((p, sid) => {
    if (sid === mySid) return;
    let r = remote.get(sid);
    if (!r) {
      const a = new Avatar(p.skin || 'character_1');
      scene.add(a.group);
      r = { avatar: a, px: p.x, pz: p.z };
      remote.set(sid, r);
    }
    const speed = Math.hypot(p.x - r.px, p.z - r.pz) / Math.max(dt, 0.001);
    r.px = p.x;
    r.pz = p.z;
    r.avatar.group.position.set(p.x, p.y, p.z);
    r.avatar.group.rotation.y = p.yaw;
    r.avatar.animate(dt, speed, p.pitch);
  });
  for (const [sid, r] of remote) {
    if (!state.players.get(sid)) {
      scene.remove(r.avatar.group);
      remote.delete(sid);
    }
  }
}

// Cameras
const persp = new THREE.PerspectiveCamera(75, 1, 0.1, 500);
let mode: CamMode = 'iso';
let isoDist = 16; // iso camera distance (perspective 3/4 view, like third; wheel zooms)
let thirdDist = 4.6; // 3rd-person camera distance (mouse-wheel zooms it)
let isoYaw = -Math.PI / 4; // iso camera orbit yaw (RMB-drag rotates the map)
let isoPitch = 0.687; // iso camera tilt above the horizon (RMB-drag, free up/down)
let camYaw = 0; // third-person camera orbit (RMB-drag)
let camPitch = 0.35;
const camRay = new THREE.Raycaster(); // pulls the 3rd-person camera in past blocks
// User settings (persisted). invertY + camera collision default on; auto-switch
// tool default OFF (Minecraft is manual; auto-switch is the optional mod-like aid).
const settings = { invertY: true, camCollide: true, autoTool: false };
try {
  Object.assign(settings, JSON.parse(localStorage.getItem('voxSettings') ?? '{}') as Partial<typeof settings>);
} catch {
  /* ignore bad storage */
}
let net: VoxelNet | null = null; // set once connected; null = offline (local only)
function saveSettings(): void {
  try {
    localStorage.setItem('voxSettings', JSON.stringify(settings));
  } catch {
    /* ignore */
  }
  pushSettings();
}
let moveTarget: THREE.Vector3 | null = null; // iso click-to-walk destination
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

function resize(): void {
  renderer.setSize(window.innerWidth, window.innerHeight);
  persp.aspect = window.innerWidth / window.innerHeight;
  persp.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

function activeCam(): THREE.Camera {
  return persp; // perspective in every mode now (iso is a perspective 3/4 view)
}
function placeCamera(): void {
  scene.fog = perspFog; // perspective in every mode now
  const eye = player.eye;
  if (mode === 'first') {
    persp.position.copy(eye);
    persp.rotation.set(player.pitch, player.yaw, 0, 'YXZ');
  } else {
    // iso + third are both perspective orbits around the player. iso uses
    // isoYaw/isoPitch + isoDist (map-rotate via RMB, click-to-walk, character
    // faces its move direction); third uses camYaw/camPitch + thirdDist (faces
    // away from the camera). Both cast eye→camera and pull in past blocks, so the
    // camera never clips through terrain (handles zoom AND rotation).
    const yaw = mode === 'iso' ? isoYaw : camYaw;
    const pitch = mode === 'iso' ? isoPitch : camPitch;
    const cp = Math.cos(pitch),
      sp = Math.sin(pitch);
    const dir = new THREE.Vector3(Math.sin(yaw) * cp, sp, Math.cos(yaw) * cp); // eye → camera
    let dist = mode === 'iso' ? isoDist : thirdDist;
    if (settings.camCollide && terrainGroup.children.length) {
      camRay.set(eye, dir);
      camRay.far = dist;
      const hit = camRay.intersectObjects(terrainGroup.children, false)[0];
      if (hit) dist = Math.max(0.5, hit.distance - 0.25);
    }
    persp.position.copy(eye).addScaledVector(dir, dist);
    persp.lookAt(eye);
  }
  // Real 3D body in every view. First person sits the camera at the eye: hide the
  // head, and fade the body to see-through when looking down so it doesn't block
  // the view (positive pitch = up, negative = down).
  avatar.group.visible = true;
  avatar.setFirstPerson(mode === 'first');
  if (mode === 'first') {
    const down = Math.max(0, -player.pitch - 0.3); // grows once you look below ~-0.3
    avatar.setOpacity(clamp(1 - down * 1.2, 0.15, 1));
  } else avatar.setOpacity(1);
  avatar.group.position.set(player.pos.x, player.pos.y, player.pos.z);
  avatar.group.rotation.y = player.yaw;
}

// ── Input ───────────────────────────────────────────────────────────────────
const keys = new Set<string>();
window.addEventListener('keydown', (e) => {
  if (e.code === 'Escape' && pickerOpen()) return closePicker();
  if (e.code === 'Escape' && settingsOpen()) return closeSettings();
  if (e.code === 'KeyO') return settingsOpen() ? closeSettings() : openSettings();
  if (e.code === 'KeyV') return cycleMode();
  if (e.code === 'KeyB') return pickerOpen() ? closePicker() : openItemPicker();
  if (e.code === 'KeyK') return pickerOpen() ? closePicker() : openSkinPicker();
  if (e.code === 'KeyE' && !pickerOpen()) return placeBlock(); // place a block (Q breaks, held)
  if (e.code === 'KeyP' && !menuOpen()) return makePortal(); // mark aimed block as a portal
  const n = Number(e.key);
  if (n >= 1 && n <= hotbar.length) selectSlot(n - 1);
  keys.add(e.code);
});
window.addEventListener('keyup', (e) => keys.delete(e.code));

const pointerNDC = new THREE.Vector2(0, 0); // cursor pos (iso) → target for E/Q + click-to-walk
const locked = (): boolean => document.pointerLockElement === canvas;
const menuOpen = (): boolean => pickerOpen() || settingsOpen();
let rotating = false; // RMB held → free-orbit the camera (iso + third)
const ndc = (e: MouseEvent): THREE.Vector2 =>
  new THREE.Vector2((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);

canvas.addEventListener('mousemove', (e) => {
  if (mode === 'first') {
    if (locked()) player.setLook(-e.movementX * 0.0022, -e.movementY * 0.0022);
    return;
  }
  // RMB free-orbit: yaw (left/right) + pitch (up/down) in both iso and third.
  if (rotating) {
    const invY = settings.invertY ? 1 : -1;
    if (mode === 'iso') {
      isoYaw -= e.movementX * 0.006;
      isoPitch = clamp(isoPitch - e.movementY * 0.005 * invY, 0.2, 1.45);
    } else {
      camYaw -= e.movementX * 0.006;
      camPitch = clamp(camPitch + e.movementY * 0.005 * invY, -0.15, 1.25);
    }
  }
  // Track the cursor (iso + third); E/Q place/break at whatever it's over.
  pointerNDC.copy(ndc(e));
});
let firstBreakHeld = false; // first-person LMB held → break (progress in the loop)
canvas.addEventListener('mousedown', (e) => {
  if (mode === 'first') {
    if (settingsOpen()) return; // don't grab pointer-lock / dig while tuning
    if (!locked()) return void canvas.requestPointerLock();
    if (e.button === 0) firstBreakHeld = true;
    else if (e.button === 2) placeBlock();
    return;
  }
  // iso / third: RIGHT button orbits the camera (allowed even with a menu open,
  // so you can view the wield while adjusting it). LEFT button (iso) walks.
  if (e.button === 2) rotating = true;
});
window.addEventListener('mouseup', (e) => {
  if (e.button === 2) rotating = false; // end camera orbit
  if (mode === 'first') {
    if (e.button === 0) firstBreakHeld = false;
    return;
  }
  // Left-click walks — but only when it lands on the WORLD (canvas), not on UI
  // (clicking the gear / dragging the settings window must not move the player),
  // and not while a menu is open.
  if (e.button === 0 && mode === 'iso' && e.target === canvas && !menuOpen()) clickToMove(ndc(e));
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('wheel', (e) => {
  // Zoom = camera distance in both perspective orbit modes.
  const f = e.deltaY > 0 ? 1.12 : 0.9;
  if (mode === 'iso') {
    isoDist = clamp(isoDist * f, 3, 45);
  } else if (mode === 'third') {
    thirdDist = clamp(thirdDist * f, 1.0, 14); // closer over-the-shoulder
  }
  e.preventDefault();
});

/** Raycast the ground under the cursor → an auto-walk destination (iso click). */
function clickToMove(p: THREE.Vector2): void {
  raycaster.setFromCamera(p, activeCam());
  const hits = raycaster.intersectObjects(terrainGroup.children, false);
  if (!hits.length) return;
  const hit = hits[0].point.clone().addScaledVector(hits[0].face?.normal ?? new THREE.Vector3(0, 1, 0), -0.5);
  moveTarget = new THREE.Vector3(Math.floor(hit.x) + 0.5, 0, Math.floor(hit.z) + 0.5);
}

function cycleMode(): void {
  mode = mode === 'iso' ? 'third' : mode === 'third' ? 'first' : 'iso';
  moveTarget = null;
  rotating = false;
  if (mode !== 'first' && locked()) document.exitPointerLock();
  updateHud();
}

// ── Break / place via raycast ────────────────────────────────────────────────
// Reach is measured from the player, not the camera (the iso/third cams sit far
// back, so a camera-distance check would reject every edit). iso + third aim at
// the cursor; first person aims from screen centre. Placing (E / RMB) is instant;
// breaking (held Q / LMB) fills a progress bar with a crack overlay on the block.
const raycaster = new THREE.Raycaster();
const REACH = 7; // max build distance from the player (blocks)
const CENTER = new THREE.Vector2(0, 0);
const UP = new THREE.Vector3(0, 1, 0);

/** The best tool the player is carrying (a hotbar tool) for a block, or undefined
 *  if none helps. Used by auto-switch and the dig-time calc. */
function bestToolFor(blockId: number): string | undefined {
  let best: string | undefined;
  let bestT = Infinity;
  for (const id of hotbar) {
    const tool = itemById(id).tool;
    if (!tool) continue;
    const t = digTime(blockId, [tool]);
    if (t !== null && t < bestT) {
      bestT = t;
      best = tool;
    }
  }
  return best;
}
/** Tool(s) used to dig a block right now: auto-switch picks the best carried
 *  tool; otherwise it's whatever is held (a block = bare hand). */
function digToolsFor(blockId: number): string[] {
  if (settings.autoTool) {
    const best = bestToolFor(blockId);
    if (best) return [best];
  }
  const held = itemById(hotbar[selectedSlot]).tool;
  return held ? [held] : [];
}

const crackStages = makeCrackStages(6);
const breakOverlay = new THREE.Mesh(
  new THREE.BoxGeometry(1.03, 1.03, 1.03),
  new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }),
);
breakOverlay.visible = false;
scene.add(breakOverlay);
let breaking: { x: number; y: number; z: number; t: number; dur: number } | null = null;

/** First hit of the aim ray, if within reach — or null. */
function aimHit(): THREE.Intersection | null {
  raycaster.setFromCamera(mode === 'first' ? CENTER : pointerNDC, activeCam());
  const hits = raycaster.intersectObjects(terrainGroup.children, false);
  if (!hits.length || hits[0].point.distanceTo(player.eye) > REACH) return null;
  return hits[0];
}

/** Place the held block against the aimed face (instant). Tools don't place. */
function placeBlock(): void {
  const block = itemById(hotbar[selectedSlot]).block;
  if (block === undefined) return; // holding a tool → nothing to place
  const h = aimHit();
  if (!h) return;
  const nrm = h.face ? h.face.normal : UP;
  const p = h.point.clone().addScaledVector(nrm, 0.5);
  const bx = Math.floor(p.x),
    by = Math.floor(p.y),
    bz = Math.floor(p.z);
  // Don't place inside yourself — that would embed the AABB and lock movement.
  if (world.solid(bx, by, bz) || player.intersectsBlock(bx, by, bz)) return;
  avatar.playDig();
  if (net) {
    net.sendEdit(bx, by, bz, block); // authoritative — applied when the server echoes
  } else {
    world.set(bx, by, bz, block);
    markDirty(toChunk(bx), toChunk(by), toChunk(bz));
  }
  // Placing a portal cube → ask for its destination and register it (you stand on it to jump).
  if (block === PORTAL_ID) promptPortal(bx, by, bz);
}

/** Continue breaking the aimed block while the break control is held. */
function updateBreaking(dt: number, want: boolean): void {
  const h = want ? aimHit() : null;
  let tgt: { x: number; y: number; z: number } | null = null;
  if (h) {
    const nrm = h.face ? h.face.normal : UP;
    const p = h.point.clone().addScaledVector(nrm, -0.5);
    const x = Math.floor(p.x),
      y = Math.floor(p.y),
      z = Math.floor(p.z);
    if (world.solid(x, y, z)) tgt = { x, y, z };
  }
  // Dig time from the held/auto tool + block group (Luanti data). null = the tool
  // is too weak (e.g. steel pick on a diamond block) → can't break it.
  const dur = tgt ? digTime(world.get(tgt.x, tgt.y, tgt.z), digToolsFor(world.get(tgt.x, tgt.y, tgt.z))) : null;
  if (!tgt || dur === null) {
    breaking = null;
    breakOverlay.visible = false;
    avatar.setMining(false);
    return;
  }
  if (!breaking || breaking.x !== tgt.x || breaking.y !== tgt.y || breaking.z !== tgt.z) breaking = { ...tgt, t: 0, dur };
  breaking.t += dt;
  avatar.setMining(true);
  breakOverlay.position.set(tgt.x + 0.5, tgt.y + 0.5, tgt.z + 0.5);
  breakOverlay.visible = true;
  const stage = Math.min(crackStages.length - 1, Math.floor((breaking.t / breaking.dur) * crackStages.length));
  const mat = breakOverlay.material as THREE.MeshBasicMaterial;
  if (mat.map !== crackStages[stage]) {
    mat.map = crackStages[stage];
    mat.needsUpdate = true;
  }
  if (breaking.t >= breaking.dur) {
    if (net) {
      net.sendEdit(tgt.x, tgt.y, tgt.z, 0); // authoritative break — server confirms
    } else {
      world.set(tgt.x, tgt.y, tgt.z, 0);
      markDirty(toChunk(tgt.x), toChunk(tgt.y), toChunk(tgt.z));
    }
    breaking = null;
    breakOverlay.visible = false;
    avatar.setMining(false);
  }
}

// ── HUD (crosshair + hotbar + pickers) ────────────────────────────────────────
// Hotbar holds 9 item ids (tools + blocks). The selected slot is what the avatar
// holds and what drives digging (tool → its speed, block → bare hand) + placing
// (blocks only). Number keys pick a slot; the "b" picker swaps a slot to any item.
const hotbar = [...DEFAULT_HOTBAR];
let selectedSlot = 0;
const held = (): Item => itemById(hotbar[selectedSlot]);
function selectSlot(i: number): void {
  selectedSlot = (i + hotbar.length) % hotbar.length;
  updateHud();
  refreshEditor();
}
function updateHud(): void {
  const label = document.getElementById('mode');
  if (label) label.textContent = `View: ${mode} (V) · Item: ${held().name} · B items · K skin`;
  const bar = document.getElementById('hotbar')!;
  bar.innerHTML = '';
  hotbar.forEach((id, i) => {
    const it = itemById(id);
    const s = document.createElement('div');
    s.className = 'slot' + (i === selectedSlot ? ' on' : '');
    s.style.backgroundImage = `url(${itemTexUrl(it.texUrl)})`;
    s.style.backgroundSize = 'cover';
    s.title = it.name;
    s.onclick = () => selectSlot(i);
    bar.appendChild(s);
  });
  document.getElementById('cross')!.style.display = mode === 'first' ? 'block' : 'none';
}

function openItemPicker(): void {
  if (locked()) document.exitPointerLock();
  openPicker(
    'Items — click to put in slot ' + (selectedSlot + 1),
    ALL_ITEMS.map((it) => ({
      thumb: itemTexUrl(it.texUrl),
      label: it.name,
      selected: it.id === hotbar[selectedSlot],
      onPick: () => {
        hotbar[selectedSlot] = it.id;
        updateHud();
        refreshEditor();
        closePicker();
      },
    })),
  );
}

// Wield sync: the avatar holds the selected item (rebuilt only when it changes);
// during an auto-switch break it shows the tool actually being used.
let wieldedId = '';
function setWielded(it: Item): void {
  if (it.id === wieldedId) return;
  wieldedId = it.id;
  avatar.wield(it.texUrl, it.pivot, loadWield(it.id));
}
function updateWield(): void {
  if (settings.autoTool && breaking && !settingsOpen()) {
    const tool = bestToolFor(world.get(breaking.x, breaking.y, breaking.z));
    const ti = tool ? TOOL_ITEMS.find((i) => i.tool === tool) : undefined;
    if (ti) return setWielded(ti);
  }
  setWielded(held());
}
updateHud();
function openSkinPicker(): void {
  if (locked()) document.exitPointerLock();
  openPicker(
    'Player skin',
    SKINS.map((name) => ({
      thumb: skinUrl(name),
      label: name.replace('character_', '#'),
      onPick: () => {
        playerSkin = name;
        avatar.setSkin(name);
        try {
          localStorage.setItem('voxSkin', name);
        } catch {
          /* ignore */
        }
        net?.room.send('setSkin', name); // let other players see the new skin
        pushSettings(); // persist per-user server-side
        closePicker();
      },
    })),
  );
}

// ── Settings menu ─────────────────────────────────────────────────────────────
const settingsPanel = document.getElementById('settings') as HTMLElement;
const settingsOpen = (): boolean => !settingsPanel.hidden;
function openSettings(): void {
  settingsPanel.hidden = false;
  rotating = false; // cancel any in-progress camera drag / break so the world stays put
  firstBreakHeld = false;
  if (locked()) document.exitPointerLock();
}
function closeSettings(): void {
  settingsPanel.hidden = true;
}
document.getElementById('settings-btn')!.onclick = () => (settingsOpen() ? closeSettings() : openSettings());
document.getElementById('settings-close')!.onclick = closeSettings;

// Make the settings window draggable by its title bar (free placement so it need
// not cover the centred character). Uses its own listeners; the world handlers
// ignore input while the menu is open, so dragging never moves the player.
const dragHandle = settingsPanel.querySelector('h3') as HTMLElement;
let dragOff: { x: number; y: number } | null = null;
dragHandle.addEventListener('mousedown', (e) => {
  const r = settingsPanel.getBoundingClientRect();
  settingsPanel.style.left = `${r.left}px`;
  settingsPanel.style.top = `${r.top}px`;
  settingsPanel.style.transform = 'none';
  dragOff = { x: e.clientX - r.left, y: e.clientY - r.top };
  e.preventDefault();
});
window.addEventListener('mousemove', (e) => {
  if (!dragOff) return;
  settingsPanel.style.left = `${e.clientX - dragOff.x}px`;
  settingsPanel.style.top = `${e.clientY - dragOff.y}px`;
});
window.addEventListener('mouseup', () => (dragOff = null));

// Tabs: switch the settings pages (Camera / Items).
const tabBtns = [...settingsPanel.querySelectorAll('#tabs .tab')] as HTMLButtonElement[];
const pages = [...settingsPanel.querySelectorAll('.page')] as HTMLElement[];
for (const t of tabBtns) {
  t.onclick = () => {
    for (const b of tabBtns) b.classList.toggle('on', b === t);
    for (const p of pages) p.hidden = p.dataset.page !== t.dataset.tab;
  };
}

// Camera page: invert Y-axis + camera collision (both persisted).
const invertYCb = document.getElementById('opt-inverty') as HTMLInputElement;
const camCollideCb = document.getElementById('opt-camcollide') as HTMLInputElement;
invertYCb.checked = settings.invertY;
camCollideCb.checked = settings.camCollide;
invertYCb.onchange = () => {
  settings.invertY = invertYCb.checked;
  saveSettings();
};
camCollideCb.onchange = () => {
  settings.camCollide = camCollideCb.checked;
  saveSettings();
};

// Items page. Auto-switch tool toggle (default off = Minecraft-manual).
const autoToolCb = document.getElementById('opt-autotool') as HTMLInputElement;
autoToolCb.checked = settings.autoTool;
autoToolCb.onchange = () => {
  settings.autoTool = autoToolCb.checked;
  saveSettings();
};

// Wield editor: tunes how the CURRENTLY HELD item attaches to the hand; the ‹ ›
// buttons step the held hotbar slot through all items. Persisted per item id.
const WIELD_FIELDS: { k: keyof Wield; label: string; min: number; max: number; step: number }[] = [
  { k: 'px', label: 'Pos X', min: -8, max: 8, step: 0.1 },
  { k: 'py', label: 'Pos Y', min: -8, max: 8, step: 0.1 },
  { k: 'pz', label: 'Pos Z', min: -8, max: 8, step: 0.1 },
  { k: 'rx', label: 'Rot X', min: -3.2, max: 3.2, step: 0.02 },
  { k: 'ry', label: 'Rot Y', min: -3.2, max: 3.2, step: 0.02 },
  { k: 'rz', label: 'Rot Z', min: -3.2, max: 3.2, step: 0.02 },
  { k: 's', label: 'Scale', min: 1, max: 12, step: 0.1 },
];
const wInputs: Record<string, HTMLInputElement> = {};
const wVals: Record<string, HTMLSpanElement> = {};
let wield: Wield = loadWield(held().id);
const showValues = (): void => void (document.getElementById('hand-values')!.textContent = JSON.stringify(wield));
function applyWield(): void {
  avatar.setWieldTransform(wield);
  showValues();
  try {
    localStorage.setItem('voxWield:' + held().id, JSON.stringify(wield));
  } catch {
    /* ignore */
  }
  pushSettings();
}
function syncSliders(): void {
  for (const f of WIELD_FIELDS) {
    wInputs[f.k].value = String(wield[f.k]);
    wVals[f.k].textContent = wield[f.k].toFixed(2);
  }
}
// Reload the editor for whatever item is currently held (slot change / picker / ‹ ›).
function refreshEditor(): void {
  wield = loadWield(held().id);
  document.getElementById('item-name')!.textContent = held().name;
  syncSliders();
  showValues();
}
const slidersBox = document.getElementById('hand-sliders')!;
for (const f of WIELD_FIELDS) {
  const row = document.createElement('label');
  const name = document.createElement('span');
  name.textContent = f.label;
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(f.min);
  input.max = String(f.max);
  input.step = String(f.step);
  const val = document.createElement('span');
  input.oninput = () => {
    wield[f.k] = Number(input.value);
    val.textContent = wield[f.k].toFixed(2);
    applyWield();
  };
  wInputs[f.k] = input;
  wVals[f.k] = val;
  row.append(name, input, val);
  slidersBox.appendChild(row);
}
function stepItem(dir: number): void {
  const i = ALL_ITEMS.findIndex((it) => it.id === hotbar[selectedSlot]);
  hotbar[selectedSlot] = ALL_ITEMS[(i + dir + ALL_ITEMS.length) % ALL_ITEMS.length].id;
  updateHud();
  refreshEditor();
}
document.getElementById('item-prev')!.onclick = () => stepItem(-1);
document.getElementById('item-next')!.onclick = () => stepItem(1);
const copyBtn = document.getElementById('hand-copy') as HTMLButtonElement;
copyBtn.onclick = () => {
  void navigator.clipboard?.writeText(JSON.stringify(wield));
  copyBtn.textContent = 'Copied!';
  window.setTimeout(() => (copyBtn.textContent = 'Copy values'), 1200);
};
document.getElementById('hand-reset')!.onclick = () => {
  wield = { ...DEFAULT_WIELD };
  syncSliders();
  applyWield();
};
refreshEditor(); // initialise for the held item

// ── Server sync of settings (per-user, requires login) ───────────────────────
// Build the full settings blob (toggles + every per-item wield transform) from
// local state; the server stores it per account and returns it on next login.
function currentSettingsBlob(): unknown {
  const wield: Record<string, unknown> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k?.startsWith('voxWield:')) {
      try {
        wield[k.slice('voxWield:'.length)] = JSON.parse(localStorage.getItem(k) ?? 'null');
      } catch {
        /* skip bad entry */
      }
    }
  }
  return { invertY: settings.invertY, camCollide: settings.camCollide, autoTool: settings.autoTool, skin: playerSkin, wield };
}
let pushTimer = 0;
function pushSettings(): void {
  if (!net) return; // offline / anonymous → local only
  window.clearTimeout(pushTimer);
  pushTimer = window.setTimeout(() => net?.saveSettings(currentSettingsBlob()), 400);
}
// Apply settings that arrive from the server (on login) over the local defaults.
function applyServerSettings(s: unknown): void {
  const o = s as Partial<{
    invertY: boolean;
    camCollide: boolean;
    autoTool: boolean;
    skin: string;
    wield: Record<string, Wield>;
  }> | null;
  if (!o || typeof o !== 'object') return;
  if (typeof o.invertY === 'boolean') settings.invertY = o.invertY;
  if (typeof o.camCollide === 'boolean') settings.camCollide = o.camCollide;
  if (typeof o.autoTool === 'boolean') settings.autoTool = o.autoTool;
  invertYCb.checked = settings.invertY;
  camCollideCb.checked = settings.camCollide;
  autoToolCb.checked = settings.autoTool;
  if (typeof o.skin === 'string') {
    playerSkin = o.skin;
    avatar.setSkin(o.skin);
    net?.room.send('setSkin', o.skin);
  }
  if (o.wield && typeof o.wield === 'object') {
    for (const [id, w] of Object.entries(o.wield)) {
      try {
        localStorage.setItem('voxWield:' + id, JSON.stringify(w));
      } catch {
        /* ignore */
      }
    }
  }
  refreshEditor(); // reload the held item's (possibly server-provided) transform
}
// ── World connect + multiworld switching ──────────────────────────────────────
const worldHandlers = { onSettings: applyServerSettings, onWelcome, onChunk, onUnload, onEdit: onServerEdit, onPortal, onWorlds };
let currentWorld = 'default';
let lastJump = 0;
/** Jump to a portal destination: another voxel world (seamless) or the 2D client. */
function jumpTo(dest: unknown): void {
  const now = performance.now();
  if (now - lastJump < 1500) return; // debounce so arriving doesn't re-trigger
  lastJump = now;
  const d = dest as { kind?: string; world?: string; seed?: number; id?: string };
  if (d?.kind === 'voxel' && d.world) void connectWorld(d.world, Number.isFinite(d.seed) ? d.seed : undefined);
  else if (d?.kind === 'zone') window.location.href = './'; // 2D client (session carries; zone-targeting is TODO)
}
function onPortal(dest: unknown): void {
  jumpTo(dest);
}
/** Mark the aimed block as a portal (server stores it; stepping on it jumps). */
function promptPortal(x: number, y: number, z: number): void {
  if (!net) return;
  const ans = window.prompt('Portal target — "world:<id>" or "zone:<id>":', 'world:dungeon1');
  if (!ans) return;
  const i = ans.indexOf(':');
  const kind = ans.slice(0, i).trim();
  const val = ans.slice(i + 1).trim();
  const dest = kind === 'world' && val ? { kind: 'voxel', world: val } : kind === 'zone' && val ? { kind: 'zone', id: val } : null;
  if (dest) net.setPortal(x, y, z, dest);
}
/** Re-target the aimed block as a portal (P key) — handy for existing blocks. */
function makePortal(): void {
  const h = aimHit();
  if (!h) return;
  const p = h.point.clone().addScaledVector(h.face ? h.face.normal : UP, -0.5);
  promptPortal(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
}
const worldLabel = document.getElementById('world-current');
function goOffline(): void {
  world.generateLocalFallback();
  for (const key of world.keys()) dirty.add(key);
  spawn = { x: 0.5, y: world.columnTop(0, 0) + 1, z: 0.5 };
  ready = false;
}
/** Connect to (or jump to) a voxel world: tears down the current world's client
 *  state and reconnects. Voxel↔voxel is seamless (no page reload). */
async function connectWorld(worldId: string, seed?: number): Promise<void> {
  if (net) {
    try {
      await net.leave();
    } catch {
      /* ignore */
    }
    net = null;
  }
  // reset the client-side world
  for (const [, r] of remote) scene.remove(r.avatar.group);
  remote.clear();
  for (const m of chunkMeshes.values()) {
    terrainGroup.remove(m);
    m.geometry.dispose();
  }
  chunkMeshes.clear();
  dirty.clear();
  world.clear();
  ready = false;
  breaking = null;
  breakOverlay.visible = false;
  moveTarget = null;
  currentWorld = worldId;
  if (worldLabel) worldLabel.textContent = worldId;
  rebuildWorldSelect();
  net = await connectVoxel(worldId, worldHandlers, { skin: playerSkin, seed });
  if (!net) goOffline(); // offline dev / unreachable → local terrain
}
// World tab: jump to another world by id (created on first visit).
const worldInput = document.getElementById('world-input') as HTMLInputElement;
const seedInput = document.getElementById('world-seed') as HTMLInputElement;
function goWorld(): void {
  const id = (worldInput.value.trim() || 'default').slice(0, 40);
  const seedRaw = seedInput.value.trim();
  const seed = seedRaw ? Number(seedRaw) >>> 0 : undefined; // custom seed (new worlds only)
  if (id !== currentWorld) void connectWorld(id, Number.isFinite(seed) ? seed : undefined);
  worldInput.value = '';
}
document.getElementById('world-go')!.onclick = goWorld;
worldInput.onkeydown = (e) => {
  if (e.key === 'Enter') goWorld();
};

// Dropdown of known voxel worlds (from the server) + the 2D zones.
const worldSelect = document.getElementById('world-select') as HTMLSelectElement;
let knownWorlds: string[] = ['default'];
function rebuildWorldSelect(): void {
  const worlds = [...new Set([...knownWorlds, currentWorld])].sort();
  const opt = (v: string, label: string, sel: boolean): string => `<option value="${v}"${sel ? ' selected' : ''}>${label}</option>`;
  worldSelect.innerHTML =
    '<optgroup label="Voxel worlds">' +
    worlds.map((w) => opt('voxel:' + w, w, w === currentWorld)).join('') +
    '</optgroup><optgroup label="2D zones">' +
    Object.values(ZONES)
      .map((z) => opt('zone:' + z.id, z.label, false))
      .join('') +
    '</optgroup>';
}
function onWorlds(list: unknown): void {
  if (Array.isArray(list)) knownWorlds = list.filter((x): x is string => typeof x === 'string');
  rebuildWorldSelect();
}
worldSelect.onchange = () => {
  const v = worldSelect.value;
  const i = v.indexOf(':');
  const kind = v.slice(0, i),
    id = v.slice(i + 1);
  if (kind === 'voxel') {
    if (id !== currentWorld) void connectWorld(id);
  } else if (kind === 'zone') jumpTo({ kind: 'zone', id });
};

// Log out (clears the session on the server, redirects to login).
document.getElementById('settings-logout')!.onclick = gotoLogout;

rebuildWorldSelect();
void connectWorld('default');

// ── Loop ──────────────────────────────────────────────────────────────────────
let last = performance.now();
let lastMoveSent = 0;
function frame(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  flushDirty(); // (re)mesh a few dirty chunks per frame
  // Hold physics until the spawn column has streamed in, then drop the player on it.
  if (!ready && world.hasChunk(toChunk(spawn.x), toChunk(spawn.y - 1), toChunk(spawn.z))) {
    player.pos.set(spawn.x, spawn.y, spawn.z);
    player.vel.set(0, 0, 0);
    ready = true;
  }
  const busy = menuOpen(); // don't move while a menu is open
  const w = !busy && (keys.has('KeyW') || keys.has('ArrowUp'));
  const s = !busy && (keys.has('KeyS') || keys.has('ArrowDown'));
  const a = !busy && (keys.has('KeyA') || keys.has('ArrowLeft'));
  const d = !busy && (keys.has('KeyD') || keys.has('ArrowRight'));
  const jump = !busy && keys.has('Space');
  const still: MoveInput = { forward: false, back: false, left: false, right: false, jump: false };
  let input: MoveInput;
  if (mode === 'iso') {
    if (w || s || a || d) {
      moveTarget = null; // manual movement cancels click-to-walk
      player.yaw = isoYaw; // WASD moves relative to the current map rotation
      input = { forward: w, back: s, left: a, right: d, jump };
    } else if (moveTarget && !busy) {
      const dx = moveTarget.x - player.pos.x;
      const dz = moveTarget.z - player.pos.z;
      if (Math.hypot(dx, dz) < 0.4) {
        moveTarget = null;
        input = still;
      } else {
        player.yaw = Math.atan2(-dx, -dz); // face + walk toward the destination
        input = { forward: true, back: false, left: false, right: false, jump: false };
      }
    } else input = still;
  } else {
    if (mode === 'third') player.yaw = camYaw; // face away from the orbiting camera
    input = { forward: w, back: s, left: a, right: d, jump };
  }
  if (ready) player.update(dt, input);
  // Safety net: never fall out of the world — snap back to spawn if you somehow
  // drop below the bedrock floor (e.g. through not-yet-streamed chunks).
  if (ready && player.pos.y < -30) {
    player.pos.set(spawn.x, spawn.y, spawn.z);
    player.vel.set(0, 0, 0);
  }
  // Clouds follow the player + drift.
  clouds.position.set(player.pos.x, 70, player.pos.z);
  cloudTex.offset.x += dt * 0.004;
  const wantBreak = !busy && ready && (mode === 'first' ? firstBreakHeld : keys.has('KeyQ'));
  updateBreaking(dt, wantBreak);
  updateWield();
  avatar.animate(dt, player.speed2d, player.pitch);
  // Report our transform to the server (throttled) so AOI + other players update.
  if (net && ready && now - lastMoveSent > 100) {
    lastMoveSent = now;
    net.sendMove(player.pos.x, player.pos.y, player.pos.z, player.yaw, player.pitch, player.speed2d > 0.4 ? 'walk' : 'idle');
  }
  syncRemotePlayers(dt);
  placeCamera();
  renderer.render(scene, activeCam());
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
