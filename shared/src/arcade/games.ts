/**
 * Arcade game registry — the single shared catalog of DOS games that arcade
 * machines can launch, used by BOTH the 2D (Pixels) and 3D (Voxel) clients and
 * the multiplayer lobby on the server. One source of truth, never duplicated per
 * world (see AGENTS.md: shared features share one backend).
 *
 * Games run in the browser via js-dos v8 (DOSBox → WASM). Each entry points at a
 * self-hosted `.jsdos` bundle under the client's public dir. Multiplayer uses
 * DOSBox's IPX network tunnelled over WebRTC by js-dos; the server only brokers
 * the lobby (who hosts, peer ids).
 */

export type ArcadeGameId = 'doom' | 'doom2' | 'tnt' | 'plutonia' | 'wolf3d' | 'keen' | 'duke' | 'duke3d';

export interface ArcadeGame {
  /** Stable bundled game id. */
  id: ArcadeGameId;
  /** Marquee title shown on the machine + in the launcher. */
  title: string;
  /** Short flavour line under the title. */
  blurb: string;
  /** URL (site-root relative) of the `.jsdos` bundle to load. */
  bundleUrl: string;
  /** Whether this game supports IPX multiplayer. */
  multiplayer: boolean;
  /** Max simultaneous IPX players (Doom's engine caps at 4). */
  maxPlayers: number;
  /** License note (display only). */
  license: string;
}

export const ARCADE_GAMES: Record<ArcadeGameId, ArcadeGame> = {
  // Full DOOM + DOOM II (id Software): the vanilla DOS engine (DOOM.EXE/DOOM2.EXE)
  // + IWAD from the operator's own licensed copy, packaged at build time from
  // tmp/doom-wads (never committed; see scripts/build-shareware-bundles.mjs).
  doom: {
    id: 'doom',
    title: 'DOOM',
    blurb: 'The Ultimate DOOM',
    bundleUrl: '/jsdos/bundles/doom.jsdos',
    multiplayer: true,
    maxPlayers: 4,
    license: 'id Software — from the operator’s licensed copy',
  },
  doom2: {
    id: 'doom2',
    title: 'DOOM II',
    blurb: 'Hell on Earth',
    bundleUrl: '/jsdos/bundles/doom2.jsdos',
    multiplayer: true,
    maxPlayers: 4,
    license: 'id Software — from the operator’s licensed copy',
  },
  // Final Doom (id Software) — standalone megawads on the Final Doom DOS engine.
  tnt: {
    id: 'tnt',
    title: 'Final DOOM: TNT',
    blurb: 'TNT: Evilution',
    bundleUrl: '/jsdos/bundles/tnt.jsdos',
    multiplayer: true,
    maxPlayers: 4,
    license: 'id Software — from the operator’s licensed copy',
  },
  plutonia: {
    id: 'plutonia',
    title: 'Final DOOM: Plutonia',
    blurb: 'The Plutonia Experiment',
    bundleUrl: '/jsdos/bundles/plutonia.jsdos',
    multiplayer: true,
    maxPlayers: 4,
    license: 'id Software — from the operator’s licensed copy',
  },
  wolf3d: {
    id: 'wolf3d',
    title: 'Wolfenstein 3D',
    blurb: 'Escape from Castle Wolfenstein — shareware',
    bundleUrl: '/jsdos/bundles/wolf3d.jsdos',
    multiplayer: false,
    maxPlayers: 1,
    license: 'id Software shareware (freely distributable)',
  },
  keen: {
    id: 'keen',
    title: 'Commander Keen',
    blurb: 'Marooned on Mars — shareware',
    bundleUrl: '/jsdos/bundles/keen.jsdos',
    multiplayer: false,
    maxPlayers: 1,
    license: 'Apogee shareware (freely distributable)',
  },
  duke: {
    id: 'duke',
    title: 'Duke Nukem',
    blurb: 'Episode 1 — shareware',
    bundleUrl: '/jsdos/bundles/duke.jsdos',
    multiplayer: false,
    maxPlayers: 1,
    license: 'Apogee shareware (freely distributable)',
  },
  duke3d: {
    id: 'duke3d',
    title: 'Duke Nukem 3D',
    blurb: 'L.A. Meltdown — shareware',
    bundleUrl: '/jsdos/bundles/duke3d.jsdos',
    multiplayer: false,
    maxPlayers: 1,
    license: '3D Realms shareware (freely distributable)',
  },
};

export const ARCADE_GAME_LIST: ArcadeGame[] = Object.values(ARCADE_GAMES);

export function getArcadeGame(id: string | null | undefined): ArcadeGame | undefined {
  return id ? ARCADE_GAMES[id as ArcadeGameId] : undefined;
}
