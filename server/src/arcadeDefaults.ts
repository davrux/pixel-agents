/**
 * Global default game-id list for arcade cabinets, plus the resolver that
 * combines a cabinet's own override (zoneStore.cabinetGamesOverride) with that
 * default. Kept separate from arcadeCatalog.ts (the content-driven game list
 * itself) and zoneStore.ts (per-cabinet overrides) so neither needs to depend
 * on the other.
 */
import { appStore } from './appStore.js';
import { getArcadeCatalog } from './arcadeCatalog.js';

const DEFAULT_GAMES_KEY = 'arcadeDefaultGames';

/** The default game-id list new/unconfigured cabinets follow. `null` = never
 *  customized — every catalog game (unchanged behavior until an admin curates
 *  this). */
export function getArcadeDefaultGames(): string[] | null {
  return appStore.getSetting<string[] | null>(DEFAULT_GAMES_KEY, null);
}

export function setArcadeDefaultGames(gameIds: string[]): void {
  appStore.setSetting(DEFAULT_GAMES_KEY, gameIds);
}

/** A cabinet's effective allowed game ids: its own override if it has one, else
 *  the current global default, else every catalog game. Ids for games that no
 *  longer exist in the catalog (removed/renamed content) are dropped, so a
 *  stale override can't offer a broken button. */
export function resolveAllowedGames(override: string[] | null): string[] {
  const ids = override ?? getArcadeDefaultGames() ?? getArcadeCatalog().map((g) => g.id);
  const valid = new Set(getArcadeCatalog().map((g) => g.id));
  return ids.filter((id) => valid.has(id));
}
