/**
 * Voxel spike bootstrap — a browser Minecraft-style vertical slice, client-only:
 * a Three.js voxel world, three camera modes (isometric default · third · first
 * person), free AABB movement with gravity/jump, and break/place via a crosshair/
 * mouse raycast. Isolated behind its own page (voxel.html); the 2D game is
 * untouched. Server authority + multiplayer chunk sync are the next phase — this
 * is the foundation to evaluate the look and controls.
 */
import * as THREE from 'three';
import { CHUNK, chunkKey, toChunk, ZONES, isWaterId, isLavaId, CRAFT_RECIPES, SMELT_RECIPES, FUEL_ITEMS, MATERIAL_BASE, TOOL_BASE, isHoe, isBucket, isFlintSteel, BUCKET_EMPTY, surfaceColor } from '@pixel/shared';
import { VoxelWorld } from './world.js';
import { buildChunkMesh } from './mesher.js';
import { computeChunkLight, invalidateLight, clearLightCache } from './light.js';
import { ChatUI } from '../ui/chatUI.js';
import { ZoneVoiceUI } from '../voice/ZoneVoiceUI.js';
import { SkinPreview } from './skinPreview.js';
import { Player, type MoveInput } from './player.js';
import { BLOCK_TEXTURES, BLOCKS, OVERLAY_TEXTURES, PORTAL_ID, WATER_ID, LAVA_ID, TORCH_ID, CHEST_ID, DOOR_CLOSED, DOOR_OPEN, FURNACE_ID, TNT_ID, SIGN_ID, FENCE_GATE_CLOSED, FENCE_GATE_OPEN, BED_ID, LIGHT_BLOCKS } from './blocks.js';
import type { SignMsg, ChatMsg } from './net.js';
import { daySample, isNight } from './daylight.js';
import { TravelMap } from './map.js';
import { createWaterMaterial, createLavaMaterial } from './water.js';
import { sound, footstepFor } from './sounds.js';
import { type Item, type ArmorSlot, TOOL_ITEMS, BLOCK_ITEMS, ARMOR_ITEMS, itemById, invItem, toolNum, DEFAULT_TOOLS, DEFAULT_BLOCKS } from './items.js';
import { Inventory } from './inventory.js';
import { loadBlockAtlas, SYNTHETIC, type Atlas } from './textures.js';
import { Avatar, type Wield, DEFAULT_WIELD } from './avatar.js';
import { MobModel } from './mob.js';
import { makeCrackStages } from './crack.js';
import { connectVoxel, type VoxelNet } from './net.js';
import { gotoLogout } from '../net/room';
import { digTime } from './luanti.js';
import { openPicker, closePicker, pickerOpen } from './picker.js';
import { injectPixelSkin } from './ui.js';

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
// Underwater: swap to a dense blue fog + a blue screen overlay so submerged blocks
// look murky/blue (Minecraft-like), applied when the active camera is in water.
const underwaterFog = new THREE.Fog(0x1f5a83, 0.1, 15);
const underwaterOverlay = document.createElement('div');
underwaterOverlay.id = 'vx-underwater';
underwaterOverlay.style.cssText =
  'position:fixed;inset:0;pointer-events:none;z-index:45;opacity:0;transition:opacity .18s;background:rgba(28,92,146,0.4);';
(document.getElementById('game') ?? document.body).appendChild(underwaterOverlay);
// In lava: a hot orange fog + screen glow (the server deals the actual burn damage).
const lavaFog = new THREE.Fog(0x7a1e05, 0.1, 6);
const lavaOverlay = document.createElement('div');
lavaOverlay.id = 'vx-inlava';
lavaOverlay.style.cssText =
  'position:fixed;inset:0;pointer-events:none;z-index:46;opacity:0;transition:opacity .18s;background:rgba(200,60,10,0.62);';
(document.getElementById('game') ?? document.body).appendChild(lavaOverlay);

// Day/night: the server hands us a shared clock in the welcome; tod (0..1) is
// advanced locally each frame and tints the sky/fog + the (unlit) world material.
let clockOffset = 0; // serverNow - clientNow, so all players share the time of day
let dayLengthMs = 20 * 60 * 1000;
let todNow = 0.35; // current time of day (default: morning) until welcome arrives
const dayColors = { sky: new THREE.Color(0x8fc7ff), light: new THREE.Color(0xffffff) };

// World + per-chunk meshes. Chunks are streamed from the server (or the offline
// fallback); each loaded chunk is its own mesh under terrainGroup so an edit only
// rebuilds the affected chunk. Boundary faces are re-culled by remeshing loaded
// neighbours. A dirty-set is flushed (capped) each frame to smooth the join burst.
const world = new VoxelWorld();
const material = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, alphaTest: 0.5 });
// Voxel light engine: the terrain is unlit, so we combine the two baked light channels
// (aSky/aBlock, see mesher + light.ts) in-shader. Final brightness = AO×shade (vColor) ×
// max(daylight×skylight, warmTorch×blocklight), floored by a small ambient so nothing is
// pitch black. `uSky` tracks the live day/night colour each frame ⇒ re-lights without
// re-meshing. material.color stays white (the daylight tint now lives in uSky).
const lightUniforms = {
  uSky: { value: new THREE.Color(1, 1, 1) }, // daytime sky/sun colour (updated per frame)
  uBlockCol: { value: new THREE.Color(1.0, 0.78, 0.5) }, // warm torch/lava light
  uAmbient: { value: 0.05 }, // faint floor so unlit caves aren't fully black
};
material.onBeforeCompile = (shader) => {
  shader.uniforms.uSky = lightUniforms.uSky;
  shader.uniforms.uBlockCol = lightUniforms.uBlockCol;
  shader.uniforms.uAmbient = lightUniforms.uAmbient;
  shader.vertexShader = 'attribute float aSky;\nattribute float aBlock;\nvarying float vSky;\nvarying float vBlock;\n' + shader.vertexShader.replace('#include <color_vertex>', '#include <color_vertex>\n  vSky = aSky;\n  vBlock = aBlock;');
  shader.fragmentShader =
    'uniform vec3 uSky;\nuniform vec3 uBlockCol;\nuniform float uAmbient;\nvarying float vSky;\nvarying float vBlock;\n' +
    shader.fragmentShader.replace(
      '#include <color_fragment>',
      '#include <color_fragment>\n  vec3 vxLit = max(uSky * vSky, uBlockCol * vBlock);\n  diffuseColor.rgb *= max(vxLit, vec3(uAmbient));',
    );
};
// Water: separate translucent pass (see-through, no depth write so submerged
// terrain shows through). Animated waving-liquid shader (see water.ts).
const { material: waterMaterial, uniforms: waterUniforms } = createWaterMaterial();
const { material: lavaMaterial, uniforms: lavaUniforms } = createLavaMaterial();
sound.preload(); // CC Luanti sound effects (footsteps, dig/place, hurt, lava hiss)
let atlas: Atlas | null = null;
const terrainGroup = new THREE.Group(); // opaque blocks — the aim/raycast target
const waterGroup = new THREE.Group(); // translucent water — NOT raycast (can't build on water)
const lavaGroup = new THREE.Group(); // emissive lava — NOT raycast
scene.add(terrainGroup);
scene.add(waterGroup);
scene.add(lavaGroup);
const chunkMeshes = new Map<string, THREE.Mesh>();
const chunkWater = new Map<string, THREE.Mesh>();
const chunkLava = new Map<string, THREE.Mesh>();
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
  const geom = atlas ? buildChunkMesh(world, atlas, computeChunkLight(world, cx, cy, cz), cx, cy, cz) : null;
  // Update one layer (opaque or water) in place: swap geometry, or add/remove the mesh.
  const layer = (map: Map<string, THREE.Mesh>, group: THREE.Group, mat: THREE.Material, geo: THREE.BufferGeometry | null): void => {
    const existing = map.get(key);
    if (!geo) {
      if (existing) {
        group.remove(existing);
        existing.geometry.dispose();
        map.delete(key);
      }
      return;
    }
    if (existing) {
      existing.geometry.dispose();
      existing.geometry = geo;
    } else {
      const m = new THREE.Mesh(geo, mat);
      map.set(key, m);
      group.add(m);
    }
  };
  layer(chunkMeshes, terrainGroup, material, geom?.opaque ?? null);
  layer(chunkWater, waterGroup, waterMaterial, geom?.water ?? null);
  layer(chunkLava, lavaGroup, lavaMaterial, geom?.lava ?? null);
  refreshPortalGlow(cx, cy, cz);
  refreshTorchGlow(cx, cy, cz);
}

// Torch light: the renderer is unlit (no scene lights), so a torch (id 33) can't cast
// real light. Instead each torch in a loaded chunk gets a warm additive halo so it
// reads as a light source (a full voxel-light engine is a much bigger follow-up).
const torchGlowGroup = new THREE.Group();
scene.add(torchGlowGroup);
const torchGlows = new Map<string, THREE.Object3D>();
const torchHaloMat = new THREE.MeshBasicMaterial({
  color: 0xffb24a,
  transparent: true,
  opacity: 0.5,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  side: THREE.DoubleSide,
});
const torchHaloGeo = new THREE.SphereGeometry(0.7, 8, 8);
/** Reconcile torch halos for one chunk: drop this chunk's halos, re-add for id-33. */
function refreshTorchGlow(cx: number, cy: number, cz: number): void {
  for (const [key, node] of torchGlows) {
    const [px, py, pz] = key.split(',').map(Number);
    if (toChunk(px) === cx && toChunk(py) === cy && toChunk(pz) === cz) {
      torchGlowGroup.remove(node);
      torchGlows.delete(key);
    }
  }
  const cells = world.rawChunk(cx, cy, cz);
  if (!cells || !cells.some((c) => LIGHT_BLOCKS.has(c))) return;
  const x0 = cx * CHUNK,
    y0 = cy * CHUNK,
    z0 = cz * CHUNK;
  const AREA = CHUNK * CHUNK;
  for (let i = 0; i < cells.length; i++) {
    if (!LIGHT_BLOCKS.has(cells[i])) continue;
    const ly = (i / AREA) | 0,
      rem = i % AREA,
      lz = (rem / CHUNK) | 0,
      lx = rem % CHUNK;
    const halo = new THREE.Mesh(torchHaloGeo, torchHaloMat);
    halo.position.set(x0 + lx + 0.5, y0 + ly + 0.5, z0 + lz + 0.5);
    torchGlows.set(`${x0 + lx},${y0 + ly},${z0 + lz}`, halo);
    torchGlowGroup.add(halo);
  }
}

// Signs: each sign block with text gets an in-world label — a camera-facing canvas-
// texture plane just above the block. Texts arrive via 'signs' (all, on join) + 'sign'
// (live edits); empty text removes the label. Billboarded toward the camera each frame.
const signGroup = new THREE.Group();
scene.add(signGroup);
const signObjs = new Map<string, THREE.Mesh>();
const signTexts = new Map<string, string>(); // cellKey → text (so the editor prefills the current text)
function makeSignTexture(text: string): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = 256;
  cv.height = 128;
  const g = cv.getContext('2d')!;
  g.fillStyle = 'rgba(60,42,24,0.92)';
  g.fillRect(0, 0, 256, 128);
  g.strokeStyle = '#2a1c0e';
  g.lineWidth = 8;
  g.strokeRect(4, 4, 248, 120);
  g.fillStyle = '#f4e4c1';
  g.font = 'bold 26px monospace';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const words = text.split(' ');
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const t = line ? line + ' ' + w : w;
    if (g.measureText(t).width > 232 && line) {
      lines.push(line);
      line = w;
    } else line = t;
  }
  if (line) lines.push(line);
  const shown = lines.slice(0, 4);
  const lh = 30;
  const y0 = 64 - ((shown.length - 1) * lh) / 2;
  shown.forEach((l, i) => g.fillText(l, 128, y0 + i * lh));
  const tex = new THREE.CanvasTexture(cv);
  tex.magFilter = THREE.NearestFilter;
  return tex;
}
function removeSign(key: string): void {
  const m = signObjs.get(key);
  if (!m) return;
  signGroup.remove(m);
  (m.material as THREE.MeshBasicMaterial).map?.dispose();
  (m.material as THREE.Material).dispose();
  m.geometry.dispose();
  signObjs.delete(key);
}
function applySign(m: SignMsg): void {
  const key = `${m.x},${m.y},${m.z}`;
  removeSign(key);
  if (!m.text) {
    signTexts.delete(key);
    return;
  }
  signTexts.set(key, m.text);
  const mat = new THREE.MeshBasicMaterial({ map: makeSignTexture(m.text), transparent: true, side: THREE.DoubleSide, depthWrite: false });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.45), mat);
  mesh.position.set(m.x + 0.5, m.y + 1.15, m.z + 0.5); // float just above the sign block
  signObjs.set(key, mesh);
  signGroup.add(mesh);
}
function applySigns(list: SignMsg[]): void {
  for (const key of [...signObjs.keys()]) removeSign(key);
  signTexts.clear();
  for (const m of list) applySign(m);
}
/** Turn every sign label to face the camera (billboard) — called each frame. */
function updateSignBillboards(): void {
  if (!signObjs.size) return;
  const cam = activeCam();
  for (const m of signObjs.values()) m.quaternion.copy(cam.quaternion);
}

// Portal glow: every portal cube (block id 28) in a loaded chunk gets a pulsing
// additive halo + a tall light column so it's easy to spot from afar. Shared
// materials pulse in the loop; per-cell meshes are (re)built when a chunk remeshes.
const portalGlowGroup = new THREE.Group();
scene.add(portalGlowGroup);
const portalGlows = new Map<string, THREE.Object3D>(); // cellKey → glow node
const portalHaloMat = new THREE.MeshBasicMaterial({
  color: 0x8fe9ff,
  transparent: true,
  opacity: 0.4,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  side: THREE.DoubleSide,
});
const portalBeamMat = new THREE.MeshBasicMaterial({
  color: 0x7fd0ff,
  transparent: true,
  opacity: 0.12,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
});
const portalHaloGeo = new THREE.BoxGeometry(1.28, 1.28, 1.28);
const portalBeamGeo = new THREE.CylinderGeometry(0.32, 0.32, 48, 10, 1, true);
function makePortalGlow(x: number, y: number, z: number): THREE.Object3D {
  const g = new THREE.Group();
  const halo = new THREE.Mesh(portalHaloGeo, portalHaloMat);
  halo.position.set(x + 0.5, y + 0.5, z + 0.5);
  const beam = new THREE.Mesh(portalBeamGeo, portalBeamMat);
  beam.position.set(x + 0.5, y + 24, z + 0.5); // column rising from the portal
  g.add(halo, beam);
  return g;
}
/** Reconcile portal glows for one chunk: drop this chunk's glows, re-add for id-28. */
function refreshPortalGlow(cx: number, cy: number, cz: number): void {
  // Drop this chunk's existing glows (usually none → trivial).
  for (const [key, node] of portalGlows) {
    const [px, py, pz] = key.split(',').map(Number);
    if (toChunk(px) === cx && toChunk(py) === cy && toChunk(pz) === cz) {
      portalGlowGroup.remove(node);
      portalGlows.delete(key);
    }
  }
  // Scan the raw cells array (fast) with an early reject — portals are rare, so most
  // remeshes bail after one linear pass instead of 4096 keyed world.get calls.
  const cells = world.rawChunk(cx, cy, cz);
  if (!cells || !cells.includes(PORTAL_ID)) return;
  const x0 = cx * CHUNK,
    y0 = cy * CHUNK,
    z0 = cz * CHUNK;
  const AREA = CHUNK * CHUNK;
  for (let i = 0; i < cells.length; i++) {
    if (cells[i] !== PORTAL_ID) continue;
    const ly = (i / AREA) | 0,
      rem = i % AREA,
      lz = (rem / CHUNK) | 0,
      lx = rem % CHUNK;
    const x = x0 + lx,
      y = y0 + ly,
      z = z0 + lz;
    const node = makePortalGlow(x, y, z);
    portalGlows.set(`${x},${y},${z}`, node);
    portalGlowGroup.add(node);
  }
}
/** Remesh up to `cap` dirty chunks per frame (rest wait for the next frame). */
function flushDirty(cap = 6): void {
  if (!atlas || dirty.size === 0) return;
  let n = 0;
  for (const key of dirty) {
    const [cx, cy, cz] = key.split(',').map(Number);
    remeshChunk(cx, cy, cz);
    dirty.delete(key);
    if (++n >= cap) break;
  }
}
void loadBlockAtlas([...BLOCK_TEXTURES, ...OVERLAY_TEXTURES], SYNTHETIC).then((a) => {
  atlas = a;
  material.map = a.texture;
  material.needsUpdate = true;
  dropMaterial = new THREE.MeshBasicMaterial({ map: a.texture, alphaTest: 0.5 }); // drop-cube icons
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
  id: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  skin: string;
  state: string;
  hp: number;
  hpMax: number;
  food: number;
  name: string;
}
interface RemoteNpc {
  x: number;
  y: number;
  z: number;
  yaw: number;
  skin: string;
  kind: string;
  state: string;
}
interface RemoteItem {
  x: number;
  y: number;
  z: number;
  block: number;
  count: number;
}
interface RemoteState {
  players: { forEach(cb: (p: RemotePlayer, k: string) => void): void; get(k: string): RemotePlayer | undefined };
  npcs: { forEach(cb: (p: RemoteNpc, k: string) => void): void; get(k: string): RemoteNpc | undefined };
  items: { forEach(cb: (p: RemoteItem, k: string) => void): void; get(k: string): RemoteItem | undefined };
}
const remote = new Map<string, { avatar: Avatar }>();
// An NPC is rendered as either a humanoid Avatar (monsters) or a blocky MobModel
// (animals) — both expose the same group/setTint/animate surface used below.
type NpcRender = { group: THREE.Object3D; setTint(c: THREE.Color): void; animate(dt: number, speed: number): void };
const npcAvatars = new Map<string, { avatar: NpcRender }>();
// Dropped items: small textured cubes that bob + spin, synced from state.items (AOI).
const itemGroup = new THREE.Group();
scene.add(itemGroup);
const itemDrops = new Map<string, { obj: THREE.Object3D; block: number }>();
// Client mirror of the server stack inventory (item id → count) — drives the hotbar
// counts + place-consumes-stack. Declared early: updateHud() reads it during init.
const invCounts = new Map<number, number>();
// Per-tool durability (tool id → uses left / max), from the server; drives the wear bar
// on hotbar tool slots. In-memory (resets on reconnect, like the server's wear).
const toolDurability = new Map<number, { left: number; max: number }>();
let dropMaterial: THREE.MeshBasicMaterial | null = null;
/** A 0.32-cube geometry UV-mapped to a block's side tile on every face (drop icon). */
function buildDropGeo(block: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(0.32, 0.32, 0.32);
  const r = atlas!.rect(BLOCKS[block]?.tiles.side ?? 'stone');
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, r.u0 + uv.getX(i) * (r.u1 - r.u0), r.vBot + uv.getY(i) * (r.vTop - r.vBot));
  }
  uv.needsUpdate = true;
  return g;
}
// Non-block material drops render as flat billboards (Minecraft-style item sprites),
// not cubes. Sprite materials are cached per material id (shared texture, no per-drop
// GPU cost) so they're never disposed on despawn.
const texLoader = new THREE.TextureLoader();
const matSpriteMats = new Map<number, THREE.SpriteMaterial>();
function materialSpriteMat(id: number): THREE.SpriteMaterial {
  let m = matSpriteMats.get(id);
  if (!m) {
    const tex = texLoader.load(itemTexUrl(invItem(id).texUrl));
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.colorSpace = THREE.SRGBColorSpace;
    m = new THREE.SpriteMaterial({ map: tex, transparent: true });
    matSpriteMats.set(id, m);
  }
  return m;
}
/** Build the world object for a dropped item: a billboard sprite for materials, a
 *  textured cube for blocks. */
function buildDropObject(block: number): THREE.Object3D {
  if (block >= MATERIAL_BASE) {
    const s = new THREE.Sprite(materialSpriteMat(block));
    s.scale.set(0.4, 0.4, 0.4);
    return s;
  }
  return new THREE.Mesh(buildDropGeo(block), dropMaterial!);
}
/** Remove a dropped-item object from the scene, disposing its per-drop geometry (cube
 *  only — sprites share cached materials/textures). */
function disposeDrop(d: { obj: THREE.Object3D }): void {
  itemGroup.remove(d.obj);
  const mesh = d.obj as THREE.Mesh;
  if (mesh.isMesh) mesh.geometry.dispose();
}

/** Smoothly move + turn an avatar toward its synced transform (server sends ~10 Hz;
 *  we interpolate at frame rate so movement + walk animation aren't choppy). Returns
 *  whether it's still moving (drives walk vs idle, stable between server updates). */
function smoothAvatar(a: { group: THREE.Object3D }, tx: number, ty: number, tz: number, tyaw: number, dt: number): boolean {
  const g = a.group.position;
  const moving = Math.hypot(tx - g.x, tz - g.z) > 0.03;
  const k = Math.min(1, dt * 12);
  g.x += (tx - g.x) * k;
  g.y += (ty - g.y) * k;
  g.z += (tz - g.z) * k;
  let dyaw = tyaw - a.group.rotation.y;
  while (dyaw > Math.PI) dyaw -= 2 * Math.PI;
  while (dyaw < -Math.PI) dyaw += 2 * Math.PI;
  a.group.rotation.y += dyaw * k;
  return moving;
}

let worldSeed = 0; // seed of the current world (from 'welcome') — drives the full-world map
let playerIsAdmin = false; // from welcome; gates admin slash-commands in the chat /help
function onWelcome(m: unknown): void {
  const w = m as { spawn?: { x: number; y: number; z: number }; now?: number; dayLengthMs?: number; seed?: number; isAdmin?: boolean };
  if (typeof w.isAdmin === 'boolean') playerIsAdmin = w.isAdmin;
  if (Number.isFinite(w.seed)) worldSeed = w.seed!; // for the full-world map colour
  if (Number.isFinite(w.now)) clockOffset = w.now! - Date.now(); // align to the server day clock
  if (Number.isFinite(w.dayLengthMs) && w.dayLengthMs! > 0) dayLengthMs = w.dayLengthMs!;
  if (w.spawn) {
    spawn = w.spawn;
    // Move the player/camera to the new spawn immediately so the view is centred
    // where the server streams chunks (otherwise, if you'd walked away in the old
    // world, the camera would stare into empty space = blue). Physics still waits
    // for the ground chunk via `ready`.
    player.pos.set(spawn.x, spawn.y, spawn.z);
    player.vel.set(0, 0, 0);
    ready = false;
  }
  net?.setCreative(settings.creative); // sync build mode to this (possibly fresh) session
  net?.setPeaceful(settings.peaceful); // default peaceful → animals only, no monsters
  net?.setDurability(settings.durability); // tool wear on/off
  net?.setHunger(settings.hunger); // hunger on/off
  updateHud();
}
/** Shared day clock jumped (someone slept) — realign our local clock to the server's. */
function onTime(m: { now: number; dayLengthMs: number }): void {
  if (Number.isFinite(m.now)) clockOffset = m.now - Date.now();
  if (Number.isFinite(m.dayLengthMs) && m.dayLengthMs > 0) dayLengthMs = m.dayLengthMs;
}
function onNote(m: { text: string }): void {
  if (m?.text) showToast(m.text);
}
function onChunk(c: { cx: number; cy: number; cz: number; cells: Uint8Array }): void {
  world.setChunk(c.cx, c.cy, c.cz, c.cells);
  invalidateLight(c.cx, c.cy, c.cz); // fresh terrain → recompute column heights + sources
  markDirty(c.cx, c.cy, c.cz);
  markExploredChunk(c.cx, c.cz); // remember this area for the map
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
let lastHiss = -1e9;
function onServerEdit(e: { x: number; y: number; z: number; id: number }): void {
  const prev = world.get(e.x, e.y, e.z);
  world.set(e.x, e.y, e.z, e.id);
  invalidateLight(toChunk(e.x), toChunk(e.y), toChunk(e.z)); // block changed → recompute local light
  markDirty(toChunk(e.x), toChunk(e.y), toChunk(e.z));
  markExploredColumn(e.x, e.z); // keep the map in sync with edits
  // Lava hiss: a cell just hardened to obsidian/stone next to lava (cool_lava). Throttle
  // (many cells harden at once) + only when audibly close to the player.
  if ((e.id === 15 || e.id === 3) && !isLavaId(prev)) {
    const near = Math.hypot(e.x - player.pos.x, e.y - player.pos.y, e.z - player.pos.z) < 24;
    const touchesLava = [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ].some(([a, b, c]) => world.lava(e.x + a, e.y + b, e.z + c));
    const t = performance.now();
    if (near && touchesLava && t - lastHiss > 500) {
      lastHiss = t;
      sound.play('cool_lava', 0.8);
    }
  }
}
/** Reconcile remote-player avatars from the room state each frame. */
function syncRemotePlayers(dt: number): void {
  if (!net) return;
  const state = net.room.state as unknown as RemoteState;
  if (!state?.players || !state.npcs || !state.items) return; // schema not synced yet (early frames)
  const mySid = net.sessionId;
  state.players.forEach((p, sid) => {
    if (sid === mySid) return;
    let r = remote.get(sid);
    if (!r) {
      const a = new Avatar(p.skin || 'character_1');
      a.group.position.set(p.x, p.y, p.z); // spawn at the right spot, don't lerp from origin
      scene.add(a.group);
      r = { avatar: a };
      remote.set(sid, r);
    }
    const moving = smoothAvatar(r.avatar, p.x, p.y, p.z, p.yaw, dt);
    r.avatar.setSwimming(p.state === 'swim');
    r.avatar.setTint(dayColors.light);
    r.avatar.animate(dt, moving ? 2 : 0, p.pitch);
  });
  for (const [sid, r] of remote) {
    if (!state.players.get(sid)) {
      scene.remove(r.avatar.group);
      remote.delete(sid);
    }
  }
  syncNpcs(dt, state);
}

/** Reconcile server-driven NPC avatars (same model as players; walk anim from
 *  position delta; day/night tint). NPC decisions are server-side — we only render. */
function syncNpcs(dt: number, state: RemoteState): void {
  state.npcs.forEach((n, id) => {
    let r = npcAvatars.get(id);
    if (!r) {
      // Every mob (animals + monsters) is a blocky model now — no humanoid placeholders.
      const a: NpcRender = new MobModel(n.kind);
      a.group.position.set(n.x, n.y, n.z);
      scene.add(a.group);
      r = { avatar: a };
      npcAvatars.set(id, r);
    }
    const moving = smoothAvatar(r.avatar, n.x, n.y, n.z, n.yaw, dt);
    r.avatar.setTint(dayColors.light);
    r.avatar.animate(dt, moving ? 2 : 0);
  });
  for (const [id, r] of npcAvatars) {
    if (!state.npcs.get(id)) {
      scene.remove(r.avatar.group);
      npcAvatars.delete(id);
    }
  }
  syncItemDrops(state);
}

/** Reconcile dropped-item cubes from state.items — bob + spin; add/remove on AOI. */
let dropSpin = 0;
function syncItemDrops(state: RemoteState): void {
  dropSpin += 0.03;
  state.items.forEach((it, id) => {
    let d = itemDrops.get(id);
    if ((!d || d.block !== it.block) && atlas && dropMaterial) {
      if (d) disposeDrop(d);
      const obj = buildDropObject(it.block);
      itemGroup.add(obj);
      d = { obj, block: it.block };
      itemDrops.set(id, d);
    }
    if (d) {
      d.obj.position.set(it.x, it.y + 0.15 + Math.sin(dropSpin + it.x) * 0.08, it.z);
      if (!(d.obj as THREE.Sprite).isSprite) d.obj.rotation.y = dropSpin; // sprites always face the camera
    }
  });
  for (const [id, d] of itemDrops) {
    if (!state.items.get(id)) {
      disposeDrop(d);
      itemDrops.delete(id);
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
const settings = { invertY: true, camCollide: true, autoTool: false, dayNight: false, fly: false, peaceful: true, sound: true, creative: false, durability: true, hunger: true };
try {
  Object.assign(settings, JSON.parse(localStorage.getItem('voxSettings') ?? '{}') as Partial<typeof settings>);
} catch {
  /* ignore bad storage */
}
sound.enabled = settings.sound; // apply the loaded preference to the audio manager
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
  // While typing in chat, the input handles keys itself — suspend all game keybinds.
  // (ChatUI owns the Enter-to-focus binding + stopPropagation while typing.)
  if (chat.isFocused()) return;
  if (e.code === 'Escape' && pickerOpen()) return closePicker();
  if (e.code === 'Escape' && settingsOpen()) return closeSettings();
  if (e.code === 'Escape' && travelMap.isOpen()) return travelMap.close();
  if (e.code === 'Escape' && inventory.isOpen()) return inventory.close();
  if (e.code === 'Escape' && craftOpen()) return craftClose();
  if (e.code === 'Escape' && chestUiOpen()) return chestClose();
  if (e.code === 'Escape' && furnaceOpen()) return furnaceClose();
  if (e.code === 'KeyM' && !pickerOpen() && !settingsOpen()) { travelMap.toggle(); frontPanel('vx-map'); return; }
  if (e.code === 'KeyI' && !pickerOpen() && !settingsOpen()) { inventory.toggle(); frontPanel('vx-inv'); return; }
  if (e.code === 'KeyC' && !pickerOpen() && !settingsOpen()) return craftToggle();
  if (e.code === 'KeyO') return settingsOpen() ? closeSettings() : openSettings();
  if (e.code === 'KeyV') return cycleMode();
  if (e.code === 'KeyK') return pickerOpen() ? closePicker() : openSkinPicker();
  if (e.code === 'KeyE' && !pickerOpen()) return placeBlock(); // place a block (Q breaks, held)
  if (e.code === 'KeyP' && !menuOpen()) return makePortal(); // mark aimed block as a portal
  if (e.code === 'KeyF' && !menuOpen()) return attackNearestNpc(); // melee the nearest NPC
  if (e.code === 'KeyG' && !menuOpen()) return void net?.eat(); // eat food (apple/bread) → restore hunger
  const n = Number(e.key);
  if (n >= 1 && n <= tools.length + blocks.length) selectSlot(n - 1);
  keys.add(e.code);
});
window.addEventListener('keyup', (e) => keys.delete(e.code));

const pointerNDC = new THREE.Vector2(0, 0); // cursor pos (iso) → target for E/Q + click-to-walk
const locked = (): boolean => document.pointerLockElement === canvas;
const menuOpen = (): boolean => pickerOpen() || settingsOpen() || travelMap.isOpen() || inventory.isOpen() || craftOpen() || chestUiOpen() || furnaceOpen() || audioOpen();
// Bring a panel to the front when opened, so the last-opened window is always on top
// (all panels share a base z-index → without this, DOM order decided stacking).
let panelZTop = 300;
function frontPanel(idOrEl: string | HTMLElement): void {
  const el = typeof idOrEl === 'string' ? document.getElementById(idOrEl) : idOrEl;
  if (el) el.style.zIndex = String(++panelZTop);
}

// Travel map (M): top-down minimap of loaded terrain + click-to-teleport.
const MAP_COLORS: Record<number, number> = {
  1: 0x5aa33a, // grass
  2: 0x8a5a3a, // dirt
  3: 0x8a8a8a, // stone
  7: 0xd8c98a, // sand
  17: 0x6a4a2a, // wood
  21: 0x3f8a3f, // leaves
  27: 0x3a6ea5, // water
  28: 0x8fe9ff, // portal
};
// Persistent explored-terrain colour cache for the map (grows as chunks load, so the
// map shows everything you've explored, not just the current AOI).
const exploredColors = new Map<string, number>();
function markExploredChunk(cx: number, cz: number): void {
  const x0 = cx * CHUNK,
    z0 = cz * CHUNK;
  for (let lx = 0; lx < CHUNK; lx++)
    for (let lz = 0; lz < CHUNK; lz++) {
      const c = columnColor(x0 + lx, z0 + lz);
      if (c != null) exploredColors.set(x0 + lx + ',' + (z0 + lz), c);
    }
}
function markExploredColumn(x: number, z: number): void {
  const c = columnColor(x, z);
  if (c != null) exploredColors.set(x + ',' + z, c);
}
function columnColor(x: number, z: number): number | null {
  // Scan only LOADED chunks top-down via their raw cells (a null chunk skips a whole
  // 16-cell band with one Map lookup) — far cheaper than 100+ keyed world.get/column.
  const lx = ((x % CHUNK) + CHUNK) % CHUNK,
    lz = ((z % CHUNK) + CHUNK) % CHUNK;
  for (let cy = 6; cy >= -1; cy--) {
    const cells = world.rawChunk(toChunk(x), cy, toChunk(z));
    if (!cells) continue;
    for (let ly = CHUNK - 1; ly >= 0; ly--) {
      const id = cells[lx + CHUNK * (lz + CHUNK * ly)];
      if (id === 0) continue;
      return isWaterId(id) ? 0x3a6ea5 : isLavaId(id) ? 0xe2521a : MAP_COLORS[id] ?? 0x777777;
    }
  }
  return null;
}
const travelMap = new TravelMap({
  // Full world from the seed (no "explored" gaps) — an edited/loaded column overrides
  // with its real top colour so player-made changes show on the map.
  colorAt: (x, z) => exploredColors.get(x + ',' + z) ?? surfaceColor(x, z, worldSeed, currentWorld === 'default'),
  player: () => ({ x: player.pos.x, z: player.pos.z, yaw: player.yaw }),
  onTravel: (x, z) => {
    if (net) net.sendTeleport(x, z);
    else {
      player.pos.set(x + 0.5, world.columnTop(x, z) + 1, z + 0.5);
      player.vel.set(0, 0, 0);
    }
  },
  onOpen: () => {
    if (locked()) document.exitPointerLock(); // free the mouse to click the map
  },
  onClose: () => {
    if (mode === 'first') canvas.requestPointerLock(); // re-capture in first person
  },
});
function onTeleport(m: { x: number; y: number; z: number }): void {
  spawn = { x: m.x, y: m.y, z: m.z };
  player.pos.set(m.x, m.y, m.z);
  player.vel.set(0, 0, 0);
  ready = false; // re-drop onto the ground once the destination chunks stream in
}

// ── Combat HUD (HP bar + damage flash) + melee ───────────────────────────────
// Player HUD (top-left, stacked): HP + food + armor, then the player nameplate with an
// online/offline dot. Grouped in one #vx-hud column so it reads as a player frame.
const hpStyle = document.createElement('style');
hpStyle.textContent = `
  #vx-hud{position:fixed;right:12px;bottom:12px;display:flex;flex-direction:column;align-items:flex-end;gap:5px;z-index:60;
    font-family:'FS Pixel Sans',ui-monospace,monospace;}
  #vx-hp,#vx-food{position:relative;width:180px;background:rgba(0,0,0,.5);border:3px solid #1c1c1c;
    border-radius:4px;overflow:hidden;}
  #vx-hp{height:18px;} #vx-food{height:16px;}
  #vx-hp .fill{position:absolute;inset:0;background:linear-gradient(#e05a5a,#b83232);width:100%;transition:width .15s;}
  #vx-food .fill{position:absolute;inset:0;background:linear-gradient(#d0973f,#8a5a1e);width:100%;transition:width .15s;}
  #vx-hp span,#vx-food span{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#fff;
    font-size:.72rem;text-shadow:1px 1px 0 #000;}
  #vx-name{display:flex;align-items:center;gap:6px;color:#eef1fb;font-size:.82rem;text-shadow:1px 1px 0 #000;margin-top:1px;}
  #vx-name .dot{width:9px;height:9px;border-radius:50%;background:#4ad06a;box-shadow:0 0 5px #4ad06a;}
  #vx-name .st{color:#9fe6b0;font-size:.68rem;}
  #vx-name.off .dot{background:#c0392b;box-shadow:none;} #vx-name.off .st{color:#e79a9a;}
  #vx-dmg{position:fixed;inset:0;pointer-events:none;z-index:55;opacity:0;transition:opacity .25s;
    box-shadow:inset 0 0 120px 40px rgba(200,0,0,.75);}`;
document.head.appendChild(hpStyle);
const hud = document.createElement('div');
hud.id = 'vx-hud';
(document.getElementById('game') ?? document.body).appendChild(hud);
const hpBar = document.createElement('div');
hpBar.id = 'vx-hp';
hpBar.innerHTML = '<div class="fill"></div><span></span>';
hud.appendChild(hpBar);
const foodBar = document.createElement('div');
foodBar.id = 'vx-food';
foodBar.innerHTML = '<div class="fill"></div><span></span>';
hud.appendChild(foodBar);
const foodFill = foodBar.querySelector('.fill') as HTMLDivElement;
const foodText = foodBar.querySelector('span') as HTMLSpanElement;
function updateFoodBar(food: number): void {
  foodFill.style.width = Math.max(0, Math.min(100, (food / 20) * 100)) + '%';
  foodText.textContent = `🍖 ${food} / 20`;
}
const dmgFlash = document.createElement('div');
dmgFlash.id = 'vx-dmg';
(document.getElementById('game') ?? document.body).appendChild(dmgFlash);
const hpFill = hpBar.querySelector('.fill') as HTMLDivElement;
const hpText = hpBar.querySelector('span') as HTMLSpanElement;
let lastHp = 20;
function updateHpBar(hp: number, max: number): void {
  hpFill.style.width = Math.max(0, Math.min(100, (hp / Math.max(1, max)) * 100)) + '%';
  hpText.textContent = `${hp} / ${max}`;
  if (hp < lastHp) {
    dmgFlash.style.opacity = '1';
    window.setTimeout(() => (dmgFlash.style.opacity = '0'), 90);
    sound.play('hurt');
  }
  lastHp = hp;
}
/** Melee: hit the nearest NPC within reach that's in front of the player (F). */
function attackNearestNpc(): void {
  if (!net) return;
  const fx = -Math.sin(player.yaw),
    fz = -Math.cos(player.yaw);
  let bestId: string | null = null;
  let bestD = 3.4 * 3.4;
  for (const [id, r] of npcAvatars) {
    const dx = r.avatar.group.position.x - player.pos.x;
    const dz = r.avatar.group.position.z - player.pos.z;
    const d = dx * dx + dz * dz;
    if (d > bestD) continue;
    const dist = Math.sqrt(d) || 1;
    if ((dx / dist) * fx + (dz / dist) * fz < -0.1) continue; // roughly in front
    bestD = d;
    bestId = id;
  }
  if (bestId) {
    net.sendAttack(bestId);
    avatar.playDig(); // swing feedback
  }
}

// ── Inventory + armour (I) ───────────────────────────────────────────────────
const armorEquipped: Record<ArmorSlot, string | null> = { head: null, torso: null, legs: null, feet: null };
function armorDefense(): number {
  let d = 0;
  for (const id of Object.values(armorEquipped)) if (id) d += itemById(id).armor?.defense ?? 0;
  return d;
}
const armorHudStyle = document.createElement('style');
armorHudStyle.textContent = `
  #vx-armor{display:flex;gap:4px;align-items:center;
    font-family:'FS Pixel Sans',ui-monospace,monospace;color:#fff;font-size:.72rem;text-shadow:1px 1px 0 #000;}
  #vx-armor .a{width:20px;height:20px;border:2px solid #1c1c1c;border-radius:3px;background:#0006 center/80% no-repeat;image-rendering:pixelated;}
  #vx-armor b{margin-left:4px;}`;
document.head.appendChild(armorHudStyle);
const armorHud = document.createElement('div');
armorHud.id = 'vx-armor';
hud.appendChild(armorHud);
// Player nameplate + online/offline dot (below the bars/armor).
const nameEl = document.createElement('div');
nameEl.id = 'vx-name';
nameEl.innerHTML = '<span class="dot"></span><b class="nm">player</b><span class="st">online</span>';
hud.appendChild(nameEl);
const nameNm = nameEl.querySelector('.nm') as HTMLElement;
const nameSt = nameEl.querySelector('.st') as HTMLElement;
function setPlayerName(name: string): void {
  if (name && nameNm.textContent !== name) nameNm.textContent = name;
}
function setOnline(on: boolean): void {
  nameEl.classList.toggle('off', !on);
  nameSt.textContent = on ? 'online' : 'offline';
}

// Chat: the SAME shared ChatUI as the 2D office (client/src/ui/chatUI.ts) — one codebase.
// Enter opens the input; while typing, game keybinds are suspended (stopPropagation +
// the isFocused guard in the keydown handler).
const chat = new ChatUI({
  sendChat: (text) => net?.sendChat(text),
  sendCommand: (name, args) => net?.sendCommand(name, args),
  isAdmin: () => playerIsAdmin,
  canFocus: () => !menuOpen(),
  clientCommand: (name, _args, sys) => {
    if (name === 'voxel') return sys('You are already in the voxel world.'), true;
    return false;
  },
  onFocus: () => {
    if (locked()) document.exitPointerLock();
  },
});

// Audio / zone voice — the SAME ZoneVoiceUI as the 2D office, mounted in a top-right
// panel (mirrors the top-left settings). Per-world LiveKit voice; proximity uses the
// horizontal (x,z) distance between players. Voice media needs a mic + LiveKit config.
const audioStyle = document.createElement('style');
audioStyle.textContent = `
  #vx-audio-btn{position:fixed;left:10px;top:8px;width:30px;height:30px;z-index:120;cursor:pointer;
    display:flex;align-items:center;justify-content:center;font-size:1rem;background:#141826;border:2px solid #05060b;
    border-radius:.4rem;color:#e9ecf7;box-shadow:inset 0 2px 0 #2b3252,inset 0 -3px 0 #090b16;}
  #vx-audio-btn.on{border-color:#4ad06a;color:#9fe6b0;}
  #vx-audio{position:fixed;left:12px;top:44px;width:340px;max-width:92vw;z-index:120;display:none;
    background:#0f1220;border:2px solid #05060b;border-radius:.6rem;color:#eef1fb;
    box-shadow:inset 0 2px 0 #232a44,inset 0 -3px 0 #080a14,0 12px 28px rgba(0,0,0,.55);
    font-family:'FS Pixel Sans',ui-monospace,monospace;}
  #vx-audio.open{display:block;}
  #vx-audio .hd{display:flex;align-items:center;gap:.6rem;padding:.6rem .8rem;border-bottom:2px solid #05060b;}
  #vx-audio .hd h3{margin:0;font-size:1rem;} #vx-audio .hd .x{margin-left:auto;cursor:pointer;padding:.1rem .5rem;
    background:#141826;border:2px solid #05060b;border-radius:.4rem;}
  #vx-audio .pa-body{padding:.7rem .8rem;max-height:70vh;overflow-y:auto;}`;
document.head.appendChild(audioStyle);
const audioPanelEl = document.createElement('div');
audioPanelEl.id = 'vx-audio';
audioPanelEl.innerHTML = '<div class="hd"><h3>Audio · Voice</h3><div class="x" title="Close">✕</div></div><div class="pa-body"></div>';
(document.getElementById('game') ?? document.body).appendChild(audioPanelEl);
const audioBtn = document.createElement('div');
audioBtn.id = 'vx-audio-btn';
audioBtn.textContent = '🔊';
audioBtn.title = 'Audio / voice';
(document.getElementById('game') ?? document.body).appendChild(audioBtn);
function audioOpen(): boolean {
  return audioPanelEl.classList.contains('open');
}
function toggleAudio(): void {
  const open = !audioOpen();
  audioPanelEl.classList.toggle('open', open);
  if (open) {
    frontPanel(audioPanelEl);
    if (locked()) document.exitPointerLock();
  }
}
audioBtn.onclick = toggleAudio;
audioPanelEl.querySelector<HTMLElement>('.x')!.onclick = () => audioPanelEl.classList.remove('open');
const playerPosById = (id: number): { x: number; y: number } | null => {
  if (!net) return null;
  let pos: { x: number; y: number } | null = null;
  (net.room.state as unknown as RemoteState).players.forEach((p) => {
    if (p.id === id) pos = { x: p.x, y: p.z }; // horizontal plane for proximity
  });
  return pos;
};
const zoneVoice = new ZoneVoiceUI(audioPanelEl.querySelector<HTMLElement>('.pa-body')!, {
  requestToken: () => net?.sendZoneVoiceToken(),
  announceVoice: (event) => net?.sendVoiceEvent(event),
  myPosition: () => ({ x: player.pos.x, y: player.pos.z }),
  positionOf: (id) => playerPosById(id),
  onSpeakers: () => {},
  onVoiceStatus: () => {},
  onStateChange: (s) => audioBtn.classList.toggle('on', !!(s.connected || s.micOn)),
});
function updateArmorHud(): void {
  armorHud.innerHTML = '';
  for (const slot of ['head', 'torso', 'legs', 'feet'] as ArmorSlot[]) {
    const id = armorEquipped[slot];
    const a = document.createElement('div');
    a.className = 'a';
    if (id) a.style.backgroundImage = `url(${itemById(id).icon ?? ''})`;
    a.title = slot + (id ? `: ${itemById(id).name}` : ' (empty)');
    armorHud.appendChild(a);
  }
  const def = document.createElement('b');
  def.textContent = `🛡 ${armorDefense()}`;
  armorHud.appendChild(def);
}
function applyArmor(): void {
  net?.sendArmor(armorDefense());
  updateArmorHud();
  pushSettings();
}
const inventory = new Inventory({
  toolSlots: () => tools,
  blockSlots: () => blocks,
  armorSlots: () => armorEquipped,
  setToolSlot: (i, id) => {
    tools[i] = id;
    updateHud();
    refreshEditor();
    pushSettings();
  },
  setBlockSlot: (i, id) => {
    blocks[i] = id;
    updateHud();
    refreshEditor();
    pushSettings();
  },
  setArmor: (slot, id) => {
    armorEquipped[slot] = id;
    applyArmor();
  },
  item: itemById,
  palette: { tools: TOOL_ITEMS, blocks: BLOCK_ITEMS, armor: ARMOR_ITEMS },
  collected: () =>
    [...invCounts.entries()]
      .filter(([id, c]) => c > 0 && id < MATERIAL_BASE) // only placeable blocks in the Blocks grid
      .sort((a, b) => a[0] - b[0])
      .map(([block, count]) => ({ block, count })),
  materials: () =>
    [...invCounts.entries()]
      .filter(([id, c]) => c > 0 && id >= MATERIAL_BASE && id < TOOL_BASE) // non-block materials (lumps/ingots/sticks)
      .sort((a, b) => a[0] - b[0])
      .map(([id, count]) => ({ id, count })),
  creative: () => settings.creative,
  // Portal is always a shown build tool; water/lava are direct-place only in creative (else use a bucket).
  special: () => (settings.creative ? [WATER_ID, PORTAL_ID, LAVA_ID] : [PORTAL_ID]),
  owns: (it) => it.toolId === undefined || settings.creative || (invCounts.get(it.toolId) ?? 0) > 0,
  // Raise the live bottom hotbar above the inventory panel while it's open, so you can
  // drag palette items straight onto the real bar (not just the mirrored rows). Also
  // free the mouse in first person (to drag), and re-capture it on close.
  onOpen: () => {
    document.getElementById('hotbar')?.classList.add('drop-target');
    if (locked()) document.exitPointerLock();
  },
  onClose: () => {
    document.getElementById('hotbar')?.classList.remove('drop-target');
    if (mode === 'first') canvas.requestPointerLock();
  },
});
updateArmorHud();
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
    const invY = settings.invertY ? -1 : 1;
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
  if (mode !== 'first') {
    if (locked()) document.exitPointerLock();
    player.pitch = 0; // reset the first-person look-down so the figure stands level in iso/third
  }
  updateHud();
  pushSettings(); // remember the last-used view (iso/third/first) across sessions
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

/** Whether the player owns (has crafted) a given tool — creative owns everything.
 *  Unowned tools are shown in the hotbar but dig at bare-hand speed. */
function toolOwned(stringId: string): boolean {
  if (settings.creative) return true;
  const n = itemById(stringId).toolId; // works for dig tools + buckets (both carry toolId)
  return n !== undefined && (invCounts.get(n) ?? 0) > 0;
}
/** The best tool the player OWNS (a hotbar tool) for a block, or undefined if none
 *  helps. Used by auto-switch and the dig-time calc. */
function bestToolFor(blockId: number): string | undefined {
  let best: string | undefined;
  let bestT = Infinity;
  for (const id of tools) {
    const tool = itemById(id).tool;
    if (!tool || !toolOwned(id)) continue;
    const t = digTime(blockId, [tool]);
    if (t !== null && t < bestT) {
      bestT = t;
      best = tool;
    }
  }
  return best;
}
/** Tool(s) used to dig a block right now: auto-switch picks the best owned tool;
 *  otherwise it's the held tool IF owned (unowned tool or a block = bare hand). */
function digToolsFor(blockId: number): string[] {
  if (settings.autoTool) {
    const best = bestToolFor(blockId);
    if (best) return [best];
  }
  const sel = tools[selTool];
  const digTool = sel && toolOwned(sel) ? itemById(sel).tool : undefined; // selected breaking tool, if owned
  return digTool ? [digTool] : [];
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

/** Where a placed block would land: against the aimed face, or — when aiming into
 *  empty space over a void while standing on solid ground — one block out from
 *  under the feet in the aim's horizontal direction (Minecraft "bridging"). */
function placeTarget(): { x: number; y: number; z: number } | null {
  const h = aimHit();
  if (h) {
    const nrm = h.face ? h.face.normal : UP;
    const p = h.point.clone().addScaledVector(nrm, 0.5);
    return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
  }
  // Bridging fallback: the aim missed (pointing over the abyss). Extend from the
  // block under our feet in the direction we're aiming, so you can walk out onto it.
  const fx = Math.floor(player.pos.x),
    fy = Math.floor(player.pos.y) - 1,
    fz = Math.floor(player.pos.z);
  if (!world.solid(fx, fy, fz)) return null; // nothing solid to extend from
  const dir = raycaster.ray.direction; // set by aimHit() above
  const [dx, dz] = Math.abs(dir.x) >= Math.abs(dir.z) ? [Math.sign(dir.x), 0] : [0, Math.sign(dir.z)];
  if (!dx && !dz) return null;
  return { x: fx + dx, y: fy, z: fz + dz };
}

/** Right-clicking/using an interactive node (chest → open) instead of placing.
 *  Returns true if it handled the aimed cell (so placing is suppressed). */
function useAimedNode(): boolean {
  const h = aimHit();
  if (!h) return false;
  const nrm = h.face ? h.face.normal : UP;
  const p = h.point.clone().addScaledVector(nrm, -0.5);
  const x = Math.floor(p.x),
    y = Math.floor(p.y),
    z = Math.floor(p.z);
  const b = world.get(x, y, z);
  const heldId = heldNum();
  // Buckets act on liquids instead of placing: empty scoops the aimed source; filled
  // pours its source into the air cell against the aimed face. Holding one never places.
  if (isBucket(heldId)) {
    if (heldId === BUCKET_EMPTY) {
      if (b === WATER_ID || b === LAVA_ID) net?.use(x, y, z, heldId);
    } else {
      const po = h.point.clone().addScaledVector(nrm, 0.5);
      const ox = Math.floor(po.x),
        oy = Math.floor(po.y),
        oz = Math.floor(po.z);
      if (!world.solid(ox, oy, oz)) net?.use(ox, oy, oz, heldId);
    }
    return true;
  }
  // Flint & steel lights fire in the air cell against the aimed face (server checks flammability).
  if (isFlintSteel(heldId)) {
    const po = h.point.clone().addScaledVector(nrm, 0.5);
    const ox = Math.floor(po.x),
      oy = Math.floor(po.y),
      oz = Math.floor(po.z);
    if (!world.solid(ox, oy, oz)) net?.use(ox, oy, oz, heldId);
    return true;
  }
  // A sign: open its text editor (client-side prompt, prefilled with the current text).
  if (b === SIGN_ID) {
    promptSign(x, y, z);
    return true;
  }
  if (b === CHEST_ID || b === DOOR_CLOSED || b === DOOR_OPEN || b === FURNACE_ID || b === TNT_ID || b === FENCE_GATE_CLOSED || b === FENCE_GATE_OPEN || b === BED_ID) {
    net?.use(x, y, z, heldId); // chest → open; door/gate → toggle; furnace → smelt UI; TNT → ignite; bed → sleep
    return true;
  }
  // Holding a hoe + aiming at tillable ground (dirt/grass/sand) → farmland (server converts it).
  if (isHoe(heldId) && (b === 2 || b === 1 || b === 7 || b === 8)) {
    net?.use(x, y, z, heldId);
    return true;
  }
  return false;
}
/** Numeric id of the currently held item (owned tool from the tool track, else the
 *  selected build block) — sent with the use-action so the server can act on it (hoe). */
function heldNum(): number {
  if (lastTrack === 'tool') {
    const t = tools[selTool];
    return t && toolOwned(t) ? itemById(t).toolId ?? 0 : 0;
  }
  return itemById(blocks[selBlock]).block ?? 0;
}

/** Place the held block against the aimed face (instant). Tools don't place. */
function placeBlock(): void {
  if (useAimedNode()) return; // aiming at a chest → open it, don't place
  const block = itemById(blocks[selBlock]).block; // the selected build block
  if (block === undefined) return; // block track is somehow empty → nothing to place
  const t = placeTarget();
  if (!t) return;
  const { x: bx, y: by, z: bz } = t;
  // Don't place inside yourself — that would embed the AABB and lock movement.
  if (world.solid(bx, by, bz) || player.intersectsBlock(bx, by, bz)) return;
  // Survival: need one in the stack inventory (fluids/portal/creative are unlimited).
  if (!blockUnlimited(block) && (invCounts.get(block) ?? 0) <= 0) {
    showToast(`Kein Vorrat: ${itemById(blocks[selBlock]).name}`);
    return;
  }
  avatar.playDig();
  sound.play('place');
  if (!blockUnlimited(block)) onInv({ block, total: (invCounts.get(block) ?? 0) - 1 }); // optimistic; server 'inv' corrects
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
  // is too weak (e.g. steel pick on a diamond block) → can't break it. Creative breaks
  // ANY block near-instantly (Minecraft-style), never blocked by tool tier.
  const dur = !tgt ? null : settings.creative ? 0.05 : digTime(world.get(tgt.x, tgt.y, tgt.z), digToolsFor(world.get(tgt.x, tgt.y, tgt.z)));
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
    const broke = world.get(tgt.x, tgt.y, tgt.z);
    sound.play(broke === 14 || broke === 16 ? 'glass_break' : 'dug'); // glass shatters, else generic dug
    // The tool used (numeric id) so the server can wear it; 0 = bare hand (no wear).
    const usedTool = digToolsFor(broke)[0];
    const toolId = usedTool ? toolNum(usedTool) ?? 0 : 0;
    if (net) {
      net.sendEdit(tgt.x, tgt.y, tgt.z, 0, toolId); // authoritative break — server confirms
    } else {
      world.set(tgt.x, tgt.y, tgt.z, 0);
      markDirty(toChunk(tgt.x), toChunk(tgt.y), toChunk(tgt.z));
    }
    breaking = null;
    breakOverlay.visible = false;
    avatar.setMining(false);
  }
}

// Footsteps: accumulate the ACTUAL horizontal distance walked (robust to the per-axis
// collision zeroing velocity on bumps/steps) and fire a step every stride. "On ground"
// = onGround OR a solid block right below (steps make onGround flicker). In water it's
// the wet step; flying is silent.
let stepAcc = 0;
let fsPrevX = 0;
let fsPrevZ = 0;
function updateFootsteps(_dt: number): void {
  const dx = player.pos.x - fsPrevX;
  const dz = player.pos.z - fsPrevZ;
  fsPrevX = player.pos.x;
  fsPrevZ = player.pos.z;
  const dist = Math.hypot(dx, dz);
  if (settings.fly || dist < 0.002 || dist > 3) return; // idle / flying / teleport-jump → no step
  const bx = Math.floor(player.pos.x),
    bz = Math.floor(player.pos.z),
    fy = Math.floor(player.pos.y);
  if (player.inWater) {
    stepAcc += dist;
    if (stepAcc >= 1.4) ((stepAcc = 0), sound.play('foot_water', 0.7, 0.95 + Math.random() * 0.1));
    return;
  }
  if (!player.onGround && !world.solid(bx, fy - 1, bz)) return; // airborne (not just over a step)
  stepAcc += dist;
  if (stepAcc >= 2.0) {
    stepAcc = 0;
    const below = world.get(bx, fy - 1, bz);
    if (below !== 0) sound.play(footstepFor(below), 0.55, 0.94 + Math.random() * 0.12);
  }
}

// ── HUD (crosshair + hotbar + pickers) ────────────────────────────────────────
// The hotbar is split into two independent tracks: a TOOL track (used when
// breaking) and a BLOCK track (used when placing). Each keeps its own selection,
// so you never have to swap a single slot between "dig" and "build" — pick a pick
// once, a block once, and Q/E just work. Number keys run across both tracks
// (tools first, then blocks); clicking a slot selects it; the wield editor + "b"
// picker follow whichever track you last touched.
const tools = [...DEFAULT_TOOLS]; // breaking side
const blocks = [...DEFAULT_BLOCKS]; // placing side
let selTool = 0;
let selBlock = 0;
let lastTrack: 'tool' | 'block' = 'block'; // side the label / editor / picker follow
const held = (): Item => itemById(lastTrack === 'tool' ? tools[selTool] : blocks[selBlock]);
function selectTool(i: number): void {
  selTool = (i + tools.length) % tools.length;
  lastTrack = 'tool';
  updateHud();
  refreshEditor();
  pushSettings(); // remember the selected slot across sessions
}
function selectBlock(i: number): void {
  selBlock = (i + blocks.length) % blocks.length;
  lastTrack = 'block';
  updateHud();
  refreshEditor();
  pushSettings();
}
/** Number keys 1..N run across both tracks: 1..tools then blocks. */
function selectSlot(i: number): void {
  if (i < tools.length) selectTool(i);
  else selectBlock(i - tools.length);
}
function updateHud(): void {
  const label = document.getElementById('mode');
  if (label)
    label.textContent = `View: ${mode} (V) · Break: ${itemById(tools[selTool]).name} · Place: ${itemById(blocks[selBlock]).name} · I inventory · K skin`;
  const bar = document.getElementById('hotbar')!;
  bar.innerHTML = '';
  const addSlots = (ids: string[], sel: number, pick: (i: number) => void, isTool: boolean): void => {
    ids.forEach((id, i) => {
      // Luanti-style short hotbar: the tool track shows only tools you actually own
      // (creative owns all). The full catalogue (dimmed unowned tools) lives in the
      // inventory panel. Keeps the bar from being a huge fixed row of every tier.
      if (isTool && !toolOwned(id)) return;
      const it = itemById(id);
      const s = document.createElement('div');
      s.className = 'slot' + (i === sel ? ' on' : '');
      s.style.backgroundImage = `url(${itemTexUrl(it.texUrl)})`;
      s.style.backgroundSize = 'cover';
      s.title = it.name;
      s.onclick = () => pick(i);
      // Survival stack count on build blocks (∞ for fluids/portal/creative; dim at 0).
      if (!isTool && it.block !== undefined) {
        const bid = it.block;
        const badge = document.createElement('span');
        badge.className = 'count';
        badge.textContent = blockUnlimited(bid) ? '∞' : String(invCounts.get(bid) ?? 0);
        if (!blockUnlimited(bid) && (invCounts.get(bid) ?? 0) <= 0) badge.classList.add('empty');
        s.appendChild(badge);
      }
      // Owned tool: a durability wear bar (green→red) once it's been used.
      if (isTool && it.toolId !== undefined) {
        const dur = toolDurability.get(it.toolId);
        if (dur && dur.left < dur.max) {
          const frac = Math.max(0, dur.left / dur.max);
          const bar = document.createElement('span');
          bar.style.cssText = `position:absolute;left:2px;right:2px;bottom:2px;height:3px;background:#05060b;`;
          const fill = document.createElement('span');
          const hue = Math.round(frac * 120); // 0=red .. 120=green
          fill.style.cssText = `position:absolute;left:0;top:0;bottom:0;width:${Math.round(frac * 100)}%;background:hsl(${hue},70%,50%);`;
          bar.appendChild(fill);
          s.appendChild(bar);
        }
      }
      // Drop target for inventory drag&drop onto the real bar (kind-checked).
      (s as unknown as { __accept: (dragId: string) => void }).__accept = (dragId) => {
        const di = itemById(dragId);
        if (isTool ? !!di.tool : di.block !== undefined) {
          (isTool ? tools : blocks)[i] = dragId;
          updateHud();
          refreshEditor();
          pushSettings();
          inventory.render();
        }
      };
      bar.appendChild(s);
    });
  };
  addSlots(tools, selTool, selectTool, true);
  const divider = document.createElement('div');
  divider.className = 'hdivider';
  divider.title = 'left: dig tools · right: build blocks';
  bar.appendChild(divider);
  addSlots(blocks, selBlock, selectBlock, false);
  document.getElementById('cross')!.style.display = mode === 'first' ? 'block' : 'none';
}

// (The old "B" hotbar-slot picker was removed — there's no such menu in Minecraft/
// Luanti; the Inventory panel (I) already drags items onto hotbar slots, and creative
// shows the full palette there.)

// Wield sync: the avatar holds the block being built by default, and swaps to the
// dig tool while actively breaking (auto-switch shows the best carried tool).
let wieldedId = '';
function setWielded(it: Item): void {
  if (it.id === wieldedId) return;
  wieldedId = it.id;
  avatar.wield(it.texUrl, it.pivot, loadWield(it.id));
}
function clearWielded(): void {
  if (wieldedId === '') return;
  wieldedId = '';
  avatar.hideWield();
}
function updateWield(): void {
  if (breaking && !settingsOpen()) {
    if (settings.autoTool) {
      const tool = bestToolFor(world.get(breaking.x, breaking.y, breaking.z));
      const ti = tool ? TOOL_ITEMS.find((i) => i.tool === tool) : undefined;
      if (ti) return setWielded(ti);
    }
    const sel = tools[selTool];
    return sel && toolOwned(sel) ? setWielded(itemById(sel)) : clearWielded(); // manual: the selected dig tool, if owned
  }
  const active = held();
  if (active.block !== undefined) return clearWielded(); // only tools are held in hand, not blocks
  if (active.tool && !toolOwned(active.id)) return clearWielded(); // don't show a tool you haven't crafted
  setWielded(active);
}
updateHud();
let skinPreview: SkinPreview | null = null;
function openSkinPicker(): void {
  if (locked()) document.exitPointerLock();
  frontPanel('vx-picker');
  if (!skinPreview) skinPreview = new SkinPreview(playerSkin);
  skinPreview.setSkin(playerSkin);
  const pane = document.createElement('div');
  pane.innerHTML = '<div class="pl">Preview</div>';
  pane.prepend(skinPreview.canvas);
  openPicker(
    'Player skin',
    SKINS.map((name) => ({
      thumb: skinUrl(name),
      label: name.replace('character_', '#'),
      selected: name === playerSkin,
      onHover: () => skinPreview!.setSkin(name), // live 3D preview while hovering
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
    pane,
  );
  skinPreview.start(() => pickerOpen());
}

// ── Settings menu ─────────────────────────────────────────────────────────────
const settingsPanel = document.getElementById('settings') as HTMLElement;
const settingsOpen = (): boolean => !settingsPanel.hidden;
function openSettings(): void {
  settingsPanel.hidden = false;
  frontPanel('settings');
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
const dayNightCb = document.getElementById('opt-daynight') as HTMLInputElement;
const flyCb = document.getElementById('opt-fly') as HTMLInputElement;
dayNightCb.checked = settings.dayNight;
flyCb.checked = settings.fly;
dayNightCb.onchange = () => {
  settings.dayNight = dayNightCb.checked;
  saveSettings();
};
flyCb.onchange = () => {
  settings.fly = flyCb.checked;
  saveSettings();
};
const peacefulCb = document.getElementById('opt-peaceful') as HTMLInputElement;
peacefulCb.checked = settings.peaceful;
peacefulCb.onchange = () => {
  settings.peaceful = peacefulCb.checked;
  net?.setPeaceful(settings.peaceful); // server suppresses/clears monsters
  saveSettings();
};
const soundCb = document.getElementById('opt-sound') as HTMLInputElement;
soundCb.checked = settings.sound;
soundCb.onchange = () => {
  settings.sound = soundCb.checked;
  sound.enabled = settings.sound;
  if (settings.sound) sound.play('place', 0.6); // audible confirmation
  saveSettings();
};

// Items page. Auto-switch tool toggle (default off = Minecraft-manual).
const autoToolCb = document.getElementById('opt-autotool') as HTMLInputElement;
autoToolCb.checked = settings.autoTool;
autoToolCb.onchange = () => {
  settings.autoTool = autoToolCb.checked;
  saveSettings();
};
const durabilityCb = document.getElementById('opt-durability') as HTMLInputElement;
durabilityCb.checked = settings.durability;
durabilityCb.onchange = () => {
  settings.durability = durabilityCb.checked;
  net?.setDurability(settings.durability); // off → server never wears tools
  saveSettings();
};
const hungerCb = document.getElementById('opt-hunger') as HTMLInputElement;
hungerCb.checked = settings.hunger;
hungerCb.onchange = () => {
  settings.hunger = hungerCb.checked;
  net?.setHunger(settings.hunger); // off → food stays full, no starving
  saveSettings();
};
const creativeCb = document.getElementById('opt-creative') as HTMLInputElement;
creativeCb.checked = settings.creative;
creativeCb.onchange = () => {
  settings.creative = creativeCb.checked;
  net?.setCreative(settings.creative); // server skips stack consumption + damage while creative
  // Creative implies flight (Minecraft-style): enable fly on, disable it when leaving creative.
  settings.fly = creativeCb.checked;
  flyCb.checked = settings.fly;
  updateHud(); // ∞ vs counts
  if (inventory.isOpen()) inventory.render(); // full palette vs owned-only
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
  const isTool = lastTrack === 'tool';
  const pool = isTool ? TOOL_ITEMS : BLOCK_ITEMS;
  const cur = isTool ? tools[selTool] : blocks[selBlock];
  const i = pool.findIndex((it) => it.id === cur);
  const next = pool[(i + dir + pool.length) % pool.length].id;
  if (isTool) tools[selTool] = next;
  else blocks[selBlock] = next;
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
  return {
    invertY: settings.invertY,
    camCollide: settings.camCollide,
    autoTool: settings.autoTool,
    dayNight: settings.dayNight,
    fly: settings.fly,
    peaceful: settings.peaceful,
    sound: settings.sound,
    creative: settings.creative,
    durability: settings.durability,
    hunger: settings.hunger,
    view: mode,
    skin: playerSkin,
    wield,
    hotbar: { blocks: [...blocks] }, // tool track is now a fixed catalog (owned tools unlock), not persisted
    armor: { ...armorEquipped },
    sel: { tool: selTool, block: selBlock, track: lastTrack }, // remembered hotbar selection
  };
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
    dayNight: boolean;
    fly: boolean;
    peaceful: boolean;
    sound: boolean;
    creative: boolean;
    durability: boolean;
    hunger: boolean;
    view: CamMode;
    skin: string;
    wield: Record<string, Wield>;
    hotbar: { tools?: string[]; blocks?: string[] };
    armor: Record<string, string | null>;
    sel: { tool?: number; block?: number; track?: 'tool' | 'block' };
  }> | null;
  if (!o || typeof o !== 'object') return;
  if (typeof o.invertY === 'boolean') settings.invertY = o.invertY;
  if (typeof o.camCollide === 'boolean') settings.camCollide = o.camCollide;
  if (typeof o.autoTool === 'boolean') settings.autoTool = o.autoTool;
  if (typeof o.dayNight === 'boolean') settings.dayNight = o.dayNight;
  if (typeof o.fly === 'boolean') settings.fly = o.fly;
  if (typeof o.peaceful === 'boolean') settings.peaceful = o.peaceful;
  if (typeof o.sound === 'boolean') {
    settings.sound = o.sound;
    sound.enabled = o.sound;
    soundCb.checked = o.sound;
  }
  if (typeof o.creative === 'boolean') {
    settings.creative = o.creative;
    creativeCb.checked = o.creative;
    net?.setCreative(o.creative);
    updateHud();
  }
  if (typeof o.durability === 'boolean') {
    settings.durability = o.durability;
    durabilityCb.checked = o.durability;
    net?.setDurability(o.durability);
  }
  if (typeof o.hunger === 'boolean') {
    settings.hunger = o.hunger;
    hungerCb.checked = o.hunger;
    net?.setHunger(o.hunger);
  }
  if (o.view === 'iso' || o.view === 'third' || o.view === 'first') {
    mode = o.view; // restore the last-used camera view
    if (mode !== 'first' && locked()) document.exitPointerLock();
    updateHud();
  }
  invertYCb.checked = settings.invertY;
  camCollideCb.checked = settings.camCollide;
  autoToolCb.checked = settings.autoTool;
  dayNightCb.checked = settings.dayNight;
  flyCb.checked = settings.fly;
  peacefulCb.checked = settings.peaceful;
  net?.setPeaceful(settings.peaceful); // tell the server the loaded preference
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
  // Restore the saved block hotbar layout (kind-checked). The tool track is a fixed
  // catalog now (owned tools unlock), so it is no longer persisted/restored.
  if (o.hotbar) {
    if (Array.isArray(o.hotbar.blocks))
      o.hotbar.blocks.forEach((id, i) => i < blocks.length && itemById(id).block !== undefined && (blocks[i] = id));
    updateHud();
  }
  // Restore the remembered hotbar selection (which slots were active).
  if (o.sel) {
    if (Number.isInteger(o.sel.tool)) selTool = Math.max(0, Math.min(tools.length - 1, o.sel.tool!));
    if (Number.isInteger(o.sel.block)) selBlock = Math.max(0, Math.min(blocks.length - 1, o.sel.block!));
    if (o.sel.track === 'tool' || o.sel.track === 'block') lastTrack = o.sel.track;
    updateHud();
  }
  if (o.armor && typeof o.armor === 'object') {
    for (const slot of ['head', 'torso', 'legs', 'feet'] as ArmorSlot[]) {
      const id = o.armor[slot];
      armorEquipped[slot] = id && itemById(id).armor?.slot === slot ? id : null;
    }
    net?.sendArmor(armorDefense());
    updateArmorHud();
  }
  refreshEditor(); // reload the held item's (possibly server-provided) transform
}
// ── Item pickup (collected drops) ─────────────────────────────────────────────
const toast = document.createElement('div');
toast.id = 'vx-toast';
toast.style.cssText =
  "position:fixed;left:50%;bottom:9.5rem;transform:translateX(-50%);z-index:120;padding:.35rem .7rem;" +
  "background:rgba(20,22,28,.82);border:2px solid #1c1c1c;border-radius:5px;color:#fff;font-family:'FS Pixel Sans',ui-monospace,monospace;" +
  'font-size:.8rem;text-shadow:1px 1px 0 #000;opacity:0;transition:opacity .2s;pointer-events:none;';
(document.getElementById('game') ?? document.body).appendChild(toast);
let toastTimer = 0;
function showToast(text: string): void {
  toast.textContent = text;
  toast.style.opacity = '1';
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toast.style.opacity = '0'), 1400);
}
function onPickup(m: { block: number; count: number; total: number }): void {
  invCounts.set(m.block, m.total);
  const name = invItem(m.block).name;
  showToast(`+${m.count} ${name}  ×${m.total}`);
  sound.play('place', 0.4);
  updateHud(); // reflect the new count on the hotbar
  craftRender(); // affordability may have changed
  if (inventory.isOpen()) inventory.render(); // collected counts
  if (chestUiOpen()) chestRender();
  if (furnaceOpen()) smeltRender();
}
function onInv(m: { block: number; total: number }): void {
  if (m.total > 0) invCounts.set(m.block, m.total);
  else invCounts.delete(m.block);
  updateHud();
  craftRender();
  if (inventory.isOpen()) inventory.render();
  if (chestUiOpen()) chestRender();
  if (furnaceOpen()) smeltRender();
}
/** TNT explosion (server): a red flash + a bang if it went off near the player. */
function onBoom(m: { x: number; y: number; z: number }): void {
  const d = Math.hypot(m.x - player.pos.x, m.y - player.pos.y, m.z - player.pos.z);
  if (d > 28) return;
  dmgFlash.style.opacity = '1';
  window.setTimeout(() => (dmgFlash.style.opacity = '0'), 120);
  sound.play('dug', Math.max(0.3, 1 - d / 28), 0.5); // low-pitched thud (no dedicated boom sample)
}
/** Tool wear from the server: update the slot's wear bar; toast + forget when it breaks. */
function onDurability(m: { tool: number; left: number; max: number }): void {
  if (m.left <= 0) {
    toolDurability.delete(m.tool);
    showToast(`${invItem(m.tool).name} zerbrochen!`);
    sound.play('dug', 0.6);
  } else {
    toolDurability.set(m.tool, { left: m.left, max: m.max });
  }
  updateHud();
}
/** Bulk inventory snapshot on join (persisted survival inventory restored server-side). */
function onInvAll(items: Record<string, number>): void {
  invCounts.clear();
  for (const [k, v] of Object.entries(items)) if (v > 0) invCounts.set(Number(k), v);
  updateHud();
  craftRender();
  if (inventory.isOpen()) inventory.render();
  if (chestUiOpen()) chestRender();
  if (furnaceOpen()) smeltRender();
}
// Fluids + the portal marker are build tools (no finite supply); creative = unlimited all.
function blockUnlimited(id: number): boolean {
  // Portals are always a free build tool; water/lava are ∞ only in creative (survival uses buckets).
  return settings.creative || id === PORTAL_ID;
}

// ── Crafting panel (C) ────────────────────────────────────────────────────────
// A simple recipe list: each row shows the inputs → output; a row is enabled only
// when the stack inventory (invCounts, or creative) can afford it. Crafting is
// server-authoritative — we send the recipe index and the server validates + updates
// inventory via 'inv'. Re-rendered whenever the inventory changes while open.
const craftStyle = document.createElement('style');
craftStyle.textContent = `
  #vx-craft{position:fixed;inset:0;z-index:150;display:none;align-items:center;justify-content:center;
    background:rgba(0,0,0,.55);font-family:'FS Pixel Sans',ui-monospace,monospace;color:#fff;}
  #vx-craft.open{display:flex;}
  #vx-craft .win{background:#2b2b2b;border:4px solid #1c1c1c;border-radius:6px;box-shadow:0 8px 0 rgba(0,0,0,.5);padding:.8rem;min-width:340px;max-height:80vh;overflow:auto;}
  #vx-craft .hd{display:flex;align-items:center;gap:.6rem;margin-bottom:.6rem;}
  #vx-craft .hd h3{margin:0;font-size:1.05rem;text-shadow:1px 1px 0 #000;}
  #vx-craft .hd .x{margin-left:auto;cursor:pointer;width:1.6rem;height:1.6rem;display:flex;align-items:center;justify-content:center;background:#3a3a3a;border:3px solid #1c1c1c;border-radius:4px;}
  #vx-craft .row{display:flex;align-items:center;gap:.5rem;padding:.4rem;border:3px solid #1c1c1c;border-radius:5px;margin-bottom:.5rem;background:#333;}
  #vx-craft .row.off{opacity:.45;}
  #vx-craft .sect{font-size:.82rem;color:#cfcfcf;text-shadow:1px 1px 0 #000;margin:.2rem 0 .5rem;border-top:2px solid #1c1c1c;padding-top:.5rem;}
  #vx-craft .ic{width:34px;height:34px;background-size:cover;image-rendering:pixelated;border:2px solid #1c1c1c;position:relative;}
  #vx-craft .ic .c{position:absolute;right:0;bottom:0;font-size:.62rem;padding:0 1px;background:rgba(0,0,0,.6);text-shadow:1px 1px 0 #000;}
  #vx-craft .arrow{opacity:.8;}
  #vx-craft .mk{margin-left:auto;padding:.35rem .7rem;background:#3a6ea5;border:3px solid #1c1c1c;border-radius:4px;cursor:pointer;color:#fff;}
  #vx-craft .row.off .mk{background:#555;cursor:default;}
  #vx-craft .tip{font-size:.72rem;color:#cfcfcf;text-align:center;margin-top:.3rem;}`;
document.head.appendChild(craftStyle);
const craftEl = document.createElement('div');
craftEl.id = 'vx-craft';
craftEl.innerHTML = `<div class="win"><div class="hd"><h3>Crafting</h3><div class="x" title="Close (C / Esc)">✕</div></div><div class="list"></div><div class="tip">Dig materials, then craft · needs the ingredients in your inventory</div></div>`;
(document.getElementById('game') ?? document.body).appendChild(craftEl);
craftEl.querySelector<HTMLElement>('.x')!.onclick = () => craftClose();
craftEl.addEventListener('mousedown', (e) => {
  if (e.target === craftEl) craftClose();
});
const craftOpen = (): boolean => craftEl.classList.contains('open');
function craftToggle(): void {
  craftOpen() ? craftClose() : craftShow();
}
function craftShow(): void {
  frontPanel(craftEl);
  if (locked()) document.exitPointerLock();
  craftEl.classList.add('open');
  craftRender();
}
function craftClose(): void {
  craftEl.classList.remove('open');
  if (mode === 'first') canvas.requestPointerLock(); // re-capture the mouse in first person
}
function iconHtml(id: number, count: number): string {
  const it = invItem(id);
  const url = itemTexUrl(it.texUrl);
  return `<div class="ic" title="${it.name}" style="background-image:url(${url})"><span class="c">${count}</span></div>`;
}
function craftRow(afford: boolean, inner: string, verb: string, run: () => void): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'row' + (afford ? '' : ' off');
  row.innerHTML = inner + `<button class="mk">${verb}</button>`;
  const btn = row.querySelector<HTMLButtonElement>('.mk')!;
  btn.onclick = () => {
    if (!afford || !net) return;
    run();
    sound.play('place', 0.5);
  };
  return row;
}
function craftRender(): void {
  if (!craftOpen()) return;
  const list = craftEl.querySelector('.list')!;
  list.innerHTML = '';
  // Crafting: block/material → item (creative affords everything). Smelting moved to
  // the furnace node (place + use a furnace) — see smeltRender().
  CRAFT_RECIPES.forEach((r, i) => {
    const afford = settings.creative || r.in.every((ing) => (invCounts.get(ing.block) ?? 0) >= ing.count);
    const inner = r.in.map((ing) => iconHtml(ing.block, ing.count)).join('') + `<span class="arrow">→</span>` + iconHtml(r.out.block, r.out.count);
    list.appendChild(craftRow(afford, inner, 'Craft', () => net!.craft(i)));
  });
}

// ── Furnace UI (smelting — opened by using a placed furnace node) ────────────────
// Smelting is gated behind a furnace now (Luanti-faithful): place a furnace, right-click
// it. The recipes + validation are unchanged (net.smelt → server onSmelt); this is just
// its own panel, reusing the craft panel's chrome.
const furnaceEl = document.createElement('div');
furnaceEl.id = 'vx-craft'; // reuse the craft panel's CSS
furnaceEl.style.zIndex = '151';
furnaceEl.innerHTML = `<div class="win"><div class="hd"><h3>Furnace</h3><div class="x" title="Close (Esc)">✕</div></div><div class="list"></div><div class="tip">Smelt with fuel in your inventory (coal, wood, planks)</div></div>`;
(document.getElementById('game') ?? document.body).appendChild(furnaceEl);
furnaceEl.querySelector<HTMLElement>('.x')!.onclick = () => furnaceClose();
furnaceEl.addEventListener('mousedown', (e) => {
  if (e.target === furnaceEl) furnaceClose();
});
const furnaceOpen = (): boolean => furnaceEl.classList.contains('open');
function onFurnaceOpen(): void {
  frontPanel(furnaceEl);
  if (locked()) document.exitPointerLock();
  furnaceEl.classList.add('open');
  smeltRender();
}
function furnaceClose(): void {
  furnaceEl.classList.remove('open');
  if (mode === 'first') canvas.requestPointerLock();
}
function smeltRender(): void {
  if (!furnaceOpen()) return;
  const list = furnaceEl.querySelector('.list')!;
  list.innerHTML = '';
  const haveFuel = FUEL_ITEMS.some((f) => (invCounts.get(f) ?? 0) >= 1);
  const sect = document.createElement('div');
  sect.className = 'sect';
  sect.textContent = haveFuel ? 'Smelting' : 'Smelting (needs fuel: coal, wood, planks)';
  list.appendChild(sect);
  SMELT_RECIPES.forEach((r, i) => {
    const afford = (invCounts.get(r.in) ?? 0) >= 1 && haveFuel;
    const inner = iconHtml(r.in, 1) + `<span class="arrow" title="+ fuel">🔥→</span>` + iconHtml(r.out, r.count);
    list.appendChild(craftRow(afford, inner, 'Smelt', () => net!.smelt(i)));
  });
}

// ── Chest UI (open a chest node → move stacks between it and your inventory) ─────
// Server-authoritative: opening a chest asks the server ('use'); it replies 'chestOpen'
// with the contents. Clicking a stack sends 'chestMove' (take/put); the server validates,
// persists, and echoes the updated player count + chest. Click = move a whole stack.
const chestStyle = document.createElement('style');
chestStyle.textContent = `
  #vx-chest{position:fixed;inset:0;z-index:150;display:none;align-items:center;justify-content:center;
    background:rgba(0,0,0,.55);font-family:'FS Pixel Sans',ui-monospace,monospace;color:#fff;}
  #vx-chest.open{display:flex;}
  #vx-chest .win{width:min(94vw,34rem);background:#2b2b2b;border:4px solid #1c1c1c;border-radius:6px;box-shadow:0 8px 0 rgba(0,0,0,.5);padding:.8rem;}
  #vx-chest .hd{display:flex;align-items:center;gap:.6rem;margin-bottom:.5rem;}
  #vx-chest .hd h3{margin:0;font-size:1.05rem;text-shadow:1px 1px 0 #000;}
  #vx-chest .hd .x{margin-left:auto;cursor:pointer;width:1.6rem;height:1.6rem;display:flex;align-items:center;justify-content:center;background:#3a3a3a;border:3px solid #1c1c1c;border-radius:4px;}
  #vx-chest h4{margin:.5rem 0 .3rem;font-size:.78rem;color:#cfcfcf;text-shadow:1px 1px 0 #000;}
  #vx-chest .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(2.6rem,1fr));gap:5px;min-height:2.6rem;}
  #vx-chest .cell{width:2.4rem;height:2.4rem;border:3px solid #4a4a4a;border-radius:4px;background:#3a3a3a center/80% no-repeat;image-rendering:pixelated;cursor:pointer;position:relative;}
  #vx-chest .cell .num{position:absolute;right:0;bottom:0;font-size:.62rem;padding:0 2px;background:rgba(0,0,0,.62);text-shadow:1px 1px 0 #000;border-radius:2px 0 0 0;}
  #vx-chest .empty{font-size:.72rem;color:#9a9a9a;}
  #vx-chest .tip{margin-top:.6rem;font-size:.7rem;color:#bdbdbd;}`;
document.head.appendChild(chestStyle);
const chestEl = document.createElement('div');
chestEl.id = 'vx-chest';
chestEl.innerHTML = `<div class="win"><div class="hd"><h3>Chest</h3><div class="x" title="Close (Esc)">✕</div></div>
  <h4>Chest</h4><div class="cgrid grid"></div><h4>Your inventory</h4><div class="pgrid grid"></div>
  <div class="tip">Click a stack to move it · chest ↔ inventory</div></div>`;
(document.getElementById('game') ?? document.body).appendChild(chestEl);
chestEl.querySelector<HTMLElement>('.x')!.onclick = () => chestClose();
chestEl.addEventListener('mousedown', (e) => {
  if (e.target === chestEl) chestClose();
});
let openChest: { x: number; y: number; z: number } | null = null;
const chestItems = new Map<number, number>();
const chestUiOpen = (): boolean => chestEl.classList.contains('open');
function onChestOpen(m: { x: number; y: number; z: number; items: Record<string, number> }): void {
  openChest = { x: m.x, y: m.y, z: m.z };
  chestItems.clear();
  for (const [k, v] of Object.entries(m.items)) if (v > 0) chestItems.set(Number(k), v);
  if (!chestUiOpen()) {
    if (locked()) document.exitPointerLock();
    chestEl.classList.add('open');
  }
  frontPanel(chestEl);
  chestRender();
}
function chestClose(): void {
  chestEl.classList.remove('open');
  openChest = null;
  if (mode === 'first') canvas.requestPointerLock();
}
function chestCell(id: number, count: number, onClick: () => void): HTMLDivElement {
  const c = document.createElement('div');
  c.className = 'cell';
  c.style.backgroundImage = `url(${itemTexUrl(invItem(id).texUrl)})`;
  c.title = invItem(id).name;
  const n = document.createElement('div');
  n.className = 'num';
  n.textContent = String(count);
  c.appendChild(n);
  c.onclick = onClick;
  return c;
}
function chestRender(): void {
  if (!chestUiOpen() || !openChest) return;
  const { x, y, z } = openChest;
  const cg = chestEl.querySelector<HTMLElement>('.cgrid')!;
  const pg = chestEl.querySelector<HTMLElement>('.pgrid')!;
  cg.innerHTML = '';
  pg.innerHTML = '';
  const chestList = [...chestItems.entries()].filter(([, c]) => c > 0).sort((a, b) => a[0] - b[0]);
  if (!chestList.length) cg.innerHTML = '<div class="empty">(empty)</div>';
  for (const [id, count] of chestList) cg.appendChild(chestCell(id, count, () => net?.chestMove(x, y, z, id, 'take')));
  const invList = [...invCounts.entries()].filter(([, c]) => c > 0).sort((a, b) => a[0] - b[0]);
  if (!invList.length) pg.innerHTML = '<div class="empty">(empty)</div>';
  for (const [id, count] of invList) pg.appendChild(chestCell(id, count, () => net?.chestMove(x, y, z, id, 'put')));
}

// ── World connect + multiworld switching ──────────────────────────────────────
const worldHandlers = { onSettings: applyServerSettings, onWelcome, onChunk, onUnload, onEdit: onServerEdit, onPortal, onWorlds, onTeleport, onPickup, onInv, onInvAll, onChestOpen, onFurnaceOpen, onDurability, onBoom, onSign: applySign, onSigns: applySigns, onTime, onNote, onLeave: () => setOnline(false), onMsg: onWorldMsg };
function onWorldMsg(m: ChatMsg & { url?: string; token?: string; error?: string }): void {
  if (m.type === 'zoneVoiceToken') void zoneVoice.onToken(m);
  else if (m.type === 'system') chat.addSystemLine(m.text ?? '');
  else if (m.type === 'chat') chat.addChatLine(m.from ?? 'player', m.text ?? '', m.at);
}
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
/** Edit a sign's text: prompt (prefilled with the current text) → send to the server,
 *  which stores + broadcasts it so the in-world label updates for everyone. */
function promptSign(x: number, y: number, z: number): void {
  if (!net) return;
  const cur = signTexts.get(`${x},${y},${z}`) ?? '';
  const ans = window.prompt('Sign text:', cur);
  if (ans === null) return; // cancelled
  net.setSign(x, y, z, ans);
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
  for (const [, r] of npcAvatars) scene.remove(r.avatar.group);
  npcAvatars.clear();
  for (const [, d] of itemDrops) disposeDrop(d);
  itemDrops.clear();
  invCounts.clear(); // reconnect = new session id → server inventory starts fresh
  exploredColors.clear(); // new world → fresh map
  for (const m of chunkMeshes.values()) {
    terrainGroup.remove(m);
    m.geometry.dispose();
  }
  chunkMeshes.clear();
  for (const m of chunkWater.values()) {
    waterGroup.remove(m);
    m.geometry.dispose();
  }
  chunkWater.clear();
  for (const m of chunkLava.values()) {
    lavaGroup.remove(m);
    m.geometry.dispose();
  }
  chunkLava.clear();
  for (const node of portalGlows.values()) portalGlowGroup.remove(node);
  portalGlows.clear();
  for (const node of torchGlows.values()) torchGlowGroup.remove(node);
  torchGlows.clear();
  for (const key of [...signObjs.keys()]) removeSign(key);
  signTexts.clear();
  dirty.clear();
  clearLightCache(); // new world → drop cached column heights + light sources
  world.clear();
  ready = false;
  breaking = null;
  breakOverlay.visible = false;
  moveTarget = null;
  currentWorld = worldId;
  if (worldLabel) worldLabel.textContent = worldId;
  rebuildWorldSelect();
  net = await connectVoxel(worldId, worldHandlers, { skin: playerSkin, seed });
  setOnline(!!net); // connected → online dot; null (offline dev) → offline
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
let lastMapRender = 0;
function frame(now: number): void {
  requestAnimationFrame(frame); // schedule next FIRST — a thrown frame must never stop the loop
  try {
    frameBody(now);
  } catch (e) {
    console.warn('[voxel] frame error (skipped):', e);
  }
}
function frameBody(now: number): void {
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
  const down = !busy && (keys.has('ShiftLeft') || keys.has('ShiftRight')); // sneak / dive
  // Horizontal intent (WASD, or iso click-to-walk); jump/down always pass through so
  // you can surface/dive while standing still in water.
  let fwd = false,
    bk = false,
    lt = false,
    rt = false;
  if (mode === 'iso') {
    if (w || s || a || d) {
      moveTarget = null; // manual movement cancels click-to-walk
      player.yaw = isoYaw; // WASD moves relative to the current map rotation
      fwd = w;
      bk = s;
      lt = a;
      rt = d;
    } else if (moveTarget && !busy) {
      const dx = moveTarget.x - player.pos.x;
      const dz = moveTarget.z - player.pos.z;
      if (Math.hypot(dx, dz) < 0.4) moveTarget = null;
      else {
        player.yaw = Math.atan2(-dx, -dz); // face + walk toward the destination
        fwd = true;
      }
    }
  } else {
    if (mode === 'third') player.yaw = camYaw; // face away from the orbiting camera
    fwd = w;
    bk = s;
    lt = a;
    rt = d;
  }
  const input: MoveInput = { forward: fwd, back: bk, left: lt, right: rt, jump, down, fly: settings.fly };
  if (ready) player.update(dt, input);
  // Safety net: never fall out of the world — snap back to spawn if you somehow
  // drop below the bedrock floor (e.g. through not-yet-streamed chunks).
  if (ready && player.pos.y < -30) {
    player.pos.set(spawn.x, spawn.y, spawn.z);
    player.vel.set(0, 0, 0);
  }
  // Day/night: advance the shared clock and tint sky/fog + the unlit world.
  // Day/night only when enabled in settings; otherwise hold a bright daytime.
  todNow = settings.dayNight ? ((((Date.now() + clockOffset) / dayLengthMs) % 1) + 1) % 1 : 0.4;
  daySample(todNow, dayColors);
  (scene.background as THREE.Color).copy(dayColors.sky);
  perspFog.color.copy(dayColors.sky);
  // Terrain daylight now drives the skylight channel in-shader (material.color stays white);
  // caves/interiors keep their baked darkness while the surface follows the sun.
  lightUniforms.uSky.value.copy(dayColors.light);
  waterUniforms.uLight.value.copy(dayColors.light);
  waterUniforms.uTime.value = now * 0.001;
  lavaUniforms.uTime.value = now * 0.001;
  (clouds.material as THREE.MeshBasicMaterial).color.copy(dayColors.light);
  avatar.setTint(dayColors.light);
  // Clouds follow the player + drift.
  clouds.position.set(player.pos.x, 70, player.pos.z);
  cloudTex.offset.x += dt * 0.004;
  updateSignBillboards(); // sign labels always face the camera
  // Travel map: repaint from loaded terrain while open (throttled).
  if (travelMap.isOpen() && now - lastMapRender > 500) {
    lastMapRender = now;
    travelMap.render();
  }
  // Portal glow pulse (shared materials → all portals shimmer together; brighter at night).
  if (portalGlows.size) {
    const pulse = 0.5 + 0.5 * Math.sin(now * 0.004);
    const boost = isNight(todNow) ? 1.7 : 1;
    portalHaloMat.opacity = (0.25 + 0.35 * pulse) * boost;
    portalBeamMat.opacity = (0.06 + 0.12 * pulse) * boost;
  }
  const wantBreak = !busy && ready && (mode === 'first' ? firstBreakHeld : keys.has('KeyQ'));
  updateBreaking(dt, wantBreak);
  updateWield();
  avatar.setSwimming(player.inWater);
  avatar.animate(dt, player.speed2d, player.pitch);
  updateFootsteps(dt);
  // Report our transform to the server (throttled) so AOI + other players update.
  if (net && ready && now - lastMoveSent > 100) {
    lastMoveSent = now;
    const moveState = player.inWater ? 'swim' : player.speed2d > 0.4 ? 'walk' : 'idle';
    net.sendMove(player.pos.x, player.pos.y, player.pos.z, player.yaw, player.pitch, moveState);
  }
  syncRemotePlayers(dt);
  // Own HP → bar (+ damage flash on decrease).
  if (net) {
    const me = (net.room.state as unknown as RemoteState).players.get(net.sessionId);
    if (me) {
      updateHpBar(me.hp, me.hpMax);
      updateFoodBar(me.food);
      setPlayerName(me.name);
    }
  }
  placeCamera();
  // Fluid murk: dense fog + screen overlay when the camera is submerged (lava wins if both).
  const cam = activeCam();
  const cx = Math.floor(cam.position.x),
    cy = Math.floor(cam.position.y),
    cz = Math.floor(cam.position.z);
  const camLava = world.lava(cx, cy, cz);
  const camWet = !camLava && world.water(cx, cy, cz);
  scene.fog = camLava ? lavaFog : camWet ? underwaterFog : perspFog;
  underwaterOverlay.style.opacity = camWet ? '0.4' : '0';
  lavaOverlay.style.opacity = camLava ? '0.62' : '0';
  renderer.render(scene, activeCam());
}
injectPixelSkin(); // one pixel-menu look for all voxel panels (appended last → wins the cascade)
requestAnimationFrame(frame);
