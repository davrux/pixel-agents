/**
 * Client-side player physics for the spike: an AABB with gravity + jump and
 * per-axis voxel collision (free Minecraft-style movement). In phase 2 the server
 * becomes authoritative — the client keeps this for prediction and the server
 * validates/reconciles; for now it runs standalone so we can walk and build.
 */
import * as THREE from 'three';
import type { VoxelWorld } from './world.js';

const HW = 0.3; // half width/depth
const PH = 1.8; // height (eye ≈ 1.6)
const SPEED = 5.2; // blocks/s
const GRAVITY = -26;
const JUMP = 8.4;
// Swimming: water is non-solid, so in it we swap gravity for gentle buoyancy —
// you sink slowly, hold jump to rise, and move at a reduced speed (no fall damage).
const SWIM_SPEED = 0.62; // horizontal speed factor in water
const SWIM_GRAVITY = -6.5; // gentle sink
const SWIM_UP = 4.6; // hold jump → rise / stay afloat
const SWIM_MAX_DOWN = -2.4;

export interface MoveInput {
  forward: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
  jump: boolean;
}

export class Player {
  /** Feet position (centre-x, feet-y, centre-z). */
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  yaw = 0; // radians; 0 looks toward -Z
  pitch = 0;
  onGround = false;
  inWater = false; // body submerged → swim physics + swim animation

  constructor(private readonly world: VoxelWorld) {}

  get eye(): THREE.Vector3 {
    return new THREE.Vector3(this.pos.x, this.pos.y + 1.6, this.pos.z);
  }

  private collides(x: number, y: number, z: number): boolean {
    const x0 = Math.floor(x - HW),
      x1 = Math.floor(x + HW);
    const y0 = Math.floor(y),
      y1 = Math.floor(y + PH - 0.001);
    const z0 = Math.floor(z - HW),
      z1 = Math.floor(z + HW);
    for (let xi = x0; xi <= x1; xi++)
      for (let yi = y0; yi <= y1; yi++)
        for (let zi = z0; zi <= z1; zi++) {
          // Infinite streamed world: collision is purely against loaded solid
          // blocks (the server fills bedrock below, so there's ground to stand on).
          if (this.world.solid(xi, yi, zi)) return true;
        }
    return false;
  }

  /** Horizontal speed (blocks/s) — drives the avatar's walk animation. */
  get speed2d(): number {
    return Math.hypot(this.vel.x, this.vel.z);
  }

  /** Does the unit cell (bx,by,bz) overlap the player's AABB? Used to forbid
   *  placing a block inside yourself (Minecraft rule) — otherwise you'd embed in
   *  a solid cell and collision would lock you in place. */
  intersectsBlock(bx: number, by: number, bz: number): boolean {
    return (
      bx + 1 > this.pos.x - HW &&
      bx < this.pos.x + HW &&
      bz + 1 > this.pos.z - HW &&
      bz < this.pos.z + HW &&
      by + 1 > this.pos.y &&
      by < this.pos.y + PH
    );
  }

  setLook(dYaw: number, dPitch: number): void {
    this.yaw += dYaw;
    this.pitch = Math.max(-1.4, Math.min(1.4, this.pitch + dPitch));
  }

  update(dt: number, input: MoveInput): void {
    // Desired horizontal velocity from input, rotated into world by yaw.
    const fx = -Math.sin(this.yaw),
      fz = -Math.cos(this.yaw);
    const rx = Math.cos(this.yaw),
      rz = -Math.sin(this.yaw);
    let mx = 0,
      mz = 0;
    if (input.forward) {
      mx += fx;
      mz += fz;
    }
    if (input.back) {
      mx -= fx;
      mz -= fz;
    }
    if (input.right) {
      mx += rx;
      mz += rz;
    }
    if (input.left) {
      mx -= rx;
      mz -= rz;
    }
    // Submerged? Check feet + mid-body cells (water is non-solid, so we detect it
    // separately from collision). Drives swim physics + the swim animation.
    const wx = Math.floor(this.pos.x),
      wz = Math.floor(this.pos.z);
    this.inWater = this.world.water(wx, Math.floor(this.pos.y), wz) || this.world.water(wx, Math.floor(this.pos.y + 1.0), wz);

    const speed = this.inWater ? SPEED * SWIM_SPEED : SPEED;
    const len = Math.hypot(mx, mz) || 1;
    this.vel.x = (mx / len) * speed * (mx || mz ? 1 : 0);
    this.vel.z = (mz / len) * speed * (mx || mz ? 1 : 0);

    if (this.inWater) {
      this.vel.y += SWIM_GRAVITY * dt; // gentle sink
      if (input.jump) this.vel.y = SWIM_UP; // hold jump to rise / tread water
      this.vel.y = Math.max(SWIM_MAX_DOWN, Math.min(SWIM_UP, this.vel.y));
      this.onGround = false;
    } else {
      this.vel.y += GRAVITY * dt;
      if (input.jump && this.onGround) {
        this.vel.y = JUMP;
        this.onGround = false;
      }
    }

    // Recovery: if we're embedded in solid (a block appeared against our AABB),
    // rise until free so we stand on top instead of being locked in place.
    for (let i = 0; i < PH + 2 && this.collides(this.pos.x, this.pos.y, this.pos.z); i++) {
      this.pos.y = Math.floor(this.pos.y) + 1;
      this.vel.y = 0;
      this.onGround = true;
    }

    // Move + resolve per axis (x, z, then y).
    const nx = this.pos.x + this.vel.x * dt;
    if (!this.collides(nx, this.pos.y, this.pos.z)) this.pos.x = nx;
    else this.vel.x = 0;

    const nz = this.pos.z + this.vel.z * dt;
    if (!this.collides(this.pos.x, this.pos.y, nz)) this.pos.z = nz;
    else this.vel.z = 0;

    const ny = this.pos.y + this.vel.y * dt;
    if (!this.collides(this.pos.x, ny, this.pos.z)) {
      this.pos.y = ny;
      this.onGround = false;
    } else {
      if (this.vel.y < 0) this.onGround = true;
      this.vel.y = 0;
    }

    // Fell out of the world → respawn on the surface.
    if (this.pos.y < -8) this.spawnOnColumn(Math.floor(this.pos.x), Math.floor(this.pos.z));
  }

  spawnOnColumn(x: number, z: number): void {
    const top = this.world.columnTop(x, z);
    this.pos.set(x + 0.5, top + 1, z + 0.5);
    this.vel.set(0, 0, 0);
  }
}
