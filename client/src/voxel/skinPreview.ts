/**
 * A small live 3D preview of a player skin on the real character model — shown in the
 * skin picker (K) so you see the skin before committing. Its own tiny WebGL renderer +
 * scene + one Avatar (the world's renderer is untouched); slowly turntables so you see
 * all sides. The world is unlit (MeshBasicMaterial) so no lights are needed.
 */
import * as THREE from 'three';
import { Avatar } from './avatar.js';

export class SkinPreview {
  readonly canvas: HTMLCanvasElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly cam: THREE.PerspectiveCamera;
  private readonly avatar: Avatar;
  private raf = 0;
  private last = 0;

  constructor(skin: string, size = 168) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.canvas.height = size;
    this.canvas.style.cssText = `width:${size}px;height:${size}px;image-rendering:auto;border-radius:6px;background:#11151c;`;
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, alpha: true, antialias: true });
    this.renderer.setSize(size, size, false);
    this.cam = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
    this.cam.position.set(0, 1.05, 3.3);
    this.cam.lookAt(0, 0.95, 0);
    this.avatar = new Avatar(skin);
    this.avatar.group.rotation.y = Math.PI; // model faces -Z; turn it to face the camera (+Z)
    this.scene.add(this.avatar.group);
  }

  setSkin(name: string): void {
    this.avatar.setSkin(name);
  }

  /** Render the turntable while `active()` holds (stops itself once the picker closes). */
  start(active: () => boolean): void {
    this.last = 0;
    const loop = (t: number): void => {
      if (!active()) { this.raf = 0; return; }
      this.raf = requestAnimationFrame(loop);
      const dt = this.last ? Math.min(0.05, (t - this.last) / 1000) : 0;
      this.last = t;
      this.avatar.group.rotation.y += dt * 0.7; // slow turntable
      this.avatar.animate(dt, 0, 0); // idle pose
      this.renderer.render(this.scene, this.cam);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }
}
