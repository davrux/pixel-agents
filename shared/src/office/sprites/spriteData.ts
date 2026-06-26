import type { ColorValue } from '../colorTypes.js';
import { PALETTE_COUNT } from '../constants.js';
import { adjustSprite } from '../colorize.js';
import type { CharacterPose, Direction, SpriteData } from '../types.js';
import { Direction as Dir } from '../types.js';
import { DEFAULT_CHARACTER_SPEC } from './characterSpec.js';
import type { CharacterSpec } from './characterSpec.js';
import bubblePermissionData from './bubble-permission.json';
import bubbleWaitingData from './bubble-waiting.json';

export type { CharacterSpec, CharacterTrack, TrackPlay } from './characterSpec.js';
export { DEFAULT_CHARACTER_SPEC, resolveCharacterSpec, specFrameCount, MAX_CHAR_DIM } from './characterSpec.js';

// ── Speech Bubble Sprites ───────────────────────────────────────

interface BubbleSpriteJson {
  palette: Record<string, string>;
  pixels: string[][];
}

function resolveBubbleSprite(data: BubbleSpriteJson): SpriteData {
  return data.pixels.map((row) => row.map((key) => data.palette[key] ?? key));
}

/** Permission bubble: white square with "..." in amber, and a tail pointer (11x13) */
export const BUBBLE_PERMISSION_SPRITE: SpriteData = resolveBubbleSprite(bubblePermissionData);

/** Waiting bubble: white square with green checkmark, and a tail pointer (11x13) */
export const BUBBLE_WAITING_SPRITE: SpriteData = resolveBubbleSprite(bubbleWaitingData);

// ════════════════════════════════════════════════════════════════
// Loaded character sprites (from PNG assets)
// ════════════════════════════════════════════════════════════════

export interface LoadedCharacterData {
  down: SpriteData[];
  up: SpriteData[];
  right: SpriteData[];
  /** Optional left-facing frames. When absent, left is mirrored from `right`
   *  (the bundled defaults have no left row); the editor can override it. */
  left?: SpriteData[];
  /** Optional display name (editor metadata; the engine keys by palette index). */
  name?: string;
  /** Optional animation spec (frame size + per-pose tracks). Absent → the
   *  DEFAULT_CHARACTER_SPEC (historical 16×32, walk3/type2/read2 layout). */
  spec?: CharacterSpec;
}

let loadedCharacters: LoadedCharacterData[] | null = null;

/** Set pre-colored character sprites loaded from PNG assets. Call this when characterSpritesLoaded message arrives. */
export function setCharacterTemplates(data: LoadedCharacterData[]): void {
  loadedCharacters = data;
  // Clear cache so sprites are rebuilt from loaded data
  spriteCache.clear();
}

/** Raw per-character frame data (down/up/right), for the character editor. */
export function getCharacterTemplates(): LoadedCharacterData[] | null {
  return loadedCharacters;
}

/** Return the number of loaded character palettes, or PALETTE_COUNT as fallback. */
export function getLoadedCharacterCount(): number {
  return loadedCharacters ? loadedCharacters.length : PALETTE_COUNT;
}

/** Frame size (w×h, px) of a character template by palette index. All frames of
 *  a character share one size; falls back to 16×32 before templates load. Used
 *  by the renderer/hit-test to place overlays correctly for any character size. */
export function getCharacterSize(paletteIndex: number): { w: number; h: number } {
  if (loadedCharacters && loadedCharacters.length > 0) {
    const f = loadedCharacters[paletteIndex % loadedCharacters.length]?.down?.[0];
    if (f && f.length) return { w: f[0]?.length ?? 16, h: f.length };
  }
  return { w: 16, h: 32 };
}

/** Animation spec of a character template by palette index, or the default
 *  (historical) layout when the template carries none. */
export function getCharacterSpec(paletteIndex: number): CharacterSpec {
  const c = loadedCharacters?.[paletteIndex % (loadedCharacters.length || 1)];
  return c?.spec ?? DEFAULT_CHARACTER_SPEC;
}

/** Flip a SpriteData horizontally (for generating left sprites from right) */
function flipSpriteHorizontal(sprite: SpriteData): SpriteData {
  return sprite.map((row) => [...row].reverse());
}

// ════════════════════════════════════════════════════════════════
// Loaded pet sprites (dogs & cats, from PNG assets)
// ════════════════════════════════════════════════════════════════

interface LoadedPetData {
  down: SpriteData[];
  up: SpriteData[];
  right: SpriteData[];
}

let loadedDogs: LoadedPetData[] | null = null;
let loadedCats: LoadedPetData[] | null = null;
let loadedDucks: LoadedPetData[] | null = null;

type PetKindName = 'dog' | 'cat' | 'duck';
function petArr(kind: PetKindName): LoadedPetData[] | null {
  return kind === 'dog' ? loadedDogs : kind === 'cat' ? loadedCats : loadedDucks;
}

/** Set pet sprites loaded from PNG assets. Call this when petSpritesLoaded arrives. */
export function setPetTemplates(dogs: LoadedPetData[], cats: LoadedPetData[], ducks: LoadedPetData[] = []): void {
  loadedDogs = dogs;
  loadedCats = cats;
  loadedDucks = ducks;
  petSpriteCache.clear();
}

/** Number of loaded variants for a pet kind (0 if none loaded). */
export function getLoadedPetVariantCount(kind: PetKindName): number {
  const arr = petArr(kind);
  return arr ? arr.length : 0;
}

export interface PetSprites {
  // walk: 4-frame cycle [0,1,2,1]; sit: tail-wag pair [3,4]; idle: single [5]
  walk: Record<Direction, [SpriteData, SpriteData, SpriteData, SpriteData]>;
  sit: Record<Direction, [SpriteData, SpriteData]>;
  idle: Record<Direction, SpriteData>;
}

const petSpriteCache = new Map<string, PetSprites>();

/** Resolve animated sprites for a pet kind/variant (LEFT mirrored from RIGHT). */
export function getPetSprites(kind: PetKindName, variant: number): PetSprites {
  const cacheKey = `${kind}:${variant}`;
  const cached = petSpriteCache.get(cacheKey);
  if (cached) return cached;

  const arr = petArr(kind);
  let sprites: PetSprites;

  if (arr && arr.length > 0) {
    const pet = arr[variant % arr.length];
    const d = pet.down;
    const u = pet.up;
    const rt = pet.right;
    const flip = flipSpriteHorizontal;
    sprites = {
      walk: {
        [Dir.DOWN]: [d[0], d[1], d[2], d[1]],
        [Dir.UP]: [u[0], u[1], u[2], u[1]],
        [Dir.RIGHT]: [rt[0], rt[1], rt[2], rt[1]],
        [Dir.LEFT]: [flip(rt[0]), flip(rt[1]), flip(rt[2]), flip(rt[1])],
      },
      sit: {
        [Dir.DOWN]: [d[3], d[4]],
        [Dir.UP]: [u[3], u[4]],
        [Dir.RIGHT]: [rt[3], rt[4]],
        [Dir.LEFT]: [flip(rt[3]), flip(rt[4])],
      },
      idle: {
        [Dir.DOWN]: d[5],
        [Dir.UP]: u[5],
        [Dir.RIGHT]: rt[5],
        [Dir.LEFT]: flip(rt[5]),
      },
    };
  } else {
    const e = emptySprite(16, 16);
    const walkSet: [SpriteData, SpriteData, SpriteData, SpriteData] = [e, e, e, e];
    const pairSet: [SpriteData, SpriteData] = [e, e];
    sprites = {
      walk: { [Dir.DOWN]: walkSet, [Dir.UP]: walkSet, [Dir.RIGHT]: walkSet, [Dir.LEFT]: walkSet },
      sit: { [Dir.DOWN]: pairSet, [Dir.UP]: pairSet, [Dir.RIGHT]: pairSet, [Dir.LEFT]: pairSet },
      idle: { [Dir.DOWN]: e, [Dir.UP]: e, [Dir.RIGHT]: e, [Dir.LEFT]: e },
    };
  }

  petSpriteCache.set(cacheKey, sprites);
  return sprites;
}

// ════════════════════════════════════════════════════════════════
// Sprite resolution + caching
// ════════════════════════════════════════════════════════════════

export interface CharacterSprites {
  /** Track name → ready-to-play per-direction frame *sequences* (the ping-pong
   *  expansion is baked in, e.g. walk = [0,1,2,1]). Track names are arbitrary —
   *  agents use walk/typing/reading/coffee, NPCs use walk/sit/idle/sleep, … —
   *  and a pose maps to a track by name. Lengths come from the CharacterSpec, so
   *  they vary per entity. A track with no art falls back to the stand frame. */
  byTrack: Record<string, Record<Direction, SpriteData[]>>;
  /** Neutral standing frame per direction, used for the idle pose and for any
   *  pose whose track is absent. */
  stand: Record<Direction, SpriteData>;
}

/**
 * Resolve the sprite frame for a pose. A pose is just a track *name*; the frame
 * cycles the track's sequence. `idle` (and any pose without a matching track)
 * falls back to the neutral standing frame. This is the single mapping point —
 * new poses need only a track on the spec, no code branch here.
 */
export function spriteForPose(
  pose: CharacterPose | string,
  dir: Direction,
  frame: number,
  sprites: CharacterSprites,
): SpriteData {
  // A pose uses its same-named track when present; otherwise the neutral stand
  // frame. So an agent's `idle` (no idle track) stands still, while an NPC with
  // a dedicated `idle` track animates it.
  const seq = sprites.byTrack[pose]?.[dir];
  if (!seq || seq.length === 0) return sprites.stand[dir];
  return seq[frame % seq.length];
}

const spriteCache = new Map<string, CharacterSprites>();

/** Apply hue shift to every sprite in a CharacterSprites set */
function hueShiftSprites(sprites: CharacterSprites, hueShift: number): CharacterSprites {
  const color: ColorValue = { h: hueShift, s: 0, b: 0, c: 0 };
  const shift = (s: SpriteData) => adjustSprite(s, color);
  const shiftDirs = (rec: Record<Direction, SpriteData[]>): Record<Direction, SpriteData[]> => ({
    [Dir.DOWN]: rec[Dir.DOWN].map(shift),
    [Dir.UP]: rec[Dir.UP].map(shift),
    [Dir.RIGHT]: rec[Dir.RIGHT].map(shift),
    [Dir.LEFT]: rec[Dir.LEFT].map(shift),
  });
  const byTrack: Record<string, Record<Direction, SpriteData[]>> = {};
  for (const [name, dirs] of Object.entries(sprites.byTrack)) byTrack[name] = shiftDirs(dirs);
  return {
    byTrack,
    stand: {
      [Dir.DOWN]: shift(sprites.stand[Dir.DOWN]),
      [Dir.UP]: shift(sprites.stand[Dir.UP]),
      [Dir.RIGHT]: shift(sprites.stand[Dir.RIGHT]),
      [Dir.LEFT]: shift(sprites.stand[Dir.LEFT]),
    },
  };
}

/** Create a transparent placeholder sprite of given dimensions */
function emptySprite(w: number, h: number): SpriteData {
  const rows: string[][] = [];
  for (let y = 0; y < h; y++) {
    rows.push(new Array(w).fill(''));
  }
  return rows;
}

/** Per-track slot offsets in the flat frame list (track order = layout order). */
interface TrackSlot {
  start: number;
  count: number;
  play: 'loop' | 'pingpong';
}
function trackSlots(spec: CharacterSpec): Map<string, TrackSlot> {
  const m = new Map<string, TrackSlot>();
  let off = 0;
  for (const t of spec.tracks) {
    m.set(t.name, { start: off, count: t.frames, play: t.play });
    off += t.frames;
  }
  return m;
}

/** Build a playback sequence for a track in one direction from the flat frames.
 *  Frames beyond what the sheet actually provides are dropped; an empty result
 *  falls back to a single standing frame. Walk-style 'pingpong' expands
 *  [0..n-1] to [0..n-1..1]. */
function buildTrackSeq(
  slot: TrackSlot | undefined,
  get: (i: number) => SpriteData,
  available: number,
  fallbackIdx: number,
): SpriteData[] {
  if (!slot) return [get(fallbackIdx)];
  const frames: SpriteData[] = [];
  for (let i = 0; i < slot.count; i++) {
    const idx = slot.start + i;
    if (idx < available) frames.push(get(idx));
  }
  if (frames.length === 0) return [get(fallbackIdx)];
  if (slot.play === 'pingpong' && frames.length > 2) {
    const seq = frames.slice();
    for (let i = frames.length - 2; i >= 1; i--) seq.push(frames[i]);
    return seq;
  }
  return frames;
}

export function getCharacterSprites(paletteIndex: number, hueShift = 0): CharacterSprites {
  const cacheKey = `${paletteIndex}:${hueShift}`;
  const cached = spriteCache.get(cacheKey);
  if (cached) return cached;

  let sprites: CharacterSprites;

  if (loadedCharacters) {
    // Use pre-colored character sprites directly (no palette swapping)
    const char = loadedCharacters[paletteIndex % loadedCharacters.length];
    const d = char.down;
    const u = char.up;
    const rt = char.right;
    const lf = char.left; // explicit left-facing frames, or undefined → mirror right
    const flip = flipSpriteHorizontal;
    // Left frame at index i: use the explicit left art if provided, else mirror right.
    const L = (i: number): SpriteData => lf?.[i] ?? flip(rt[i]);

    // Track-driven frame layout from the character's spec (default → historical
    // walk 0-2 / type 3-4 / read 5-6 / coffee 7+). Frame counts therefore vary
    // per character; the server advances ch.frame with the matching length.
    const spec = char.spec ?? DEFAULT_CHARACTER_SPEC;
    const slots = trackSlots(spec);
    const available = d.length;
    const walk = slots.get('walk');
    const standIdx = walk ? walk.start + Math.min(1, walk.count - 1) : 1;
    const getD = (i: number): SpriteData => d[i];
    const getU = (i: number): SpriteData => u[i];
    const getR = (i: number): SpriteData => rt[i];

    // Build a per-direction playback sequence for every track the spec declares.
    const byTrack: Record<string, Record<Direction, SpriteData[]>> = {};
    for (const t of spec.tracks) {
      const slot = slots.get(t.name);
      byTrack[t.name] = {
        [Dir.DOWN]: buildTrackSeq(slot, getD, available, standIdx),
        [Dir.UP]: buildTrackSeq(slot, getU, available, standIdx),
        [Dir.RIGHT]: buildTrackSeq(slot, getR, available, standIdx),
        [Dir.LEFT]: buildTrackSeq(slot, L, available, standIdx),
      };
    }
    sprites = {
      byTrack,
      stand: {
        [Dir.DOWN]: getD(standIdx),
        [Dir.UP]: getU(standIdx),
        [Dir.RIGHT]: getR(standIdx),
        [Dir.LEFT]: L(standIdx),
      },
    };
  } else {
    // Fallback: a single transparent placeholder stand frame (16×32).
    const e = emptySprite(16, 32);
    sprites = {
      byTrack: {},
      stand: { [Dir.DOWN]: e, [Dir.UP]: e, [Dir.RIGHT]: e, [Dir.LEFT]: e },
    };
  }

  // Apply hue shift if non-zero
  if (hueShift !== 0) {
    sprites = hueShiftSprites(sprites, hueShift);
  }

  spriteCache.set(cacheKey, sprites);
  return sprites;
}

/**
 * Playback length (number of distinct animation steps) for a character's pose —
 * the modulo the server uses to advance `ch.frame`. Derived from the built
 * sequences so it accounts for both the spec's track length/play-mode and the
 * frames the sheet actually provides (e.g. a missing coffee track → 1). Always
 * ≥ 1. Server and client agree because both build from the same templates.
 */
export function getPosePlaybackLength(paletteIndex: number, pose: CharacterPose | string): number {
  const s = getCharacterSprites(paletteIndex);
  const seq = s.byTrack[pose]?.[Dir.DOWN];
  return Math.max(1, seq?.length ?? 1); // poses without a track are static
}
