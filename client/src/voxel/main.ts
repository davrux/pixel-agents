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
import { Avatar, type Wield, DEFAULT_WIELD } from './avatar.js';
import { makeCrackStages } from './crack.js';
import { digTime } from './luanti.js';
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
// Fog gives depth; all modes are perspective now (iso is a perspective 3/4 view).
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
const persp = new THREE.PerspectiveCamera(75, 1, 0.1, 500);
let mode: CamMode = 'iso';
let isoDist = 16; // iso camera distance (perspective 3/4 view, like third; wheel zooms)
let thirdDist = 4.6; // 3rd-person camera distance (mouse-wheel zooms it)
let isoYaw = -Math.PI / 4; // iso camera orbit yaw (RMB-drag rotates the map)
let isoPitch = 0.687; // iso camera tilt above the horizon (RMB-drag, free up/down)
let camYaw = 0; // third-person camera orbit (RMB-drag)
let camPitch = 0.35;
const camRay = new THREE.Raycaster(); // pulls the 3rd-person camera in past blocks
// User settings (persisted). invertY default on; camera collision default on.
const settings = { invertY: true, camCollide: true };
try {
  Object.assign(settings, JSON.parse(localStorage.getItem('voxSettings') ?? '{}') as Partial<typeof settings>);
} catch {
  /* ignore bad storage */
}
function saveSettings(): void {
  try {
    localStorage.setItem('voxSettings', JSON.stringify(settings));
  } catch {
    /* ignore */
  }
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
    if (settings.camCollide && terrain) {
      camRay.set(eye, dir);
      camRay.far = dist;
      const hit = camRay.intersectObject(terrain, false)[0];
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
const WIELDED_TOOL = 'pick_steel'; // the tool the avatar holds (drives dig times)

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
  // Dig time from the wielded tool + block group (Luanti data). null = the tool
  // is too weak (e.g. steel pick on a diamond block) → can't break it.
  const dur = tgt ? digTime(world.get(tgt.x, tgt.y, tgt.z), [WIELDED_TOOL]) : null;
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

// Items page: cycle items and live-tune how each attaches to the hand (Arm_Right
// bone). Persisted per item id so every tool keeps its own placement.
const ITEMS = [
  { id: 'default_tool_steelpick', name: 'Steel Pickaxe' },
  { id: 'default_tool_steelaxe', name: 'Steel Axe' },
  { id: 'default_tool_steelshovel', name: 'Steel Shovel' },
  { id: 'default_tool_steelsword', name: 'Steel Sword' },
  { id: 'default_tool_woodpick', name: 'Wood Pickaxe' },
];
const WIELD_FIELDS: { k: keyof Wield; label: string; min: number; max: number; step: number }[] = [
  { k: 'px', label: 'Pos X', min: -8, max: 8, step: 0.1 },
  { k: 'py', label: 'Pos Y', min: -8, max: 8, step: 0.1 },
  { k: 'pz', label: 'Pos Z', min: -8, max: 8, step: 0.1 },
  { k: 'rx', label: 'Rot X', min: -3.2, max: 3.2, step: 0.02 },
  { k: 'ry', label: 'Rot Y', min: -3.2, max: 3.2, step: 0.02 },
  { k: 'rz', label: 'Rot Z', min: -3.2, max: 3.2, step: 0.02 },
  { k: 's', label: 'Scale', min: 1, max: 12, step: 0.1 },
];
const loadWield = (id: string): Wield => {
  try {
    return { ...DEFAULT_WIELD, ...(JSON.parse(localStorage.getItem('voxWield:' + id) ?? '{}') as Partial<Wield>) };
  } catch {
    return { ...DEFAULT_WIELD };
  }
};
let itemIdx = 0;
let wield: Wield = loadWield(ITEMS[itemIdx].id);
const wInputs: Record<string, HTMLInputElement> = {};
const wVals: Record<string, HTMLSpanElement> = {};
const showValues = (): void => void (document.getElementById('hand-values')!.textContent = JSON.stringify(wield));
function applyWield(): void {
  avatar.setWieldTransform(wield);
  showValues();
  try {
    localStorage.setItem('voxWield:' + ITEMS[itemIdx].id, JSON.stringify(wield));
  } catch {
    /* ignore */
  }
}
function syncSliders(): void {
  for (const f of WIELD_FIELDS) {
    wInputs[f.k].value = String(wield[f.k]);
    wVals[f.k].textContent = wield[f.k].toFixed(2);
  }
}
function selectItem(idx: number): void {
  itemIdx = (idx + ITEMS.length) % ITEMS.length;
  wield = loadWield(ITEMS[itemIdx].id);
  document.getElementById('item-name')!.textContent = ITEMS[itemIdx].name;
  syncSliders();
  showValues();
  avatar.wield(ITEMS[itemIdx].id, wield); // rebuild the held mesh + apply its transform
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
document.getElementById('item-prev')!.onclick = () => selectItem(itemIdx - 1);
document.getElementById('item-next')!.onclick = () => selectItem(itemIdx + 1);
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
selectItem(0); // wield the first item with its stored/default placement

// ── Loop ──────────────────────────────────────────────────────────────────────
let last = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
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
  player.update(dt, input);
  const wantBreak = !busy && (mode === 'first' ? firstBreakHeld : keys.has('KeyQ'));
  updateBreaking(dt, wantBreak);
  avatar.animate(dt, player.speed2d, player.pitch);
  placeCamera();
  renderer.render(scene, activeCam());
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
