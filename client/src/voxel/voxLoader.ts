/**
 * Minimal MagicaVoxel (.vox) loader + mesher for character segments.
 *
 * Parses the RIFF-like .vox format (MAIN › SIZE / XYZI / RGBA), then builds one
 * merged, face-culled BufferGeometry with per-voxel vertex colours from the
 * model's palette — small models (a few hundred voxels) so a plain merged mesh
 * is plenty. Unlit MeshBasicMaterial to match the rest of the voxel client.
 *
 * Coordinates: MagicaVoxel and Veloren are both Z-up, so voxel (x,y,z) maps 1:1
 * into a bone's local frame (x=right, y=forward, z=up). Each voxel spans the unit
 * cube [pos, pos+1]; `offset` (from Veloren's part manifests) shifts voxel (0,0,0).
 */
import * as THREE from 'three';

export interface VoxModel {
  sx: number;
  sy: number;
  sz: number;
  voxels: Uint8Array; // flat x + y*sx + z*sx*sy → palette index (0 = empty)
  palette: number[]; // 256 entries, 0xRRGGBB (index 1..255; 0 unused)
}

/** Parse a .vox file buffer into a VoxModel (first model only). */
export function parseVox(buf: ArrayBuffer): VoxModel {
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== 'VOX ') throw new Error('not a .vox file');
  let sx = 0,
    sy = 0,
    sz = 0;
  let xyzi: { x: number; y: number; z: number; i: number }[] = [];
  let palette: number[] | null = null;

  // Walk chunks starting after the 8-byte header (magic + version). MAIN's own
  // content is empty; its children follow immediately, so a flat scan works.
  let p = 8;
  const id = (o: number): string => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
  while (p + 12 <= buf.byteLength) {
    const cid = id(p);
    const contentLen = dv.getUint32(p + 4, true);
    const childrenLen = dv.getUint32(p + 8, true);
    const content = p + 12;
    if (cid === 'MAIN') {
      p = content; // descend into MAIN's children
      continue;
    }
    if (cid === 'SIZE') {
      sx = dv.getUint32(content, true);
      sy = dv.getUint32(content + 4, true);
      sz = dv.getUint32(content + 8, true);
    } else if (cid === 'XYZI') {
      const n = dv.getUint32(content, true);
      xyzi = new Array(n);
      for (let k = 0; k < n; k++) {
        const o = content + 4 + k * 4;
        xyzi[k] = { x: dv.getUint8(o), y: dv.getUint8(o + 1), z: dv.getUint8(o + 2), i: dv.getUint8(o + 3) };
      }
    } else if (cid === 'RGBA') {
      palette = new Array(256).fill(0);
      // File palette is 1-indexed: colour for voxel index n is entry n-1 here.
      for (let k = 0; k < 256; k++) {
        const o = content + k * 4;
        const r = dv.getUint8(o),
          g = dv.getUint8(o + 1),
          b = dv.getUint8(o + 2);
        palette[k + 1] = (r << 16) | (g << 8) | b;
      }
    }
    p = content + contentLen + childrenLen;
  }

  const voxels = new Uint8Array(sx * sy * sz);
  for (const v of xyzi) voxels[v.x + v.y * sx + v.z * sx * sy] = v.i;
  return { sx, sy, sz, voxels, palette: palette ?? fallbackPalette() };
}

/** Load and parse a .vox from a URL under the site root. Cached per URL so the
 *  many characters that share body/armor parts fetch + parse each file only once. */
const voxCache = new Map<string, Promise<VoxModel>>();
export function loadVox(url: string): Promise<VoxModel> {
  let p = voxCache.get(url);
  if (!p) {
    p = fetch(url).then((res) => {
      if (!res.ok) throw new Error(`vox load failed: ${url} (${res.status})`);
      return res.arrayBuffer().then(parseVox);
    });
    voxCache.set(url, p);
  }
  return p;
}

// Fixed directional shade baked into vertex colours (the scene is unlit): faces
// pointing up/toward the light are brighter, downward faces darker — gives the
// figures depth + an ambient-occlusion feel without any scene lights. Per unit
// face normal, precomputed for the 6 axes.
const LIGHT_DIR = ((): [number, number, number] => {
  const l: [number, number, number] = [0.35, 1, 0.25];
  const m = Math.hypot(l[0], l[1], l[2]);
  return [l[0] / m, l[1] / m, l[2] / m];
})();
const AMBIENT = 0.55;
const shadeFor = (nx: number, ny: number, nz: number): number => {
  const d = Math.max(0, nx * LIGHT_DIR[0] + ny * LIGHT_DIR[1] + nz * LIGHT_DIR[2]);
  return AMBIENT + (1 - AMBIENT) * d;
};

/**
 * Build a merged, face-culled mesh from a VoxModel.
 * @param offset  bone-local position of voxel (0,0,0) (from the Veloren manifest).
 * @param recolor optional multiply (0xRRGGBB) — Veloren tints some grayscale parts.
 */
export function buildVoxMesh(model: VoxModel, offset: [number, number, number], recolor?: number): THREE.Mesh {
  const { sx, sy, sz, voxels, palette } = model;
  const at = (x: number, y: number, z: number): number => {
    if (x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz) return 0;
    return voxels[x + y * sx + z * sx * sy];
  };
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const rMul = recolor === undefined ? 1 : ((recolor >> 16) & 255) / 255;
  const gMul = recolor === undefined ? 1 : ((recolor >> 8) & 255) / 255;
  const bMul = recolor === undefined ? 1 : (recolor & 255) / 255;

  // The six unit-cube faces: normal + the 4 corner offsets (CCW) for two tris.
  const FACES: { n: [number, number, number]; c: [number, number, number][] }[] = [
    { n: [1, 0, 0], c: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]] },
    { n: [-1, 0, 0], c: [[0, 0, 1], [0, 1, 1], [0, 1, 0], [0, 0, 0]] },
    { n: [0, 1, 0], c: [[1, 1, 0], [0, 1, 0], [0, 1, 1], [1, 1, 1]] },
    { n: [0, -1, 0], c: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]] },
    { n: [0, 0, 1], c: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]] },
    { n: [0, 0, -1], c: [[0, 1, 0], [1, 1, 0], [1, 0, 0], [0, 0, 0]] },
  ];
  const [ox, oy, oz] = offset;
  for (let z = 0; z < sz; z++)
    for (let y = 0; y < sy; y++)
      for (let x = 0; x < sx; x++) {
        const idx = at(x, y, z);
        if (idx === 0) continue;
        const rgb = palette[idx] ?? 0xffffff;
        const cr = (((rgb >> 16) & 255) / 255) * rMul;
        const cg = (((rgb >> 8) & 255) / 255) * gMul;
        const cb = ((rgb & 255) / 255) * bMul;
        for (const f of FACES) {
          if (at(x + f.n[0], y + f.n[1], z + f.n[2]) !== 0) continue; // interior face — skip
          const sh = shadeFor(f.n[0], f.n[1], f.n[2]); // bake directional shade into the colour
          const sr = cr * sh,
            sg = cg * sh,
            sb = cb * sh;
          const [a, b, c, d] = f.c;
          const quad = [a, b, c, a, c, d]; // two triangles
          for (const [dx, dy, dz] of quad) {
            positions.push(ox + x + dx, oy + y + dy, oz + z + dz);
            normals.push(f.n[0], f.n[1], f.n[2]);
            colors.push(sr, sg, sb);
          }
        }
      }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  const mat = new THREE.MeshBasicMaterial({ vertexColors: true });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  return mesh;
}

/** Most-used voxel colour (0xRRGGBB) — Veloren heads bake their skin tone, so this
 *  gives a species' skin colour to tint the white "skin-slot" body parts with. */
export function dominantColor(model: VoxModel): number {
  const counts = new Map<number, number>();
  for (const idx of model.voxels) {
    if (idx === 0) continue;
    counts.set(idx, (counts.get(idx) ?? 0) + 1);
  }
  let best = 0,
    bestN = -1;
  for (const [idx, n] of counts)
    if (n > bestN) {
      bestN = n;
      best = model.palette[idx] ?? 0xffffff;
    }
  return best;
}

/** Grayscale fallback if a file somehow lacks an RGBA chunk (Veloren parts all ship one). */
function fallbackPalette(): number[] {
  const pal = new Array(256).fill(0);
  for (let i = 1; i < 256; i++) {
    const v = i & 255;
    pal[i] = (v << 16) | (v << 8) | v;
  }
  return pal;
}
