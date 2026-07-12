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

export type ArcadeGameId = 'doom';

export interface ArcadeGame {
  /** Stable id, used in furniture/block state and lobby keys. */
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
  /** License note for the bundled WAD (all shipped content is free/libre). */
  license: string;
}

export const ARCADE_GAMES: Record<ArcadeGameId, ArcadeGame> = {
  // Shareware DOOM (id Software): the vanilla v1.9 engine (DOOM.EXE) + Episode 1
  // (DOOM1.WAD), freely distributable. Used instead of Freedoom+MBF386 because the
  // GPL MBF386 build's mouse only turned one way; vanilla Doom's mouse is correct.
  doom: {
    id: 'doom',
    title: 'DOOM',
    blurb: 'Knee-Deep in the Dead — shareware',
    bundleUrl: '/jsdos/bundles/doom.jsdos',
    multiplayer: true,
    maxPlayers: 4,
    license: 'id Software shareware (freely distributable)',
  },
};

export const ARCADE_GAME_LIST: ArcadeGame[] = Object.values(ARCADE_GAMES);

export function getArcadeGame(id: string | null | undefined): ArcadeGame | undefined {
  return id ? ARCADE_GAMES[id as ArcadeGameId] : undefined;
}
