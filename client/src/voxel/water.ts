/**
 * Animated water material — a Luanti-style "waving liquid": a translucent blue
 * surface that gently waves (vertex displacement) and shows moving ripple bands
 * (fragment) so the lake looks alive/flowing, not a flat sheet. Rendered in its own
 * transparent pass (depthWrite off) over the submerged terrain. `uLight` carries the
 * day/night tint; `uTime` is advanced each frame. Vertex `color` is the baked
 * AO/shade from the mesher.
 */
import * as THREE from 'three';

export interface WaterMaterial {
  material: THREE.ShaderMaterial;
  uniforms: { uTime: { value: number }; uLight: { value: THREE.Color }; uOpacity: { value: number } };
}

export function createWaterMaterial(): WaterMaterial {
  const uniforms = {
    uTime: { value: 0 },
    uLight: { value: new THREE.Color(1, 1, 1) },
    uOpacity: { value: 0.78 },
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    vertexShader: `
      attribute vec3 color;
      varying vec3 vColor;
      varying vec3 vWorld;
      uniform float uTime;
      void main() {
        vColor = color;
        vec3 p = position;
        vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
        // Gentle surface swell (only the exposed top/side faces are visible).
        float w = sin(vWorld.x * 0.6 + uTime * 1.6) + sin(vWorld.z * 0.7 + uTime * 1.3);
        p.y += w * 0.045;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: `
      varying vec3 vColor;
      varying vec3 vWorld;
      uniform float uTime;
      uniform vec3 uLight;
      uniform float uOpacity;
      void main() {
        vec3 base = vec3(0.18, 0.44, 0.72);
        // Moving ripple bands → a flowing look.
        float rip = sin(vWorld.x * 1.4 + uTime * 2.0) * sin(vWorld.z * 1.2 - uTime * 1.7);
        base += rip * 0.06;
        vec3 col = base * vColor * uLight;
        gl_FragColor = vec4(col, uOpacity);
      }`,
  });
  return { material, uniforms };
}
