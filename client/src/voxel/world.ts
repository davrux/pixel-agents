/**
 * The voxel world for the spike: a single fixed region (no chunk streaming yet —
 * that's a later, server-driven phase). Flat Uint8Array of block ids; simple
 * value-noise terrain with grass/dirt/stone layers, sand near the low band, and
 * a few trees. Server authority + chunked sync come in phase 2; this is the
 * client-side foundation so we can see and drive the world.
 */
import { AIR } from './blocks.js';

export const SX = 64; // world size in x
export const SZ = 64; // world size in z
export const SY = 40; // world height

export class VoxelWorld {
  readonly sx = SX;
  readonly sy = SY;
  readonly sz = SZ;
  private readonly data = new Uint8Array(SX * SY * SZ);

  private idx(x: number, y: number, z: number): number {
    return (y * SZ + z) * SX + x;
  }
  inBounds(x: number, y: number, z: number): boolean {
    return x >= 0 && y >= 0 && z >= 0 && x < SX && y < SY && z < SZ;
  }
  get(x: number, y: number, z: number): number {
    if (!this.inBounds(x, y, z)) return AIR;
    return this.data[this.idx(x, y, z)];
  }
  set(x: number, y: number, z: number, id: number): void {
    if (this.inBounds(x, y, z)) this.data[this.idx(x, y, z)] = id;
  }
  solid(x: number, y: number, z: number): boolean {
    return this.get(x, y, z) !== AIR;
  }

  /** Deterministic value-noise heightmap → layered terrain + scattered trees. */
  generate(): void {
    const hAt = (x: number, z: number): number => {
      // a couple of smooth sine octaves — deterministic, no RNG needed
      const n =
        Math.sin(x * 0.18) * 2.2 +
        Math.cos(z * 0.15) * 2.0 +
        Math.sin((x + z) * 0.07) * 3.0 +
        Math.sin(x * 0.05 + z * 0.09) * 2.5;
      return Math.round(SY * 0.45 + n);
    };
    for (let x = 0; x < SX; x++) {
      for (let z = 0; z < SZ; z++) {
        const h = Math.max(2, Math.min(SY - 6, hAt(x, z)));
        for (let y = 0; y <= h; y++) {
          let id = 3; // stone
          if (y === h) id = h <= SY * 0.4 ? 6 : 1; // sand in low band, else grass
          else if (y > h - 3) id = 2; // dirt just under the surface
          this.set(x, y, z, id);
        }
        // scatter deterministic scenery on the grass band: trees, rocks, bushes.
        if (h > SY * 0.4) this.decorate(x, h + 1, z);
      }
    }
  }

  /** Stable per-column hash → deterministic scenery placement + variety. */
  private hash(x: number, z: number): number {
    let n = (Math.imul(x, 73856093) ^ Math.imul(z, 19349663)) >>> 0;
    n = (n ^ (n >>> 13)) >>> 0;
    return Math.imul(n, 1274126177) >>> 0;
  }

  private decorate(x: number, y: number, z: number): void {
    const r = this.hash(x, z);
    if (r % 71 === 0) this.tree(x, y, z, (r >>> 8) & 1);
    else if (r % 89 === 0) this.rock(x, y, z, r);
    else if (r % 23 === 0) this.bush(x, y, z, r);
  }

  /** A rounded horizontal disk of leaves (only fills air, so trunks survive). */
  private leafDisk(cx: number, cy: number, cz: number, rad: number): void {
    for (let dx = -rad; dx <= rad; dx++)
      for (let dz = -rad; dz <= rad; dz++) {
        if (dx * dx + dz * dz > rad * rad + 1) continue; // rounded corners
        if (this.get(cx + dx, cy, cz + dz) === AIR) this.set(cx + dx, cy, cz + dz, 5);
      }
  }

  private tree(x: number, y: number, z: number, variant: number): void {
    const th = 4 + (this.hash(x + 5, z + 9) % 3); // trunk 4–6
    for (let i = 0; i < th; i++) this.set(x, y + i, z, 4); // trunk (wood)
    const top = y + th - 1;
    if (variant === 0) {
      // full round broadleaf canopy
      this.leafDisk(x, top - 1, z, 2);
      this.leafDisk(x, top, z, 2);
      this.leafDisk(x, top + 1, z, 1);
      if (this.get(x, top + 2, z) === AIR) this.set(x, top + 2, z, 5);
    } else {
      // taller, tapered (conifer-ish)
      this.leafDisk(x, top - 2, z, 2);
      this.leafDisk(x, top - 1, z, 1);
      this.leafDisk(x, top, z, 1);
      if (this.get(x, top + 1, z) === AIR) this.set(x, top + 1, z, 5);
    }
  }

  /** A low stone boulder: plus-shaped base + a top bump + a couple of irregular
   *  hash-chosen corners, so no two look identical. */
  private rock(x: number, y: number, z: number, r: number): void {
    const put = (dx: number, dz: number, dy: number): void => this.set(x + dx, y + dy, z + dz, 3);
    put(0, 0, 0);
    put(1, 0, 0);
    put(-1, 0, 0);
    put(0, 1, 0);
    put(0, -1, 0);
    if (r & 1) put(1, 1, 0);
    if (r & 2) put(-1, -1, 0);
    put(0, 0, 1); // bump on top
  }

  /** A small leaf shrub — sometimes a wider clump or two tall. */
  private bush(x: number, y: number, z: number, r: number): void {
    this.set(x, y, z, 5);
    if (r & 4) this.set(x + (r & 8 ? 1 : -1), y, z, 5);
    if (r & 16) this.set(x, y + 1, z, 5);
  }

  /** Highest solid y at (x,z), or -1 if empty — used to spawn the player on top. */
  columnTop(x: number, z: number): number {
    for (let y = SY - 1; y >= 0; y--) if (this.solid(x, y, z)) return y;
    return -1;
  }
}
