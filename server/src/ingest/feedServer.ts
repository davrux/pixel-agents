import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

import { WebSocketServer, type WebSocket } from 'ws';

import { director } from '../sim/director.js';
import { newParseState, parseLine, type ParseState } from './transcriptParser.js';

/** Credentials travel in Sec-WebSocket-Protocol (base64url), never the URL. */
function decodeProtocols(protocolHeader: string | undefined): { user?: string; token?: string } {
  const out: { user?: string; token?: string } = {};
  if (!protocolHeader) return out;
  for (const raw of protocolHeader.split(',')) {
    const p = raw.trim();
    if (p.startsWith('u.')) out.user = b64urlDecode(p.slice(2));
    else if (p.startsWith('t.')) out.token = b64urlDecode(p.slice(2));
  }
  return out;
}

function b64urlDecode(s: string): string {
  try {
    return Buffer.from(s, 'base64url').toString('utf8');
  } catch {
    return '';
  }
}

let nextAgentId = 1;

interface FeedConn {
  user: string;
  /** session id → agent id */
  sessions: Map<string, number>;
  /** agent id → parse state */
  parsers: Map<number, ParseState>;
}

/**
 * WebSocket endpoint (`/feed`) that accepts the same client stream format as the
 * original pixel-agents client: {s: session, p: project, ls: string[]}. Each
 * (connection, session) becomes one agent in the director.
 *
 * Mounted on the SAME HTTP server as the viewer/Colyseus traffic so the whole
 * app is a single port: the browser and the feeder both talk to `host:PORT`
 * (the feeder at `ws://host:PORT/feed`). Colyseus owns the http server's
 * `upgrade` event, so we route `/feed` upgrades to our own (noServer) wss and
 * delegate everything else back to Colyseus's original upgrade listeners.
 */
export function attachFeedServer(httpServer: HttpServer, token: string | null): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  // Colyseus' ws-transport has already registered its upgrade listener(s) by
  // the time we get here; capture and replace them with a path dispatcher.
  const colyseusUpgrade = httpServer.listeners('upgrade') as Array<
    (req: IncomingMessage, socket: Duplex, head: Buffer) => void
  >;
  httpServer.removeAllListeners('upgrade');
  httpServer.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    let pathname = '/';
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      /* malformed URL → treat as non-feed */
    }
    if (pathname === '/feed') {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    } else {
      for (const l of colyseusUpgrade) l.call(httpServer, req, socket, head);
    }
  });

  wss.on('connection', (ws: WebSocket, req) => {
    const creds = decodeProtocols(req.headers['sec-websocket-protocol']);
    if (token && creds.token !== token) {
      ws.close(4001, 'unauthorized');
      return;
    }
    const conn: FeedConn = {
      user: (creds.user || 'agent').slice(0, 16),
      sessions: new Map(),
      parsers: new Map(),
    };
    console.log(`[feed] client connected: ${conn.user}`);

    ws.on('message', (data) => {
      let msg: { s?: string; p?: string; ls?: string[] };
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!msg.s || !Array.isArray(msg.ls)) return;

      let agentId = conn.sessions.get(msg.s);
      if (agentId === undefined) {
        agentId = nextAgentId++;
        conn.sessions.set(msg.s, agentId);
        conn.parsers.set(agentId, newParseState());
        director.apply({ t: 'created', id: agentId, label: conn.user });
      }
      const st = conn.parsers.get(agentId)!;
      for (const line of msg.ls) parseLine(agentId, line, st, (ev) => director.apply(ev));
    });

    ws.on('close', () => {
      for (const id of conn.sessions.values()) director.apply({ t: 'removed', id });
      console.log(`[feed] client disconnected: ${conn.user}`);
    });
  });

  console.log('[feed] mounted at /feed (shared viewer port)');
  return wss;
}
