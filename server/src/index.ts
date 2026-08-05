import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

/** Version for the startup log: env override, else the release-time version.txt,
 *  else a live `git describe` in dev, else "dev". */
function serverVersion(): string {
  const env = process.env.PIXEL_VERSION?.trim();
  if (env) return env;
  try {
    return readFileSync(fileURLToPath(new URL('../version.txt', import.meta.url)), 'utf8').trim() || 'dev';
  } catch {
    /* no release file — try git, else dev */
  }
  try {
    return (
      execSync('git describe --tags --always --dirty', {
        cwd: fileURLToPath(new URL('.', import.meta.url)),
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .toString()
        .trim() || 'dev'
    );
  } catch {
    return 'dev';
  }
}

import { Server } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import cors from 'cors';
import express, { type Request, type Response, type NextFunction, type RequestHandler } from 'express';

import { WORLD_ROOM } from '@pixel/shared';

import { loadAssetBundle } from './assets.js';
import { initAssetDefaults } from './assetOverrides.js';
import { dataPath } from './paths.js';
import { registerAuth, hasValidSession, hasValidBearerSession } from './auth.js';
import { registerAdminApi } from './adminApi.js';
import { registerMeetingRoomApi } from './meetingRoomApi.js';
import { arcadeTurnConfigured } from './arcadeTurn.js';
import { arcadeContentDir, getArcadeCatalog } from './arcadeCatalog.js';
import { resolveAllowedGames } from './arcadeDefaults.js';
import { ZoneStore } from './zoneStore.js';

// Load the repo-root .env (LIVEKIT_* for conferencing, etc.) if present — uses
// Node's built-in loader (no dependency). Missing file is fine.
try {
  process.loadEnvFile(fileURLToPath(new URL('../../.env', import.meta.url)));
} catch {
  /* no .env present */
}
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
// Admin login token — pass --token <T> at start, or set PIXEL_ADMIN_TOKEN.
// Presenting it at login makes that user an admin (and creates them if new).
// When set, login (user id + password) is required and there is no anonymous
// mode; empty → open dev mode (no login, anonymous viewer). Agents authenticate
// the feed with their own per-user token, not this one.
const ADMIN_TOKEN = arg('--token', process.env.PIXEL_ADMIN_TOKEN ?? '').trim() || null;
const MOCK = Number(process.env.MOCK ?? 0);

const __dirname = dirname(fileURLToPath(import.meta.url));
// Built client (vite). Override with PIXEL_STREAM_CLIENT_DIR for non-standard layouts.
const clientDist = process.env.PIXEL_STREAM_CLIENT_DIR?.trim() || resolve(__dirname, '../../client/dist');

// Narrow cross-origin support for the desktop bearer path (AC-012). The desktop
// app runs from a packaged origin and must be able to send `Authorization` to
// the token/signout endpoints and to probe `/health` cross-origin. This echoes
// the request Origin and allows the `Authorization` header, but deliberately
// does NOT set `Access-Control-Allow-Credentials` — no cross-origin cookie
// surface is opened, so the same-origin cookie flow is unaffected. Same-origin
// requests (no Origin header) pass through untouched. Kept separate from the
// open `cors()` so a future tightening of the base policy leaves this contract
// intact.
const DESKTOP_CORS_PATHS = new Set(['/desktop/token', '/desktop/signout', '/health']);

export function desktopCors(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.headers.origin;
    // Only cross-origin requests to the desktop-reachable endpoints get headers.
    if (origin && DESKTOP_CORS_PATHS.has(req.path)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      // Intentionally NO Access-Control-Allow-Credentials (AC-012).
      if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
      }
    }
    next();
  };
}

// Baseline response headers, applied to every request. Scoped deliberately narrow:
// frame-ancestors/X-Frame-Options block clickjacking (the app — including the
// public /meet/<slug> guest page — is never meant to be framed by another site);
// nosniff + Referrer-Policy are cheap, safe-by-default hardening. HSTS only fires
// over an actual HTTPS connection (direct TLS or behind the TLS-terminating Caddy
// proxy — see `trust proxy` above), never over plain http (would be wrong advice
// for local dev). Deliberately NOT a full page CSP (script-src/connect-src/etc.):
// Phaser and LiveKit rely on blob: workers, wss:// connections and canvas/data:
// images that a hand-rolled CSP could break without careful auditing —
// left for a follow-up if a full CSP is wanted.
export function securityHeaders(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
      res.setHeader('Strict-Transport-Security', 'max-age=15552000');
    }
    next();
  };
}

async function main(): Promise<void> {
  console.log('[server] decoding assets…');
  const bundle = await loadAssetBundle();
  initAssetDefaults(bundle); // process-wide merged-bundle cache (see assetOverrides.ts)
  console.log(`[server] assets ready (${bundle.messages.length} asset messages)`);

  const app = express();
  // Trust only a reverse proxy connecting from loopback (our deploy topology: Caddy
  // on the same host, see deploy/Caddyfile) to read the real client IP from
  // X-Forwarded-For. Without this, req.ip is always the proxy's own loopback
  // address behind Caddy, which silently collapses any per-guest IP throttle
  // (e.g. the /meet join password guard) into a single shared bucket. Scoped to
  // 'loopback' rather than trusting an arbitrary XFF chain from the internet.
  app.set('trust proxy', 'loopback');
  app.use(securityHeaders());
  app.use(cors());
  // Narrow cross-origin headers for the desktop bearer path (Authorization
  // allowed, no credentialed cookies) — see desktopCors. Applied before the
  // routes so preflight and actual responses carry the contract.
  app.use(desktopCors());
  app.get('/health', (_req, res) => res.json({ ok: true }));

  // Arcade catalog — metadata only (titles/emulator/flags), so it's public (the
  // content files at /arcade/content are auth-gated). Registered before the auth
  // gate so the launcher can populate itself on both browser + desktop.
  app.get('/arcade/catalog', (_req, res) => res.json({ games: getArcadeCatalog() }));

  // Which games one placed cabinet currently offers (its own admin override, or
  // the global default — see arcadeDefaults.ts). Same public trust level as
  // /arcade/catalog above: this is content curation, not an access control.
  const arcadeZones = new ZoneStore();
  app.get('/arcade/allowed-games', (req, res) => {
    const zone = typeof req.query.zone === 'string' ? req.query.zone : '';
    const cabinet = typeof req.query.cabinet === 'string' ? req.query.cabinet : '';
    const override = zone && /^\d+,\d+$/.test(cabinet) ? arcadeZones.cabinetGamesOverride(zone, cabinet) : null;
    res.json({ gameIds: resolveAllowedGames(override) });
  });

  // Suggested Mumble address, so the desktop app can offer the community's voice
  // server instead of making everyone type it. Suggestion only: the desktop app
  // connects to Mumble directly and keeps its own credentials and certificate —
  // the server holds nothing here beyond these three env vars.
  // Registered before registerAuth installs its gate, so it has to check the
  // session itself rather than inherit the gate.
  app.get('/mumble/config', (req, res) => {
    if (ADMIN_TOKEN && !hasValidSession(req.headers.cookie) && !hasValidBearerSession(req.headers.authorization)) {
      return void res.status(401).json({ error: 'unauthorized' });
    }
    res.json({
      host: process.env.MUMBLE_HOST?.trim() || null,
      port: Number(process.env.MUMBLE_PORT ?? 64738),
      channel: process.env.MUMBLE_CHANNEL?.trim() || null,
    });
  });

  // Ad-hoc meeting rooms (/meet/<slug>) are reachable by anyone with the link —
  // no pixel-agents account required — so they're registered here, before the
  // login gate, same as /arcade/catalog above.
  registerMeetingRoomApi(app, clientDist);

  // Login + cookie-session gate (only when an admin token is configured).
  if (ADMIN_TOKEN) {
    registerAuth(app, ADMIN_TOKEN);
    registerAdminApi(app); // admin-only user/room management REST API (in-game admin overlay)
    console.log('[server] login required (--token / PIXEL_ADMIN_TOKEN set)');
  }
  // Arcade content (js-dos bundles, emulator ROMs, …) + its catalog.json are NOT in
  // the image — the operator bind-mounts ARCADE_CONTENT_DIR at runtime. The catalog
  // (metadata only) is public; the files are auth-gated (see auth.ts: /arcade/content
  // is not treated as a public asset). Served BEFORE the client build.
  const contentDir = arcadeContentDir();
  if (contentDir && existsSync(contentDir)) {
    app.use('/arcade/content', express.static(contentDir));
    console.log(`[server] arcade: content dir ${contentDir} (${getArcadeCatalog().length} games in catalog)`);
  } else if (contentDir) {
    console.warn(`[server] arcade: ARCADE_CONTENT_DIR=${contentDir} does not exist — no games available`);
  } else {
    console.log('[server] arcade: no ARCADE_CONTENT_DIR set — no games available');
  }
  if (existsSync(clientDist)) {
    app.use(express.static(clientDist));
    console.log(`[server] serving client build from ${clientDist}`);
  }

  // TLS: if a cert + key are present in the data dir (alongside the SQLite DB),
  // serve HTTPS/WSS — required for camera/mic/screen-share (secure context) and
  // used for dev + first-step production. Falls back to plain HTTP otherwise
  // (e.g. behind a TLS-terminating reverse proxy). Override paths with
  // PIXEL_TLS_CERT / PIXEL_TLS_KEY (e.g. later for Let's Encrypt).
  const certPath = process.env.PIXEL_TLS_CERT || dataPath('cert.pem');
  const keyPath = process.env.PIXEL_TLS_KEY || dataPath('key.pem');
  const useTls = existsSync(certPath) && existsSync(keyPath);
  const httpServer = useTls
    ? createHttpsServer({ cert: readFileSync(certPath), key: readFileSync(keyPath) }, app)
    : createServer(app);
  // ws-transport defaults maxPayload to 4 KB — far too small for saved layouts
  // (an expanded office with per-tile colours) and asset-editor saves (a single
  // character is ~100 KB of SpriteData). Editor ops are authenticated, so allow
  // up to 8 MB.
  const gameServer = new Server({
    transport: new WebSocketTransport({ server: httpServer, maxPayload: 8 * 1024 * 1024 }),
  });
  // Resolve the version once: logged at startup and handed to each room so the
  // client can show it next to the connection status.
  const version = serverVersion();
  // One room type, matchmade per zone: joinOrCreate({ zone }) groups players into
  // the same instance for a zone and a separate instance per other zone.
  // No visitors anywhere: every room + the feed require a logged-in account (a valid
  // session cookie / bearer). Login is served by registerAuth, which needs an admin
  // token to be configured — without one nobody can join (there is no anonymous mode).
  if (!ADMIN_TOKEN) console.warn('[server] NO PIXEL_ADMIN_TOKEN set → login is unavailable and NOBODY can join (no-visitor policy). Set --token / PIXEL_ADMIN_TOKEN.');
  gameServer.define(WORLD_ROOM, SimRoom, { authRequired: true, version }).filterBy(['zone']);

  // Mount the agent feed (/feed) on the same http server (after Colyseus has
  // registered its upgrade listener, so the dispatcher can delegate to it).
  attachFeedServer(httpServer, { authRequired: true });

  console.log(
    arcadeTurnConfigured()
      ? '[server] arcade IPX: TURN relay configured (NAT-to-NAT play enabled)'
      : '[server] arcade IPX: no TURN configured — set ARCADE_TURN_URLS + ARCADE_TURN_SECRET for internet play behind NAT (STUN-only otherwise)',
  );

  // Fail safe: with no admin token there is no login and no gate — the whole HTTP
  // surface would be public. Refuse to expose that beyond loopback (a forgotten
  // PIXEL_ADMIN_TOKEN in production must not silently open the app to the network).
  const isLoopback = (h: string): boolean => h === '127.0.0.1' || h === 'localhost' || h === '::1';
  const bindHost = ADMIN_TOKEN || isLoopback(HOST) ? HOST : '127.0.0.1';
  if (!ADMIN_TOKEN && bindHost !== HOST) {
    console.warn(`[server] SECURITY: no PIXEL_ADMIN_TOKEN → no login/gate; binding to 127.0.0.1 instead of ${HOST} so the open app is not network-reachable. Set a token to serve publicly.`);
  }

  httpServer.listen(PORT, bindHost, () => {
    const scheme = useTls ? 'https' : 'http';
    console.log(`[server] pixel-agents ${version}`);
    console.log(`[server] listening on ${scheme}://${bindHost}:${PORT} (viewer + Colyseus + /feed)`);
    if (useTls) console.log(`[server] TLS enabled (cert: ${certPath})`);
  });

  if (MOCK > 0) startMockDriver(MOCK);
}

// Only boot the server when run as the entrypoint. Importing this module (e.g.
// to reuse `desktopCors` in tests) must not start Colyseus or load assets.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
