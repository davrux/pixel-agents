import { Client, type Room } from 'colyseus.js';
import { WORLD_ROOM } from '@pixel/shared/protocol';

/** Resolve the Colyseus endpoint. In Vite dev the page is on :5173 while the
 *  server is on :2567; in production they share an origin. */
function endpoint(): string {
  const loc = window.location;
  const proto = loc.protocol === 'https:' ? 'wss' : 'ws';
  if (loc.port === '5173') return `${proto}://${loc.hostname}:2567`;
  return `${proto}://${loc.host}`;
}

/** HTTP(S) origin of the server — where the login page / auth gate lives. */
function serverHttpOrigin(): string {
  const loc = window.location;
  if (loc.port === '5173') return `${loc.protocol}//${loc.hostname}:2567`;
  return loc.origin;
}

/** Did the room reject the join because the session cookie is missing/invalid?
 *  Colyseus 0.16 maps an onAuth throw to ErrorCode.AUTH_FAILED (4215). */
export function isAuthError(err: unknown): boolean {
  const e = err as { code?: number; message?: string } | undefined;
  const msg = (e?.message ?? '').toLowerCase();
  return e?.code === 4215 || e?.code === 401 || msg.includes('unauthorized') || msg.includes('onauth');
}

/** Send the viewer to the server's login page (the auth gate serves the form). */
export function redirectToLogin(): void {
  window.location.href = `${serverHttpOrigin()}/`;
}

/** Log out: hit /logout (clears the session + cookie), which redirects to login. */
export function gotoLogout(): void {
  window.location.href = `${serverHttpOrigin()}/logout`;
}

export async function connect(): Promise<Room> {
  const client = new Client(endpoint());
  return client.joinOrCreate(WORLD_ROOM);
}
