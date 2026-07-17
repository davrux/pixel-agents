/**
 * Arcade game catalog — the shared contract between the client launcher and the
 * server. There is NO hardcoded game list: the catalog is content-driven. The
 * operator drops game files + a `catalog.json` into the server's ARCADE_CONTENT_DIR
 * (a runtime bind-mount); the server serves the catalog and the files, and the
 * client renders the launcher from it. Nothing game-specific is baked into the
 * image, and new emulators are just new `emulator` values + files — no code per
 * title (see AGENTS.md: shared features share one backend).
 */

/** Which in-browser emulator loads a game. js-dos = DOS (DOSBox→WASM); emulatorjs
 *  = libretro cores (NES/SNES/GB/… — added later). */
export type ArcadeEmulator = 'jsdos' | 'emulatorjs';

export interface ArcadeGame {
  /** Stable id (keys savegames + multiplayer matches). */
  id: string;
  /** Marquee title shown in the launcher. */
  title: string;
  /** Short flavour line under the title. */
  blurb: string;
  /** Which emulator loads this game. */
  emulator: ArcadeEmulator;
  /** File name within the content dir (served at /arcade/content/<file>). */
  file: string;
  /** Content version/hash for cache-busting (optional). */
  version?: string;
  /** IPX multiplayer support (js-dos/DOOM only for now). */
  multiplayer?: boolean;
  /** Max simultaneous players (Doom's engine caps at 4). */
  maxPlayers?: number;
  /** libretro core for emulatorjs games (e.g. "nes", "snes"). */
  core?: string;
}

const EMULATORS: ArcadeEmulator[] = ['jsdos', 'emulatorjs'];

/** Validate + normalise a parsed `catalog.json` (an array of raw entries). Unknown
 *  or malformed entries are dropped (never throws) so one bad row can't break the
 *  whole launcher. Returns clean ArcadeGame records. */
export function parseArcadeCatalog(raw: unknown): ArcadeGame[] {
  if (!Array.isArray(raw)) return [];
  const out: ArcadeGame[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const e = r as Record<string, unknown>;
    const id = typeof e.id === 'string' ? e.id.trim() : '';
    const file = typeof e.file === 'string' ? e.file.trim() : '';
    const emulator = e.emulator as ArcadeEmulator;
    if (!id || !file || !EMULATORS.includes(emulator)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      title: typeof e.title === 'string' && e.title ? e.title : id,
      blurb: typeof e.blurb === 'string' ? e.blurb : '',
      emulator,
      file,
      version: typeof e.version === 'string' ? e.version : undefined,
      multiplayer: e.multiplayer === true,
      maxPlayers: Number.isFinite(e.maxPlayers) ? Math.max(1, Math.floor(e.maxPlayers as number)) : 1,
      core: typeof e.core === 'string' ? e.core : undefined,
    });
  }
  return out;
}
