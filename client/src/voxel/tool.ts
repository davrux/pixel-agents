/**
 * Extrude a flat pixel-art item sprite (16×16 tool PNG) into a thin 3D mesh —
 * the classic Minecraft "item in hand" look. Each opaque pixel becomes a small
 * vertex-coloured box; all boxes are merged into ONE geometry (single draw call)
 * so the tool can hang off the avatar's arm bone cheaply. The result spans ~1×1
 * in its XY plane, thin along Z. The `pivot` (sprite UV, 0..1 top-left) is moved
 * to the mesh origin so the object rotates/attaches about that point — pass the
 * handle end (e.g. [0.1, 0.85] for a bottom-left tool handle) so the fist grips
 * the handle, not the middle. Default [0.5,0.5] keeps it centred.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export function buildItemMesh(url: string, pivot: [number, number] = [0.5, 0.5]): Promise<THREE.Mesh> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const n = img.width; // assume square (16)
      const cv = document.createElement('canvas');
      cv.width = cv.height = n;
      const ctx = cv.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, n, n).data;
      const px = 1 / n; // pixel size within the unit mesh
      const depth = px * 2; // ~2px thick
      const base = new THREE.BoxGeometry(px, px, depth);
      const boxes: THREE.BufferGeometry[] = [];
      for (let y = 0; y < n; y++)
        for (let x = 0; x < n; x++) {
          const i = (y * n + x) * 4;
          if (data[i + 3] < 128) continue; // transparent → skip
          const g = base.clone();
          const r = data[i] / 255,
            gg = data[i + 1] / 255,
            b = data[i + 2] / 255;
          const cnt = g.attributes.position.count;
          const col = new Float32Array(cnt * 3);
          for (let k = 0; k < cnt; k++) {
            col[k * 3] = r;
            col[k * 3 + 1] = gg;
            col[k * 3 + 2] = b;
          }
          g.setAttribute('color', new THREE.BufferAttribute(col, 3));
          // sprite (0,0) is top-left → centre the mesh and flip Y
          g.translate((x + 0.5) * px - 0.5, 0.5 - (y + 0.5) * px, 0);
          boxes.push(g);
        }
      base.dispose();
      const merged = boxes.length ? mergeGeometries(boxes, false)! : new THREE.BufferGeometry();
      boxes.forEach((b) => b.dispose());
      // shift so the requested pivot (sprite UV) lands at the mesh origin
      merged.translate(-(pivot[0] - 0.5), -(0.5 - pivot[1]), 0);
      resolve(new THREE.Mesh(merged, new THREE.MeshBasicMaterial({ vertexColors: true })));
    };
    img.onerror = () => reject(new Error('tool image load failed: ' + url));
    img.src = url;
  });
}
