/**
 * Time-of-day → sky + light colour. The server hands the client a shared clock
 * (epoch-aligned `now` + `dayLengthMs`) so every player sees the same sky; the
 * client advances it locally each frame. The world is unlit (MeshBasicMaterial),
 * so "night" is applied by tinting the terrain/water/avatar material colour toward
 * the `light` value while the sky + fog take the `sky` value.
 */
import * as THREE from 'three';

// Keyframes across one day (tod 0..1): [tod, skyHex, lightHex]. tod 0 = midnight,
// 0.25 ≈ dawn, 0.5 = noon, 0.75 ≈ dusk. Interpolated between adjacent frames.
const KEYS: [number, number, number][] = [
  [0.0, 0x060912, 0x2b3555], // midnight — deep blue, dim
  [0.2, 0x1a2036, 0x3a4260], // pre-dawn
  [0.25, 0xffb066, 0xd8b090], // dawn — warm orange
  [0.33, 0x8fc7ff, 0xffffff], // morning — full daylight
  [0.5, 0x9fd0ff, 0xffffff], // noon
  [0.68, 0x8fc7ff, 0xffffff], // afternoon
  [0.75, 0xff9a55, 0xd8a888], // dusk — orange
  [0.82, 0x11172b, 0x333c5c], // dusk → night
  [1.0, 0x060912, 0x2b3555], // midnight (wrap)
];

const cA = new THREE.Color();
const cB = new THREE.Color();

export interface DayColors {
  sky: THREE.Color;
  light: THREE.Color;
}

/** Sample sky + light colours for a time-of-day (0..1), written into `out`. */
export function daySample(tod: number, out: DayColors): DayColors {
  const t = ((tod % 1) + 1) % 1;
  let i = 0;
  while (i < KEYS.length - 1 && t > KEYS[i + 1][0]) i++;
  const [t0, sky0, light0] = KEYS[i];
  const [t1, sky1, light1] = KEYS[Math.min(i + 1, KEYS.length - 1)];
  const f = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
  out.sky.set(cA.setHex(sky0).lerp(cB.setHex(sky1), f));
  out.light.set(cA.setHex(light0).lerp(cB.setHex(light1), f));
  return out;
}

/** True during the dark hours — for lamp/emissive logic (e.g. portals brighter). */
export function isNight(tod: number): boolean {
  const t = ((tod % 1) + 1) % 1;
  return t < 0.23 || t > 0.8;
}
