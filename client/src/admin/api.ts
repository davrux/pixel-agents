/**
 * Thin authed client for the admin REST API (server/src/adminApi.ts). Same-origin
 * session cookie in the browser, desktop bearer token in the Electron app. The
 * server enforces admin-only; this is just transport + typing.
 */
import { serverHttpOrigin } from '../net/room.js';
import { isDesktop, desktop } from '../desktop/bridge.js';

export type Role = 'admin' | 'user' | 'customer';
export interface AdminUser {
  userId: string;
  username: string;
  role: Role;
  hasPassword: boolean;
  allowPixels: boolean;
}
export interface AdminZone {
  id: string;
  label: string;
  readOnly: boolean;
  locked: boolean;
  customers: number;
}
export interface AdminMonitor {
  key: string;
  name: string;
  locked: boolean;
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
  listUsers: () => req<{ users: AdminUser[] }>('GET', '/admin/users'),
  createUser: (loginId: string, password: string, role: Role, allowPixels = false) =>
    req<{ user: AdminUser }>('POST', '/admin/users', { loginId, password, role, allowPixels }),
  updateUser: (id: string, patch: { role?: Role; password?: string; allowPixels?: boolean }) =>
    req<{ user: AdminUser }>('PATCH', `/admin/users/${encodeURIComponent(id)}`, patch),
  deleteUser: (id: string) => req<{ ok: true }>('DELETE', `/admin/users/${encodeURIComponent(id)}`),

  listZones: () => req<{ zones: AdminZone[] }>('GET', '/admin/zones'),
  setZonePassword: (id: string, password: string) =>
    req<{ locked: boolean }>('PUT', `/admin/zone/${encodeURIComponent(id)}/password`, { password }),

  userRooms: (id: string) => req<{ assigned: string[] }>('GET', `/admin/users/${encodeURIComponent(id)}/rooms`),
  assignRoom: (id: string, zoneId: string, on: boolean) =>
    req<{ assigned: string[] }>('PUT', `/admin/users/${encodeURIComponent(id)}/rooms`, { zoneId, on }),

  listMonitors: (zoneId: string) =>
    req<{ monitors: AdminMonitor[] }>('GET', `/admin/zone/${encodeURIComponent(zoneId)}/monitors`),
  setMonitorPassword: (zoneId: string, key: string, password: string) =>
    req<{ locked: boolean }>('PUT', `/admin/zone/${encodeURIComponent(zoneId)}/monitor`, { key, password }),
};
