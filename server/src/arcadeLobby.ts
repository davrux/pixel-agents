/**
 * Arcade multiplayer lobby — brokers an IPX match at one cabinet among the players
 * in the same room (SimRoom zone / VoxelRoom world). js-dos does the actual peer
 * rendezvous over WebRTC using a shared ALIAS (both host and joiners set
 * connectIpxAddress = alias; the host also runs the IPX server). So the lobby only
 * has to agree on: the alias, the player count (IPX -nodes), the mode, and a
 * synchronised start — no raw peer-id handshake.
 *
 * One match per cabinet (keyed "col,row"); the first joiner is the host. Matches
 * live in the room instance (players must be in the same room to share one).
 *
 * Protocol (client ↔ room):
 *   → arcadeLobbyJoin  { game, cabinet }
 *   → arcadeLobbyLeave { cabinet }
 *   → arcadeLobbyMode  { cabinet, mode }      (host only)
 *   → arcadeLobbyStart { cabinet }            (host only)
 *   ← arcadeLobby   { cabinet, game, mode, members, host, youAreHost, max, started }
 *   ← arcadeLaunch  { cabinet, game, alias, nodes, mode, host }   (to each member)
 */
import { randomBytes } from 'node:crypto';
import type { Client, Room } from '@colyseus/core';
import { getArcadeGame } from './arcadeCatalog.js';
import { arcadeIceServers } from './arcadeTurn.js';

type Mode = 'dm' | 'coop';
interface Member { sessionId: string; name: string }
interface Match {
  game: string;
  cabinet: string;
  mode: Mode;
  alias: string;
  hostSession: string;
  members: Member[];
  maxPlayers: number;
  started: boolean;
}

const userNameOf = (client: Client): string =>
  (client.auth as { username?: string; userId?: string } | undefined)?.username ||
  (client.auth as { userId?: string } | undefined)?.userId ||
  'Player';

// A cabinet key: 2 coords (2D "col,row") or 3 (voxel "x,y,z"), signed.
const isCabinet = (c?: string): c is string => typeof c === 'string' && /^-?\d+,-?\d+(,-?\d+)?$/.test(c);

export function registerArcadeLobby(room: Room): { onLeave: (sessionId: string) => void } {
  const matches = new Map<string, Match>(); // cabinet → match

  const clientFor = (sessionId: string): Client | undefined => room.clients.find((c) => c.sessionId === sessionId);

  const sendLobby = (m: Match): void => {
    const names = m.members.map((x) => x.name);
    const hostName = m.members.find((x) => x.sessionId === m.hostSession)?.name ?? '';
    for (const mem of m.members) {
      clientFor(mem.sessionId)?.send('arcadeLobby', {
        cabinet: m.cabinet,
        game: m.game,
        mode: m.mode,
        members: names,
        host: hostName,
        youAreHost: mem.sessionId === m.hostSession,
        max: m.maxPlayers,
        started: m.started,
      });
    }
  };

  const dissolve = (cabinet: string): void => {
    const m = matches.get(cabinet);
    if (!m) return;
    matches.delete(cabinet);
    for (const mem of m.members) clientFor(mem.sessionId)?.send('arcadeLobby', { cabinet, closed: true });
  };

  const leave = (sessionId: string): void => {
    for (const [cabinet, m] of matches) {
      const i = m.members.findIndex((x) => x.sessionId === sessionId);
      if (i < 0) continue;
      // Host leaving before start (or the room emptying) dissolves the match.
      if (m.started) {
        m.members.splice(i, 1);
        if (!m.members.length) matches.delete(cabinet);
      } else if (sessionId === m.hostSession) {
        dissolve(cabinet);
      } else {
        m.members.splice(i, 1);
        sendLobby(m);
      }
      return;
    }
  };

  room.onMessage('arcadeLobbyJoin', (client: Client, msg: { game?: string; cabinet?: string }) => {
    const game = getArcadeGame(msg?.game);
    if (!game || !game.multiplayer || !isCabinet(msg?.cabinet)) return;
    const cabinet = msg.cabinet;
    let m = matches.get(cabinet);
    if (m && !m.members.some((x) => x.sessionId === client.sessionId) && (m.game !== game.id || m.started)) {
      // Busy with another game / already running — tell the joiner instead of
      // dropping silently (which leaves their UI stuck on "connecting to lobby").
      client.send('arcadeLobby', {
        cabinet,
        busy: true,
        reason: m.started ? 'running' : 'othergame',
        game: m.game,
      });
      return;
    }
    if (!m) {
      m = {
        game: game.id,
        cabinet,
        mode: 'dm',
        alias: `ar-${randomBytes(6).toString('hex')}`,
        hostSession: client.sessionId,
        members: [],
        maxPlayers: game.maxPlayers ?? 4,
        started: false,
      };
      matches.set(cabinet, m);
    }
    if (!m.members.some((x) => x.sessionId === client.sessionId)) {
      if (m.members.length >= m.maxPlayers) return; // full
      m.members.push({ sessionId: client.sessionId, name: userNameOf(client) });
    }
    sendLobby(m);
  });

  room.onMessage('arcadeLobbyLeave', (client: Client, msg: { cabinet?: string }) => {
    if (isCabinet(msg?.cabinet) && matches.get(msg.cabinet)?.members.some((x) => x.sessionId === client.sessionId)) {
      leave(client.sessionId);
    }
  });

  room.onMessage('arcadeLobbyMode', (client: Client, msg: { cabinet?: string; mode?: string }) => {
    const m = isCabinet(msg?.cabinet) ? matches.get(msg.cabinet) : undefined;
    if (!m || m.hostSession !== client.sessionId || m.started) return;
    m.mode = msg.mode === 'coop' ? 'coop' : 'dm';
    sendLobby(m);
  });

  room.onMessage('arcadeLobbyStart', (client: Client, msg: { cabinet?: string }) => {
    const m = isCabinet(msg?.cabinet) ? matches.get(msg.cabinet) : undefined;
    if (!m || m.hostSession !== client.sessionId || m.started || m.members.length < 2) return;
    m.started = true;
    const nodes = m.members.length;
    // One ICE set for the whole match (shared TURN credential window) — needed
    // because every peer is behind NAT and only the server is public.
    const iceServers = arcadeIceServers();
    for (const mem of m.members) {
      clientFor(mem.sessionId)?.send('arcadeLaunch', {
        cabinet: m.cabinet,
        game: m.game,
        alias: m.alias,
        nodes,
        mode: m.mode,
        host: mem.sessionId === m.hostSession,
        iceServers,
      });
    }
  });

  return { onLeave: leave };
}
