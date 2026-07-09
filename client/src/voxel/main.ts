/**
 * Voxel spike bootstrap — a browser Minecraft-style vertical slice, client-only:
 * a Three.js voxel world, three camera modes (isometric default · third · first
 * person), free AABB movement with gravity/jump, and break/place via a crosshair/
 * mouse raycast. Isolated behind its own page (voxel.html); the 2D game is
 * untouched. Server authority + multiplayer chunk sync are the next phase — this
 * is the foundation to evaluate the look and controls.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { CHUNK, chunkKey, toChunk, ZONES, isWaterId, isLavaId, CRAFT_RECIPES, SMELT_RECIPES, FUEL_ITEMS, MATERIAL_BASE, TOOL_BASE, isHoe, isBucket, isFlintSteel, isBoat, isCart, BUCKET_EMPTY, surfaceColor } from '@pixel/shared';
import { VoxelWorld } from './world.js';
import { buildChunkBuffers, type LayerBuffers, type ChunkBuffers } from './mesher.js';
import { NodeModels } from './nodeModels.js';
import { computeChunkLight, invalidateLight, clearLightCache } from './light.js';
import { ChatUI } from '../ui/chatUI.js';
import { injectPaSkin } from '../ui/paSkin.js';
import { openPaDialog, paDialogOpen, closePaDialog } from '../ui/paDialog.js';
import { ZoneVoiceUI } from '../voice/ZoneVoiceUI.js';
import { ConferenceUI } from '../conference/ConferenceUI.js';
import { LiveKitConference } from '../conference/LiveKitConference.js';
import { SkinPreview } from './skinPreview.js';
import { Player, type MoveInput } from './player.js';
import { BLOCK_TEXTURES, BLOCKS, OVERLAY_TEXTURES, EXTRA_TEXTURES, SYNTHETIC_TILES, PORTAL_ID, WATER_ID, LAVA_ID, TORCH_ID, CHEST_ID, DOOR_CLOSED, DOOR_OPEN, FURNACE_ID, TNT_ID, SIGN_ID, FENCE_GATE_CLOSED, FENCE_GATE_OPEN, BED_ID, FIRE_ID, RAIL_ID, MONITOR_ID, BEDROCK_ID, LIGHT_BLOCKS, ALL_BLOCK_IDS } from './blocks.js';
import type { SignMsg, ChatMsg } from './net.js';
import { daySample, isNight } from './daylight.js';
import { TravelMap } from './map.js';
import { createWaterMaterial, createLavaMaterial } from './water.js';
import { sound, footstepFor, digSoundFor, dugSoundFor, placeSoundFor } from './sounds.js';
import { type Item, type ArmorSlot, TOOL_ITEMS, BLOCK_ITEMS, ARMOR_ITEMS, ALL_ITEMS, itemById, invItem, iconUrl, toolNum, DEFAULT_BLOCKS } from './items.js';
import { Inventory } from './inventory.js';
import { loadBlockAtlas, SYNTHETIC, type Atlas } from './textures.js';
import { Avatar, type Wield, DEFAULT_WIELD } from './avatar.js';
import { makeMob } from './mob.js';
import { makeCrackStages } from './crack.js';
import { connectVoxel, type VoxelNet } from './net.js';
import { gotoLogout, isServerUp, fetchVoxelWorlds } from '../net/room';
import { reloadApp, isDesktop, desktop, setConfiguredServerOrigin } from '../desktop/bridge';
import { KICK_CLOSE_CODE, type CommandSpec } from '@pixel/shared';
import { digTime } from './luanti.js';
import { openPicker, closePicker, pickerOpen } from './picker.js';
import { injectPixelSkin } from './ui.js';

// The CC0 "Simple Skins" set staged under textures/player/skins/.
const SKINS = [...Array(31)].map((_, i) => `character_${i + 1}`).concat(['character_900']);
const itemTexUrl = (rel: string): string => new URL(`textures/${rel}.png`, document.baseURI).href;
const skinUrl = (name: string): string => new URL(`textures/player/skins/${name}.png`, document.baseURI).href;
// The converted boat/cart glTFs reference their original baked texture name (e.g.
// carts_cart.png) which we don't ship — each dir has a `texture.png` we override with.
// Redirect glTF image requests to that sibling so GLTFLoader doesn't 404 + warn.
const gltfTexManager = new THREE.LoadingManager();
gltfTexManager.setURLModifier((url) => url.replace(/\/[^/]+\.png(\?.*)?$/i, '/texture.png'));
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
renderer.setPixelRatio(1); // bootstrap; replaced by applyRenderScale() once settings load
/** Apply the render-resolution preference (clamped 0.5..2) to the WebGL pixelRatio. */
function applyRenderScale(): void {
  renderer.setPixelRatio(Math.max(0.5, Math.min(2, settings.renderScale || 1)));
}

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
// Real Luanti glTF node models (torches/doors/fence gates) drawn instead of cubes;
// reconciled per chunk alongside the mesh (see remeshChunk / onUnload).
const nodeModels = new NodeModels();
scene.add(nodeModels.group);
scene.add(nodeModels.aimGroup); // invisible aim proxies so node models can be targeted

// Boats: rideable water entities synced in state.boats. One glTF template, cloned per
// boat; the local player's camera follows via player.pos (the server glues it to the boat).
const boatGroup = new THREE.Group();
scene.add(boatGroup);
const boatMeshes = new Map<string, THREE.Object3D>();
let boatTemplate: THREE.Object3D | null = null;
{
  const bbase = new URL('models/luanti/boats_boat/', document.baseURI).href;
  const bmat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  new THREE.TextureLoader().load(bbase + 'texture.png', (t) => {
    t.colorSpace = THREE.SRGBColorSpace;
    t.flipY = false;
    bmat.map = t;
    bmat.needsUpdate = true;
  });
  new GLTFLoader(gltfTexManager).load(bbase + 'boats_boat.gltf', (g) => {
    const o = g.scene;
    o.traverse((m) => {
      if ((m as THREE.Mesh).isMesh) {
        (m as THREE.Mesh).material = bmat;
        m.frustumCulled = false;
      }
    });
    const box = new THREE.Box3().setFromObject(o);
    const size = new THREE.Vector3();
    box.getSize(size);
    const s = 1.5 / Math.max(0.001, size.x); // ~1.5 blocks long
    o.scale.setScalar(s);
    o.position.set(-(box.min.x + size.x / 2) * s, -box.min.y * s, -(box.min.z + size.z / 2) * s);
    const wrap = new THREE.Group();
    wrap.add(o);
    boatTemplate = wrap;
  });
}
/** The boat the local player is currently riding (rider === our session id), or null. */
function ridingBoat(): RemoteBoat | null {
  if (!net) return null;
  const st = net.room.state as unknown as RemoteState;
  if (!st?.boats) return null;
  let mine: RemoteBoat | null = null;
  st.boats.forEach((b) => {
    if (b.rider === net!.sessionId) mine = b;
  });
  return mine;
}
/** Render/reconcile boat models from state.boats (AOI-filtered). The server moves boats
 *  at 10 Hz; interpolate the mesh each frame so travel isn't jittery. */
function syncBoats(dt: number, state: RemoteState): void {
  if (!state.boats) return;
  const k = Math.min(1, dt * 10);
  const seen = new Set<string>();
  state.boats.forEach((b, id) => {
    seen.add(id);
    const ty = b.y - 0.1; // hull floats ON the surface (raised — not half-submerged)
    const tyaw = b.yaw - Math.PI; // +90° clockwise from the earlier -π/2 to face travel
    let m = boatMeshes.get(id);
    if (!m) {
      if (!boatTemplate) return;
      m = boatTemplate.clone(true);
      m.userData.boatId = id;
      m.position.set(b.x, ty, b.z); // snap on spawn
      m.rotation.y = tyaw;
      boatMeshes.set(id, m);
      boatGroup.add(m);
      return;
    }
    m.position.x += (b.x - m.position.x) * k;
    m.position.y += (ty - m.position.y) * k;
    m.position.z += (b.z - m.position.z) * k;
    let dyaw = tyaw - m.rotation.y;
    while (dyaw > Math.PI) dyaw -= 2 * Math.PI;
    while (dyaw < -Math.PI) dyaw += 2 * Math.PI;
    m.rotation.y += dyaw * k;
  });
  for (const [id, m] of boatMeshes)
    if (!seen.has(id)) {
      boatGroup.remove(m);
      boatMeshes.delete(id);
    }
}
/** Right-click looking at a boat → mount it. Returns true if it mounted. */
function tryMountBoat(): boolean {
  if (ridingBoat() || !net || !boatGroup.children.length) return false;
  raycaster.setFromCamera(mode === 'first' ? CENTER : pointerNDC, activeCam());
  const hit = raycaster.intersectObjects(boatGroup.children, true)[0];
  if (!hit || hit.distance > REACH + 2) return false;
  let o: THREE.Object3D | null = hit.object;
  while (o && o.parent !== boatGroup) o = o.parent;
  const id = o?.userData.boatId as string | undefined;
  if (!id) return false;
  net.boatMount(id);
  return true;
}

// Carts: rideable rail entities in state.carts. Same pattern as boats (one glTF template,
// cloned per cart, interpolated); the local rider's camera follows via player.pos.
const cartGroup = new THREE.Group();
scene.add(cartGroup);
const cartMeshes = new Map<string, THREE.Object3D>();
let cartTemplate: THREE.Object3D | null = null;
{
  const cbase = new URL('models/luanti/carts_cart/', document.baseURI).href;
  const cmat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  new THREE.TextureLoader().load(cbase + 'texture.png', (t) => {
    t.colorSpace = THREE.SRGBColorSpace;
    t.flipY = false;
    cmat.map = t;
    cmat.needsUpdate = true;
  });
  new GLTFLoader(gltfTexManager).load(cbase + 'carts_cart.gltf', (g) => {
    // The cart is a SkinnedMesh with a single bone carrying a baked 180° rotation — skinned
    // rendering (and .clone(true)) send it off-screen. We don't animate the cart, so render
    // its bind-pose GEOMETRY as a plain static mesh (verified: this shows; skinned didn't).
    let geo: THREE.BufferGeometry | null = null;
    g.scene.traverse((mm) => {
      if ((mm as THREE.Mesh).isMesh && !geo) geo = (mm as THREE.Mesh).geometry as THREE.BufferGeometry;
    });
    if (!geo) return;
    const mesh = new THREE.Mesh(geo, cmat);
    mesh.frustumCulled = false;
    const box = new THREE.Box3().setFromObject(mesh);
    const size = new THREE.Vector3();
    box.getSize(size);
    const s = 0.9 / Math.max(0.001, Math.max(size.x, size.z)); // ~1 block
    mesh.scale.setScalar(s);
    mesh.position.set(-(box.min.x + size.x / 2) * s, -box.min.y * s, -(box.min.z + size.z / 2) * s);
    const wrap = new THREE.Group();
    wrap.add(mesh);
    cartTemplate = wrap;
  });
}
function ridingCart(): RemoteCart | null {
  if (!net) return null;
  const st = net.room.state as unknown as RemoteState;
  if (!st?.carts) return null;
  let mine: RemoteCart | null = null;
  st.carts.forEach((c) => {
    if (c.rider === net!.sessionId) mine = c;
  });
  return mine;
}
function syncCarts(dt: number, state: RemoteState): void {
  if (!state.carts) return;
  const k = Math.min(1, dt * 10);
  const seen = new Set<string>();
  state.carts.forEach((c, id) => {
    seen.add(id);
    let m = cartMeshes.get(id);
    if (!m) {
      if (!cartTemplate) return;
      m = cartTemplate.clone(true); // template is a plain static mesh now → clone is fine
      m.userData.cartId = id;
      m.position.set(c.x, c.y, c.z);
      m.rotation.y = c.yaw;
      cartMeshes.set(id, m);
      cartGroup.add(m);
      return;
    }
    m.position.x += (c.x - m.position.x) * k;
    m.position.y += (c.y - m.position.y) * k;
    m.position.z += (c.z - m.position.z) * k;
    let dyaw = c.yaw - m.rotation.y;
    while (dyaw > Math.PI) dyaw -= 2 * Math.PI;
    while (dyaw < -Math.PI) dyaw += 2 * Math.PI;
    m.rotation.y += dyaw * k;
  });
  for (const [id, m] of cartMeshes)
    if (!seen.has(id)) {
      cartGroup.remove(m);
      cartMeshes.delete(id);
    }
}
function tryMountCart(): boolean {
  if (ridingCart() || !net || !cartGroup.children.length) return false;
  raycaster.setFromCamera(mode === 'first' ? CENTER : pointerNDC, activeCam());
  const hit = raycaster.intersectObjects(cartGroup.children, true)[0];
  if (!hit || hit.distance > REACH + 2) return false;
  let o: THREE.Object3D | null = hit.object;
  while (o && o.parent !== cartGroup) o = o.parent;
  const id = o?.userData.cartId as string | undefined;
  if (!id) return false;
  net.cartMount(id);
  return true;
}
/** Punch (dig) an empty boat/cart you're looking at → ask the server to remove it and
 *  return the item. Returns true if it handled the aim (so no block is dug). */
function tryRemoveMount(): boolean {
  if (!net || ridingBoat() || ridingCart()) return false;
  raycaster.setFromCamera(mode === 'first' ? CENTER : pointerNDC, activeCam());
  const hit = raycaster.intersectObjects([...boatGroup.children, ...cartGroup.children], true)[0];
  if (!hit || hit.distance > REACH + 2) return false;
  let o: THREE.Object3D | null = hit.object;
  while (o && o.parent !== boatGroup && o.parent !== cartGroup) o = o.parent;
  const bid = o?.userData.boatId as string | undefined;
  const cid = o?.userData.cartId as string | undefined;
  if (bid) return void net.boatRemove(bid), true;
  if (cid) return void net.cartRemove(cid), true;
  return false;
}
const NEIGHBORS = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];
function markDirty(cx: number, cy: number, cz: number): void {
  if (meshWorker) return; // the worker meshes from its own world + edit stream (see below)
  dirty.add(chunkKey(cx, cy, cz));
  for (const [dx, dy, dz] of NEIGHBORS) if (world.hasChunk(cx + dx, cy + dy, cz + dz)) dirty.add(chunkKey(cx + dx, cy + dy, cz + dz));
}
/** Assemble a renderable BufferGeometry from the mesher's raw (worker-transferable)
 *  buffers. Kept on the main thread so the mesher itself stays THREE-free. */
function geometryFromBuffers(b: LayerBuffers | null): THREE.BufferGeometry | null {
  if (!b) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(b.pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(b.col, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(b.uv, 2));
  if (b.sky) g.setAttribute('aSky', new THREE.BufferAttribute(b.sky, 1));
  if (b.blk) g.setAttribute('aBlock', new THREE.BufferAttribute(b.blk, 1));
  g.computeBoundingSphere();
  return g;
}
/** Apply freshly-built chunk buffers (from the worker OR the inline path) to the scene:
 *  swap the three terrain layers in place, then refresh the main-thread-only extras
 *  (portal/torch glow + glTF node models). Guarded on hasChunk so a worker result that
 *  arrives just after the chunk was unloaded is dropped instead of re-adding a ghost. */
function applyChunkBuffers(cx: number, cy: number, cz: number, bufs: ChunkBuffers | null): void {
  const key = chunkKey(cx, cy, cz);
  if (!world.hasChunk(cx, cy, cz)) return; // chunk unloaded while its mesh was in flight
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
  layer(chunkMeshes, terrainGroup, material, geometryFromBuffers(bufs?.opaque ?? null));
  layer(chunkWater, waterGroup, waterMaterial, geometryFromBuffers(bufs?.water ?? null));
  layer(chunkLava, lavaGroup, lavaMaterial, geometryFromBuffers(bufs?.lava ?? null));
  refreshPortalGlow(cx, cy, cz);
  refreshTorchGlow(cx, cy, cz);
  nodeModels.rebuildChunk(cx, cy, cz, world); // torch/door/gate glTF models for this chunk
}
/** Inline (main-thread) remesh — the fallback when no mesh worker is available. */
function remeshChunk(cx: number, cy: number, cz: number): void {
  applyChunkBuffers(cx, cy, cz, atlas ? buildChunkBuffers(world, atlas, computeChunkLight(world, cx, cy, cz), cx, cy, cz) : null);
}
// Once all node-model templates have streamed in, rescan already-loaded chunks so
// their torches/doors/gates appear (chunks loaded before the models finished loading).
nodeModels.onReady(() => {
  for (const k of world.keys()) {
    const [cx, cy, cz] = k.split(',').map(Number);
    nodeModels.rebuildChunk(cx, cy, cz, world);
  }
});

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
const monitorNames = new Map<string, string>(); // cellKey → conference room name (title + join-by-name)
// Named monitors show their room name on a floating label above the screen (like signs).
const monitorLabels = new Map<string, THREE.Mesh>();
function makeMonitorLabel(name: string): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = 384;
  cv.height = 96;
  const g = cv.getContext('2d')!;
  g.fillStyle = 'rgba(15,18,32,0.92)'; // dark plaque, blue trim (matches the monitor)
  g.fillRect(0, 0, 384, 96);
  g.strokeStyle = '#3a6ea5';
  g.lineWidth = 8;
  g.strokeRect(4, 4, 376, 88);
  g.fillStyle = '#dfe8f5';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  let size = 34;
  do {
    g.font = `bold ${size}px sans-serif`;
    if (g.measureText(name).width <= 356) break;
    size -= 2;
  } while (size > 16);
  g.fillText(`📹 ${name}`, 192, 50);
  const tex = new THREE.CanvasTexture(cv);
  tex.magFilter = THREE.NearestFilter;
  return tex;
}
function removeMonitorLabel(key: string): void {
  const m = monitorLabels.get(key);
  if (!m) return;
  signGroup.remove(m);
  (m.material as THREE.MeshBasicMaterial).map?.dispose();
  (m.material as THREE.Material).dispose();
  m.geometry.dispose();
  monitorLabels.delete(key);
}
function applyMonitor(m: { x: number; y: number; z: number; name: string }): void {
  const key = `${m.x},${m.y},${m.z}`;
  removeMonitorLabel(key);
  if (m.name) {
    monitorNames.set(key, m.name);
    const mat = new THREE.MeshBasicMaterial({ map: makeMonitorLabel(m.name), transparent: true, side: THREE.DoubleSide, depthWrite: false });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 0.35), mat);
    mesh.position.set(m.x + 0.5, m.y + 1.85, m.z + 0.5); // above the monitor screen
    monitorLabels.set(key, mesh);
    signGroup.add(mesh); // shares the sign group (also billboarded each frame)
  } else monitorNames.delete(key);
}
function applyMonitors(list: { x: number; y: number; z: number; name: string }[]): void {
  for (const key of [...monitorLabels.keys()]) removeMonitorLabel(key);
  monitorNames.clear();
  for (const m of list) applyMonitor(m);
}
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
/** Turn every sign + monitor-name label to face the camera (billboard) — each frame. */
function updateSignBillboards(): void {
  if (!signObjs.size && !monitorLabels.size) return;
  const cam = activeCam();
  for (const m of signObjs.values()) m.quaternion.copy(cam.quaternion);
  for (const m of monitorLabels.values()) m.quaternion.copy(cam.quaternion);
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
/** Remesh dirty chunks until a per-frame TIME budget is spent (not a fixed count):
 *  each chunk's remesh is light-BFS + geometry ≈ several ms, so meshing a fixed 6/frame
 *  could blow a 60 fps frame (16.7 ms) into a 30–60 ms stall during streaming. We always
 *  do at least one (progress never stalls), then stop once `budgetMs` is exceeded; the
 *  rest wait for later frames. A single cold chunk may overshoot, but never a whole batch. */
function flushDirty(budgetMs = 6): void {
  if (!atlas || dirty.size === 0) return;
  const t0 = performance.now();
  for (const key of dirty) {
    const [cx, cy, cz] = key.split(',').map(Number);
    remeshChunk(cx, cy, cz);
    dirty.delete(key);
    if (performance.now() - t0 >= budgetMs) break; // out of frame time — resume next frame
  }
}

// ── Mesh worker: chunk light+geometry off the main thread (see meshWorker.ts). The main
// thread feeds it the same chunk/edit/unload stream, then just uploads the buffers it
// posts back. Falls back to inline meshing (flushDirty) if a worker can't be created.
let meshWorker: Worker | null = null;
const pendingMesh: { cx: number; cy: number; cz: number; buffers: ChunkBuffers }[] = [];
try {
  meshWorker = new Worker(new URL('./meshWorker.ts', import.meta.url), { type: 'module' });
  meshWorker.onmessage = (e: MessageEvent) => {
    const m = e.data as { t: string; cx: number; cy: number; cz: number; buffers: ChunkBuffers };
    if (m.t === 'mesh') pendingMesh.push(m);
  };
  meshWorker.onerror = (err) => {
    console.warn('[voxel] mesh worker error — falling back to inline meshing', err);
    meshWorker = null;
    pendingMesh.length = 0;
    for (const key of world.keys()) dirty.add(key); // re-mesh everything on the main thread
  };
} catch (err) {
  console.warn('[voxel] no mesh worker — inline meshing', err);
  meshWorker = null;
}
/** Apply worker mesh results within a per-frame time budget (upload + node models are
 *  far cheaper than building them, but a big burst could still spike — so we bound it). */
function applyPendingMeshes(budgetMs = 6): void {
  if (pendingMesh.length === 0) return;
  const t0 = performance.now();
  while (pendingMesh.length) {
    const m = pendingMesh.shift()!;
    applyChunkBuffers(m.cx, m.cy, m.cz, m.buffers);
    if (performance.now() - t0 >= budgetMs) break;
  }
}
void loadBlockAtlas([...BLOCK_TEXTURES, ...OVERLAY_TEXTURES, ...EXTRA_TEXTURES], SYNTHETIC).then((a) => {
  atlas = a;
  material.map = a.texture;
  material.needsUpdate = true;
  dropMaterial = new THREE.MeshBasicMaterial({ map: a.texture, alphaTest: 0.5 }); // drop-cube icons
  // Hand the worker the atlas rects (it needs them to mesh); it re-meshes every known
  // chunk once they arrive. No worker → mesh everything already streamed on the main thread.
  if (meshWorker) meshWorker.postMessage({ t: 'rects', rects: a.rects });
  else for (const key of world.keys()) dirty.add(key);
  // Synthetic-tile blocks (ores / water / lava / portal) have no standalone PNG, so their
  // inventory icon was empty — crop it out of the composited atlas canvas instead.
  const cv = a.texture.image as HTMLCanvasElement;
  const iconFromAtlas = (tile: string): string => {
    const r = a.rect(tile);
    const out = document.createElement('canvas');
    out.width = out.height = 32;
    const octx = out.getContext('2d')!;
    octx.imageSmoothingEnabled = false;
    octx.drawImage(cv, r.u0 * cv.width, (1 - r.vTop) * cv.height, (r.u1 - r.u0) * cv.width, (r.vTop - r.vBot) * cv.height, 0, 0, 32, 32);
    return out.toDataURL();
  };
  for (const it of BLOCK_ITEMS) {
    if (it.block !== undefined && SYNTHETIC_TILES.includes(BLOCKS[it.block].tex)) it.icon = iconFromAtlas(BLOCKS[it.block].tex);
  }
  updateHud(); // re-render the hotbar now that synthetic-block icons exist (else they show black on reload)
  if (inventory.isOpen()) inventory.render();
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
  afk: boolean;
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
interface RemoteBoat {
  x: number;
  y: number;
  z: number;
  yaw: number;
  rider: string;
}
type RemoteCart = RemoteBoat; // same shape (x/y/z/yaw/rider)
interface RemoteState {
  players: { forEach(cb: (p: RemotePlayer, k: string) => void): void; get(k: string): RemotePlayer | undefined };
  npcs: { forEach(cb: (p: RemoteNpc, k: string) => void): void; get(k: string): RemoteNpc | undefined };
  items: { forEach(cb: (p: RemoteItem, k: string) => void): void; get(k: string): RemoteItem | undefined };
  boats: { forEach(cb: (p: RemoteBoat, k: string) => void): void; get(k: string): RemoteBoat | undefined };
  carts: { forEach(cb: (p: RemoteCart, k: string) => void): void; get(k: string): RemoteCart | undefined };
}
const remote = new Map<string, { avatar: Avatar; afk?: THREE.Sprite; nameTag?: THREE.Sprite; nameText?: string }>();

// A camera-facing name tag over each remote player's head (Sprite auto-billboards).
// Sized to the text so short names don't get a wide bar. Texture is per-name (rebuilt
// only when the name changes) and disposed with the player.
function makeNameSprite(name: string): THREE.Sprite {
  const cv = document.createElement('canvas');
  const font = 'bold 40px sans-serif';
  const measure = cv.getContext('2d')!;
  measure.font = font;
  const padX = 22;
  cv.width = Math.ceil(measure.measureText(name).width) + padX * 2;
  cv.height = 64;
  const g = cv.getContext('2d')!;
  g.font = font; // resizing the canvas resets the context, so set the font again
  g.fillStyle = 'rgba(15,18,32,0.7)';
  const r = 12;
  g.beginPath();
  g.moveTo(r, 2);
  g.arcTo(cv.width - 2, 2, cv.width - 2, 62, r);
  g.arcTo(cv.width - 2, 62, 2, 62, r);
  g.arcTo(2, 62, 2, 2, r);
  g.arcTo(2, 2, cv.width - 2, 2, r);
  g.fill();
  g.fillStyle = '#eef3fb';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(name, cv.width / 2, 34);
  const tex = new THREE.CanvasTexture(cv);
  tex.magFilter = THREE.NearestFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  const h = 0.3; // world-units tall; width follows the canvas aspect
  sp.scale.set(h * (cv.width / cv.height), h, 1);
  sp.position.set(0, 2.1, 0); // above the head, just under the afk marker (2.35)
  sp.renderOrder = 999;
  return sp;
}
/** Attach/refresh a remote player's floating name tag; rebuilds only when the name changes. */
function setNameTag(rec: { avatar: { group: THREE.Object3D }; nameTag?: THREE.Sprite; nameText?: string }, name: string): void {
  const label = (name || '').trim();
  if (rec.nameText === label) return;
  if (rec.nameTag) {
    rec.avatar.group.remove(rec.nameTag);
    rec.nameTag.material.map?.dispose();
    rec.nameTag.material.dispose();
    rec.nameTag = undefined;
  }
  rec.nameText = label;
  if (label) {
    rec.nameTag = makeNameSprite(label);
    rec.avatar.group.add(rec.nameTag);
  }
}

// A camera-facing "afk" marker (Sprite auto-billboards). Cached texture, one per marker.
let afkTexture: THREE.Texture | null = null;
function afkSprite(): THREE.Sprite {
  if (!afkTexture) {
    const cv = document.createElement('canvas');
    cv.width = 128;
    cv.height = 64;
    const g = cv.getContext('2d')!;
    g.fillStyle = 'rgba(15,18,32,0.85)';
    g.strokeStyle = '#7fa7e0';
    g.lineWidth = 4;
    const r = 10;
    g.beginPath();
    g.moveTo(r, 2);
    g.arcTo(126, 2, 126, 62, r);
    g.arcTo(126, 62, 2, 62, r);
    g.arcTo(2, 62, 2, 2, r);
    g.arcTo(2, 2, 126, 2, r);
    g.fill();
    g.stroke();
    g.fillStyle = '#dfe8f5';
    g.font = 'bold 34px sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('💤 afk', 64, 34);
    afkTexture = new THREE.CanvasTexture(cv);
    afkTexture.magFilter = THREE.NearestFilter;
    afkTexture.colorSpace = THREE.SRGBColorSpace;
  }
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: afkTexture, transparent: true, depthTest: false }));
  sp.scale.set(0.9, 0.45, 1);
  sp.position.set(0, 2.35, 0); // above the head
  sp.renderOrder = 999;
  return sp;
}
// The local player's afk marker (over your own avatar; the schema drives it via mySid).
const selfAfkRec: { avatar: Avatar; afk?: THREE.Sprite } = { avatar };
/** Attach/detach the afk marker on an avatar group to match its afk state. */
function setAfkMarker(rec: { avatar: { group: THREE.Object3D }; afk?: THREE.Sprite }, on: boolean): void {
  if (on && !rec.afk) {
    rec.afk = afkSprite();
    rec.avatar.group.add(rec.afk);
  } else if (!on && rec.afk) {
    rec.avatar.group.remove(rec.afk);
    rec.afk.material.dispose();
    rec.afk = undefined;
  }
}
// An NPC is rendered as either a humanoid Avatar (monsters) or a blocky MobModel
// (animals) — both expose the same group/setTint/animate surface used below.
type NpcRender = { group: THREE.Object3D; setTint(c: THREE.Color): void; animate(dt: number, speed: number): void; dispose(): void };
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
let worldHalfExtent = 0; // world border half-extent in blocks (0 = unbounded), from welcome
function onWelcome(m: unknown): void {
  const w = m as { spawn?: { x: number; y: number; z: number }; now?: number; dayLengthMs?: number; seed?: number; isAdmin?: boolean; size?: number };
  if (typeof w.isAdmin === 'boolean') playerIsAdmin = w.isAdmin;
  worldHalfExtent = Number.isFinite(w.size) && w.size! > 0 ? w.size! / 2 : 0; // 0 = unbounded
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
  meshWorker?.postMessage({ t: 'chunk', cx: c.cx, cy: c.cy, cz: c.cz, cells: c.cells }); // clone (no transfer — main keeps its copy for physics/raycast)
  invalidateLight(c.cx, c.cy, c.cz); // fresh terrain → recompute column heights + sources
  markDirty(c.cx, c.cy, c.cz); // no-op when the worker is active
  markExploredChunk(c.cx, c.cz); // remember this area for the map
}
function onUnload(cx: number, cy: number, cz: number): void {
  world.dropChunk(cx, cy, cz);
  meshWorker?.postMessage({ t: 'unload', cx, cy, cz });
  const key = chunkKey(cx, cy, cz);
  const mesh = chunkMeshes.get(key);
  if (mesh) {
    terrainGroup.remove(mesh);
    mesh.geometry.dispose();
    chunkMeshes.delete(key);
  }
  nodeModels.removeChunk(cx, cy, cz); // drop this chunk's torch/door/gate models
  dirty.delete(key);
}
let lastHiss = -1e9;
function onServerEdit(e: { x: number; y: number; z: number; id: number }): void {
  const prev = world.get(e.x, e.y, e.z);
  world.set(e.x, e.y, e.z, e.id);
  meshWorker?.postMessage({ t: 'edit', x: e.x, y: e.y, z: e.z, id: e.id });
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
  // Fire igniting / going out nearby → a one-shot (the crackle loop is in updateAmbient).
  if ((e.id === FIRE_ID) !== (prev === FIRE_ID)) {
    const near = Math.hypot(e.x - player.pos.x, e.y - player.pos.y, e.z - player.pos.z) < 20;
    if (near) sound.play(e.id === FIRE_ID ? 'fire_small' : 'fire_out', 0.7);
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
    setAfkMarker(r, !!p.afk);
    setNameTag(r, p.name);
  });
  for (const [sid, r] of remote) {
    if (!state.players.get(sid)) {
      scene.remove(r.avatar.group);
      if (r.nameTag) {
        r.nameTag.material.map?.dispose(); // the per-name canvas texture isn't freed by avatar.dispose()
        r.nameTag.material.dispose();
      }
      r.avatar.dispose(); // free GPU geometry/material/texture — not freed by scene.remove()
      remote.delete(sid);
    }
  }
  setAfkMarker(selfAfkRec, !!state.players.get(mySid)?.afk); // own afk marker (visible in 3rd/iso)
  syncNpcs(dt, state);
}

/** Reconcile server-driven NPC avatars (same model as players; walk anim from
 *  position delta; day/night tint). NPC decisions are server-side — we only render. */
function syncNpcs(dt: number, state: RemoteState): void {
  state.npcs.forEach((n, id) => {
    let r = npcAvatars.get(id);
    if (!r) {
      // Animals use their real converted Luanti model; monsters/unmapped kinds
      // fall back to the blocky box model (see makeMob).
      const a: NpcRender = makeMob(n.kind);
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
      r.avatar.dispose(); // free GPU geometry/material/texture — not freed by scene.remove()
      npcAvatars.delete(id);
    }
  }
  syncItemDrops(state);
  syncBoats(dt, state);
  syncCarts(dt, state);
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
// renderScale = the WebGL pixelRatio (render pixels per CSS pixel). 1 = native CSS
// resolution (crisp, the sensible default); <1 renders fewer pixels + upscales (much
// faster when fill-rate bound, e.g. looking down from high up); 2 = full retina (sharp
// but 4× the fragments). Adjustable on the Camera settings page — see applyRenderScale.
const settings = { invertY: true, camCollide: true, autoTool: false, dayNight: false, fly: false, peaceful: true, sound: true, creative: false, durability: true, hunger: true, keepInventory: true, creativeInstantDig: true, hotbarSize: 8, renderScale: 1 };
try {
  Object.assign(settings, JSON.parse(localStorage.getItem('voxSettings') ?? '{}') as Partial<typeof settings>);
} catch {
  /* ignore bad storage */
}
sound.enabled = settings.sound; // apply the loaded preference to the audio manager
applyRenderScale(); // override the bootstrap pixelRatio (line ~65) with the saved preference
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
// Stuck-detection for click-to-walk: the best (smallest) distance reached so far and
// when it last improved. If a placed block / wall stops progress, we abandon the walk
// instead of shoving into it every frame forever (runaway CPU + a "stuck moving" char).
let moveBestDist = Infinity;
let moveStuckSince = 0;
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
  // Typing in any dialog/text field: let the field keep the key (WSAD/Q/E/F… are game
  // binds that would otherwise steal the char via preventDefault). Esc falls through so
  // the dialog can still close below.
  const ae = document.activeElement as HTMLElement | null;
  if (e.code !== 'Escape' && (ae instanceof HTMLInputElement || ae instanceof HTMLTextAreaElement || ae instanceof HTMLSelectElement || ae?.isContentEditable)) return;
  if (e.code === 'Escape' && paDialogOpen()) return closePaDialog();
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
  if (e.code === 'KeyE' && !pickerOpen()) return primaryUse(); // use/place the held item (Q holds to dig)
  // Q press: punch an empty boat/cart you look at → pick it up (else Q holds to dig).
  if (e.code === 'KeyQ' && !e.repeat && !menuOpen() && tryRemoveMount()) return;
  if (e.code === 'KeyP' && !menuOpen()) return makePortal(); // mark aimed block as a portal
  if (e.code === 'KeyF' && !menuOpen()) return attackNearestNpc(); // melee the nearest NPC
  if (e.code === 'KeyG' && !menuOpen()) return void net?.eat(); // eat food (apple/bread) → restore hunger
  const n = Number(e.key);
  if (n >= 1 && n <= HOTBAR_N) selectSlot(n - 1); // 1-8 select a hotbar slot
  keys.add(e.code);
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
// Release all held keys when focus/pointer-lock is lost: a dialog, alt-tab, or Firefox's
// "slow script" prompt swallows the keyup, so an otherwise-held movement key would stick
// and the character runs forever (a runaway "movement loop" that also streams chunks
// nonstop → max CPU). Mirrors the 2D office's blur handler. First-person also drops keys
// when pointer lock exits (you've clicked away / a dialog opened).
const releaseKeys = (): void => keys.clear();
window.addEventListener('blur', releaseKeys);
document.addEventListener('pointerlockchange', () => {
  if (!locked()) releaseKeys();
});

const pointerNDC = new THREE.Vector2(0, 0); // cursor pos (iso) → target for E/Q + click-to-walk
const locked = (): boolean => document.pointerLockElement === canvas;
const menuOpen = (): boolean => pickerOpen() || settingsOpen() || travelMap.isOpen() || inventory.isOpen() || craftOpen() || chestUiOpen() || furnaceOpen() || audioOpen() || paDialogOpen() || inConference;
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
  #vx-name .fps{color:#9aa0b8;font-size:.68rem;margin-left:2px;}
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
nameEl.innerHTML = '<span class="dot"></span><b class="nm">player</b><span class="st">online</span><span class="fps"></span>';
hud.appendChild(nameEl);
const nameNm = nameEl.querySelector('.nm') as HTMLElement;
const nameSt = nameEl.querySelector('.st') as HTMLElement;
const nameFps = nameEl.querySelector('.fps') as HTMLElement;
let fpsAvg = 60; // smoothed FPS, shown in the nameplate
let fpsAcc = 0; // seconds since the last nameplate FPS update
function setPlayerName(name: string): void {
  if (name && nameNm.textContent !== name) nameNm.textContent = name;
}
function setOnline(on: boolean): void {
  nameEl.classList.toggle('off', !on);
  nameSt.textContent = on ? 'online' : 'offline';
}

// ── Auto-reconnect (mirrors the 2D office): if the socket drops unexpectedly (server
// restart / network blip), wait for the server to come back and reload so the player
// rejoins automatically. A consented leave (world switch) or an admin kick is skipped.
let leavingIntentionally = false; // set before our own net.leave() so it isn't treated as a drop
let reconnecting = false;
/** The socket closed/errored. KICK_CLOSE_CODE = admin kick (no reconnect). Any other close
 *  that we didn't initiate (leavingIntentionally) means the server went away → reconnect.
 *  We rely on the leavingIntentionally flag, not the close code, since a graceful server
 *  restart can close with 1000 just like a consented leave. */
function onWorldLeave(code: number): void {
  setOnline(false);
  if (code === KICK_CLOSE_CODE) {
    leavingIntentionally = true; // manual reload/re-login required — don't auto-reconnect
    showReconnectOverlay('You were kicked by an admin. Reload the page to rejoin.', true);
    return;
  }
  if (!leavingIntentionally) handleDisconnect();
}
function showReconnectOverlay(text: string, kicked = false): HTMLElement {
  let overlay = document.getElementById('vx-reconnect');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'vx-reconnect';
    overlay.className = 'pa-ui';
    overlay.style.cssText =
      'position:fixed;inset:0;z-index:1200;display:flex;align-items:center;justify-content:center;text-align:center;padding:1rem;' +
      `background:rgba(10,12,18,${kicked ? 0.9 : 0.82});color:${kicked ? '#ffd2dc' : '#eef1f6'};font:1.15rem 'FS Pixel Sans',ui-monospace,monospace;`;
    (document.getElementById('game') ?? document.body).appendChild(overlay);
  }
  overlay.textContent = text;
  return overlay;
}
/** Poll /health until the server is back, then reload to rejoin. */
function handleDisconnect(): void {
  if (reconnecting || leavingIntentionally) return;
  reconnecting = true;
  showReconnectOverlay('Connection lost — reconnecting…');
  const poll = async (): Promise<void> => {
    if (await isServerUp()) return void reloadApp();
    window.setTimeout(() => void poll(), 2000);
  };
  window.setTimeout(() => void poll(), 1500);
}

// Chat: the SAME shared ChatUI as the 2D office (client/src/ui/chatUI.ts) — one codebase.
// Enter opens the input; while typing, game keybinds are suspended (stopPropagation +
// the isFocused guard in the keydown handler).
// Voxel-only chat commands (kept out of the shared registry; merged into /help + TAB
// autocomplete via ChatUI.extraCommands, handled below in clientCommand).
const VOXEL_COMMANDS: CommandSpec[] = [
  { name: 'pos', group: 'user', usage: '/pos [print]', summary: 'Show your position; /pos print posts it to chat as a clickable /goto link.' },
  { name: 'goto', group: 'user', usage: '/goto <x> <y> <z> | world-spawn', summary: 'Teleport to coordinates in this world, or to the world spawn point.' },
  { name: 'pos1', group: 'user', usage: '/pos1', summary: 'World editor: set selection corner 1 to the block you aim at (or stand on).' },
  { name: 'pos2', group: 'user', usage: '/pos2', summary: 'World editor: set selection corner 2.' },
  { name: 'fill', group: 'user', usage: '/fill <block>', summary: 'World editor: fill the selection with a block (creative). e.g. /fill stone · /fill air.' },
  { name: 'replace', group: 'user', usage: '/replace <from> <to>', summary: 'World editor: replace one block with another inside the selection (creative).' },
];
/** Resolve a block name (e.g. "stone", "glass", "air") or numeric id → a block id. */
function blockIdByName(arg: string): number | undefined {
  const a = arg.trim().toLowerCase();
  if (!a) return undefined;
  if (a === 'air') return 0;
  if (/^\d+$/.test(a)) {
    const n = Number(a);
    return n >= 0 && n < BLOCKS.length ? n : undefined;
  }
  const i = BLOCKS.findIndex((b, idx) => idx > 0 && b.name.toLowerCase() === a);
  return i > 0 ? i : undefined;
}
/** The block cell the player is aiming at (else the block under their feet) — the corner
 *  the /pos1 // pos2 commands select. */
function weAimCell(): { x: number; y: number; z: number } {
  const h = aimHit();
  if (h) {
    const nrm = h.face ? h.face.normal : UP;
    const p = h.point.clone().addScaledVector(nrm, -0.5);
    return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
  }
  return { x: Math.floor(player.pos.x), y: Math.floor(player.pos.y) - 1, z: Math.floor(player.pos.z) };
}
function handleFill(args: string, sys: (t: string) => void): void {
  const id = blockIdByName(args);
  if (id === undefined) return void sys(`Unknown block: "${args.trim()}". Use a name (stone, glass, air, …) or an id.`);
  net?.weFill(id);
}
function handleReplace(args: string, sys: (t: string) => void): void {
  const [a, b] = args.trim().split(/\s+/);
  const from = blockIdByName(a ?? ''),
    to = blockIdByName(b ?? '');
  if (from === undefined || to === undefined) return void sys('Usage: /replace <from> <to> — names or ids, e.g. /replace dirt stone');
  net?.weReplace(from, to);
}
function handleWeSel(n: 1 | 2): void {
  const c = weAimCell();
  net?.weSel(n, c.x, c.y, c.z);
}
/** /pos — show your block position; `print` broadcasts it as a clickable /goto. */
function handlePos(args: string, sys: (t: string) => void): void {
  const x = Math.floor(player.pos.x),
    y = Math.round(player.pos.y),
    z = Math.floor(player.pos.z);
  const cmd = `/goto ${x} ${y} ${z}`;
  if (args.trim().toLowerCase() === 'print') net?.sendChat(`📍 ${cmd}`); // everyone sees a clickable link
  else sys(`Your position: ${x}, ${y}, ${z}  →  ${cmd}`);
}
/** /goto — teleport to coords in this world, or to the world spawn (server-authoritative). */
function handleGoto(args: string, sys: (t: string) => void): void {
  if (!net) return;
  const a = args.trim();
  if (a.toLowerCase() === 'world-spawn') {
    net.sendTeleport(0, 0); // origin surface = the world spawn point
    return void sys('Teleporting to the world spawn…');
  }
  const p = a.split(/\s+/).map(Number);
  if (p.length === 3 && p.every((n) => Number.isFinite(n))) {
    net.sendTeleport(p[0], p[2], p[1]); // (x, z, y)
    return void sys(`Teleporting to ${p[0]}, ${p[1]}, ${p[2]}…`);
  }
  sys('Usage: /goto <x> <y> <z>  or  /goto world-spawn');
}
const chat = new ChatUI({
  sendChat: (text) => net?.sendChat(text),
  sendCommand: (name, args) => net?.sendCommand(name, args),
  isAdmin: () => playerIsAdmin,
  canFocus: () => !menuOpen(),
  extraCommands: VOXEL_COMMANDS,
  clientCommand: (name, args, sys) => {
    if (name === 'voxel') return sys('You are already in the voxel world.'), true;
    if (name === 'pos') return handlePos(args, sys), true;
    if (name === 'goto') return handleGoto(args, sys), true;
    if (name === 'pos1') return handleWeSel(1), true;
    if (name === 'pos2') return handleWeSel(2), true;
    if (name === 'fill') return handleFill(args, sys), true;
    if (name === 'replace') return handleReplace(args, sys), true;
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
  #vx-audio{position:fixed;left:0.75rem;top:3.7rem;width:24rem;max-width:94vw;z-index:120;display:none;
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
  (net.room.state as unknown as { players?: RemoteState['players'] }).players?.forEach((p) => {
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
  // The panel doesn't mirror the hotbar (you drag palette items onto the live bar's
  // slots, which are the drop targets). These slot deps point at the single hotbar.
  toolSlots: () => hotbar,
  blockSlots: () => hotbar,
  armorSlots: () => armorEquipped,
  setToolSlot: (i, id) => {
    hotbar[i] = id;
    updateHud();
    refreshEditor();
    pushSettings();
  },
  setBlockSlot: (i, id) => {
    hotbar[i] = id;
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
    if (e.button === 0) {
      if (tryRemoveMount()) return; // punch an empty boat/cart → pick it up
      firstBreakHeld = true; // else dig with the held item
    } else if (e.button === 1) {
      e.preventDefault(); // no browser autoscroll
      pickBlock(); // middle-click: load the aimed block into the held slot
    } else if (e.button === 2) primaryUse(); // place block / use tool
    return;
  }
  // iso / third: RIGHT button orbits the camera (allowed even with a menu open,
  // so you can view the wield while adjusting it). LEFT button (iso) walks.
  if (e.button === 1 && !menuOpen()) {
    e.preventDefault(); // middle-click: pick the aimed block (no browser autoscroll)
    pickBlock();
  } else if (e.button === 2) rotating = true;
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
// A right-click that opens a dialog releases the pointer lock mid-handler, which lets the
// browser deliver its context menu afterwards (no longer on the canvas). Suppress it
// document-wide — except inside text fields, where the paste/copy menu is still useful.
document.addEventListener('contextmenu', (e) => {
  if ((e.target as HTMLElement | null)?.closest('input, textarea, [contenteditable]')) return;
  e.preventDefault();
});
canvas.addEventListener('wheel', (e) => {
  // First person: the wheel selects the hotbar slot (like Luanti/Minecraft). Iso/third
  // keep the wheel as camera zoom (there you pick a slot with 1-8 or by clicking it).
  if (mode === 'first') {
    selectSlot(sel + (e.deltaY > 0 ? 1 : -1));
    e.preventDefault();
    return;
  }
  const f = e.deltaY > 0 ? 1.12 : 0.9;
  if (mode === 'iso') isoDist = clamp(isoDist * f, 3, 45);
  else if (mode === 'third') thirdDist = clamp(thirdDist * f, 1.0, 14); // closer over-the-shoulder
  e.preventDefault();
});

/** Raycast the ground under the cursor → an auto-walk destination (iso click). */
function clickToMove(p: THREE.Vector2): void {
  raycaster.setFromCamera(p, activeCam());
  const hits = raycaster.intersectObjects(terrainGroup.children, false);
  if (!hits.length) return;
  const hit = hits[0].point.clone().addScaledVector(hits[0].face?.normal ?? new THREE.Vector3(0, 1, 0), -0.5);
  moveTarget = new THREE.Vector3(Math.floor(hit.x) + 0.5, 0, Math.floor(hit.z) + 0.5);
  moveBestDist = Infinity; // reset stuck-detection for the new destination
  moveStuckSince = performance.now();
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
  for (const it of TOOL_ITEMS) {
    const tool = it.tool;
    if (!tool || !toolOwned(it.id)) continue;
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
  const heldId = hotbar[sel];
  const digTool = heldId && toolOwned(heldId) ? itemById(heldId).tool : undefined; // held dig tool, if owned
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
let digStage = -1; // last crack stage a dig sound played on (repeats the dig sound per stage)

/** First hit of the aim ray, if within reach — or null. Includes the node-model aim
 *  proxies (torch/door/gate) so those can be targeted (broken/opened) too. */
function aimHit(): THREE.Intersection | null {
  raycaster.setFromCamera(mode === 'first' ? CENTER : pointerNDC, activeCam());
  const hits = raycaster.intersectObjects([...terrainGroup.children, ...nodeModels.aimGroup.children], false);
  if (!hits.length || hits[0].point.distanceTo(player.eye) > REACH) return null;
  return hits[0];
}

/** March the aim ray through the voxel grid (fluids aren't in the raycast mesh) and
 *  return the first cell + the last empty cell before it, up to REACH. Used by the
 *  bucket: empty scoops the first liquid SOURCE it finds; filled pours into the last
 *  air cell before a hit. `match` decides what counts as the target cell. */
function aimVoxel(
  match: (id: number) => boolean,
  blocks: (id: number) => boolean = (id) => id !== 0,
): { hit: { x: number; y: number; z: number }; air: { x: number; y: number; z: number } } | null {
  raycaster.setFromCamera(mode === 'first' ? CENTER : pointerNDC, activeCam());
  const o = raycaster.ray.origin;
  const d = raycaster.ray.direction;
  let air = { x: Math.floor(o.x), y: Math.floor(o.y), z: Math.floor(o.z) };
  for (let t = 0; t <= REACH; t += 0.08) {
    const x = Math.floor(o.x + d.x * t);
    const y = Math.floor(o.y + d.y * t);
    const z = Math.floor(o.z + d.z * t);
    const id = world.get(x, y, z);
    if (match(id)) return { hit: { x, y, z }, air };
    if (blocks(id)) return null; // a blocker stops the aim
    if (id === 0) air = { x, y, z }; // remember the last true-air cell (pour target)
  }
  return null;
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

/** Use the currently held TOOL (bucket / hoe / flint&steel) — the tool-track action,
 *  fired by the dig/tool input (LMB in first person, Q in iso/third). These can't dig:
 *  a bucket scoops/pours liquid, flint&steel lights fire, a hoe tills ground. Right-click
 *  stays free to place your build block (two-track hotbar) — see placeBlock. */
function useHeldTool(): void {
  const heldId = heldNum();
  // Boat item: aim at a water surface → spawn a rideable boat there (server consumes it).
  if (isBoat(heldId)) {
    const m = aimVoxel(
      (id) => isWaterId(id),
      (id) => id !== 0 && !isWaterId(id) && !isLavaId(id),
    );
    if (m) {
      net?.boatPlace(m.hit.x, m.hit.y, m.hit.z);
      avatar.playDig();
      sound.play('foot_water');
    }
    return;
  }
  // Cart item: march the aim ray to the first RAIL cell (rails are a thin flat quad, so a
  // face-hit gives the wrong cell) and spawn a cart there.
  if (isCart(heldId)) {
    const m = aimVoxel(
      (id) => id === RAIL_ID,
      (id) => id !== 0 && id !== RAIL_ID,
    );
    if (m) {
      net?.cartPlace(m.hit.x, m.hit.y, m.hit.z);
      avatar.playDig();
      sound.play('place');
    }
    return;
  }
  // Buckets act on liquids. Fluids aren't in the raycast mesh, so march the aim ray
  // through the voxel grid: empty scoops the first SOURCE (seeing THROUGH flowing
  // liquid — only solids block); filled pours into the last air cell before a hit.
  if (isBucket(heldId)) {
    if (heldId === BUCKET_EMPTY) {
      const m = aimVoxel(
        (id) => id === WATER_ID || id === LAVA_ID,
        (id) => id !== 0 && !isWaterId(id) && !isLavaId(id),
      );
      if (m) {
        const lava = isLavaId(world.get(m.hit.x, m.hit.y, m.hit.z));
        net?.use(m.hit.x, m.hit.y, m.hit.z, heldId);
        avatar.playDig(); // arm swing (the wielded bucket dips)
        sound.play(lava ? 'cool_lava' : 'foot_water'); // sizzle / water splash
      }
    } else {
      const m = aimVoxel((id) => id !== 0);
      if (m) {
        net?.use(m.air.x, m.air.y, m.air.z, heldId);
        avatar.playDig();
        sound.play('foot_water'); // pour splash
      }
    }
    return;
  }
  const h = aimHit();
  if (!h) return;
  const nrm = h.face ? h.face.normal : UP;
  // Flint & steel lights fire in the air cell against the aimed face (server checks flammability).
  if (isFlintSteel(heldId)) {
    const po = h.point.clone().addScaledVector(nrm, 0.5);
    const ox = Math.floor(po.x),
      oy = Math.floor(po.y),
      oz = Math.floor(po.z);
    if (!world.solid(ox, oy, oz)) {
      net?.use(ox, oy, oz, heldId);
      avatar.playDig();
      sound.play('flint'); // flint & steel strike
    }
    return;
  }
  // Hoe + tillable ground (dirt/grass/sand) → farmland (server converts it).
  if (isHoe(heldId)) {
    const p = h.point.clone().addScaledVector(nrm, -0.5);
    const x = Math.floor(p.x),
      y = Math.floor(p.y),
      z = Math.floor(p.z);
    const b = world.get(x, y, z);
    if (b === 2 || b === 1 || b === 7 || b === 8) {
      net?.use(x, y, z, heldId);
      avatar.playDig(); // hoe swing
      sound.play('dug'); // soil turn
    }
  }
}

/** Right-click on an interactive NODE (chest → open, door/gate → toggle, sign → edit,
 *  furnace → smelt UI, TNT → ignite, bed → sleep) — independent of the held item, so it
 *  works whatever you carry. Returns true if it handled the aimed cell (suppress placing). */
function interactNode(): boolean {
  const h = aimHit();
  if (!h) return false;
  const nrm = h.face ? h.face.normal : UP;
  const p = h.point.clone().addScaledVector(nrm, -0.5);
  const x = Math.floor(p.x),
    y = Math.floor(p.y),
    z = Math.floor(p.z);
  const b = world.get(x, y, z);
  if (b === SIGN_ID) {
    promptSign(x, y, z);
    return true;
  }
  if (b === MONITOR_ID) {
    openConference(x, y, z);
    return true;
  }
  if (b === CHEST_ID || b === DOOR_CLOSED || b === DOOR_OPEN || b === FURNACE_ID || b === TNT_ID || b === FENCE_GATE_CLOSED || b === FENCE_GATE_OPEN || b === BED_ID) {
    net?.use(x, y, z, heldNum()); // chest → open; door/gate → toggle; furnace → smelt UI; TNT → ignite; bed → sleep
    // Door/gate toggle feedback (chest_open plays on the server's onChestOpen reply).
    if (b === DOOR_CLOSED) sound.play('door_open');
    else if (b === DOOR_OPEN) sound.play('door_close');
    else if (b === FENCE_GATE_CLOSED) sound.play('gate_open');
    else if (b === FENCE_GATE_OPEN) sound.play('gate_close');
    else if (b === TNT_ID) sound.play('tnt_ignite');
    return true;
  }
  return false;
}
/** Numeric id of the currently held item (a tool's toolId, else a block's id, else 0)
 *  — sent with the use-action so the server can act on it (hoe/bucket/flint). */
function heldNum(): number {
  const it = held();
  return it.toolId ?? it.block ?? 0;
}

/** Right-click / E action with the held item (Luanti secondary use): interact with an
 *  aimed node (chest/door) first; else use a held tool (bucket/hoe/flint); else place a
 *  held block. */
function primaryUse(): void {
  if (tryMountBoat() || tryMountCart()) return; // looking at a boat/cart → climb in
  if (interactNode()) return; // aiming at a chest/door → open/toggle it, don't place
  const n = held().toolId ?? 0;
  if (isBucket(n) || isHoe(n) || isFlintSteel(n) || isBoat(n) || isCart(n)) return useHeldTool();
  placeBlock();
}

/** Place the held block against the aimed face (instant). A held tool places nothing. */
function placeBlock(): void {
  const block = held().block; // the held build block
  if (block === undefined) return; // holding a tool → nothing to place
  const t = placeTarget();
  if (!t) return;
  const { x: bx, y: by, z: bz } = t;
  // Don't place inside yourself — that would embed the AABB and lock movement.
  if (world.solid(bx, by, bz) || player.intersectsBlock(bx, by, bz)) return;
  // Survival: need one in the stack inventory (fluids/portal/creative are unlimited).
  if (!blockUnlimited(block) && (invCounts.get(block) ?? 0) <= 0) {
    showToast(`Kein Vorrat: ${held().name}`);
    return;
  }
  avatar.playDig();
  sound.play(placeSoundFor(block)); // material-specific place (hard/metal/soft)
  if (!blockUnlimited(block)) onInv({ block, total: (invCounts.get(block) ?? 0) - 1 }); // optimistic; server 'inv' corrects
  if (net) {
    net.sendEdit(bx, by, bz, block); // authoritative — applied when the server echoes
  } else {
    world.set(bx, by, bz, block);
    meshWorker?.postMessage({ t: 'edit', x: bx, y: by, z: bz, id: block });
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
    // Any real block the aim hits is diggable — not just solid ones. Torches, ladders,
    // plants, fire etc. are NONSOLID but still breakable (the ray only hits terrain mesh,
    // so a non-air, non-fluid cell here is a placed block).
    const b = world.get(x, y, z);
    if (b !== 0 && !isWaterId(b) && !isLavaId(b) && b !== BEDROCK_ID) tgt = { x, y, z }; // bedrock is unbreakable
  }
  // Dig time from the held/auto tool + block group (Luanti data). null = the tool
  // is too weak (e.g. steel pick on a diamond block) → can't break it. Creative breaks
  // ANY block near-instantly (Minecraft-style), never blocked by tool tier.
  // Creative digs INSTANTLY by default (Luanti-faithful, one click); the "creativeInstantDig"
  // setting can turn that off → normal dig times + the full break animation (never blocked,
  // so a weak held tool still breaks: fall back to 0.8s if digTime says the tool's too weak).
  const cb = tgt ? world.get(tgt.x, tgt.y, tgt.z) : 0;
  const dur = !tgt
    ? null
    : settings.creative
      ? settings.creativeInstantDig
        ? 0.05
        : digTime(cb, digToolsFor(cb)) ?? 0.8
      : digTime(cb, digToolsFor(cb));
  if (!tgt || dur === null) {
    breaking = null;
    breakOverlay.visible = false;
    avatar.setMining(false);
    return;
  }
  if (!breaking || breaking.x !== tgt.x || breaking.y !== tgt.y || breaking.z !== tgt.z) {
    breaking = { ...tgt, t: 0, dur };
    digStage = -1; // new target → restart the dig-sound cadence
  }
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
  // Repeating dig sound (Luanti: the dig-group sound loops while mining) — one hit per
  // crack stage, at a soft volume so the final dug sound stands out.
  if (stage !== digStage) {
    digStage = stage;
    sound.play(digSoundFor(world.get(tgt.x, tgt.y, tgt.z)), 0.4, 0.95 + Math.random() * 0.1);
  }
  if (breaking.t >= breaking.dur) {
    const broke = world.get(tgt.x, tgt.y, tgt.z);
    sound.play(dugSoundFor(broke)); // material-specific removal (glass shatter, metal clink, …)
    // The tool used (numeric id) so the server can wear it; 0 = bare hand (no wear).
    const usedTool = digToolsFor(broke)[0];
    const toolId = usedTool ? toolNum(usedTool) ?? 0 : 0;
    if (net) {
      net.sendEdit(tgt.x, tgt.y, tgt.z, 0, toolId); // authoritative break — server confirms
    } else {
      world.set(tgt.x, tgt.y, tgt.z, 0);
      meshWorker?.postMessage({ t: 'edit', x: tgt.x, y: tgt.y, z: tgt.z, id: 0 });
      markDirty(toChunk(tgt.x), toChunk(tgt.y), toChunk(tgt.z));
    }
    breaking = null;
    breakOverlay.visible = false;
    avatar.setMining(false);
  }
}

const PICKABLE_BLOCKS = new Set(ALL_BLOCK_IDS); // placeable ids the pick-block control may load
/** Middle-click "pick block" (Minecraft-style): load the block the player is aiming at
 *  into the currently selected hotbar slot so it can be re-placed. */
function pickBlock(): void {
  const h = aimHit();
  if (!h) return;
  const nrm = h.face ? h.face.normal : UP;
  const p = h.point.clone().addScaledVector(nrm, -0.5);
  const id = world.get(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
  if (!PICKABLE_BLOCKS.has(id)) return; // air/fluid/bedrock/hidden → nothing to pick
  hotbar[sel] = 'block:' + id;
  updateHud();
  refreshEditor();
  pushSettings();
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

// Positional ambience (Luanti env_sounds): scan a box around the player and set the
// looping water/lava ambience volume by how much liquid is nearby (submerged → loud).
let ambAcc = 0;
function updateAmbient(dt: number): void {
  ambAcc += dt;
  if (ambAcc < 0.35) return;
  ambAcc = 0;
  const R = 6;
  const px = Math.floor(player.pos.x),
    py = Math.floor(player.pos.y),
    pz = Math.floor(player.pos.z);
  let water = 0,
    lava = 0,
    fire = 0;
  for (let dx = -R; dx <= R; dx++)
    for (let dy = -R; dy <= R; dy++)
      for (let dz = -R; dz <= R; dz++) {
        const id = world.get(px + dx, py + dy, pz + dz);
        if (isWaterId(id)) water++;
        else if (isLavaId(id)) lava++;
        else if (id === FIRE_ID) fire++;
      }
  sound.setAmbient('env_water', Math.min(1, water / 30));
  sound.setAmbient('env_lava', Math.min(1, lava / 20));
  sound.setAmbient('fire', Math.min(1, fire / 4)); // crackle near flames
}

// ── HUD (crosshair + hotbar + pickers) ────────────────────────────────────────
// Luanti-style SINGLE hotbar: one row, ONE selected slot = the held item. Left-click
// (first) / Q (iso·third) digs the aimed block with it (tool speed if it's a dig tool);
// right-click / E places it (block) or uses it (bucket/hoe/flint). Slots are arranged
// by dragging items from the Inventory (I) onto them — any item into any slot. Numbers
// 1-8 select; the mouse WHEEL selects only in FIRST person (iso/third keep wheel = zoom).
let HOTBAR_N = Math.max(4, Math.min(12, settings.hotbarSize || 8)); // slot count — adjustable (Luanti hud_hotbar_itemcount)
const DEFAULT_SLOTS: string[] = ['pick_wood', 'axe_wood', ...DEFAULT_BLOCKS, 'b' + BUCKET_EMPTY];
const hotbar: string[] = [...DEFAULT_SLOTS.slice(0, HOTBAR_N)];
while (hotbar.length < HOTBAR_N) hotbar.push('block:1');
let sel = 0;
const held = (): Item => itemById(hotbar[sel]);
function selectSlot(i: number): void {
  sel = ((i % HOTBAR_N) + HOTBAR_N) % HOTBAR_N;
  updateHud();
  refreshEditor();
  pushSettings(); // remember the selected slot across sessions
}
/** Resize the hotbar (Luanti-style; 4-12 slots): pad new slots with a default block,
 *  trim extras, keep the selection valid. Persisted in settings. */
function setHotbarSize(n: number): void {
  HOTBAR_N = Math.max(4, Math.min(12, Math.floor(n) || 8));
  settings.hotbarSize = HOTBAR_N;
  while (hotbar.length < HOTBAR_N) hotbar.push(DEFAULT_SLOTS[hotbar.length] ?? 'block:1');
  hotbar.length = HOTBAR_N;
  if (sel >= HOTBAR_N) sel = HOTBAR_N - 1;
  updateHud();
  saveSettings();
}
function updateHud(): void {
  const label = document.getElementById('mode');
  if (label) label.textContent = `View: ${mode} (V) · Held: ${held().name} · I inventory · K skin`;
  const bar = document.getElementById('hotbar')!;
  bar.innerHTML = '';
  hotbar.forEach((id, i) => {
    const it = itemById(id);
    const s = document.createElement('div');
    s.className = 'slot' + (i === sel ? ' on' : '');
    s.style.backgroundImage = `url(${iconUrl(it)})`; // iconUrl → the atlas-cropped icon for synthetic blocks (portal/water/lava/ores), else the PNG
    s.style.backgroundSize = 'cover';
    s.title = `${i + 1}. ${it.name}`;
    s.onclick = () => selectSlot(i);
    // Small slot number (1-8…) so you know which key selects it — Luanti/Minecraft-style.
    if (i < 9) {
      const idx = document.createElement('span');
      idx.className = 'idx';
      idx.textContent = String(i + 1);
      s.appendChild(idx);
    }
    // A block slot shows its stack count (∞ for fluids/portal/creative; dim at 0); a tool
    // slot dims if not crafted yet and shows a durability wear bar once used.
    if (it.block !== undefined) {
      const bid = it.block;
      const badge = document.createElement('span');
      badge.className = 'count';
      badge.textContent = blockUnlimited(bid) ? '∞' : String(invCounts.get(bid) ?? 0);
      if (!blockUnlimited(bid) && (invCounts.get(bid) ?? 0) <= 0) badge.classList.add('empty');
      s.appendChild(badge);
    } else if (it.toolId !== undefined) {
      if (!toolOwned(id)) s.style.opacity = '0.4'; // not crafted yet → dim (still selectable)
      const dur = toolDurability.get(it.toolId);
      if (dur && dur.left < dur.max) {
        const frac = Math.max(0, dur.left / dur.max);
        const wbar = document.createElement('span');
        wbar.style.cssText = `position:absolute;left:2px;right:2px;bottom:2px;height:3px;background:#05060b;`;
        const fill = document.createElement('span');
        const hue = Math.round(frac * 120); // 0=red .. 120=green
        fill.style.cssText = `position:absolute;left:0;top:0;bottom:0;width:${Math.round(frac * 100)}%;background:hsl(${hue},70%,50%);`;
        wbar.appendChild(fill);
        s.appendChild(wbar);
      }
    }
    // Drag any inventory item onto any slot (single track — no kind check).
    (s as unknown as { __accept: (dragId: string) => void }).__accept = (dragId) => {
      hotbar[i] = dragId;
      updateHud();
      refreshEditor();
      pushSettings();
      inventory.render();
    };
    bar.appendChild(s);
  });
  document.getElementById('cross')!.style.display = mode === 'first' ? 'block' : 'none';
}

// (The old "B" hotbar-slot picker was removed — there's no such menu in Minecraft/
// Luanti; the Inventory panel (I) already drags items onto hotbar slots, and creative
// shows the full palette there.)

// Wield sync: the avatar holds the block being built by default, and swaps to the
// dig tool while actively breaking (auto-switch shows the best carried tool).
let wieldedId = '';
function setWielded(it: Item): void {
  if (!it.texUrl) return clearWielded(); // no held-mesh sprite (e.g. armour) → show an empty hand, don't load textures/.png
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
    const h = hotbar[sel];
    return h && toolOwned(h) ? setWielded(itemById(h)) : clearWielded(); // manual: the held dig tool, if owned
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
document.getElementById('settings-x')!.onclick = closeSettings;

// Make the settings window draggable by its header bar (free placement so it need
// not cover the centred character). Uses its own listeners; the world handlers
// ignore input while the menu is open, so dragging never moves the player.
const dragHandle = settingsPanel.querySelector('.settings-hd') as HTMLElement;
let dragOff: { x: number; y: number } | null = null;
dragHandle.addEventListener('mousedown', (e) => {
  if ((e.target as HTMLElement)?.id === 'settings-x') return; // clicking ✕ closes, doesn't drag
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
const renderScaleInput = document.getElementById('opt-renderscale') as HTMLInputElement;
const renderScaleVal = document.getElementById('opt-renderscale-val') as HTMLElement;
const showRenderScale = (): void => {
  renderScaleVal.textContent = `${settings.renderScale}× ${settings.renderScale < 1 ? '(faster)' : settings.renderScale > 1 ? '(sharper)' : '(native)'}`;
};
renderScaleInput.value = String(settings.renderScale);
showRenderScale();
renderScaleInput.oninput = () => {
  settings.renderScale = Number(renderScaleInput.value);
  applyRenderScale(); // live — no reload needed
  showRenderScale();
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
  else sound.stopAmbients(); // silence water/lava/fire loops immediately
  saveSettings();
};
const hotbarInput = document.getElementById('opt-hotbar') as HTMLInputElement;
hotbarInput.value = String(HOTBAR_N);
hotbarInput.onchange = () => {
  setHotbarSize(Number(hotbarInput.value));
  hotbarInput.value = String(HOTBAR_N); // reflect clamping
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
const keepInvCb = document.getElementById('opt-keepinv') as HTMLInputElement;
keepInvCb.checked = settings.keepInventory;
keepInvCb.onchange = () => {
  settings.keepInventory = keepInvCb.checked;
  net?.setKeepInv(settings.keepInventory); // off → drop a bones chest on death
  saveSettings();
};
const instantDigCb = document.getElementById('opt-instantdig') as HTMLInputElement;
instantDigCb.checked = settings.creativeInstantDig;
instantDigCb.onchange = () => {
  settings.creativeInstantDig = instantDigCb.checked; // client-only dig-time preference
  saveSettings();
};
const creativeCb = document.getElementById('opt-creative') as HTMLInputElement;
creativeCb.checked = settings.creative;
creativeCb.onchange = () => {
  settings.creative = creativeCb.checked;
  net?.setCreative(settings.creative); // server skips stack consumption + damage while creative
  // Creative unlocks flight but does NOT auto-enable it — Fly is its own toggle
  // (user preference; you can build in creative while still walking on the ground).
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
  // Wield-editor helper: cycle the held slot through every item to tune its hold transform.
  const i = ALL_ITEMS.findIndex((it) => it.id === hotbar[sel]);
  hotbar[sel] = ALL_ITEMS[(i + dir + ALL_ITEMS.length) % ALL_ITEMS.length].id;
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
    keepInventory: settings.keepInventory,
    creativeInstantDig: settings.creativeInstantDig,
    hotbarSize: settings.hotbarSize,
    view: mode,
    skin: playerSkin,
    wield,
    hotbar: { slots: [...hotbar] }, // remembered hotbar arrangement (single row)
    armor: { ...armorEquipped },
    sel, // remembered selected hotbar slot
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
    keepInventory: boolean;
    creativeInstantDig: boolean;
    hotbarSize: number;
    view: CamMode;
    skin: string;
    wield: Record<string, Wield>;
    hotbar: { slots?: string[] };
    armor: Record<string, string | null>;
    sel: number;
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
  if (typeof o.keepInventory === 'boolean') {
    settings.keepInventory = o.keepInventory;
    keepInvCb.checked = o.keepInventory;
  }
  net?.setKeepInv(settings.keepInventory); // tell the server the loaded death preference
  if (typeof o.creativeInstantDig === 'boolean') {
    settings.creativeInstantDig = o.creativeInstantDig;
    instantDigCb.checked = o.creativeInstantDig;
  }
  if (Number.isFinite(o.hotbarSize)) {
    setHotbarSize(o.hotbarSize as number); // resize BEFORE the slot arrangement is restored
    hotbarInput.value = String(HOTBAR_N);
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
  // Restore the saved single-row hotbar arrangement (each slot = any valid item id).
  if (o.hotbar && Array.isArray(o.hotbar.slots)) {
    o.hotbar.slots.forEach((id, i) => {
      if (i < HOTBAR_N && (itemById(id).block !== undefined || itemById(id).toolId !== undefined)) hotbar[i] = id;
    });
    updateHud();
  }
  // Restore the remembered selected slot.
  if (Number.isInteger(o.sel)) {
    sel = Math.max(0, Math.min(HOTBAR_N - 1, o.sel as number));
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
  "position:fixed;left:50%;bottom:9.5rem;transform:translateX(-50%);z-index:400;padding:.35rem .7rem;" +
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
  sound.play('boom', Math.max(0.3, 1 - d / 28)); // TNT explosion (Luanti tnt_explode)
}
/** Tool wear from the server: update the slot's wear bar; toast + forget when it breaks. */
function onDurability(m: { tool: number; left: number; max: number }): void {
  if (m.left <= 0) {
    toolDurability.delete(m.tool);
    showToast(`${invItem(m.tool).name} zerbrochen!`);
    sound.play('tool_breaks'); // Luanti default_tool_breaks
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
    sound.play('chest_open'); // Luanti default_chest_open
  }
  frontPanel(chestEl);
  chestRender();
}
function chestClose(): void {
  chestEl.classList.remove('open');
  openChest = null;
  sound.play('chest_close'); // Luanti default_chest_close
  if (mode === 'first') canvas.requestPointerLock();
}
function chestCell(id: number, count: number, onClick: () => void): HTMLDivElement {
  const c = document.createElement('div');
  c.className = 'cell';
  c.style.backgroundImage = `url(${iconUrl(invItem(id))})`; // atlas-cropped icon for synthetic blocks, else the PNG
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
const worldHandlers = { onSettings: applyServerSettings, onWelcome, onChunk, onUnload, onEdit: onServerEdit, onPortal, onWorlds, onTeleport, onPickup, onInv, onInvAll, onChestOpen, onFurnaceOpen, onDurability, onBoom, onSign: applySign, onSigns: applySigns, onMonitor: applyMonitor, onMonitors: applyMonitors, onTime, onNote, onLeave: onWorldLeave, onMsg: onWorldMsg,
  onCrafted: (m: { block: number; count: number }) => showToast(`✔ Crafted ${m.count}× ${invItem(m.block).name}`) };
function onWorldMsg(
  m: ChatMsg & { url?: string; token?: string; error?: string; x?: number; y?: number; z?: number; messages?: { from?: string; text?: string; at?: number }[] },
): void {
  if (m.type === 'zoneVoiceToken') void zoneVoice.onToken(m);
  else if (m.type === 'confToken') onConfToken(m);
  else if (m.type === 'chatHistory') chat.addHistory(m.messages ?? []); // replay recent chat on join (like 2D)
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
  else if (d?.kind === 'zone') {
    leavingIntentionally = true; // navigating to the 2D client — not a dropped connection
    window.location.href = './'; // 2D client (session carries; zone-targeting is TODO)
  }
}
function onPortal(dest: unknown): void {
  jumpTo(dest);
}
/** Mark the aimed block as a portal — a pixel-menu dialog with a destination dropdown
 *  (all known voxel worlds + 2D zones). Stepping on the stored portal jumps there. */
function promptPortal(x: number, y: number, z: number): void {
  if (!net) return;
  const worlds = [...new Set([...knownWorlds, currentWorld])].sort();
  const body = document.createElement('div');
  body.innerHTML =
    '<div class="fld"><label>Portal target</label><select class="pa-select">' +
    '<optgroup label="Voxel worlds">' +
    worlds.map((w) => `<option value="voxel:${w}">${w}${w === currentWorld ? ' (here)' : ''}</option>`).join('') +
    '</optgroup><optgroup label="2D zones">' +
    Object.values(ZONES)
      .map((z) => `<option value="zone:${z.id}">${z.label}</option>`)
      .join('') +
    '</optgroup></select></div>';
  const sel = body.querySelector<HTMLSelectElement>('select')!;
  if (locked()) document.exitPointerLock(); // free the mouse for the dialog
  openPaDialog({
    title: 'Portal destination',
    body,
    onClose: () => {
      if (mode === 'first') canvas.requestPointerLock();
    },
    buttons: [
      {
        label: 'Set portal',
        kind: 'green',
        onClick: () => {
          const v = sel.value;
          const i = v.indexOf(':');
          const kind = v.slice(0, i),
            id = v.slice(i + 1);
          const dest = kind === 'voxel' && id ? { kind: 'voxel', world: id } : kind === 'zone' && id ? { kind: 'zone', id } : null;
          if (dest) net?.setPortal(x, y, z, dest);
        },
      },
    ],
  });
}
/** Edit a sign's text: prompt (prefilled with the current text) → send to the server,
 *  which stores + broadcasts it so the in-world label updates for everyone. */
function promptSign(x: number, y: number, z: number): void {
  if (!net) return;
  const cur = signTexts.get(`${x},${y},${z}`) ?? '';
  const body = document.createElement('div');
  body.innerHTML = '<div class="fld"><label>Sign text</label><input class="pa-input" maxlength="120"></div>';
  const inp = body.querySelector<HTMLInputElement>('input')!;
  inp.value = cur;
  if (locked()) document.exitPointerLock();
  openPaDialog({
    title: 'Edit sign',
    body,
    onClose: () => {
      if (mode === 'first') canvas.requestPointerLock();
    },
    buttons: [{ label: 'Save', kind: 'green', onClick: () => void net?.setSign(x, y, z, inp.value) }],
  });
}
// ── Conference monitor: a video call bound to a monitor node, reusing the SAME
// ConferenceUI + LiveKitConference as the 2D office. Using a monitor asks the server
// for a LiveKit token (per-monitor room); the reply opens the window + connects media.
const confUI = new ConferenceUI();
let conf: LiveKitConference | null = null;
let confCell: { x: number; y: number; z: number } | null = null; // the monitor we're calling on
let inConference = false; // suppresses game movement while the call window is up

/** Use a monitor → a pixel-menu dialog to name the room (like Pixels). "Save name" just
 *  renames it (no join); "Join call" saves any change then asks the server for the meeting
 *  token (reply → onConfToken). A named room is shared by every monitor with that name. */
function openConference(x: number, y: number, z: number): void {
  if (!net || inConference) return;
  const key = `${x},${y},${z}`;
  const cur = monitorNames.get(key) ?? '';
  const body = document.createElement('div');
  body.innerHTML =
    '<div class="fld"><label>Room name (optional)</label><input class="pa-input" maxlength="32" placeholder="e.g. Standup"></div>';
  const inp = body.querySelector<HTMLInputElement>('input')!;
  inp.value = cur;
  const saveName = (): void => {
    const name = inp.value.trim().slice(0, 32);
    if (name !== cur) net?.sendMonitorName(x, y, z, name); // server stores + broadcasts (+ trims to 32)
  };
  let joining = false; // Join keeps the mouse free for the call UI; other closes re-lock
  if (locked()) document.exitPointerLock();
  openPaDialog({
    title: 'Conference monitor',
    body,
    onClose: () => {
      if (!joining && mode === 'first') canvas.requestPointerLock();
    },
    buttons: [
      { label: 'Save name', onClick: saveName }, // rename without joining
      {
        label: 'Join call',
        kind: 'green',
        onClick: () => {
          joining = true;
          saveName();
          confCell = { x, y, z };
          net?.sendConfToken(x, y, z);
        },
      },
    ],
  });
}

/** Server minted a LiveKit token (or reported it's unavailable) for our monitor. */
function onConfToken(m: { url?: string; token?: string; error?: string; x?: number; y?: number; z?: number; name?: string }): void {
  if (!confCell || m.x !== confCell.x || m.y !== confCell.y || m.z !== confCell.z) return;
  inConference = true;
  const title = (m.name ?? '').trim() || `Monitor (${confCell.x}, ${confCell.y}, ${confCell.z})`;
  confUI.open(title, conferenceHandlers());
  if (m.error || typeof m.url !== 'string' || typeof m.token !== 'string') {
    const msg = m.error === 'not-configured' ? 'Video not configured on the server.' : 'Conference unavailable.';
    confUI.setState({ connected: false, camOn: true, micOn: true, screenOn: false, error: msg });
    return;
  }
  conf = new LiveKitConference(confUI.stage, confUI.screens, {
    onState: (s) => confUI.setState(s),
    onDevices: (d) => confUI.setDevices(d),
    onChat: (msg) => confUI.addChat(msg),
    onParticipants: (list) => confUI.setParticipants(list),
    onScreens: (n) => confUI.setSharing(n > 0),
  });
  zoneVoice.voice.suspend(); // can't be in two calls — pause zone voice during the meeting
  void conf.connect(m.url, m.token).catch(() => {
    /* connect() reports via the state callback */
  });
}

/** Control-bar handlers for the conference window (delegate to the live conf). */
function conferenceHandlers(): import('../conference/ConferenceUI.js').ConferenceUIHandlers {
  return {
    toggleMic: () => void conf?.toggleMic(),
    toggleCam: () => void conf?.toggleCam(),
    toggleScreen: () => void conf?.toggleScreen(),
    switchCamera: (id) => void conf?.switchCamera(id),
    switchMic: (id) => void conf?.switchMic(id),
    switchSpeaker: (id) => void conf?.switchSpeaker(id),
    sendChat: (text) => conf?.sendChat(text),
    leave: () => leaveConference(),
  };
}

/** Tear down the current call: disconnect media, close the window, resume zone voice. */
function leaveConference(): void {
  void conf?.disconnect();
  conf = null;
  confUI.close();
  confCell = null;
  inConference = false;
  zoneVoice.voice.resume();
  if (mode === 'first') canvas.requestPointerLock();
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
  // No server stream offline → hand the locally-generated chunks to the worker directly.
  if (meshWorker) {
    for (const key of world.keys()) {
      const [cx, cy, cz] = key.split(',').map(Number);
      const cells = world.rawChunk(cx, cy, cz);
      if (cells) meshWorker.postMessage({ t: 'chunk', cx, cy, cz, cells });
    }
  } else for (const key of world.keys()) dirty.add(key);
  spawn = { x: 0.5, y: world.columnTop(0, 0) + 1, z: 0.5 };
  ready = false;
}
/** Connect to (or jump to) a voxel world: tears down the current world's client
 *  state and reconnects. Voxel↔voxel is seamless (no page reload). */
async function connectWorld(worldId: string, seed?: number, size?: number): Promise<void> {
  if (inConference) leaveConference(); // don't keep a call open across a world switch
  if (net) {
    leavingIntentionally = true; // our own teardown — the old room's onLeave isn't a drop
    try {
      await net.leave();
    } catch {
      /* ignore */
    }
    net = null;
  }
  // reset the client-side world
  for (const [, r] of remote) {
    scene.remove(r.avatar.group);
    r.avatar.dispose();
  }
  remote.clear();
  for (const [, r] of npcAvatars) {
    scene.remove(r.avatar.group);
    r.avatar.dispose();
  }
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
  nodeModels.clear();
  for (const m of boatMeshes.values()) boatGroup.remove(m);
  boatMeshes.clear();
  for (const m of cartMeshes.values()) cartGroup.remove(m);
  cartMeshes.clear();
  for (const key of [...signObjs.keys()]) removeSign(key);
  for (const key of [...monitorLabels.keys()]) removeMonitorLabel(key);
  signTexts.clear();
  monitorNames.clear();
  dirty.clear();
  clearLightCache(); // new world → drop cached column heights + light sources
  world.clear();
  meshWorker?.postMessage({ t: 'clear' }); // reset the worker's world mirror too
  pendingMesh.length = 0; // drop stale mesh results from the old world
  ready = false;
  breaking = null;
  breakOverlay.visible = false;
  moveTarget = null;
  currentWorld = worldId;
  try {
    localStorage.setItem('vx-last-world', worldId); // so an auto-reconnect reload returns here (like 2D's last-zone)
  } catch {
    /* storage unavailable */
  }
  if (worldLabel) worldLabel.textContent = worldId;
  renderWorldList();
  leavingIntentionally = false; // old room already closed above; a drop from here on is unexpected
  net = await connectVoxel(worldId, worldHandlers, { skin: playerSkin, seed, size });
  setOnline(!!net); // connected → online dot; null (offline dev) → offline
  if (!net) goOffline(); // offline dev / unreachable → local terrain
}
// World tab: jump to another world by id (created on first visit).
const worldInput = document.getElementById('world-input') as HTMLInputElement;
const seedInput = document.getElementById('world-seed') as HTMLInputElement;
const sizeInput = document.getElementById('world-size') as HTMLInputElement;
function goWorld(): void {
  const id = (worldInput.value.trim() || 'default').slice(0, 40);
  const seedRaw = seedInput.value.trim();
  const seed = seedRaw ? Number(seedRaw) >>> 0 : undefined; // custom seed (new worlds only)
  const sizeRaw = sizeInput.value.trim();
  const size = sizeRaw ? Math.max(0, Math.floor(Number(sizeRaw))) : undefined; // square edge, new worlds only
  if (id !== currentWorld) void connectWorld(id, Number.isFinite(seed) ? seed : undefined, Number.isFinite(size) ? size : undefined);
  worldInput.value = '';
}
document.getElementById('world-go')!.onclick = goWorld;
worldInput.onkeydown = (e) => {
  if (e.key === 'Enter') goWorld();
};

// World switcher: a <select> dropdown (like the 2D office zone switcher) — pick a voxel
// world or a 2D zone; the 🗑 next to it deletes the selected voxel world (admin).
const worldListEl = document.getElementById('world-list') as HTMLDivElement;
const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
let knownWorlds: string[] = ['default'];
/** Render the world/zone list — a per-row list (like the 2D office zones): each voxel
 *  world has "● here" or a Go button + a Delete (🗑) for non-default ones; 2D zones get
 *  a Go that hands off to the 2D client. Deleting the world you're in first hops to the
 *  default world, then deletes it (the server refuses to delete the room you occupy). */
function renderWorldList(): void {
  const worlds = [...new Set([...knownWorlds, currentWorld])].sort();
  worldListEl.innerHTML = '';
  for (const w of worlds) {
    const here = w === currentWorld;
    const row = document.createElement('div');
    row.className = 'pa-list-row';
    row.innerHTML = `<span class="nm">${here ? '● ' : ''}${esc(w)}${w === 'default' ? ' <small>(start world)</small>' : ''}</span>`;
    if (here) {
      const tag = document.createElement('span');
      tag.className = 'go';
      tag.style.cssText = 'color:#7fd08a;font-size:0.85rem;';
      tag.textContent = 'here';
      row.appendChild(tag);
    } else {
      const go = document.createElement('button');
      go.className = 'pa-b primary go';
      go.textContent = 'Go';
      go.onclick = () => void connectWorld(w);
      row.appendChild(go);
    }
    if (w !== 'default') {
      const del = document.createElement('button');
      del.className = 'pa-b danger del';
      del.textContent = '🗑';
      del.title = `Delete world "${w}"`;
      del.onclick = () => deleteWorld(w);
      row.appendChild(del);
    }
    worldListEl.appendChild(row);
  }
  // 2D zones → hand off to the 2D client.
  for (const z of Object.values(ZONES)) {
    const row = document.createElement('div');
    row.className = 'pa-list-row';
    row.innerHTML = `<span class="nm">${esc(z.label)} <small>(2D zone)</small></span>`;
    const go = document.createElement('button');
    go.className = 'pa-b go';
    go.textContent = 'Go';
    go.onclick = () => jumpTo({ kind: 'zone', id: z.id });
    row.appendChild(go);
    worldListEl.appendChild(row);
  }
}
/** Delete a voxel world (our pixel-menu confirm, not window.confirm). The current world can
 *  be deleted too — we hop to default first (the server refuses to delete the room you're in). */
function deleteWorld(id: string): void {
  if (id === 'default') return;
  const body = document.createElement('div');
  body.innerHTML = `<p style="margin:0;line-height:1.45">Delete world <b>${esc(id)}</b>?<br>This permanently removes its saved terrain + buildings.</p>`;
  openPaDialog({
    title: 'Delete world',
    body,
    buttons: [
      {
        label: 'Delete',
        kind: 'danger',
        onClick: () =>
          void (async () => {
            if (id === currentWorld) await connectWorld('default');
            net?.deleteWorld(id);
          })(),
      },
    ],
  });
}
function onWorlds(list: unknown): void {
  if (Array.isArray(list)) knownWorlds = list.filter((x): x is string => typeof x === 'string');
  renderWorldList();
}

// Log out (clears the session on the server, redirects to login).
document.getElementById('settings-logout')!.onclick = () => {
  leavingIntentionally = true; // logging out — not a dropped connection
  gotoLogout();
};

renderWorldList();
// Start in the last world we were in (so an auto-reconnect reload lands back there), else
// default. But if that world was deleted while we were away, connecting would resurrect it
// as an empty ghost — so validate it against the server's world list first and fall back to
// default when it's gone (no "nirvana"). If the list can't be fetched, try it anyway.
void (async (): Promise<void> => {
  // Desktop only: the server origin lives in a module-level cache that the office
  // bundle's boot flow populates — but arriving here via a full-page navigation to
  // voxel.html loads a *separate* bundle whose cache starts null. Repopulate it from
  // the persisted server URL before any network call, or every fetch/connect targets
  // an empty origin and the world never connects. (Browser: getServerHttpOrigin uses
  // window.location, so this is a no-op there.)
  if (isDesktop()) {
    try {
      const savedUrl = await desktop().getServerUrl();
      if (savedUrl) setConfiguredServerOrigin(savedUrl);
    } catch {
      /* fall through — connect will surface the failure */
    }
  }

  let startWorld = 'default';
  try {
    startWorld = localStorage.getItem('vx-last-world') || 'default';
  } catch {
    /* storage unavailable */
  }
  if (startWorld !== 'default') {
    const worlds = await fetchVoxelWorlds();
    if (worlds && !worlds.includes(startWorld)) {
      startWorld = 'default'; // the saved world no longer exists → land in default, not a ghost
      try {
        localStorage.setItem('vx-last-world', 'default');
      } catch {
        /* ignore */
      }
    }
  }
  await connectWorld(startWorld);
})();





// ── Loop ──────────────────────────────────────────────────────────────────────
let last = performance.now();
let lastMoveSent = 0;
let lastBoatSteer = 0;
let boatDismountLatch = false;
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
  // FPS readout in the nameplate (EMA-smoothed, refreshed ~2×/s).
  if (dt > 0) fpsAvg += (1 / dt - fpsAvg) * 0.1;
  fpsAcc += dt;
  if (fpsAcc >= 0.5) {
    fpsAcc = 0;
    nameFps.textContent = `· ${Math.round(fpsAvg)} fps`;
  }
  applyPendingMeshes(); // upload chunk meshes the worker finished (within a frame budget)
  if (!meshWorker) flushDirty(); // fallback: mesh on the main thread when no worker
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
  // Riding a boat: the server drives it — steer with WASD, ride along (camera follows the
  // player pos the server glues to the boat), Space to climb out. Local physics is skipped.
  // Horizontal intent (WASD, or iso click-to-walk); jump/down always pass through so
  // you can surface/dive while standing still in water.
  let fwd = false,
    bk = false,
    lt = false,
    rt = false;
  const boat = ridingBoat();
  const cart = boat ? null : ridingCart();
  const mount = boat || cart;
  if (mount) {
    // Riding a boat/cart: the server owns it (10 Hz) — smoothly follow it (no snap = no
    // jitter) and turn WITH it in every view. Boat: WASD steers. Cart: W accelerate /
    // S brake (rails steer). Space climbs out. Local physics + move-input are skipped.
    const k = Math.min(1, dt * 10);
    const oy = boat ? 0.2 : 0.3;
    player.pos.x += (mount.x - player.pos.x) * k;
    player.pos.y += (mount.y + oy - player.pos.y) * k;
    player.pos.z += (mount.z - player.pos.z) * k;
    player.vel.set(0, 0, 0);
    let dyaw = mount.yaw - player.yaw;
    while (dyaw > Math.PI) dyaw -= 2 * Math.PI;
    while (dyaw < -Math.PI) dyaw += 2 * Math.PI;
    player.yaw += dyaw * k;
    if (mode === 'iso') isoYaw = player.yaw; // keep the view aligned with the heading
    else if (mode === 'third') camYaw = player.yaw;
    if (net && now - lastBoatSteer > 90) {
      lastBoatSteer = now;
      if (boat) net.boatSteer(w ? 1 : s ? -1 : 0, a ? 1 : d ? -1 : 0);
      else net.cartSteer(w ? 1 : s ? -1 : 0);
    }
    if (jump && !boatDismountLatch) (boat ? net?.boatDismount() : net?.cartDismount());
    boatDismountLatch = jump;
  } else if (mode === 'iso') {
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
      const d = Math.hypot(dx, dz);
      if (d < 0.4) moveTarget = null; // arrived
      else if (d < moveBestDist - 0.05) {
        moveBestDist = d; // still making progress
        moveStuckSince = now;
      } else if (now - moveStuckSince > 1200) {
        moveTarget = null; // no progress for >1.2s → blocked; stop walking (don't loop forever)
      }
      if (moveTarget) {
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
  if (ready && !mount) player.update(dt, input); // boat/cart: server drives position, skip local physics
  // World border: keep the player inside a sized world (invisible wall at ±half-extent).
  if (worldHalfExtent > 0) {
    const lim = worldHalfExtent - 0.3; // player half-width slack
    if (player.pos.x < -lim || player.pos.x > lim) {
      player.pos.x = Math.max(-lim, Math.min(lim, player.pos.x));
      player.vel.x = 0;
    }
    if (player.pos.z < -lim || player.pos.z > lim) {
      player.pos.z = Math.max(-lim, Math.min(lim, player.pos.z));
      player.vel.z = 0;
    }
  }
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
  avatar.setSwimming(!mount && player.inWater); // riding a boat/cart → sit, don't keep the swim pose
  avatar.animate(dt, player.speed2d, player.pitch);
  updateFootsteps(dt);
  updateAmbient(dt);
  // Report our transform to the server (throttled) so AOI + other players update.
  // (Skipped while riding — the server owns the boat+rider position via boatSteer.)
  if (net && ready && !mount && now - lastMoveSent > 100) {
    lastMoveSent = now;
    const moveState = player.inWater ? 'swim' : player.speed2d > 0.4 ? 'walk' : 'idle';
    net.sendMove(player.pos.x, player.pos.y, player.pos.z, player.yaw, player.pitch, moveState);
  }
  syncRemotePlayers(dt);
  // Own HP → bar (+ damage flash on decrease).
  if (net) {
    const me = (net.room.state as unknown as { players?: RemoteState['players'] }).players?.get(net.sessionId); // players may be unsynced on the first frames
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
injectPaSkin(); // shared .pa-* skin (same as the 2D office) for the voxel select/inputs/buttons
injectPixelSkin(); // one pixel-menu look for all voxel panels (appended last → wins the cascade)
requestAnimationFrame(frame);
