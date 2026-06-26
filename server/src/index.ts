import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';

import { Server } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import cors from 'cors';
import express from 'express';

import { WORLD_ROOM } from '@pixel/shared';

import { loadAssetBundle } from './assets.js';
import { registerAuth } from './auth.js';
import { SimRoom } from './rooms/SimRoom.js';
import { attachFeedServer } from './ingest/feedServer.js';
import { startMockDriver } from './ingest/mockDriver.js';

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

// Single port for everything: viewer (browser), Colyseus and the agent feed
// (/feed) all share PORT. Follows the old project's PIXEL_STREAM_* convention
// (with PORT as a fallback for local dev).
const PORT = Number(process.env.PIXEL_STREAM_PORT ?? process.env.PORT ?? 2567);
const HOST = process.env.PIXEL_STREAM_HOST?.trim() || '0.0.0.0';
// Viewer/feed AUTH token — pass --token <T> at start, or set PIXEL_STREAM_TOKEN
// (same name the feeder uses). Empty → no login required (open dev mode).
const TOKEN = arg('--token', process.env.PIXEL_STREAM_TOKEN ?? '').trim() || null;
const MOCK = Number(process.env.MOCK ?? 0);

const __dirname = dirname(fileURLToPath(import.meta.url));
// Built client (vite). Override with PIXEL_STREAM_CLIENT_DIR for non-standard layouts.
const clientDist = process.env.PIXEL_STREAM_CLIENT_DIR?.trim() || resolve(__dirname, '../../client/dist');

async function main(): Promise<void> {
  console.log('[server] decoding assets…');
  const bundle = await loadAssetBundle();
  console.log(`[server] assets ready (${bundle.messages.length} asset messages)`);

  const app = express();
  app.use(cors());
  app.get('/health', (_req, res) => res.json({ ok: true }));
  // Token login + cookie-session gate (only when a token is configured).
  if (TOKEN) {
    registerAuth(app, TOKEN);
    console.log('[server] viewer login required (--token / PIXEL_STREAM_TOKEN set)');
  }
  if (existsSync(clientDist)) {
    app.use(express.static(clientDist));
    console.log(`[server] serving client build from ${clientDist}`);
  }

  const httpServer = createServer(app);
  // ws-transport defaults maxPayload to 4 KB — far too small for saved layouts
  // (an expanded office with per-tile colours) and asset-editor saves (a single
  // character is ~100 KB of SpriteData). Editor ops are authenticated, so allow
  // up to 8 MB.
  const gameServer = new Server({
    transport: new WebSocketTransport({ server: httpServer, maxPayload: 8 * 1024 * 1024 }),
  });
  gameServer.define(WORLD_ROOM, SimRoom, { bundle, token: TOKEN ?? undefined });

  // Mount the agent feed (/feed) on the same http server (after Colyseus has
  // registered its upgrade listener, so the dispatcher can delegate to it).
  attachFeedServer(httpServer, TOKEN);

  httpServer.listen(PORT, HOST, () => {
    console.log(`[server] listening on ${HOST}:${PORT} (viewer + Colyseus + /feed)`);
  });

  if (MOCK > 0) startMockDriver(MOCK);
}

void main();
