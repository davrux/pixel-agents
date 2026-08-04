/**
 * Thin authed client for the admin REST API (server/src/adminApi.ts). Same-origin
 * session cookie in the browser, desktop bearer token in the Electron app. The
 * server enforces admin-only; this is just transport + typing.
 */
import { serverHttpOrigin } from '../net/room.js';
import { isDesktop, desktop } from '../desktop/bridge.js';
import type { ArcadeGame } from '@pixel/shared';

export type Role = 'admin' | 'user';
export interface AdminUser {
  userId: string;
  username: string;
  role: Role;
  hasPassword: boolean;
  disabled: boolean;
}
export interface AdminZone {
  id: string;
  label: string;
  readOnly: boolean;
  locked: boolean;
  ownerId: string | null;
  ownerName: string | null;
  private: boolean;
}
export interface AdminZoneAclMember {
  userId: string;
  name: string;
  isAdmin: boolean;
}
export interface AdminZoneMembers {
  owner: AdminZoneAclMember | null;
  admins: AdminZoneAclMember[];
  acl: AdminZoneAclMember[];
}
export interface AdminMonitor {
  key: string;
  name: string;
  locked: boolean;
}
export interface AdminArcadeCabinet {
  key: string;
  name: string;
  /** This cabinet's own game list, or null if it follows the global default. */
  override: string[] | null;
  /** The resolved list actually offered right now (override ?? default ?? all). */
  effective: string[];
}
export interface AdminMeetingRoom {
  slug: string;
  ownerId: string;
  ownerName: string;
  label: string;
  createdAt: number;
  expiresAt: number;
  hasPassword: boolean;
  expired: boolean;
  ownerDisabled: boolean;
}

export interface ApiResult<T> {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
}

async function authHeaders(): Promise<Record<string, string>> {
  if (isDesktop()) {
    const token = await desktop().getToken();
    if (token) return { Authorization: `Bearer ${token}` };
  }
  return {};
}

async function req<T>(method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
  try {
    const headers: Record<string, string> = { ...(await authHeaders()) };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${serverHttpOrigin()}${path}`, {
      method,
      credentials: 'include',
      cache: 'no-store',
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = (await res.json().catch(() => ({}))) as T & { error?: string };
    return { ok: res.ok, status: res.status, data, error: res.ok ? undefined : (data as { error?: string }).error };
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

export const adminApi = {
  whoami: () => req<{ userId: string; name: string }>('GET', '/admin/whoami'),
  listUsers: () => req<{ users: AdminUser[] }>('GET', '/admin/users'),
  createUser: (loginId: string, password: string, role: Role) =>
    req<{ user: AdminUser }>('POST', '/admin/users', { loginId, password, role }),
  updateUser: (id: string, patch: { role?: Role; password?: string; disabled?: boolean }) =>
    req<{ user: AdminUser }>('PATCH', `/admin/users/${encodeURIComponent(id)}`, patch),
  deleteUser: (id: string) => req<{ ok: true }>('DELETE', `/admin/users/${encodeURIComponent(id)}`),

  listZones: () => req<{ zones: AdminZone[] }>('GET', '/admin/zones'),
  setZonePassword: (id: string, password: string) =>
    req<{ locked: boolean }>('PUT', `/admin/zone/${encodeURIComponent(id)}/password`, { password }),
  setZonePrivate: (id: string, priv: boolean) =>
    req<{ private: boolean }>('PUT', `/admin/zone/${encodeURIComponent(id)}/private`, { private: priv }),
  setZoneOwner: (id: string, ownerId: string | null) =>
    req<{ ownerId: string | null; ownerName: string | null }>('PUT', `/admin/zone/${encodeURIComponent(id)}/owner`, { ownerId }),
  zoneMembers: (id: string) => req<AdminZoneMembers>('GET', `/admin/zone/${encodeURIComponent(id)}/members`),
  addZoneAcl: (id: string, userId: string) =>
    req<{ ok: true }>('POST', `/admin/zone/${encodeURIComponent(id)}/acl`, { userId }),
  removeZoneAcl: (id: string, userId: string) =>
    req<{ ok: true }>('DELETE', `/admin/zone/${encodeURIComponent(id)}/acl/${encodeURIComponent(userId)}`),

  // Zone-admins (co-editors): callable by that zone's owner too, not just a
  // global admin (see server's zoneGrantAdminAuth) — shared by admin.html's
  // Zones tab and Pixels' own "Zone admins" panel (shared/zoneAdminsWidget.ts).
  listZoneAdmins: (id: string) => req<{ admins: AdminZoneAclMember[] }>('GET', `/admin/zone/${encodeURIComponent(id)}/admins`),
  grantZoneAdmin: (id: string, userId: string) =>
    req<{ ok: true }>('POST', `/admin/zone/${encodeURIComponent(id)}/admins`, { userId }),
  revokeZoneAdmin: (id: string, userId: string) =>
    req<{ ok: true }>('DELETE', `/admin/zone/${encodeURIComponent(id)}/admins/${encodeURIComponent(userId)}`),

  listMonitors: (zoneId: string) =>
    req<{ monitors: AdminMonitor[] }>('GET', `/admin/zone/${encodeURIComponent(zoneId)}/monitors`),
  setMonitorPassword: (zoneId: string, key: string, password: string) =>
    req<{ locked: boolean }>('PUT', `/admin/zone/${encodeURIComponent(zoneId)}/monitor`, { key, password }),

  listMeetingRooms: () => req<{ rooms: AdminMeetingRoom[] }>('GET', '/admin/meeting-rooms'),
  deleteMeetingRoom: (slug: string) =>
    req<{ ok: true }>('DELETE', `/admin/meeting-rooms/${encodeURIComponent(slug)}`),

  // Arcade: the game catalog itself is the same public route the in-game
  // launcher uses (no admin-only data in it — see server/src/index.ts).
  listArcadeGames: () => req<{ games: ArcadeGame[] }>('GET', '/arcade/catalog'),
  getArcadeDefaultGames: () => req<{ gameIds: string[] }>('GET', '/admin/arcade/default-games'),
  setArcadeDefaultGames: (gameIds: string[]) =>
    req<{ gameIds: string[] }>('PUT', '/admin/arcade/default-games', { gameIds }),
  listArcadeCabinets: (zoneId: string) =>
    req<{ cabinets: AdminArcadeCabinet[] }>('GET', `/admin/zone/${encodeURIComponent(zoneId)}/arcade-cabinets`),
  setArcadeCabinetGames: (zoneId: string, key: string, gameIds: string[] | null) =>
    req<{ effective: string[] }>('PUT', `/admin/zone/${encodeURIComponent(zoneId)}/arcade-cabinet`, { key, gameIds }),
};
