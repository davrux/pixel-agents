/**
 * Admin-only REST API backing the user-management page (admin.html). Every route
 * is gated on an admin session (cookie or desktop bearer, same store as the game).
 * State lives in the shared pixel.db via userStore + zoneStore, so changes take
 * effect on the game rooms too (entry/password gates read the DB live).
 *
 * Covers: user CRUD + role + password reset (the last admin can't be deleted or
 * demoted), per-zone entry passwords, and per-monitor call passwords. Passwords
 * are stored hashed (scrypt) — never returned.
 */
import express, { type Express, type Request, type Response } from 'express';

import { userIdFromCookie, userIdFromBearer } from './auth.js';
import { userStore, UserStore, isValidPassword, isRole, normalizeLoginId, type Role } from './userStore.js';
import { ZoneStore } from './zoneStore.js';
import { LayoutStore } from './layoutStore.js';
import { appStore } from './appStore.js';
import { meetingRoomStore } from './meetingRoomStore.js';
import { getCatalogEntry } from '@pixel/shared/office/layout/furnitureCatalog.js';
import type { PlacedFurniture } from '@pixel/shared/office/types.js';

// Fresh stores over the shared DB (reads/writes hit the same tables the rooms use).
// The layout store only needs DB-backed saved layouts here (where admins place
// monitors), so no bundled default is registered.
const zones = new ZoneStore();
const layouts = new LayoutStore(null);

export function registerAdminApi(app: Express): void {
  const json = express.json({ limit: '16kb' });

  const reqUserId = (req: Request): string | undefined =>
    userIdFromCookie(req.headers.cookie) ?? userIdFromBearer(req.headers.authorization);
  /** Resolve the caller and require they're an admin; else send 401/403. */
  const admin = (req: Request, res: Response): { userId: string } | null => {
    const uid = reqUserId(req);
    if (!uid) {
      res.status(401).json({ error: 'unauthorized' });
      return null;
    }
    if (!userStore.get(uid)?.isAdmin) {
      res.status(403).json({ error: 'forbidden' });
      return null;
    }
    return { userId: uid };
  };

  const userView = (u: { userId: string; username: string; role: Role; hasPassword: boolean; disabled: boolean }) => ({
    userId: u.userId,
    username: u.username,
    role: u.role,
    hasPassword: u.hasPassword,
    disabled: u.disabled,
  });

  // ── Users ──────────────────────────────────────────────────────────────────
  app.get('/admin/users', (req, res) => {
    if (!admin(req, res)) return;
    res.json({ users: userStore.list().map(userView) });
  });

  app.post('/admin/users', json, (req, res) => {
    if (!admin(req, res)) return;
    const body = (req.body ?? {}) as { loginId?: unknown; password?: unknown; role?: unknown };
    const loginId = normalizeLoginId(body.loginId);
    if (!loginId) return void res.status(400).json({ error: 'invalid login id' });
    if (userStore.exists(loginId)) return void res.status(409).json({ error: 'user exists' });
    if (!isValidPassword(body.password)) return void res.status(400).json({ error: 'weak password' });
    const role: Role = isRole(body.role) ? body.role : 'user';
    const user = userStore.createUser(loginId, body.password, { role });
    res.json({ ok: true, user: userView(user) });
  });

  app.patch('/admin/users/:id', json, (req, res) => {
    const me = admin(req, res);
    if (!me) return;
    const id = normalizeLoginId(req.params.id);
    const target = userStore.get(id);
    if (!target) return void res.status(404).json({ error: 'not found' });
    const body = (req.body ?? {}) as { role?: unknown; password?: unknown; disabled?: unknown };

    if (body.role !== undefined) {
      if (!isRole(body.role)) return void res.status(400).json({ error: 'invalid role' });
      // Never leave the system without an admin.
      if (target.isAdmin && body.role !== 'admin' && userStore.adminCount() <= 1) {
        return void res.status(409).json({ error: 'last admin' });
      }
      userStore.setRole(id, body.role);
    }
    if (body.password !== undefined) {
      if (!isValidPassword(body.password)) return void res.status(400).json({ error: 'weak password' });
      userStore.setPassword(id, body.password);
    }
    if (body.disabled !== undefined) {
      const disabled = !!body.disabled;
      if (disabled) {
        if (id === me.userId) return void res.status(409).json({ error: 'cannot disable yourself' });
        // Never leave the system without a usable admin (unlike adminCount(), a
        // disabled admin doesn't count as usable).
        if (target.isAdmin && userStore.enabledAdminCount() <= 1) {
          return void res.status(409).json({ error: 'last admin' });
        }
      }
      userStore.setDisabled(id, disabled);
    }
    res.json({ ok: true, user: userView(userStore.get(id)!) });
  });

  app.delete('/admin/users/:id', (req, res) => {
    const me = admin(req, res);
    if (!me) return;
    const id = normalizeLoginId(req.params.id);
    const target = userStore.get(id);
    if (!target) return void res.status(404).json({ error: 'not found' });
    if (id === me.userId) return void res.status(409).json({ error: 'cannot delete yourself' });
    if (target.isAdmin && userStore.adminCount() <= 1) return void res.status(409).json({ error: 'last admin' });
    userStore.deleteUser(id);
    // Clean up the user's global data (mirrors the /delete command). Zones are
    // deliberately left untouched — they aren't user-owned, only zone-admin
    // *grants* are (removeUserFromAllZones), so deleting an account never
    // deletes a zone.
    appStore.deletePlayerAvatar(id);
    appStore.clearCharPref(id);
    appStore.clearPlayerPref(id);
    zones.removeUserFromAllZones(id);
    meetingRoomStore.deleteAllByOwner(id);
    res.json({ ok: true });
  });

  // ── Zones (rooms) ────────────────────────────────────────────────────────────
  app.get('/admin/zones', (req, res) => {
    if (!admin(req, res)) return;
    const list = zones.list().map((z) => ({
      id: z.id,
      label: z.label,
      readOnly: !!z.readOnly,
      locked: !!z.locked,
    }));
    res.json({ zones: list });
  });

  // Set/clear a zone's entry password ('' → clears the lock).
  app.put('/admin/zone/:id/password', json, (req, res) => {
    if (!admin(req, res)) return;
    const id = req.params.id;
    if (!zones.has(id)) return void res.status(404).json({ error: 'no such zone' });
    const pw = (req.body ?? {}) as { password?: unknown };
    const password = typeof pw.password === 'string' ? pw.password : '';
    if (password && !isValidPassword(password)) return void res.status(400).json({ error: 'weak password' });
    zones.setZonePassword(id, password || null);
    res.json({ ok: true, locked: zones.zoneHasPassword(id) });
  });

  // ── Conference monitors (per zone) ────────────────────────────────────────
  // Monitors come from the zone's active saved layout (where admins place them in
  // the editor). Zones still on the pristine generated default list none here.
  app.get('/admin/zone/:id/monitors', (req, res) => {
    if (!admin(req, res)) return;
    const id = req.params.id;
    if (!zones.has(id)) return void res.status(404).json({ error: 'no such zone' });
    const locked = new Set(zones.lockedMonitors(id));
    const layout = layouts.getActiveLayout(id) as { furniture?: PlacedFurniture[] } | null;
    const monitors = (layout?.furniture ?? [])
      .filter((f) => getCatalogEntry(f.type)?.conference)
      .map((f) => ({ key: `${f.col},${f.row}`, name: f.name ?? '', locked: locked.has(`${f.col},${f.row}`) }));
    res.json({ monitors });
  });

  // Set/clear a monitor's call password (key = "col,row").
  app.put('/admin/zone/:id/monitor', json, (req, res) => {
    if (!admin(req, res)) return;
    const id = req.params.id;
    if (!zones.has(id)) return void res.status(404).json({ error: 'no such zone' });
    const body = (req.body ?? {}) as { key?: unknown; password?: unknown };
    const key = typeof body.key === 'string' && /^\d+,\d+$/.test(body.key) ? body.key : '';
    if (!key) return void res.status(400).json({ error: 'bad monitor key' });
    const password = typeof body.password === 'string' ? body.password : '';
    if (password && !isValidPassword(password)) return void res.status(400).json({ error: 'weak password' });
    zones.setMonitorPassword(id, key, password || null);
    res.json({ ok: true, locked: zones.monitorHasPassword(id, key) });
  });

  // ── Meeting rooms (ad-hoc /meet/<slug> video calls) ─────────────────────────
  // Overview + early end for rooms minted by the "Meeting Room Kiosk" furniture
  // (see meetingRoomStore.ts / SimRoom.ts meetingRoomCreate). Expired rows are
  // pruned automatically (hourly) but still listed here until then, so an admin
  // can see recently-expired rooms too, not just active ones.
  app.get('/admin/meeting-rooms', (req, res) => {
    if (!admin(req, res)) return;
    const rooms = meetingRoomStore.listAll().map((r) => {
      const owner = userStore.get(r.ownerId);
      return {
        slug: r.slug,
        ownerId: r.ownerId,
        ownerName: owner ? UserStore.displayName(owner) : r.ownerId, // owner account may since be deleted
        ownerDisabled: !!owner?.disabled,
        label: r.label,
        createdAt: r.createdAt,
        expiresAt: r.expiresAt,
        hasPassword: r.hasPassword,
        expired: meetingRoomStore.isExpired(r),
      };
    });
    res.json({ rooms });
  });

  // End a room early instead of waiting out its natural expiry.
  app.delete('/admin/meeting-rooms/:slug', (req, res) => {
    if (!admin(req, res)) return;
    if (!meetingRoomStore.delete(req.params.slug)) return void res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  });
}
