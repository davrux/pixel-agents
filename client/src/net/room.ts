import { Client, type Room } from 'colyseus.js';
import { DEFAULT_ZONE, WORLD_ROOM } from '@pixel/shared/protocol';
import { isDesktop, getConfiguredServerOrigin, desktop } from '../desktop/bridge';

/** HTTP(S) origin the network targets derive from. On desktop this is the
 *  configured server URL (from the preload IPC, held by the desktop bridge); on
 *  browser it is the `window.location`-derived origin — with the Vite dev
 *  special case where the page is on :5173 but the server is on :2567.
 *  Single source: `endpoint()` and every HTTP path below derive from this. */
export function getServerHttpOrigin(): string {
  if (isDesktop()) return getConfiguredServerOrigin() ?? '';
  const loc = window.location;
  if (loc.port === '5173') return `${loc.protocol}//${loc.hostname}:2567`;
  return loc.origin;
}

/** Resolve the Colyseus endpoint from the HTTP origin: http→ws, https→wss. */
function endpoint(): string {
  return getServerHttpOrigin().replace(/^http/, 'ws');
}

/** HTTP(S) origin of the server — where the login page / auth gate lives. */
export function serverHttpOrigin(): string {
  return getServerHttpOrigin();
}

/** Resolve once the server's /health responds OK — used to wait out a restart. */
export async function isServerUp(): Promise<boolean> {
  try {
    const res = await fetch(`${serverHttpOrigin()}/health`, { cache: 'no-store' });
    return res.ok;
  } catch {
    return false;
  }
}

/** Existing voxel world ids (so the client can validate a persisted "last world" before
 *  connecting). Returns null if the list can't be fetched (server down / offline dev). */
export async function fetchVoxelWorlds(): Promise<string[] | null> {
  try {
    const res = await fetch(`${serverHttpOrigin()}/voxel/worlds`, { cache: 'no-store' });
    if (!res.ok) return null;
    const body = (await res.json()) as { worlds?: unknown };
    return Array.isArray(body.worlds) ? body.worlds.filter((w): w is string => typeof w === 'string') : null;
  } catch {
    return null;
  }
}

function errMsg(err: unknown): string {
  return ((err as { message?: string } | undefined)?.message ?? '').toLowerCase();
}

/** A password-locked zone rejected the join (needs the room password). */
export function isZoneLockedError(err: unknown): boolean {
  return errMsg(err).includes('zone-locked');
}
/** The account may not enter this room at all (e.g. a customer, not assigned). */
export function isForbiddenError(err: unknown): boolean {
  return errMsg(err).includes('forbidden');
}

/** Did the room reject the join because the session cookie is missing/invalid?
 *  Colyseus 0.16 maps ANY onAuth throw to ErrorCode.AUTH_FAILED (4215), so the
 *  more specific room-entry rejections (locked / forbidden) are excluded here. */
export function isAuthError(err: unknown): boolean {
  const e = err as { code?: number; message?: string } | undefined;
  const msg = errMsg(err);
  if (isZoneLockedError(err) || isForbiddenError(err)) return false;
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

export async function connect(
  zone: string = DEFAULT_ZONE,
  arrive = false,
  opts: { zonePassword?: string; spectator?: boolean } = {},
): Promise<Room> {
  const client = new Client(endpoint());
  // Desktop only: attach the server-issued bearer token so colyseus.js adds
  // `Authorization: Bearer <sid>` to the matchmake POST (and `_authToken` to the
  // WS join query), reaching onAuth's bearer branch. Read once from the preload
  // IPC (in-memory, safeStorage-backed) — never persisted in the renderer. The
  // browser path sets no token and stays on the same-origin cookie flow.
  if (isDesktop()) {
    const token = await desktop().getToken();
    if (token) client.auth.token = token;
  }
  // `arrive` = the player actively entered this zone (menu switch or portal), so
  // the server should land them at the zone's arrival tile rather than where they
  // last stood. Resolved per-client in onJoin.
  // `zonePassword` is checked in onAuth for password-locked zones (ignored for
  // unlocked ones); admins / zone admins / assigned customers don't need it.
  // `spectator` = a non-spatial viewer (rooms portal): present for chat/voice/
  // meetings but not drawn as an avatar in the 2D/3D world.
  return client.joinOrCreate(WORLD_ROOM, { zone, arrive, zonePassword: opts.zonePassword, spectator: opts.spectator });
}
