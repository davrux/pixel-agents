/**
 * Viewer token-login (cookie session). The browser logs in once with the shared
 * AUTH token (in the POST body, never the URL); the server stores a session in
 * SQLite and sets an opaque HttpOnly cookie. Same model as the original fork,
 * adapted to Express. Active only when PIXEL_TOKEN is set.
 */
import * as crypto from 'node:crypto';
import type { Express, Request, Response, NextFunction } from 'express';
import express from 'express';

import { appStore } from './appStore.js';

const VIEWER_COOKIE = 'pixel_stream_sid';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sanitizeUsername(raw: unknown): string {
  return String(raw ?? '')
    .trim()
    .replace(/[^\x21-\x7e]/g, '')
    .slice(0, 16);
}

/** Resolve the logged-in username for a request's cookie (or undefined). */
export function usernameFromCookie(cookieHeader: string | undefined): string | undefined {
  const sid = parseCookies(cookieHeader)[VIEWER_COOKIE];
  return appStore.getSession(sid)?.username || undefined;
}

export function hasValidSession(cookieHeader: string | undefined): boolean {
  const sid = parseCookies(cookieHeader)[VIEWER_COOKIE];
  return appStore.getSession(sid) !== undefined;
}

function loginHtml(err = ''): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>pixel-agents — Login</title>
<style>html,body{height:100%;margin:0}body{background:#14161c;color:#e6e9ef;
font-family:ui-monospace,monospace;display:flex;align-items:center;justify-content:center}
form{background:#1b1f2a;border:2px solid #3a4150;border-radius:8px;padding:24px 28px}
h3{margin:0 0 14px}.err{color:#ff8888;min-height:1.2em;margin:6px 0}
input{background:#14161c;color:#e6e9ef;border:2px solid #3a4150;border-radius:5px;padding:9px;width:300px;
font:14px ui-monospace,monospace;display:block;margin-bottom:8px}
button{margin-top:12px;background:#3a6df0;color:#fff;border:0;border-radius:5px;padding:10px 18px;
font:bold 14px ui-monospace,monospace;cursor:pointer}</style></head><body>
<form method="post" action="/login"><h3>pixel-agents</h3><div class="err">${err}</div>
<input name="username" type="text" placeholder="Username (matches your --user)" maxlength="16" autofocus autocomplete="username">
<input name="token" type="password" placeholder="AUTH token" autocomplete="current-password">
<div><button type="submit">Sign in</button></div></form></body></html>`;
}

/** Register login + the HTML auth gate. No-op semantics when token is empty. */
export function registerAuth(app: Express, token: string): void {
  app.use(express.urlencoded({ extended: false }));

  app.post('/login', (req: Request, res: Response) => {
    const submitted = String((req.body as Record<string, unknown>)?.token ?? '');
    const username = sanitizeUsername((req.body as Record<string, unknown>)?.username);
    if (tokenEquals(submitted, token)) {
      const sid = appStore.createSession(username);
      res.setHeader('Set-Cookie', `${VIEWER_COOKIE}=${sid}; Path=/; Max-Age=${SESSION_TTL_MS / 1000}; HttpOnly; SameSite=Lax`);
      res.redirect(303, '/');
      return;
    }
    res.status(401).type('html').send(loginHtml('Invalid token.'));
  });

  // Gate the SPA document; assets, /health, /login and Colyseus matchmaking pass
  // through (the room validates the session cookie itself via onAuth).
  app.use((req: Request, res: Response, next: NextFunction) => {
    const p = req.path;
    const isAsset = p.startsWith('/assets/') || /\.(js|mjs|css|png|jpe?g|gif|svg|ico|webp|woff2?|ttf|map|json|webmanifest)$/i.test(p);
    const isApi = p === '/health' || p === '/login' || p.startsWith('/matchmake');
    const needsAuth = req.method === 'GET' && !isAsset && !isApi;
    if (needsAuth && !hasValidSession(req.headers.cookie)) {
      res.status(200).type('html').send(loginHtml());
      return;
    }
    next();
  });
}
