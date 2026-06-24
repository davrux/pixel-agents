/**
 * viewerAuth.ts — cookie session auth for the viewer (display port).
 *
 * The browser logs in once with the shared AUTH token via a POST form (the token
 * travels in the request body, never in the URL). The server then creates an
 * in-memory session and hands the browser a cookie holding only an opaque,
 * random session id — never the token itself. Flow:
 *  - Unauthenticated HTML navigation -> small login page (enter token).
 *  - `POST /login` (form field `token`) -> on a valid token, create a session,
 *    set the `pixel_stream_sid` cookie (HttpOnly, SameSite=Lax) and 303-redirect
 *    to `/`.
 *  - Static assets (JS/CSS/PNG) are not secret and pass through.
 *  - The `/ws` upgrade validates the session cookie (see httpServer.ts).
 *
 * Sessions live in memory only — a server restart simply requires a re-login.
 */
import * as crypto from 'crypto';
import type { FastifyInstance } from 'fastify';

const VIEWER_COOKIE = 'pixel_stream_sid';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** sessionId -> expiry timestamp (ms). In-memory; cleared on restart. */
const sessions = new Map<string, number>();

function tokenEquals(provided: string, expected: string): boolean {
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function createSession(): string {
  const id = crypto.randomBytes(32).toString('base64url'); // opaque, not the token
  sessions.set(id, Date.now() + SESSION_TTL_MS);
  return id;
}

/** True if the request carries a cookie for a live (non-expired) session. */
export function isValidSession(cookieHeader: string | undefined): boolean {
  const sid = parseCookies(cookieHeader)[VIEWER_COOKIE];
  if (!sid) return false;
  const expires = sessions.get(sid);
  if (expires === undefined) return false;
  if (Date.now() > expires) {
    sessions.delete(sid); // lazy cleanup
    return false;
  }
  return true;
}

function sessionCookie(sid: string): string {
  return `${VIEWER_COOKIE}=${sid}; Path=/; Max-Age=${SESSION_TTL_MS / 1000}; HttpOnly; SameSite=Lax`;
}

function loginHtml(err = ''): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>pixel-stream — Login</title>
<style>
  html,body{height:100%;margin:0}
  body{background:#1e1e2e;color:#cdd6f4;font-family:ui-monospace,Menlo,Consolas,monospace;
       display:flex;align-items:center;justify-content:center}
  form{background:#11111b;border:2px solid #45475a;padding:24px 28px;box-shadow:3px 3px 0 #0a0a14}
  h3{margin:0 0 14px} .err{color:#f38ba8;min-height:1.2em;margin:6px 0}
  input{background:#1e1e2e;color:#cdd6f4;border:2px solid #45475a;padding:8px;width:300px;
        font-family:inherit;font-size:14px}
  button{margin-top:12px;background:#89b4fa;color:#11111b;border:0;padding:9px 18px;
         font-family:inherit;font-weight:bold;cursor:pointer}
  button:hover{background:#b4befe}
</style></head><body>
<form method="post" action="/login">
  <h3>pixel-stream</h3>
  <div class="err">${err}</div>
  <input name="token" type="password" placeholder="AUTH token" autofocus autocomplete="current-password">
  <div><button type="submit">Sign in</button></div>
</form></body></html>`;
}

/**
 * Register viewer session-auth: a urlencoded body parser, the `POST /login`
 * route (token in the body), and an HTML gate that shows the login page when
 * there is no valid session. Static assets pass through.
 */
export function registerViewerAuth(app: FastifyInstance, token: string): void {
  // Parse HTML form posts (application/x-www-form-urlencoded) — Fastify only
  // handles JSON/text by default. No extra dependency.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_req, body, done) => {
      try {
        done(null, Object.fromEntries(new URLSearchParams(body as string)));
      } catch (err) {
        done(err as Error);
      }
    },
  );

  // Login: token in the POST body (never in the URL).
  app.post('/login', (req, reply) => {
    const submitted = ((req.body as Record<string, unknown> | undefined)?.token ?? '') as string;
    if (tokenEquals(String(submitted), token)) {
      reply.header('set-cookie', sessionCookie(createSession()));
      reply.code(303).header('location', '/').send(); // POST→GET (303 See Other)
      return;
    }
    reply.code(401).type('text/html').send(loginHtml('Invalid token.'));
  });

  // Gate the document (SPA entry) — path-based, independent of the Accept header.
  // Static assets (have an extension) plus /ws, /api, /health, /login pass
  // through; /ws checks the session itself.
  app.addHook('onRequest', async (req, reply) => {
    let url: URL;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return;
    }
    const p = url.pathname;
    const isAsset =
      p.startsWith('/assets/') ||
      /\.(js|mjs|css|png|jpe?g|gif|svg|ico|webp|woff2?|ttf|map|json|webmanifest)$/i.test(p);
    const isApi = p === '/ws' || p === '/health' || p === '/login' || p.startsWith('/api/');
    const needsAuth = req.method === 'GET' && !isAsset && !isApi; // '/' + SPA routes + *.html
    if (needsAuth && !isValidSession(req.headers.cookie)) {
      reply.code(200).type('text/html').send(loginHtml());
      return reply;
    }
  });
}
