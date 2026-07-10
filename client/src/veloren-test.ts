/**
 * Isolated visual test harness for the Veloren figure (dev only, not shipped).
 *
 * Renders the SHIPPING VelorenCharacter (left) next to the ported CharacterFigure
 * (right) so they can be compared frame-for-frame. No server, no auth, no world.
 *
 * URL params:
 *   ?species=human_male   species id
 *   ?anim=idle|run|jump|dig
 *   ?weapon=N             explicit weapon index (else no weapon)
 *   ?seed=N               random outfit seed (overrides weapon; gives armor+weapon)
 *   ?yaw=3.14159          figure facing (radians; default PI = face the camera)
 *   ?only=old|new         render just one side, centered
 */
import * as THREE from 'three';
import { VelorenCharacter, defaultOutfit, type Outfit } from './voxel/velorenChar.js';
import { CharacterFigure } from './voxel/velorenAnim/characterFigure.js';

const q = new URLSearchParams(location.search);
const species = q.get('species') ?? 'human_male';
const anim = q.get('anim') ?? 'idle';
const yaw = parseFloat(q.get('yaw') ?? String(Math.PI));
const only = q.get('only'); // 'old' | 'new' | null
const seedParam = q.get('seed');
const weaponParam = q.get('weapon');

function outfitArg(): Outfit | number {
  if (seedParam != null) return parseInt(seedParam, 10);
  const o = defaultOutfit();
  if (weaponParam != null) o.weapon = parseInt(weaponParam, 10);
  return o;
}

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x4a4f5a, 1);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const cam = new THREE.PerspectiveCamera(35, window.innerWidth / window.innerHeight, 0.1, 100);
cam.position.set(0, 1.0, 4.2);
cam.lookAt(0, 0.9, 0);

scene.add(new THREE.GridHelper(6, 12, 0x888888, 0x666666));

interface Fig {
  group: THREE.Group;
  animate(dt: number, speed?: number, pitch?: number): void;
  setAirborne(on: boolean, vy?: number): void;
  setMining(on: boolean): void;
  playDig(): void;
}

const figs: Fig[] = [];
const label = (x: number, text: string): void => {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#fff';
  g.font = '32px monospace';
  g.fillText(text, 8, 40);
  const tex = new THREE.CanvasTexture(c);
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true }));
  spr.position.set(x, 2.1, 0);
  spr.scale.set(1.0, 0.25, 1);
  scene.add(spr);
};

if (only !== 'new') {
  const oldc = new VelorenCharacter(species, outfitArg());
  oldc.group.position.x = only ? 0 : -1.1;
  oldc.group.rotation.y = yaw;
  scene.add(oldc.group);
  figs.push(oldc);
  label(oldc.group.position.x, 'OLD');
}
if (only !== 'old') {
  const newc = new CharacterFigure(species, outfitArg());
  newc.group.position.x = only ? 0 : 1.1;
  newc.group.rotation.y = yaw;
  scene.add(newc.group);
  figs.push(newc);
  label(newc.group.position.x, 'NEW');
}

if (anim === 'dig') for (const f of figs) f.setMining(true);
if (anim === 'jump') for (const f of figs) f.setAirborne(true, 2);

const hud = document.getElementById('hud')!;
hud.textContent = `species=${species} anim=${anim} weapon=${weaponParam ?? '-'} seed=${seedParam ?? '-'}`;

let last = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  const speed = anim === 'run' ? 4 : anim === 'jump' ? 2 : 0;
  for (const f of figs) f.animate(dt, speed, 0);
  renderer.render(scene, cam);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
