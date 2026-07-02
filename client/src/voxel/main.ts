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
import { BLOCKS, HOTBAR, BLOCK_TEXTURES } from './blocks.js';
import { loadBlockAtlas, type Atlas } from './textures.js';
import { Avatar } from './avatar.js';

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
const ISO_VIEW = 22; // world-units tall the ortho frustum shows

function resize(): void {
  const w = window.innerWidth,
    h = window.innerHeight;
  renderer.setSize(w, h);
  const aspect = w / h;
  ortho.left = (-ISO_VIEW * aspect) / 2;
  ortho.right = (ISO_VIEW * aspect) / 2;
  ortho.top = ISO_VIEW / 2;
  ortho.bottom = -ISO_VIEW / 2;
  ortho.updateProjectionMatrix();
  persp.aspect = aspect;
  persp.updateProjectionMatrix();
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
    const d = 80;
    ortho.position.set(eye.x + d, eye.y + d * 0.82, eye.z + d);
    ortho.lookAt(eye);
  } else if (mode === 'first') {
    persp.position.copy(eye);
    persp.rotation.set(player.pitch, player.yaw, 0, 'YXZ');
  } else {
    // third: behind + above, looking at the head
    const back = 4.2,
      up = 1.6;
    const fx = -Math.sin(player.yaw),
      fz = -Math.cos(player.yaw);
    persp.position.set(eye.x - fx * back, eye.y + up, eye.z - fz * back);
    persp.rotation.set(player.pitch - 0.15, player.yaw, 0, 'YXZ');
  }
  avatar.group.visible = mode !== 'first';
  avatar.group.position.set(player.pos.x, player.pos.y, player.pos.z);
  avatar.group.rotation.y = player.yaw;
}

// ── Input ───────────────────────────────────────────────────────────────────
const keys = new Set<string>();
window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyV') cycleMode();
  const n = Number(e.key);
  if (n >= 1 && n <= HOTBAR.length) selectSlot(n - 1);
  keys.add(e.code);
});
window.addEventListener('keyup', (e) => keys.delete(e.code));

let pointerNDC = new THREE.Vector2(0, 0); // crosshair centre by default
const locked = (): boolean => document.pointerLockElement === canvas;
canvas.addEventListener('mousemove', (e) => {
  if (locked()) {
    const s = 0.0022;
    player.setLook(-e.movementX * s, -e.movementY * s);
  } else if (mode === 'iso') {
    pointerNDC.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
  }
});
canvas.addEventListener('mousedown', (e) => {
  // In first/third, the first click grabs the pointer; then clicks build.
  if (mode !== 'iso' && !locked()) {
    void canvas.requestPointerLock();
    return;
  }
  if (e.button === 0) editBlock(true); // break
  else if (e.button === 2) editBlock(false); // place
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('wheel', (e) => {
  selectSlot((selected + (e.deltaY > 0 ? 1 : HOTBAR.length - 1)) % HOTBAR.length);
});

function cycleMode(): void {
  mode = mode === 'iso' ? 'third' : mode === 'third' ? 'first' : 'iso';
  if (mode === 'iso' && locked()) document.exitPointerLock();
  updateHud();
}

// ── Break / place via raycast ────────────────────────────────────────────────
const raycaster = new THREE.Raycaster();
function editBlock(breaking: boolean): void {
  if (!terrain) return;
  const origin = mode === 'iso' ? pointerNDC : new THREE.Vector2(0, 0); // crosshair centre in 1st/3rd
  raycaster.setFromCamera(origin, activeCam());
  const hits = raycaster.intersectObject(terrain, false);
  if (!hits.length || hits[0].distance > 8) return;
  const h = hits[0];
  const nrm = h.face ? h.face.normal : new THREE.Vector3(0, 1, 0);
  const p = h.point.clone().addScaledVector(nrm, breaking ? -0.5 : 0.5);
  const bx = Math.floor(p.x),
    by = Math.floor(p.y),
    bz = Math.floor(p.z);
  if (breaking) {
    if (world.solid(bx, by, bz)) {
      world.set(bx, by, bz, 0);
      rebuild();
    }
  } else {
    if (!world.solid(bx, by, bz)) {
      world.set(bx, by, bz, HOTBAR[selected]);
      rebuild();
    }
  }
}

// ── HUD (crosshair + hotbar + mode label) ─────────────────────────────────────
let selected = 0;
function selectSlot(i: number): void {
  selected = i;
  updateHud();
}
function updateHud(): void {
  const label = document.getElementById('mode');
  if (label) label.textContent = `View: ${mode} (V) · Block: ${BLOCKS[HOTBAR[selected]].name}`;
  document.querySelectorAll<HTMLElement>('#hotbar .slot').forEach((el, i) => el.classList.toggle('on', i === selected));
  document.getElementById('cross')!.style.display = mode === 'iso' ? 'none' : 'block';
}
function buildHotbar(): void {
  const bar = document.getElementById('hotbar')!;
  HOTBAR.forEach((id, i) => {
    const s = document.createElement('div');
    s.className = 'slot' + (i === 0 ? ' on' : '');
    s.style.backgroundImage = `url(${new URL('textures/blocks/' + BLOCKS[id].tex + '.png', document.baseURI).href})`;
    s.style.backgroundSize = 'cover';
    s.title = BLOCKS[id].name;
    s.onclick = () => selectSlot(i);
    bar.appendChild(s);
  });
}
buildHotbar();
updateHud();

// ── Loop ──────────────────────────────────────────────────────────────────────
let last = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (mode === 'iso') player.yaw = -Math.PI / 4; // fixed facing for the iso view
  const input: MoveInput = {
    forward: keys.has('KeyW') || keys.has('ArrowUp'),
    back: keys.has('KeyS') || keys.has('ArrowDown'),
    left: keys.has('KeyA') || keys.has('ArrowLeft'),
    right: keys.has('KeyD') || keys.has('ArrowRight'),
    jump: keys.has('Space'),
  };
  player.update(dt, input);
  avatar.animate(dt, player.speed2d, player.pitch);
  placeCamera();
  renderer.render(scene, activeCam());
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
