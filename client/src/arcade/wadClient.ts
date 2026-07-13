/**
 * Authenticated client for the server-wide "bring your own WAD" endpoints. Uses the
 * same-origin session cookie (browser) or the desktop bearer token. The server
 * enforces admin-only upload + logged-in download; this is just the transport.
 */
import { serverHttpOrigin } from '../net/room.js';
import { isDesktop, desktop } from '../desktop/bridge.js';

export interface WadInfo {
  name: string;
  title: string;
  iwad: string;
  size: number;
}

async function authHeaders(): Promise<Record<string, string>> {
  if (isDesktop()) {
    const token = await desktop().getToken();
    if (token) return { Authorization: `Bearer ${token}` };
  }
  return {};
}

/** List the WADs an admin has uploaded (empty on any error / not logged in). */
export async function listWads(): Promise<WadInfo[]> {
  try {
    const res = await fetch(`${serverHttpOrigin()}/arcade/wads`, {
      credentials: 'include',
      headers: await authHeaders(),
      cache: 'no-store',
    });
    if (!res.ok) return [];
    const j = (await res.json()) as { wads?: WadInfo[] };
    return Array.isArray(j.wads) ? j.wads : [];
  } catch {
    return [];
  }
}

/** Fetch a WAD's bytes from its download URL, or null on error. */
export async function fetchWadByUrl(url: string): Promise<Uint8Array | null> {
  try {
    const res = await fetch(url, { credentials: 'include', headers: await authHeaders() });
    if (!res.ok) return null;
    return new Uint8Array(await res.arrayBuffer());
  } catch {
    return null;
  }
}

/** Absolute download URL for an uploaded WAD (used as ArcadeGame.iwadUrl). */
export function wadUrl(name: string): string {
  return `${serverHttpOrigin()}/arcade/wad/${encodeURIComponent(name)}`;
}

/** Admin-only upload (server enforces). Returns {ok} or {ok:false,error}. */
export async function uploadWad(
  name: string,
  title: string,
  iwad: string,
  data: Uint8Array,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const url = `${serverHttpOrigin()}/arcade/wad/${encodeURIComponent(name)}?title=${encodeURIComponent(title)}&iwad=${encodeURIComponent(iwad)}`;
    // Copy into a plain ArrayBuffer (a definite BodyInit) — avoids the ArrayBufferLike
    // vs ArrayBuffer strictness on Uint8Array bodies.
    const ab = new ArrayBuffer(data.byteLength);
    new Uint8Array(ab).set(data);
    const res = await fetch(url, {
      method: 'PUT',
      credentials: 'include',
      headers: { ...(await authHeaders()), 'Content-Type': 'application/octet-stream' },
      body: ab,
    });
    if (res.ok) return { ok: true };
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: j.error ?? `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
