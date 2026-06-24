/**
 * streamIngest.ts — In-memory client stream ingestion for pixel-agents.
 *
 * Replaces the file-watching/polling input of the original pixel-agents with a
 * WebSocket endpoint `/feed`. Each client connects with a username (<=16 ASCII)
 * and the shared AUTH token, then streams its raw JSONL transcript lines. The
 * server creates one agent per (client, session) in the AgentStateStore and
 * feeds each line through `processTranscriptLine` — nothing touches disk and
 * nothing is polled. Agent state changes broadcast to viewer browsers via the
 * store's `broadcast`/`agentAdded`/`agentRemoved` events (same as the original).
 *
 * Client -> server frame (JSON):
 *   { "s": "<sessionId>", "p": "<projectName?>", "l": "<one raw jsonl line>" }
 *   { "s": "<sessionId>", "p": "<projectName?>", "ls": ["line1","line2", ...] }
 */
import * as crypto from 'crypto';
import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { AgentStateStore } from './agentStateStore.js';
import { processTranscriptLine } from './transcriptParser.js';
import type { AgentState } from './types.js';

export interface FeedOptions {
  store: AgentStateStore;
  /** Shared AUTH token; every client uses the same one. */
  token: string;
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>;
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>;
}

/** Username: 1..16 printable ASCII, no spaces/control chars. */
const USERNAME_RE = /^[\x21-\x7e]{1,16}$/;

function tokenOk(provided: string, expected: string): boolean {
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Subprotocol the client offers so the server can echo a selection. */
const SUBPROTOCOL_MARKER = 'pa1';

function decodeB64Url(v: string): string {
  try {
    return Buffer.from(v, 'base64url').toString('utf8');
  } catch {
    return '';
  }
}

/**
 * Read {username, token} from the `Sec-WebSocket-Protocol` header — this keeps
 * the token out of the request URL (and thus out of access logs / proxies).
 * The client encodes them as base64url subprotocol entries `u.<b64>` / `t.<b64>`.
 * Falls back to query params for compatibility.
 */
function readCredentials(req: FastifyRequest): { username: string; token: string } {
  const header = req.headers['sec-websocket-protocol'];
  if (typeof header === 'string' && header.length > 0) {
    let username = '';
    let token = '';
    for (const raw of header.split(',')) {
      const p = raw.trim();
      if (p.startsWith('u.')) username = decodeB64Url(p.slice(2));
      else if (p.startsWith('t.')) token = decodeB64Url(p.slice(2));
    }
    if (username || token) return { username, token };
  }
  const q = (req.query ?? {}) as Record<string, string>;
  return { username: String(q.user ?? q.username ?? ''), token: String(q.token ?? '') };
}

/** Build a minimal in-memory AgentState (mirrors the file-based adoptExternalSession). */
function makeAgent(id: number, username: string, sessionId: string): AgentState {
  return {
    id,
    sessionId,
    terminalRef: undefined,
    isExternal: true,
    projectDir: `<stream:${username}>`,
    jsonlFile: `<stream:${username}/${sessionId}>`,
    fileOffset: 0,
    lineBuffer: '',
    activeToolIds: new Set(),
    activeToolStatuses: new Map(),
    activeToolNames: new Map(),
    activeSubagentToolIds: new Map(),
    activeSubagentToolNames: new Map(),
    backgroundAgentToolIds: new Set(),
    isWaiting: false,
    permissionSent: false,
    hadToolsInTurn: false,
    hookDelivered: false,
    lastDataAt: Date.now(),
    linesProcessed: 0,
    seenUnknownRecordTypes: new Set(),
    folderName: username,
    inputTokens: 0,
    outputTokens: 0,
  };
}

export function registerFeedRoute(app: FastifyInstance, opts: FeedOptions): void {
  app.get('/feed', { websocket: true }, (socket: any, req: FastifyRequest) => {
    const { username, token } = readCredentials(req);

    if (!tokenOk(token, opts.token)) {
      socket.close(4001, 'unauthorized');
      return;
    }
    if (!USERNAME_RE.test(username)) {
      socket.close(4002, 'bad username (1..16 ASCII, no spaces)');
      return;
    }

    // Per-connection: sessionId -> agentId
    const sessions = new Map<string, number>();

    const agentFor = (sessionId: string): number => {
      let id = sessions.get(sessionId);
      if (id !== undefined) return id;
      id = opts.store.nextAgentId.current++;
      opts.store.set(id, makeAgent(id, username, sessionId)); // -> agentAdded -> viewers
      sessions.set(sessionId, id);
      return id;
    };

    console.log(`[feed] client "${username}" connected`);

    socket.on('message', (data: Buffer | string) => {
      let msg: { s?: string; p?: string; l?: string; ls?: string[] };
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return; // ignore malformed frame
      }
      const sessionId = String(msg.s ?? 'default').slice(0, 80);
      const id = agentFor(sessionId);
      const lines = Array.isArray(msg.ls) ? msg.ls : msg.l != null ? [msg.l] : [];
      for (const line of lines) {
        if (typeof line === 'string' && line.trim()) {
          processTranscriptLine(id, line, opts.store, opts.waitingTimers, opts.permissionTimers);
        }
      }
    });

    socket.on('close', () => {
      for (const id of sessions.values()) {
        opts.store.delete(id); // -> agentRemoved -> viewers get agentClosed
        opts.waitingTimers.get(id) && clearTimeout(opts.waitingTimers.get(id));
        opts.permissionTimers.get(id) && clearTimeout(opts.permissionTimers.get(id));
        opts.waitingTimers.delete(id);
        opts.permissionTimers.delete(id);
      }
      sessions.clear();
      console.log(`[feed] client "${username}" disconnected`);
    });
  });
}

/**
 * Start a DEDICATED listener on its own port that only accepts client streams
 * (the `/feed` WebSocket). Separate from the viewer port, so the display port
 * can stay control-free. Runs in the same process and shares the in-memory
 * AgentStateStore with the viewer (broadcasts flow store -> viewer WS).
 */
export async function startFeedServer(
  opts: FeedOptions & { host: string; port: number },
): Promise<{ app: FastifyInstance; port: number }> {
  const app = Fastify({ logger: false });
  // Echo the marker subprotocol so clients that offer it (carrying base64url
  // credentials in Sec-WebSocket-Protocol) complete the handshake cleanly.
  await app.register(fastifyWebsocket, {
    options: {
      handleProtocols: (protocols: Set<string>) =>
        protocols.has(SUBPROTOCOL_MARKER) ? SUBPROTOCOL_MARKER : false,
    },
  });
  app.get('/health', async () => 'ok');
  registerFeedRoute(app, opts);
  await app.listen({ host: opts.host, port: opts.port });
  const addr = app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : opts.port;
  return { app, port };
}
