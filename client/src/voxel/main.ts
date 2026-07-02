/**
 * Voxel spike bootstrap — a browser Minecraft-style vertical slice, client-only:
 * a Three.js voxel world, three camera modes (isometric default · third · first
 * person), free AABB movement with gravity/jump, and break/place via a crosshair/
 * mouse raycast. Isolated behind its own page (voxel.html); the 2D game is
 * untouched. Server authority + multiplayer chunk sync are the next phase — this
 * is the foundation to evaluate the look and controls.
 */
import * as THREE from 'three';
import { VoxelWorld } from './world.js';
import { buildMesh } from './mesher.js';
import { Player, type MoveInput } from './player.js';
import { BLOCKS, BLOCK_TEXTURES, ALL_BLOCK_IDS, DEFAULT_HOTBAR } from './blocks.js';
import { loadBlockAtlas, type Atlas } from './textures.js';
import { Avatar } from './avatar.js';
import { makeCrackStages } from './crack.js';
import { openPicker, closePicker, pickerOpen } from './picker.js';

// The CC0 "Simple Skins" set staged under textures/player/skins/.
const SKINS = [...Array(31)].map((_, i) => `character_${i + 1}`).concat(['character_900']);
const texUrl = (tex: string): string => new URL(`textures/blocks/${tex}.png`, document.baseURI).href;
const skinUrl = (name: string): string => new URL(`textures/player/skins/${name}.png`, document.baseURI).href;

type CamMode = 'iso' | 'third' | 'first';

const canvas = document.getElementById('gl') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x8fc7ff);
// Fog gives depth in the perspective modes; the ortho iso camera sits far back
// (constant distance), so distance fog would just paint everything sky — it's
// disabled for iso in placeCamera().
const perspFog = new THREE.Fog(0x8fc7ff, 24, 120);

// World + mesh
const world = new VoxelWorld();
world.generate();
// Textured cubes: the atlas gives the hue (baunilha 16px tiles), vertex colours
// carry face shade × ambient occlusion, alphaTest cuts out transparent leaves.
const material = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, alphaTest: 0.5 });
let terrain: THREE.Mesh | null = null;
let atlas: Atlas | null = null;
function rebuild(): void {
  if (!atlas) return;
  const geo = buildMesh(world, atlas);
  if (terrain) {
    terrain.geometry.dispose();
    terrain.geometry = geo;
  } else {
    terrain = new THREE.Mesh(geo, material);
    scene.add(terrain);
  }
}
// Load the block atlas, then build the terrain (physics runs meanwhile — it uses
// the voxel data, not the mesh, so the world is walkable before textures land).
void loadBlockAtlas(BLOCK_TEXTURES).then((a) => {
  atlas = a;
  material.map = a.texture;
  material.needsUpdate = true;
  rebuild();
});

// Player + a simple blocky avatar (hidden in first person)
const player = new Player(world);
player.spawnOnColumn(Math.floor(world.sx / 2), Math.floor(world.sz / 2));
player.yaw = -Math.PI / 4; // face into the iso view by default
const avatar = new Avatar();
scene.add(avatar.group);

// Cameras
const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 500);
const persp = new THREE.PerspectiveCamera(75, 1, 0.1, 500);
let mode: CamMode = 'iso';
let isoView = 22; // world-units tall the ortho frustum (mouse-wheel zooms it)
let thirdDist = 4.6; // 3rd-person camera distance (mouse-wheel zooms it)
let isoYaw = -Math.PI / 4; // iso camera orbit (LMB-drag rotates the map)
let camYaw = 0; // third-person camera orbit (LMB-drag)
let camPitch = 0.35;
let moveTarget: THREE.Vector3 | null = null; // iso click-to-walk destination
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

function applyIso(): void {
  const aspect = window.innerWidth / window.innerHeight;
  ortho.left = (-isoView * aspect) / 2;
  ortho.right = (isoView * aspect) / 2;
  ortho.top = isoView / 2;
  ortho.bottom = -isoView / 2;
  ortho.updateProjectionMatrix();
}
function resize(): void {
  renderer.setSize(window.innerWidth, window.innerHeight);
  persp.aspect = window.innerWidth / window.innerHeight;
  persp.updateProjectionMatrix();
  applyIso();
}
window.addEventListener('resize', resize);
resize();

function activeCam(): THREE.Camera {
  return mode === 'iso' ? ortho : persp;
}
function placeCamera(): void {
  scene.fog = mode === 'iso' ? null : perspFog;
  const eye = player.eye;
  if (mode === 'iso') {
    // orthographic, orbited around the player by isoYaw (drag to rotate the map)
    const d = 80;
    ortho.position.set(eye.x + Math.sin(isoYaw) * d, eye.y + d * 0.82, eye.z + Math.cos(isoYaw) * d);
    ortho.lookAt(eye);
  } else if (mode === 'first') {
    persp.position.copy(eye);
    persp.rotation.set(player.pitch, player.yaw, 0, 'YXZ');
  } else {
    // third: orbit behind/above the head by camYaw/camPitch (drag to rotate)
    const back = thirdDist;
    const cp = Math.cos(camPitch),
      sp = Math.sin(camPitch);
    persp.position.set(eye.x + Math.sin(camYaw) * cp * back, eye.y + sp * back, eye.z + Math.cos(camYaw) * cp * back);
    persp.lookAt(eye);
  }
  avatar.group.visible = mode !== 'first';
  avatar.group.position.set(player.pos.x, player.pos.y, player.pos.z);
  avatar.group.rotation.y = player.yaw;
}

// ── Input ───────────────────────────────────────────────────────────────────
const keys = new Set<string>();
window.addEventListener('keydown', (e) => {
  if (e.code === 'Escape' && pickerOpen()) return closePicker();
  if (e.code === 'KeyV') return cycleMode();
  if (e.code === 'KeyB') return pickerOpen() ? closePicker() : openBlockPicker();
  if (e.code === 'KeyK') return pickerOpen() ? closePicker() : openSkinPicker();
  if (e.code === 'KeyE' && !pickerOpen()) return placeBlock(); // place a block (Q breaks, held)
  const n = Number(e.key);
  if (n >= 1 && n <= hotbarIds.length) selectSlot(n - 1);
  keys.add(e.code);
});
window.addEventListener('keyup', (e) => keys.delete(e.code));

const pointerNDC = new THREE.Vector2(0, 0); // cursor pos (iso) → target for E/Q + click-to-walk
const locked = (): boolean => document.pointerLockElement === canvas;
let dragging = false;
let dragMoved = false;
let dragX = 0;
let dragY = 0;
const ndc = (e: MouseEvent): THREE.Vector2 =>
  new THREE.Vector2((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);

canvas.addEventListener('mousemove', (e) => {
  if (mode === 'first') {
    if (locked()) player.setLook(-e.movementX * 0.0022, -e.movementY * 0.0022);
    return;
  }
  if (dragging) {
    if (Math.hypot(e.clientX - dragX, e.clientY - dragY) > 5) dragMoved = true;
    if (mode === 'iso') isoYaw -= e.movementX * 0.006; // rotate the map
    else {
      camYaw -= e.movementX * 0.006; // orbit third-person camera
      camPitch = clamp(camPitch + e.movementY * 0.005, -0.15, 1.25);
    }
  }
  // Track the cursor in iso + third person (first person is pointer-locked and
  // aims from screen centre); E/Q place/break at whatever the cursor is over.
  pointerNDC.copy(ndc(e));
});
let firstBreakHeld = false; // first-person LMB held → break (progress in the loop)
canvas.addEventListener('mousedown', (e) => {
  if (mode === 'first') {
    if (!locked()) return void canvas.requestPointerLock();
    if (e.button === 0) firstBreakHeld = true;
    else if (e.button === 2) placeBlock();
    return;
  }
  // iso / third: hold LMB to drag-rotate; a click without a drag walks there (iso).
  if (e.button === 0) {
    dragging = true;
    dragMoved = false;
    dragX = e.clientX;
    dragY = e.clientY;
  }
});
window.addEventListener('mouseup', (e) => {
  if (e.button !== 0) return;
  if (mode === 'first') return void (firstBreakHeld = false);
  if (!dragging) return;
  dragging = false;
  if (mode === 'iso' && !dragMoved) clickToMove(ndc(e));
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('wheel', (e) => {
  // Zoom the world in/out (iso = ortho frustum, third = camera distance).
  const f = e.deltaY > 0 ? 1.12 : 0.9;
  if (mode === 'iso') {
    isoView = clamp(isoView * f, 8, 60);
    applyIso();
  } else if (mode === 'third') {
    thirdDist = clamp(thirdDist * f, 2.2, 14);
  }
  e.preventDefault();
});

/** Raycast the ground under the cursor → an auto-walk destination (iso click). */
function clickToMove(p: THREE.Vector2): void {
  if (!terrain) return;
  raycaster.setFromCamera(p, activeCam());
  const hits = raycaster.intersectObject(terrain, false);
  if (!hits.length) return;
  const hit = hits[0].point.clone().addScaledVector(hits[0].face?.normal ?? new THREE.Vector3(0, 1, 0), -0.5);
  moveTarget = new THREE.Vector3(Math.floor(hit.x) + 0.5, 0, Math.floor(hit.z) + 0.5);
}

function cycleMode(): void {
  mode = mode === 'iso' ? 'third' : mode === 'third' ? 'first' : 'iso';
  moveTarget = null;
  dragging = false;
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
const BREAK_TIME = 0.7; // seconds of holding to break a block

const crackStages = makeCrackStages(6);
const breakOverlay = new THREE.Mesh(
  new THREE.BoxGeometry(1.03, 1.03, 1.03),
  new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }),
);
breakOverlay.visible = false;
scene.add(breakOverlay);
let breaking: { x: number; y: number; z: number; t: number } | null = null;

/** First hit of the aim ray, if within reach — or null. */
function aimHit(): THREE.Intersection | null {
  if (!terrain) return null;
  raycaster.setFromCamera(mode === 'first' ? CENTER : pointerNDC, activeCam());
  const hits = raycaster.intersectObject(terrain, false);
  if (!hits.length || hits[0].point.distanceTo(player.eye) > REACH) return null;
  return hits[0];
}

/** Place the selected block against the aimed face (instant). */
function placeBlock(): void {
  const h = aimHit();
  if (!h) return;
  const nrm = h.face ? h.face.normal : UP;
  const p = h.point.clone().addScaledVector(nrm, 0.5);
  const bx = Math.floor(p.x),
    by = Math.floor(p.y),
    bz = Math.floor(p.z);
  // Don't place inside yourself — that would embed the AABB and lock movement.
  if (!world.solid(bx, by, bz) && !player.intersectsBlock(bx, by, bz)) {
    world.set(bx, by, bz, hotbarIds[selectedSlot]);
    rebuild();
    avatar.playDig();
  }
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
  if (!tgt) {
    breaking = null;
    breakOverlay.visible = false;
    avatar.setMining(false);
    return;
  }
  if (!breaking || breaking.x !== tgt.x || breaking.y !== tgt.y || breaking.z !== tgt.z) breaking = { ...tgt, t: 0 };
  breaking.t += dt;
  avatar.setMining(true);
  breakOverlay.position.set(tgt.x + 0.5, tgt.y + 0.5, tgt.z + 0.5);
  breakOverlay.visible = true;
  const stage = Math.min(crackStages.length - 1, Math.floor((breaking.t / BREAK_TIME) * crackStages.length));
  const mat = breakOverlay.material as THREE.MeshBasicMaterial;
  if (mat.map !== crackStages[stage]) {
    mat.map = crackStages[stage];
    mat.needsUpdate = true;
  }
  if (breaking.t >= BREAK_TIME) {
    world.set(tgt.x, tgt.y, tgt.z, 0);
    rebuild();
    breaking = null;
    breakOverlay.visible = false;
    avatar.setMining(false);
  }
}

// ── HUD (crosshair + hotbar + pickers) ────────────────────────────────────────
// Hotbar holds 9 block ids (quick slots); the "b" picker can swap any slot to any
// of the 26 blocks. Number keys / scroll pick a slot; the selected slot's block
// is what break/place uses.
const hotbarIds = [...DEFAULT_HOTBAR];
let selectedSlot = 0;
function selectSlot(i: number): void {
  selectedSlot = (i + hotbarIds.length) % hotbarIds.length;
  updateHud();
}
function updateHud(): void {
  const label = document.getElementById('mode');
  if (label) label.textContent = `View: ${mode} (V) · Block: ${BLOCKS[hotbarIds[selectedSlot]].name} · B blocks · K skin`;
  const bar = document.getElementById('hotbar')!;
  bar.innerHTML = '';
  hotbarIds.forEach((id, i) => {
    const s = document.createElement('div');
    s.className = 'slot' + (i === selectedSlot ? ' on' : '');
    s.style.backgroundImage = `url(${texUrl(BLOCKS[id].tex)})`;
    s.style.backgroundSize = 'cover';
    s.title = BLOCKS[id].name;
    s.onclick = () => selectSlot(i);
    bar.appendChild(s);
  });
  document.getElementById('cross')!.style.display = mode === 'first' ? 'block' : 'none';
}
updateHud();

function openBlockPicker(): void {
  if (locked()) document.exitPointerLock();
  openPicker(
    'Blocks — click to put in slot ' + (selectedSlot + 1),
    ALL_BLOCK_IDS.map((id) => ({
      thumb: texUrl(BLOCKS[id].tex),
      label: BLOCKS[id].name,
      selected: id === hotbarIds[selectedSlot],
      onPick: () => {
        hotbarIds[selectedSlot] = id;
        updateHud();
        closePicker();
      },
    })),
  );
}
function openSkinPicker(): void {
  if (locked()) document.exitPointerLock();
  openPicker(
    'Player skin',
    SKINS.map((name) => ({
      thumb: skinUrl(name),
      label: name.replace('character_', '#'),
      onPick: () => {
        avatar.setSkin(name);
        closePicker();
      },
    })),
  );
}

// ── Loop ──────────────────────────────────────────────────────────────────────
let last = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  const busy = pickerOpen(); // don't move while a picker window is open
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
    } else if (moveTarget) {
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
  player.update(dt, input);
  const wantBreak = !busy && (mode === 'first' ? firstBreakHeld : keys.has('KeyQ'));
  updateBreaking(dt, wantBreak);
  avatar.animate(dt, player.speed2d, player.pitch);
  placeCamera();
  renderer.render(scene, activeCam());
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
