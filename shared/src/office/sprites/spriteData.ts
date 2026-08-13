import type { ColorValue } from '../colorTypes.js';
import { PALETTE_COUNT } from '../constants.js';
import { adjustSprite } from '../colorize.js';
import type { CharacterPose, Direction, SpriteData } from '../types.js';
import { Direction as Dir } from '../types.js';
import { DEFAULT_CHARACTER_SPEC, PET_SPRITE_SPEC, resolveNpcConfig } from './characterSpec.js';
import type { CharacterSpec, NpcConfig } from './characterSpec.js';
import bubblePermissionData from './bubble-permission.json';
import bubbleWaitingData from './bubble-waiting.json';

export type { CharacterSpec, CharacterTrack, TrackPlay, NpcConfig } from './characterSpec.js';
export {
  DEFAULT_CHARACTER_SPEC,
  DEFAULT_NPC_CONFIG,
  PET_SPRITE_SPEC,
  NPC_TRACK_NAMES,
  resolveCharacterSpec,
  resolveNpcConfig,
  specFrameCount,
  MAX_CHAR_DIM,
} from './characterSpec.js';

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

/** Waiting bubble: white square with a green "?" — the agent's turn ended and it
 *  is waiting on you — and a tail pointer (11x13) */
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
  /** Optional display name (editor metadata; the engine keys by skin id). */
  name?: string;
  /** Optional animation spec (frame size + per-pose tracks). Absent → the
   *  DEFAULT_CHARACTER_SPEC (historical 16×32, walk3/type2/read2 layout). */
  spec?: CharacterSpec;
  /** Optional NPC spawn config (NPCs only; agents ignore it). */
  npc?: NpcConfig;
}

/** A loaded character skin with its stable string id (e.g. `char_3`). */
export interface CharacterTemplate {
  id: string;
  data: LoadedCharacterData;
}

let loadedCharacters: CharacterTemplate[] | null = null;
let charById = new Map<string, LoadedCharacterData>();

/** Set pre-colored character skins loaded from PNG assets. Call this when the
 *  characterSpritesLoaded message arrives. Keyed by stable id, not position. */
export function setCharacterTemplates(list: CharacterTemplate[]): void {
  loadedCharacters = list;
  charById = new Map(list.map((c) => [c.id, c.data]));
  // Clear cache so sprites are rebuilt from loaded data
  spriteCache.clear();
}

/** Ordered skin templates (id + frame data), for the character editor/swatches. */
export function getCharacterTemplates(): CharacterTemplate[] | null {
  return loadedCharacters;
}

/** Drop cached sprites for one skin id (all hue variants), so the next
 *  getCharacterSprites rebuilds from fresh data. */
function clearSkinCache(id: string): void {
  for (const key of [...spriteCache.keys()]) {
    if (key.startsWith(`${id}:`)) spriteCache.delete(key);
  }
}

/** Add or replace a single skin (e.g. a per-player avatar) without resetting
 *  the whole gallery. Used for zone-local avatar distribution. */
export function upsertCharacterTemplate(id: string, data: LoadedCharacterData): void {
  charById.set(id, data);
  const list = loadedCharacters ?? (loadedCharacters = []);
  const i = list.findIndex((c) => c.id === id);
  if (i >= 0) list[i] = { id, data };
  else list.push({ id, data });
  clearSkinCache(id);
}

/** Remove a single skin (e.g. when its owner leaves the zone). */
export function removeCharacterTemplate(id: string): void {
  charById.delete(id);
  if (loadedCharacters) loadedCharacters = loadedCharacters.filter((c) => c.id !== id);
  clearSkinCache(id);
}

/** The first/default skin id (fallback for an unknown skin or before load). */
export function firstSkinId(): string {
  return loadedCharacters?.[0]?.id ?? 'char_0';
}

/** All loaded skin ids, in order. */
export function getSkinIds(): string[] {
  return loadedCharacters ? loadedCharacters.map((c) => c.id) : [];
}

/** Number of loaded character skins, or PALETTE_COUNT as a fallback. */
export function getLoadedCharacterCount(): number {
  return loadedCharacters ? loadedCharacters.length : PALETTE_COUNT;
}

/** Resolve a skin's data by id, falling back to the first loaded skin. */
function resolveCharData(skin: string): LoadedCharacterData | undefined {
  return charById.get(skin) ?? loadedCharacters?.[0]?.data;
}

/** Frame size (w×h, px) of a character skin. All frames of a skin share one
 *  size; falls back to 16×32 before templates load or for an unknown skin. */
export function getCharacterSize(skin: string): { w: number; h: number } {
  const f = resolveCharData(skin)?.down?.[0];
  if (f && f.length) return { w: f[0]?.length ?? 16, h: f.length };
  return { w: 16, h: 32 };
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
  /** Editor overrides may carry these (bundled sheets don't): left-facing art,
   *  a display name, an animation spec (track layout), and a spawn config. */
  left?: SpriteData[];
  name?: string;
  spec?: CharacterSpec;
  npc?: NpcConfig;
}

let loadedDogs: LoadedPetData[] | null = null;
let loadedCats: LoadedPetData[] | null = null;
let loadedDucks: LoadedPetData[] | null = null;

type PetKindName = 'dog' | 'cat' | 'duck';
function petArr(kind: PetKindName): LoadedPetData[] | null {
  return kind === 'dog' ? loadedDogs : kind === 'cat' ? loadedCats : loadedDucks;
}

/** Set pet sprites loaded from PNG assets. Call this when petSpritesLoaded arrives.
 *  Also populates the unified NPC sprite store (same frames + PET_SPRITE_SPEC),
 *  so NPCs can be resolved through the character pipeline (getNpcSprites). */
export function setPetTemplates(dogs: LoadedPetData[], cats: LoadedPetData[], ducks: LoadedPetData[] = []): void {
  loadedDogs = dogs;
  loadedCats = cats;
  loadedDucks = ducks;
  const toNpc = (p: LoadedPetData): LoadedCharacterData => ({
    down: p.down,
    up: p.up,
    right: p.right,
    left: p.left,
    name: p.name,
    // Editor overrides carry their own spec (e.g. an added sleep track); bundled
    // sheets fall back to the default pet layout (walk/sit/idle).
    spec: p.spec ?? PET_SPRITE_SPEC,
    npc: p.npc,
  });
  loadedNpcs = { dog: dogs.map(toNpc), cat: cats.map(toNpc), duck: ducks.map(toNpc) };
  npcSpriteCache.clear();
}

/** Number of loaded variants for a pet kind (0 if none loaded). */
export function getLoadedPetVariantCount(kind: PetKindName): number {
  const arr = petArr(kind);
  return arr ? arr.length : 0;
}

// Pet sprites are resolved through the unified NPC pipeline (getNpcSprites);
// the old PetSprites builder was removed in N1.3.

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
  // A pose uses its same-named track when present. When the action has no
  // dedicated sequence, fall back to the `idle` track (every entity's neutral
  // animation); finally the bare stand frame if even idle is undrawn.
  const seq = sprites.byTrack[pose]?.[dir];
  if (seq && seq.length > 0) return seq[frame % seq.length];
  const idle = pose !== 'idle' ? sprites.byTrack['idle']?.[dir] : undefined;
  if (idle && idle.length > 0) return idle[frame % idle.length];
  return sprites.stand[dir];
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

/** A rough seated silhouette from a standing frame: shift the figure down so the
 *  head lowers and the feet/lower legs fold off the bottom. A placeholder for the
 *  `sit` pose until a real sit track is authored in the character editor. */
function synthesizeSitFrame(frame: SpriteData): SpriteData {
  const h = frame.length;
  if (h === 0) return frame;
  const w = frame[0]?.length ?? 0;
  const dy = Math.max(2, Math.round(h * 0.28));
  const out: SpriteData = [];
  for (let y = 0; y < h; y++) {
    const src = y - dy;
    out.push(src >= 0 ? frame[src].slice() : new Array(w).fill(''));
  }
  return out;
}

/** Build track-driven sprite sequences from one entity template (agent or NPC).
 *  Track layout/lengths come from the template's spec; frames missing from the
 *  sheet fall back to a stand frame. Shared by characters and NPCs. */
function buildCharacterSprites(char: LoadedCharacterData): CharacterSprites {
  const d = char.down;
  const u = char.up;
  const rt = char.right;
  const lf = char.left; // explicit left-facing frames, or undefined → mirror right
  const flip = flipSpriteHorizontal;
  const L = (i: number): SpriteData => lf?.[i] ?? flip(rt[i]);

  const spec = char.spec ?? DEFAULT_CHARACTER_SPEC;
  const slots = trackSlots(spec);
  const available = d.length;
  const walk = slots.get('walk');
  const standIdx = walk ? walk.start + Math.min(1, walk.count - 1) : 1;
  const getD = (i: number): SpriteData => d[i];
  const getU = (i: number): SpriteData => u[i];
  const getR = (i: number): SpriteData => rt[i];

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
  // Placeholder `sit` pose when no sit track was authored, so players can sit
  // anywhere. A real authored `sit` track (in the spec) takes precedence.
  if (!byTrack['sit']) {
    byTrack['sit'] = {
      [Dir.DOWN]: [synthesizeSitFrame(getD(standIdx))],
      [Dir.UP]: [synthesizeSitFrame(getU(standIdx))],
      [Dir.RIGHT]: [synthesizeSitFrame(getR(standIdx))],
      [Dir.LEFT]: [synthesizeSitFrame(L(standIdx))],
    };
  }
  return {
    byTrack,
    stand: {
      [Dir.DOWN]: getD(standIdx),
      [Dir.UP]: getU(standIdx),
      [Dir.RIGHT]: getR(standIdx),
      [Dir.LEFT]: L(standIdx),
    },
  };
}

function emptyCharacterSprites(w: number, h: number): CharacterSprites {
  const e = emptySprite(w, h);
  return { byTrack: {}, stand: { [Dir.DOWN]: e, [Dir.UP]: e, [Dir.RIGHT]: e, [Dir.LEFT]: e } };
}

export function getCharacterSprites(skin: string, hueShift = 0): CharacterSprites {
  const cacheKey = `${skin}:${hueShift}`;
  const cached = spriteCache.get(cacheKey);
  if (cached) return cached;

  let sprites: CharacterSprites;
  const data = resolveCharData(skin);
  if (data) {
    sprites = buildCharacterSprites(data);
    if (hueShift !== 0) sprites = hueShiftSprites(sprites, hueShift);
  } else {
    sprites = emptyCharacterSprites(16, 32);
  }

  spriteCache.set(cacheKey, sprites);
  return sprites;
}

// ── NPC sprites (dogs/cats/ducks, via the unified character pipeline) ──
const npcSpriteCache = new Map<string, CharacterSprites>();
let loadedNpcs: Record<PetKindName, LoadedCharacterData[]> = { dog: [], cat: [], duck: [] };

/** Resolve animated sprites for an NPC kind/variant through the same track-based
 *  pipeline as agent characters. Fed from the loaded pet sheets (see
 *  setPetTemplates), tagged with PET_SPRITE_SPEC (walk/sit/idle). */
export function getNpcSprites(kind: PetKindName, variant: number): CharacterSprites {
  const arr = loadedNpcs[kind];
  if (!arr || arr.length === 0) return emptyCharacterSprites(16, 16);
  const key = `${kind}:${variant}`;
  const cached = npcSpriteCache.get(key);
  if (cached) return cached;
  const sprites = buildCharacterSprites(arr[variant % arr.length]);
  npcSpriteCache.set(key, sprites);
  return sprites;
}

/** Playback length of an NPC pose/track (for the server's frame advance).
 *  Mirrors spriteForPose's fallback so the server's modulo matches what the
 *  client renders: action track → idle track → 1. */
export function getNpcPosePlaybackLength(kind: PetKindName, variant: number, pose: string): number {
  const byTrack = getNpcSprites(kind, variant).byTrack;
  const seq = byTrack[pose]?.[Dir.DOWN] ?? (pose !== 'idle' ? byTrack['idle']?.[Dir.DOWN] : undefined);
  return Math.max(1, seq?.length ?? 1);
}

/** Flat NPC roster (dog/cat/duck × variants), in stable order, for the editor. */
export function getNpcRoster(): Array<{ kind: PetKindName; variant: number; data: LoadedCharacterData }> {
  const out: Array<{ kind: PetKindName; variant: number; data: LoadedCharacterData }> = [];
  for (const kind of ['dog', 'cat', 'duck'] as PetKindName[]) {
    loadedNpcs[kind].forEach((data, variant) => out.push({ kind, variant, data }));
  }
  return out;
}

/** Spawn + behaviour config of an NPC variant, normalised (fills defaults,
 *  clamps, and back-fills `behaviors` for configs saved before they existed). */
export function getNpcConfig(kind: PetKindName, variant: number): NpcConfig {
  const arr = loadedNpcs[kind];
  return resolveNpcConfig(arr?.[variant % (arr.length || 1)]?.npc);
}

/**
 * Playback length (number of distinct animation steps) for a character's pose —
 * the modulo the server uses to advance `ch.frame`. Derived from the built
 * sequences so it accounts for both the spec's track length/play-mode and the
 * frames the sheet actually provides (e.g. a missing coffee track → 1). Always
 * ≥ 1. Server and client agree because both build from the same templates.
 */
export function getPosePlaybackLength(skin: string, pose: CharacterPose | string): number {
  const s = getCharacterSprites(skin);
  // Mirror spriteForPose's fallback: action track, else the idle track, else 1.
  const seq = s.byTrack[pose]?.[Dir.DOWN] ?? (pose !== 'idle' ? s.byTrack['idle']?.[Dir.DOWN] : undefined);
  return Math.max(1, seq?.length ?? 1);
}
