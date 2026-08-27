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

import { Server, matchMaker } from '@colyseus/core';
import { Encoder } from '@colyseus/schema';
import { ATLAS_MANIFEST_REL } from './tiled/furnitureAtlas.js';
import { WebSocketTransport } from '@colyseus/ws-transport';
import cors from 'cors';
import express, { type Request, type Response, type NextFunction, type RequestHandler } from 'express';

import { MAX_WS_PAYLOAD_BYTES, WORLD_ROOM } from '@pixel/shared';

import { ASSETS_ROOT, loadAssetBundle, watchFurnitureTilesets } from './assets.js';
import { ensureDevTls } from './dataBootstrap.js';
import { registerZonePushApi } from './tiled/zonePushApi.js';
import { runStartupCleanup } from './maintenance/startupCleanup.js';
import { seedBundledZoneMaps } from './tiled/seedBundledZones.js';
import { gridSheets, loadTiledRegistry } from './tiled/tiledRegistry.js';
import { initAssetDefaults } from './assetOverrides.js';
import { dataPath } from './paths.js';
import { registerAuth, hasValidSession, hasValidBearerSession } from './auth.js';
import { oidcConfig } from './oidc/config.js';
import { registerOidcAuth } from './oidc/routes.js';
import { registerAdminApi } from './adminApi.js';
import { registerArtApi } from './artApi.js';
import { registerArtSaveApi } from './artSaveApi.js';
import { registerMeetingRoomApi } from './meetingRoomApi.js';
import { arcadeTurnConfigured } from './arcadeTurn.js';
import { arcadeContentDir, getArcadeCatalog } from './arcadeCatalog.js';
import { resolveAllowedGames } from './arcadeDefaults.js';
import { ZoneStore } from './zoneStore.js';
import { setGroundColumnsResolver, ZoneMapStore } from './zoneMapStore.js';

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
// It is what makes login possible at all: rooms and the feed require an account
// either way (no anonymous mode), so without this token there is no login and
// therefore no way in — the server says so and binds to loopback (see below).
// Agents authenticate the feed with their own per-user token, not this one.
const ADMIN_TOKEN = arg('--token', process.env.PIXEL_ADMIN_TOKEN ?? '').trim() || null;
// The second way in: an OpenID Connect provider (Zitadel), configured through PIXEL_OIDC_*
// (see oidc/config.ts). Either one is enough to have logins — and therefore enough to install the
// session gate, which is what makes it safe to serve beyond loopback. The admin token remains the
// only way to create a LOCAL account and the break-glass path when the provider is unavailable.
const OIDC = oidcConfig();
const LOGIN_ENABLED = ADMIN_TOKEN !== null || OIDC !== null;
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
// `/auth/oauth/config` is here too: the desktop app asks — before it has any session, from its
// own app:// origin — whether this server offers a provider button and what to call it. It answers
// two harmless fields (see oidc/routes.ts) and, like the rest of this set, without credentials.
const DESKTOP_CORS_PATHS = new Set([
  '/desktop/token',
  '/desktop/signout',
  '/desktop/oauth/start',
  '/desktop/oauth/token',
  '/auth/oauth/config',
  '/health',
]);

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
  // Housekeeping first: the asset bundle below is built from the database and then
  // cached process-wide, so anything cleaned afterwards would still be served until
  // the next restart. See maintenance/startupCleanup.ts for what a task there must
  // guarantee — it runs unattended, on every boot, with nobody reading a report.
  runStartupCleanup();

  console.log('[server] decoding assets…');
  const bundle = await loadAssetBundle();
  initAssetDefaults(bundle); // process-wide merged-bundle cache (see assetOverrides.ts)
  watchFurnitureTilesets(); // live-reload assets/tiled/furniture-*.tsj on save (see assets.ts)
  console.log(`[server] assets ready (${bundle.messages.length} asset messages)`);

  // The maps that ship in the image fill in any zone that has none — a fresh
  // deployment comes up with a world instead of an empty field. A zone that
  // already has a map keeps it: a push is authored against that deployment and
  // a release does not get to undo one (see tiled/seedBundledZones.ts).
  // Version-1 layouts store a floor PATTERN plus a colour; turning that into a
  // tile id needs the set's column count, which only the tilesets know. Resolved
  // once here and handed to the store, which must not read assets itself.
  {
    const sheets = new Map(gridSheets(loadTiledRegistry(ASSETS_ROOT)).map((sh) => [sh.name, sh.columns]));
    setGroundColumnsResolver((name) => sheets.get(name));
  }
  const seeded = await seedBundledZoneMaps(ASSETS_ROOT, new ZoneMapStore(), new ZoneStore());
  if (seeded.seeded.length) console.log(`[zones] seeded from the image: ${seeded.seeded.join(', ')}`);
  if (seeded.kept.length) console.log(`[zones] kept the pushed map: ${seeded.kept.join(', ')}`);

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
  // Colyseus's matchmaker ships `Access-Control-Allow-Credentials: true` in its
  // DEFAULT_CORS_HEADERS, and its transport applies those to every request — which quietly
  // undid the contract stated at desktopCors ("no cross-origin cookie surface is opened",
  // AC-012). Measured 2026-08-20: every response carried it, and on the three paths
  // desktopCors echoes a specific Origin for, that pair is exactly what lets any website
  // read a cookie-authenticated response. Harmless today because those three answer nothing
  // sensitive — and a trap primed for the day a data route joins them. Removed here rather
  // than worked around at each route, and the override point is the library's own
  // (see the comment on getCorsHeaders in @colyseus/core's matchmaker/controller).
  delete (matchMaker.controller.DEFAULT_CORS_HEADERS as Record<string, string>)['Access-Control-Allow-Credentials'];
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
    if (LOGIN_ENABLED && !hasValidSession(req.headers.cookie) && !hasValidBearerSession(req.headers.authorization)) {
      return void res.status(401).json({ error: 'unauthorized' });
    }
    res.json({
      host: process.env.MUMBLE_HOST?.trim() || null,
      port: Number(process.env.MUMBLE_PORT ?? 64738),
      channel: process.env.MUMBLE_CHANNEL?.trim() || null,
    });
  });

  // Suggested TimeTracking address, so the desktop app can offer the company's
  // server instead of making everyone type it. Suggestion only, and the entire
  // extent of this server's involvement: the desktop app holds the credential
  // and does the booking (see desktop/src/timetracking/), and the server only
  // ever receives the resulting one-word status over the room's 'workStatus'
  // message. Same shape and same reasoning as /mumble/config above, including
  // checking the session itself since it is registered before the gate.
  app.get('/timetracking/config', (req, res) => {
    if (LOGIN_ENABLED && !hasValidSession(req.headers.cookie) && !hasValidBearerSession(req.headers.authorization)) {
      return void res.status(401).json({ error: 'unauthorized' });
    }
    res.json({ baseUrl: process.env.TIMETRACKING_URL?.trim() || null });
  });

  // Ad-hoc meeting rooms (/meet/<slug>) are reachable by anyone with the link —
  // no pixel-agents account required — so they're registered here, before the
  // login gate, same as /arcade/catalog above.
  registerMeetingRoomApi(app, clientDist);

  // Login + cookie-session gate (whenever there is any way to log in at all).
  if (LOGIN_ENABLED) {
    // Before the login gate on purpose: that gate answers 401 to any GET without
    // a browser SESSION, and a push authenticates with the admin token instead
    // (it has no session and should not need one). These routes check that token
    // themselves on every request — see tiled/zonePushApi.ts.
    //
    // Zone maps arrive this way and no other: the deploy server has no
    // zones/*.tmj of its own, since they are gitignored and so ride along with
    // no release. See also scripts/push-zones.mts.
    if (ADMIN_TOKEN) registerZonePushApi(app, ADMIN_TOKEN, ASSETS_ROOT);
    // Before registerAuth, on purpose: the OIDC routes are how a caller with no session gets one,
    // so they must sit ahead of the gate registerAuth installs (same as /meet/:slug above). Each
    // one authorizes itself — see oidc/routes.ts.
    registerOidcAuth(app);
    registerAuth(app, ADMIN_TOKEN);
    registerAdminApi(app); // admin-only user/room management REST API (in-game admin overlay)
    console.log(
      `[server] login required (${[ADMIN_TOKEN ? '--token / PIXEL_ADMIN_TOKEN set' : null, OIDC ? `OIDC: ${OIDC.issuer}` : null]
        .filter(Boolean)
        .join(', ')})`,
    );
    if (OIDC) {
      console.log(
        `[server] OIDC login enabled as "${OIDC.label}" (client ${OIDC.clientId}, redirect ${OIDC.redirectUri}` +
          `${OIDC.adminRole ? `, admin role "${OIDC.adminRole}"` : ', roles not mapped'})`,
      );
    }
  }
  // Character/NPC/avatar art as PNG. AFTER registerAuth on purpose: it carries no
  // file extension, so the session gate covers it — which is the whole point, since
  // avatars are personal art and /assets/*.png is served openly (see artApi.ts).
  registerArtApi(app);
  // Saving art is a POST, not a room message: see artSaveApi.ts for why (own size limit, an
  // answer the editor can show, and a decode that nothing in the room refers to any more).
  registerArtSaveApi(app);
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
  // Pre-baked, closed-palette floor/wall tile sheets (see
  // server/scripts/bake-floor-wall-tiled.mts and docs/design.md) —
  // the SAME files Tiled's own tileset images point at. Served as plain
  // static files (cacheable by the browser) so the client loads them once
  // and slices out tiles itself; no live per-pixel colorize step anymore.
  const tiledPngDir = resolve(__dirname, '../../assets/tiled/png');
  if (existsSync(tiledPngDir)) {
    app.use('/assets/tiled/png', express.static(tiledPngDir));
  }
  // Which sheets exist and how to read them. Nothing enumerates tileset filenames
  // in code any more (see tiledSheetLayout.ts) — they are discovered from disk.
  // Under /assets/ deliberately: the login gate treats that prefix as public,
  // which is right, since these are the names of files it already serves openly.
  app.get('/assets/tiled/sets.json', (_req, res) => {
    const registry = loadTiledRegistry(ASSETS_ROOT);
    // Every GRID tileset: name, the sheet's own grid geometry, where its PNG is,
    // and what its tiles say it is. All of them, not just the baked floor/wall
    // sets — a map's ground may name any grid tileset (see OfficeLayout.tiles),
    // and the client needs each one as a texture to draw cells from.
    //
    // Read off the .tsj rather than assumed, because both halves have bitten us:
    // the column count and the baked gap are PER SET (a natural-only set has 1
    // column, a palette bake 65), and the image PATH belongs to the tileset — the
    // client used to assemble png/<set>.png itself, so moving the baked sheets
    // would have needed a client release to find art that had not changed.
    //
    // Re-read per request rather than cached: a pushed or re-baked tileset must
    // show up without a restart, and this is a handful of small JSON files.
    res.json({
      sheets: gridSheets(registry),
      // The furniture atlas, same reasoning: the server owns where it bakes it.
      atlas: ATLAS_MANIFEST_REL,
    });
  });
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
  // A development run with no certificate gets one made for it, so a fresh
  // checkout has the secure context camera/mic/screen-share require. Never in a
  // deployment — see dataBootstrap.ts.
  ensureDevTls(certPath, keyPath);
  const useTls = existsSync(certPath) && existsSync(keyPath);
  const httpServer = useTls
    ? createHttpsServer({ cert: readFileSync(certPath), key: readFileSync(keyPath) }, app)
    : createServer(app);
  // ws-transport defaults maxPayload to 4 KB — far too small for saved layouts
  // (an expanded office with per-tile colours) and asset-editor saves (a single
  // character is ~100 KB of SpriteData). Editor ops are authenticated, so the
  // ceiling is generous — and it is MAX_WS_PAYLOAD_BYTES rather than a literal
  // because the art rules are bounded against it (see MAX_SHEET_CELLS): whatever
  // the validator calls legal has to fit through here, or an oversized save kills
  // the connection instead of being refused, which is what production showed.
  // Raised 8 → 12 MB in the same change, so the two numbers have room between them.
  // The schema encoder writes a room's whole state into one reusable buffer, and its
  // default is 8 KB — which this world exceeds. A zone with 154 placed furniture
  // items carries fifteen synced fields each (see FurnitureSync), and the encode then
  // overflows: the server logs "buffer overflow", the state arrives truncated, and the
  // client reports a schema definition mismatch and shows no characters at all. It is
  // intermittent, because it depends on how much else is in the room at that moment,
  // which is what made it look like a rendering bug for a while.
  //
  // Generous on purpose. The buffer is one allocation, so the cost is nothing next to
  // being the thing that silently limits how much a mapper may place — the number of
  // items in a zone is content, and content is not supposed to have a code ceiling.
  Encoder.BUFFER_SIZE = 256 * 1024;

  const gameServer = new Server({
    transport: new WebSocketTransport({
      server: httpServer,
      maxPayload: MAX_WS_PAYLOAD_BYTES,
      // Compress messages. `ws` defaults this OFF, and our biggest message is the
      // asset catalog: 5.3 MB of SpriteData that deflates to ~120 KB, because a
      // grid of hex-colour strings is about as redundant as data gets. It was
      // therefore going over the wire raw, at 66 % of the maxPayload ceiling above
      // — a ceiling on how much art a world may contain. Threshold so the many
      // tiny state messages are not run through deflate for nothing.
      perMessageDeflate: { threshold: 4096 },
    }),
  });
  // Resolve the version once: logged at startup and handed to each room so the
  // client can show it next to the connection status.
  const version = serverVersion();
  // One room type, matchmade per zone: joinOrCreate({ zone }) groups players into
  // the same instance for a zone and a separate instance per other zone.
  // No visitors anywhere: every room + the feed require a logged-in account (a valid
  // session cookie / bearer). Login is served by registerAuth and, when configured, the OIDC
  // routes — with neither an admin token nor a provider nobody can join (no anonymous mode).
  if (!LOGIN_ENABLED) {
    console.warn(
      '[server] NO login configured → NOBODY can join (no-visitor policy). Set --token / PIXEL_ADMIN_TOKEN, ' +
        'or configure an OIDC provider (PIXEL_OIDC_ISSUER / _CLIENT_ID / _REDIRECT_URI).',
    );
  }
  gameServer.define(WORLD_ROOM, SimRoom, { authRequired: true, version }).filterBy(['zone']);

  // Fail safe: with no way to log in there is no gate either — the whole HTTP surface
  // would be public. Refuse to expose that beyond loopback (a forgotten PIXEL_ADMIN_TOKEN
  // or a half-configured provider in production must not silently open the app to the network).
  const isLoopback = (h: string): boolean => h === '127.0.0.1' || h === 'localhost' || h === '::1';
  const bindHost = LOGIN_ENABLED || isLoopback(HOST) ? HOST : '127.0.0.1';
  if (!LOGIN_ENABLED && bindHost !== HOST) {
    console.warn(`[server] SECURITY: no login configured → no gate; binding to 127.0.0.1 instead of ${HOST} so the open app is not network-reachable. Set an admin token or an OIDC provider to serve publicly.`);
  }

  // Colyseus 0.17 binds the /matchmake/* HTTP routes and publishes the global
  // transport in whichever of listen()/serverless() runs bindRoutes(), which
  // 0.16 did when the transport was constructed with `{ server }`. We own the
  // http server (TLS + the shared /feed upgrade path), so gameServer.listen()
  // — not serverless() — is the right entry point: serverless() is for the
  // Vercel-style "export default server, no listen()" case and, to make req.body
  // available synchronously there, unconditionally pre-reads and caches every
  // request body raw *before* Express's own body-parsing middleware runs —
  // which left every body-parser (express.urlencoded() for /login included)
  // seeing an already-set req.body and skipping its own parse, so req.body was
  // left as an unparsed raw string. gameServer.listen() binds routes the same
  // way without that side effect, and — since the transport was constructed
  // with our own `httpServer` — binds ITS port, so this fully replaces the
  // plain httpServer.listen() call below rather than running alongside it.
  // It also registers the websocket upgrade listener, so it must run before
  // attachFeedServer below.
  //
  // Note the matchmaking routes land ahead of the middleware registered above,
  // so — as in 0.16 — they do NOT pass through registerAuth's gate and SimRoom's
  // onAuth remains the sole room-entry gate.
  await gameServer.listen(PORT, bindHost, undefined, () => {
    const scheme = useTls ? 'https' : 'http';
    console.log(`[server] pixel-agents ${version}`);
    console.log(`[server] listening on ${scheme}://${bindHost}:${PORT} (viewer + Colyseus + /feed)`);
    if (useTls) console.log(`[server] TLS enabled (cert: ${certPath})`);
  });

  // Mount the agent feed (/feed) on the same http server (after Colyseus has
  // registered its upgrade listener, so the dispatcher can delegate to it).
  attachFeedServer(httpServer, { authRequired: true });

  console.log(
    arcadeTurnConfigured()
      ? '[server] arcade IPX: TURN relay configured (NAT-to-NAT play enabled)'
      : '[server] arcade IPX: no TURN configured — set ARCADE_TURN_URLS + ARCADE_TURN_SECRET for internet play behind NAT (STUN-only otherwise)',
  );

  if (MOCK > 0) startMockDriver(MOCK);
}

// Only boot the server when run as the entrypoint. Importing this module (e.g.
// to reuse `desktopCors` in tests) must not start Colyseus or load assets.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
