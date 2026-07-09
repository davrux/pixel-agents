import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

import { WebSocketServer, type WebSocket } from 'ws';

import { isSubagentToolName } from '@pixel/shared/office/toolUtils.js';

import { director } from '../sim/director.js';
import { userStore } from '../userStore.js';
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

/** Text-idle fallback: a turn that used NO tools never emits `turn_duration`,
 *  so without this a settled text-only (typically final) turn would keep showing
 *  its last state until new lines arrive. Safe to keep short — such a turn is over
 *  the moment its single assistant message lands. */
const TEXT_IDLE_AFTER_MS = 4000;

/** Safety net for a turn that HAS used tools. Such a turn ends definitively via
 *  `turn_duration` ('waiting'/done chime), so we must NOT idle it on the short
 *  timer — the gaps between tool calls (model thinking) routinely exceed a few
 *  seconds and the agent is still mid-task. Only fall back to idle if the
 *  definitive end never arrives (crashed / truncated transcript, or a replay
 *  backlog that stopped mid-turn). Long enough to never trip on real thinking. */
const ACTIVE_IDLE_AFTER_MS = 90_000;

/** Session-closed despawn: once an agent has been quiet this long, treat its
 *  Claude session as closed and remove it entirely (not just idle). Matches the
 *  feeder's MAXAGE freshness window so a session stale past it (and thus not
 *  re-replayed on feeder reconnect) is consistently gone. A session that resumes
 *  re-creates a fresh agent on its next line. */
const SESSION_CLOSED_AFTER_MS = Number(process.env.PIXEL_FEED_SESSION_TTL_MS ?? 600_000);

interface FeedConn {
  user: string;
  /** session id → agent id */
  sessions: Map<string, number>;
  /** agent id → parse state */
  parsers: Map<number, ParseState>;
  /** agent id → last time a feed line was processed (ms) */
  lastActivity: Map<number, number>;
  /** agent ids already marked idle by the inactivity timer */
  idled: Set<number>;
}

/** Live connections, scanned by the inactivity timer. */
const conns = new Set<FeedConn>();

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
export function attachFeedServer(httpServer: HttpServer, opts: { authRequired: boolean }): WebSocketServer {
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
    // The per-user agent token identifies the owner: it resolves to a user,
    // whose user_id labels their agents (so they follow that user across zones).
    const owner = creds.token ? userStore.getByAgentToken(creds.token) : undefined;
    if (opts.authRequired && !owner) {
      ws.close(4001, 'unauthorized');
      return;
    }
    const conn: FeedConn = {
      // Authenticated: the token's user. Open dev mode: fall back to --user.
      user: owner?.userId ?? (creds.user || 'agent').slice(0, 16),
      sessions: new Map(),
      parsers: new Map(),
      lastActivity: new Map(),
      idled: new Set(),
    };
    conns.add(conn);
    console.log(`[feed] client connected: ${conn.user}`);

    ws.on('message', (data) => {
      let msg: { s?: string; p?: string; ls?: string[]; r?: number };
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
      // Initial backlog (replay): keep the main agent but suppress its historical
      // sub-agent churn, so a Task/Agent transcript doesn't pop several sub-agents
      // at once on connect. Sub-agents that start live (after catch-up) animate.
      // A sub-agent character is created by the `toolStart` of a Task/Agent tool;
      // the subagent* events only update it — suppress both during replay.
      const replay = msg.r === 1;
      for (const line of msg.ls) {
        parseLine(agentId, line, st, (ev) => {
          if (replay) {
            if (ev.t === 'subagentStart' || ev.t === 'subagentClear' || ev.t === 'subagentDone') return;
            if (ev.t === 'toolStart' && isSubagentToolName(ev.toolName)) return;
          }
          director.apply(ev);
        });
      }
      // Fresh activity → reset the inactivity countdown for this agent.
      conn.lastActivity.set(agentId, Date.now());
      conn.idled.delete(agentId);
    });

    ws.on('close', () => {
      for (const id of conn.sessions.values()) director.apply({ t: 'removed', id });
      conns.delete(conn);
      console.log(`[feed] client disconnected: ${conn.user}`);
    });
  });

  // Inactivity → idle. A quiet agent goes idle (toolsClear + idle) so it stops
  // showing its last task. This is NOT a turn-completion signal (no "done" chime):
  // the real turn end is the transcript's turn_duration event ('waiting').
  //
  // Crucially, a turn mid-task — one that has used a tool but not yet hit
  // turn_duration — must NOT idle on the short timer: the model thinks between
  // tool calls and those gaps routinely exceed a few seconds. Such turns end
  // definitively via turn_duration, so we only apply a long safety-net timeout
  // (for crashed/truncated transcripts or a replay backlog that stopped mid-turn).
  const idleTimer = setInterval(() => {
    const now = Date.now();
    for (const conn of conns) {
      for (const [sessionId, agentId] of [...conn.sessions]) {
        const st = conn.parsers.get(agentId);
        if (st && st.activeToolNames.size > 0) continue; // a tool is still running
        const last = conn.lastActivity.get(agentId) ?? 0;

        // Closed-session despawn: quiet past the grace window → remove entirely
        // and forget the session so a resumed one mints a fresh agent. Runs even
        // when already idled (a closed session is exactly the idled case).
        if (now - last >= SESSION_CLOSED_AFTER_MS) {
          director.apply({ t: 'removed', id: agentId });
          conn.sessions.delete(sessionId);
          conn.parsers.delete(agentId);
          conn.lastActivity.delete(agentId);
          conn.idled.delete(agentId);
          continue;
        }

        if (conn.idled.has(agentId)) continue;
        const idleAfter = st?.hadToolsInTurn ? ACTIVE_IDLE_AFTER_MS : TEXT_IDLE_AFTER_MS;
        if (now - last < idleAfter) continue;
        conn.idled.add(agentId);
        director.apply({ t: 'toolsClear', id: agentId });
        director.apply({ t: 'status', id: agentId, status: 'idle' });
      }
    }
  }, 1000);
  if (typeof idleTimer.unref === 'function') idleTimer.unref();

  console.log('[feed] mounted at /feed (shared viewer port)');
  return wss;
}
