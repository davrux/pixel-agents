// No worldConfig here any more. It held a hardcoded pre-Tiled office building
// (tiles, furniture, SeatDef) that nothing rendered from, and the barrel published
// its shadow copies of TILE_SIZE / Direction / CharState / tileCenter / isWalkable
// beside the real ones in office/*, so `from '@pixel/shared'` could hand you the
// wrong one. Its only remaining consumer was server/src/sim/pathfinding.ts, which
// nothing imported either — the two kept each other alive. Both are gone; the
// engine's own findPath (office/layout/tileMap.ts) is the one that runs.
export * from './protocol.js';
export * from './commands.js';
export * from './arcade/games.js';
export * as Schema from './schema/index.js';
