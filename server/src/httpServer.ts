import fastifyCors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import * as crypto from 'crypto';
import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';

import type { AgentStateStore } from './agentStateStore.js';
import type { AssetCache, SetHooksEnabledSideEffect } from './clientMessageHandler.js';
import { handleClientMessage } from './clientMessageHandler.js';
import { MAX_HOOK_BODY_SIZE } from './constants.js';
import type { LayoutStore } from './layoutStore.js';
import type { AgentState } from './types.js';
import { getSessionUsername, isValidSession, registerViewerAuth } from './viewerAuth.js';

/** Options for creating the HTTP + WebSocket server. */
export interface HttpServerOptions {
  /** true = VS Code embedded mode (ephemeral port, no static, quiet logging) */
  embedded: boolean;
  /** Host to bind to. Default: '127.0.0.1' */
  host?: string;
  /** Port to listen on. Default: 0 (auto-assign) */
  port?: number;
  /** Bearer auth token for hook and WebSocket endpoints */
  token: string;
  /** AgentStateStore for WebSocket broadcast piping */
  store: AgentStateStore;
  /** SQLite-backed layout persistence (named layouts + active selection) */
  layoutStore: LayoutStore;
  /** Path to SPA dist directory for static serving */
  staticDir?: string;
  /** Cached assets loaded at startup */
  assetCache?: AssetCache;
  /** Invoked when setHooksEnabled is toggled via WebSocket (unused in stream mode). */
  onSetHooksEnabled?: SetHooksEnabledSideEffect;
  /** Register extra routes (e.g. the /feed stream ingest) before the server listens. */
  registerExtraRoutes?: (app: FastifyInstance) => void | Promise<void>;
  /** Display-only viewer: the /ws socket only answers `webviewReady` (state request)
   *  and ignores all mutating/control messages. */
  readOnly?: boolean;
  /** Shared AUTH token the viewer (browser) must present via cookie. When set,
   *  HTML navigation is gated behind a login page and `/ws` requires the cookie. */
  viewerAuthToken?: string;
}

/** Result of createHttpServer(). */
export interface HttpServerHandle {
  app: FastifyInstance;
  port: number;
}

const startTime = Date.now();

/** Messages an authenticated viewer may send when `readOnly` is set: state
 *  request + layout/seats/UI-preference persistence. NO agent control. */
const VIEWER_ALLOWED = new Set<string>([
  'webviewReady',
  'saveLayout',
  'saveLayoutAs',
  'loadLayout',
  'deleteLayout',
  'requestLayouts',
  'saveAgentSeats',
  'setSoundEnabled',
  'setAlwaysShowLabels',
]);

/**
 * Create a Fastify server with a health check and WebSocket support.
 *
 * All Fastify-specific code lives in this file. The rest of the server layer is
 * framework-agnostic. If Fastify is ever replaced, only this file changes.
 */
export async function createHttpServer(options: HttpServerOptions): Promise<HttpServerHandle> {
  const app = Fastify({
    logger: !options.embedded,
    bodyLimit: MAX_HOOK_BODY_SIZE,
  });

  await app.register(fastifyCors, { origin: true, credentials: true });
  await app.register(fastifyWebsocket);

  // Viewer session-auth: login page + POST /login, session cookie, HTML gate.
  if (options.viewerAuthToken) {
    registerViewerAuth(app, options.viewerAuthToken);
  }

  // Static SPA serving (standalone mode only)
  if (!options.embedded && options.staticDir) {
    await app.register(fastifyStatic, {
      root: options.staticDir,
      prefix: '/',
    });
    // HTML5 history fallback: serve index.html for unmatched routes
    app.setNotFoundHandler((_req, reply) => {
      reply.sendFile('index.html');
    });
  }

  // ── Routes ──────────────────────────────────────────────────

  registerHealthRoute(app);
  registerWebSocketRoute(app, options);
  if (options.registerExtraRoutes) {
    await options.registerExtraRoutes(app);
  }

  // ── Listen ──────────────────────────────────────────────────

  await app.listen({ host: options.host ?? '127.0.0.1', port: options.port ?? 0 });
  const address = app.server.address();
  const port = typeof address === 'object' ? (address?.port ?? 0) : 0;

  return { app, port };
}

// ── Health ──────────────────────────────────────────────────────

function registerHealthRoute(app: FastifyInstance): void {
  app.get('/api/health', async () => ({
    status: 'ok',
    uptime: Math.floor((Date.now() - startTime) / 1000),
    pid: process.pid,
  }));
}

// ── WebSocket ──────────────────────────────────────────────────

function registerWebSocketRoute(app: FastifyInstance, options: HttpServerOptions): void {
  app.get('/ws', { websocket: true }, (socket, request) => {
    // In standalone mode (not embedded), skip auth for WebSocket connections.
    // The server binds to 127.0.0.1, so only local clients can connect.
    // In embedded mode (VS Code), require Bearer token for security.
    if (options.embedded) {
      const auth = request.headers.authorization ?? '';
      const expected = `Bearer ${options.token}`;
      const authBuf = Buffer.from(auth);
      const expectedBuf = Buffer.from(expected);
      if (authBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(authBuf, expectedBuf)) {
        socket.close(4001, 'unauthorized');
        return;
      }
    } else if (options.viewerAuthToken) {
      // Standalone viewer with auth enabled: require a valid session cookie
      // (the browser obtained it by logging in via POST /login).
      if (!isValidSession(request.headers.cookie)) {
        socket.close(4001, 'unauthorized');
        return;
      }
    }

    const { store } = options;

    // Username this viewer chose at login (standalone auth only). The webview uses
    // it to play task sounds only for matching agents; undefined => play all.
    const viewerUsername = options.viewerAuthToken
      ? getSessionUsername(request.headers.cookie)
      : undefined;

    // Pipe store events to WebSocket client
    const onAgentAdded = (id: number, agent: AgentState) => {
      safeSend(socket, {
        type: 'agentCreated',
        id,
        folderName: agent.folderName,
        isExternal: agent.isExternal || undefined,
        isTeammate: agent.leadAgentId !== undefined || undefined,
        teammateName: agent.agentName,
        parentAgentId: agent.leadAgentId,
        teamName: agent.teamName,
        hooksOnly: agent.hooksOnly || undefined,
      });
    };

    const onAgentRemoved = (id: number) => {
      safeSend(socket, { type: 'agentClosed', id });
    };

    const onBroadcast = (message: Record<string, unknown>) => {
      safeSend(socket, message);
    };

    store.on('agentAdded', onAgentAdded);
    store.on('agentRemoved', onAgentRemoved);
    store.on('broadcast', onBroadcast);

    // Handle incoming client messages
    socket.on('message', (data: Buffer | string) => {
      try {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        // Display viewer: allow state request + layout/seats/UI persistence, but
        // drop AGENT control (spawn/steer) — that control logic comes later.
        // Anything not on the allowlist (incl. future control msgs) is ignored.
        if (options.readOnly && !VIEWER_ALLOWED.has(msg.type as string)) {
          return;
        }
        if (!options.embedded && msg.type) {
          console.log('[Pixel Agents] WS client message:', msg.type);
        }
        // On the initial handshake, tell the viewer which username it logged in as
        // (sent here rather than on connect so the webview's handler is registered).
        if (msg.type === 'webviewReady') {
          safeSend(socket, { type: 'viewerIdentity', username: viewerUsername });
        }
        handleClientMessage(msg, (m) => safeSend(socket, m), {
          store,
          cache: options.assetCache ?? null,
          layoutStore: options.layoutStore,
          onSetHooksEnabled: options.onSetHooksEnabled,
        });
      } catch {
        // Malformed JSON, ignore
      }
    });

    socket.on('close', () => {
      store.off('agentAdded', onAgentAdded);
      store.off('agentRemoved', onAgentRemoved);
      store.off('broadcast', onBroadcast);
    });
  });
}

// ── Utilities ──────────────────────────────────────────────────

function safeSend(
  socket: { send: (data: string) => void; readyState: number },
  message: Record<string, unknown>,
): void {
  // WebSocket.OPEN = 1
  if (socket.readyState === 1) {
    socket.send(JSON.stringify(message));
  }
}
