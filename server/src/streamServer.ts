#!/usr/bin/env node
/**
 * streamServer.ts — pixel-agents standalone server.
 *
 * A fork of the original pixel-agents standalone CLI. Instead of watching local
 * ~/.claude/projects JSONL files, it receives transcript STREAMS from remote
 * clients over a WebSocket `/feed` endpoint (see streamIngest.ts) and keeps all
 * state in memory. The pixel office SPA + viewer WebSocket (`/ws`) are reused
 * unchanged; agents appear/update/disappear as clients stream / disconnect.
 *
 * Usage: stream-server --token T [--port N] [--feed-port N] [--host H]
 *   --port       viewer (display) port (default 6161)
 *   --feed-port  client-ingest port (default 7171)
 *   --host       bind address (default 0.0.0.0 so remote clients can reach /feed)
 *   --token      shared AUTH token (required; or env PIXEL_STREAM_TOKEN)
 */
import * as crypto from 'crypto';
import * as path from 'path';

import { AgentStateStore } from './agentStateStore.js';
import {
  loadCharacterSprites,
  loadDefaultLayout,
  loadFloorTiles,
  loadFurnitureAssets,
  loadPetSprites,
  loadWallTiles,
} from './assetLoader.js';
import type { AssetCache } from './clientMessageHandler.js';
import { FileStateAdapter } from './fileStateAdapter.js';
import { createHttpServer } from './httpServer.js';
import { LayoutStore } from './layoutStore.js';
import { claudeProvider } from './providers/index.js';
import { startFeedServer } from './streamIngest.js';
import { setHookProvider } from './transcriptParser.js';

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

/** AUTH token MUST be supplied via --token (or PIXEL_STREAM_TOKEN). No file fallback. */
function resolveToken(): string {
  const tok = arg('--token', process.env.PIXEL_STREAM_TOKEN ?? '').trim();
  if (!tok) {
    console.error('[stream] ERROR: AUTH token missing. Pass --token <T> (or set PIXEL_STREAM_TOKEN).');
    process.exit(2);
  }
  return tok;
}

async function main(): Promise<void> {
  const viewerPort = parseInt(arg('--port', process.env.PIXEL_STREAM_PORT ?? '6161'), 10);
  const feedPort = parseInt(arg('--feed-port', process.env.PIXEL_STREAM_FEED_PORT ?? '7171'), 10);
  const host = arg('--host', process.env.PIXEL_STREAM_HOST ?? '0.0.0.0');
  const token = resolveToken();

  const distRoot = __dirname; // dist/ holds stream.js + assets/ + webview/
  const staticDir = path.join(distRoot, 'webview');

  // Provider powers tool-status formatting in processTranscriptLine.
  setHookProvider(claudeProvider);

  console.log('[stream] Loading assets...');
  const assetCache: AssetCache = {
    characters: await loadCharacterSprites(distRoot),
    pets: await loadPetSprites(distRoot),
    floorTiles: await loadFloorTiles(distRoot).then((t) => t?.sprites ?? null),
    wallTiles: await loadWallTiles(distRoot).then((t) => t?.sets ?? null),
    furniture: await loadFurnitureAssets(distRoot),
    defaultLayout: loadDefaultLayout(distRoot),
  };

  const store = new AgentStateStore();
  store.setAdapter(new FileStateAdapter({ namespace: 'standalone' }));

  // Named layouts live in a SQLite DB under the data dir; the bundled default
  // layout is exposed as the read-only "Default" entry.
  const layoutStore = new LayoutStore(assetCache.defaultLayout);

  // In-memory timer maps shared with the stream ingest (no file polling involved).
  const waitingTimers = new Map<number, ReturnType<typeof setTimeout>>();
  const permissionTimers = new Map<number, ReturnType<typeof setTimeout>>();

  const viewerToken = crypto.randomUUID(); // viewer /ws skips auth in standalone; placeholder

  // Viewer port (6161): display only — read-only, no /feed, no control messages.
  const viewer = await createHttpServer({
    embedded: false,
    host,
    port: viewerPort,
    token: viewerToken,
    store,
    layoutStore,
    staticDir,
    assetCache,
    readOnly: true,
    viewerAuthToken: token, // Frontend uses the same AUTH token (via cookie)
  });

  // Dedicated client-ingest listener on its own port (7171), shares the store.
  const feed = await startFeedServer({
    store,
    token,
    waitingTimers,
    permissionTimers,
    host,
    port: feedPort,
  });

  const shown = host === '0.0.0.0' ? '<server-host>' : host;
  console.log('');
  console.log('  pixel-agents server running');
  console.log(`  Viewer (browser, display only):  http://${shown}:${viewer.port}`);
  console.log(`  Client feed (WS, own port):      ws://${shown}:${feed.port}/feed`);
  console.log(`  AUTH TOKEN:                      ${token}`);
  console.log('');
  console.log('  Client:  ./pixel-agents.sh client --server ws://<server>:' + feed.port + '/feed \\');
  console.log('             --user <name> --token ' + token);
  console.log('');

  // Graceful shutdown: as PID 1 in a container, Node only stops on SIGTERM if we
  // handle it — otherwise `docker stop` waits out the grace period then SIGKILLs.
  let shuttingDown = false;
  const shutdown = async (sig: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[stream] ${sig} received — closing servers...`);
    const force = setTimeout(() => process.exit(1), 5000);
    force.unref();
    try {
      await Promise.all([viewer.app.close(), feed.app.close()]);
      layoutStore.close();
    } catch (err) {
      console.error('[stream] error during shutdown:', err);
    }
    clearTimeout(force);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((e) => {
  console.error('[stream] fatal:', e);
  process.exit(1);
});
