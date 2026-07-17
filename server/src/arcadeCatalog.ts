/**
 * Runtime arcade catalog. Game content (js-dos bundles, emulator ROMs, …) is NOT
 * baked into the image — the operator bind-mounts a directory (ARCADE_CONTENT_DIR)
 * holding the files plus a `catalog.json` describing them. This module reads that
 * catalog (cached, reloaded when the file changes) and is the server's single
 * lookup for the lobby + savegame handlers. The files themselves are served by
 * index.ts (static, auth-gated) at /arcade/content/<file>.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { type ArcadeGame, parseArcadeCatalog } from '@pixel/shared';

/** The mounted content directory, or undefined when none is configured. */
export function arcadeContentDir(): string | undefined {
  return process.env.ARCADE_CONTENT_DIR?.trim() || undefined;
}

let cache: { games: ArcadeGame[]; mtimeMs: number } | null = null;

/** The current catalog (empty when no dir/catalog is present). Cheap: cached until
 *  catalog.json's mtime changes, so an operator can edit it without a restart. */
export function getArcadeCatalog(): ArcadeGame[] {
  const dir = arcadeContentDir();
  if (!dir) return [];
  const path = join(dir, 'catalog.json');
  if (!existsSync(path)) {
    cache = null;
    return [];
  }
  const mtimeMs = statSync(path).mtimeMs;
  if (cache && cache.mtimeMs === mtimeMs) return cache.games;
  let games: ArcadeGame[] = [];
  try {
    games = parseArcadeCatalog(JSON.parse(readFileSync(path, 'utf8')));
  } catch (e) {
    console.warn(`[server] arcade: cannot read ${path}: ${(e as Error).message}`);
  }
  cache = { games, mtimeMs };
  return games;
}

/** Look up one catalog game by id (server-authoritative validation). */
export function getArcadeGame(id: string | null | undefined): ArcadeGame | undefined {
  if (!id) return undefined;
  return getArcadeCatalog().find((g) => g.id === id);
}
