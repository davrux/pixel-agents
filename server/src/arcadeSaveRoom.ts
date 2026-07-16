/**
 * Shared arcade-savegame message handlers for any game room (the 3D VoxelRoom and,
 * later, the 2D SimRoom). One shared backend — the store (arcadeSaveStore) plus
 * this registration — so saves are NOT duplicated per room (AGENTS.md: shared
 * features share one backend). Each room just calls registerArcadeSaves(this).
 *
 * Protocol (client ↔ room):
 *   → 'arcadeSaveGet' { game }         ← 'arcadeSaveData' { game, data|null }
 *   → 'arcadeSavePut' { game, data }   (fire-and-forget)
 * `data` is the js-dos changed-files bundle (Uint8Array); identity is the room's
 * already-authenticated user (client.auth.userId).
 */
import type { Client, Room } from '@colyseus/core';
import { getArcadeGame } from '@pixel/shared';
import { arcadeSaves } from './arcadeSaveStore.js';

const userIdOf = (client: Client): string => (client.auth as { userId?: string } | undefined)?.userId ?? '';

/** A valid save key: a known bundled game. */
const validGame = (g?: string): boolean => !!g && !!getArcadeGame(g);

export function registerArcadeSaves(room: Room): void {
  room.onMessage('arcadeSaveGet', (client: Client, m: { game?: string }) => {
    const game = m?.game;
    if (!validGame(game)) return;
    const data = arcadeSaves.get(userIdOf(client), game!);
    client.send('arcadeSaveData', { game, data });
  });
  room.onMessage('arcadeSavePut', (client: Client, m: { game?: string; data?: unknown }) => {
    const game = m?.game;
    if (!validGame(game)) return;
    const raw = m.data;
    // Colyseus decodes a sent Uint8Array/Buffer as binary; accept either.
    const bytes = raw instanceof Uint8Array ? raw : ArrayBuffer.isView(raw) ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength) : null;
    if (bytes) arcadeSaves.set(userIdOf(client), game!, bytes);
  });
  room.onMessage('arcadeSaveReset', (client: Client, m: { game?: string }) => {
    if (validGame(m?.game)) arcadeSaves.remove(userIdOf(client), m.game!);
  });
}
