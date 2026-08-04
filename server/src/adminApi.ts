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
import { controlBus, KICK_EVENT } from './controlBus.js';
import { can, type Principal } from './permissions.js';
import { getCatalogEntry } from '@pixel/shared/office/layout/furnitureCatalog.js';
import type { PlacedFurniture } from '@pixel/shared/office/types.js';
import { getArcadeCatalog } from './arcadeCatalog.js';
import { getArcadeDefaultGames, setArcadeDefaultGames, resolveAllowedGames } from './arcadeDefaults.js';

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

  // Delegates to the shared `can()` policy (see permissions.ts) instead of
  // re-deriving "owner or global admin" by hand, so the REST and Colyseus
  // paths can't drift apart. Unlike routes gated on `admin()` above, this
  // allows a caller who ISN'T a global admin — that's the point: a zone
  // owner calls this from inside Pixels (fetch, not by visiting admin.html,
  // which still 403s non-admins at the page level), while the admin website
  // calls the very same route as a global admin.
  const zoneCapabilityAuth = (
    req: Request,
    res: Response,
    zoneId: string,
    capability: 'zone.grantAdmin' | 'zone.managePassword' | 'zone.manageMonitors' | 'zone.managePrivacy',
  ): { userId: string } | null => {
    const uid = reqUserId(req);
    if (!uid) {
      res.status(401).json({ error: 'unauthorized' });
      return null;
    }
    const principal: Principal = { userId: uid, isAdmin: !!userStore.get(uid)?.isAdmin };
    const env = { authRequired: true, isZoneAdmin: (z: string, u: string) => zones.isZoneAdmin(z, u), zoneOwner: (z: string) => zones.zoneOwner(z) };
    if (!can(principal, capability, env, { zoneId })) {
      res.status(403).json({ error: 'forbidden' });
      return null;
    }
    return { userId: uid };
  };
  const zoneGrantAdminAuth = (req: Request, res: Response, zoneId: string): { userId: string } | null =>
    zoneCapabilityAuth(req, res, zoneId, 'zone.grantAdmin');

  const userView = (u: { userId: string; username: string; role: Role; hasPassword: boolean; disabled: boolean }) => ({
    userId: u.userId,
    username: u.username,
    role: u.role,
    hasPassword: u.hasPassword,
    disabled: u.disabled,
  });

  // Who the caller is — the admin site has no other way to know its own
  // identity (it's a plain REST client, not a Colyseus connection with a
  // viewerIdentity message); backs the "Take ownership" quick action.
  app.get('/admin/whoami', (req, res) => {
    const me = admin(req, res);
    if (!me) return;
    const user = userStore.get(me.userId);
    res.json({ userId: me.userId, name: user ? UserStore.displayName(user) : me.userId });
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
      // Disconnect them from the game right now if they're online. auth.ts
      // already re-checks `disabled` on every HTTP request (no session-row
      // change needed there), but Colyseus only re-runs onAuth on a fresh
      // connection — an already-open WebSocket wouldn't otherwise notice.
      if (disabled) controlBus.emit(KICK_EVENT, id);
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
    // Kill any active session for this login id immediately — otherwise a
    // still-valid cookie/bearer session for it keeps working (see
    // auth.ts's userIdFromCookie), and would silently attach to a future
    // account recreated with the same login id instead of forcing re-login.
    appStore.deleteSessionsForUser(id);
    // Disconnect them from the game right now too, if they're online — same
    // reach as /kick. Without this their WebSocket stays open (Colyseus only
    // re-runs onAuth on a fresh connection, not on an already-open one) even
    // though their HTTP session is already dead.
    controlBus.emit(KICK_EVENT, id);
    // Clean up the user's global data (mirrors the /delete command). Zones the
    // user owned/could-admin/was-ACL'd-into are deliberately kept, not deleted —
    // removeUserFromAllZones() only clears their grants/ACL membership and nulls
    // out owner_id on zones they owned (they become ownerless, not gone).
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
    const list = zones.list().map((z) => {
      const owner = z.ownerId ? userStore.get(z.ownerId) : undefined;
      return {
        id: z.id,
        label: z.label,
        readOnly: !!z.readOnly,
        locked: !!z.locked,
        ownerId: z.ownerId ?? null,
        ownerName: owner ? UserStore.displayName(owner) : (z.ownerId ?? null),
        private: !!z.private,
      };
    });
    res.json({ zones: list });
  });

  // Admin override: force a zone private/public regardless of its owner (or
  // even if it has none — an ownerless zone can only be managed this way).
  app.put('/admin/zone/:id/private', json, (req, res) => {
    if (!admin(req, res)) return;
    const id = req.params.id;
    if (!zones.has(id)) return void res.status(404).json({ error: 'no such zone' });
    const body = (req.body ?? {}) as { private?: unknown };
    zones.setPrivate(id, !!body.private);
    res.json({ ok: true, private: zones.isPrivate(id) });
  });

  // Take/transfer/revoke ownership — the migration path for zones that predate
  // this feature, or lost their owner when that account was deleted (they stay
  // ownerless, not gone — see zoneStore.ts removeUserFromAllZones).
  app.put('/admin/zone/:id/owner', json, (req, res) => {
    if (!admin(req, res)) return;
    const id = req.params.id;
    if (!zones.has(id)) return void res.status(404).json({ error: 'no such zone' });
    const raw = (req.body as { ownerId?: unknown } | undefined)?.ownerId;
    const ownerId = raw == null || raw === '' ? null : normalizeLoginId(raw);
    if (ownerId && !userStore.get(ownerId)) return void res.status(400).json({ error: 'no such user' });
    zones.setOwner(id, ownerId);
    const owner = ownerId ? userStore.get(ownerId) : undefined;
    res.json({ ok: true, ownerId, ownerName: owner ? UserStore.displayName(owner) : ownerId });
  });

  // Everyone with a stake in a zone's access, together — same shape as the
  // in-game zoneMembers message, so the admin UI can show the full picture
  // (owner + zone-admins + ACL) instead of the ACL alone.
  const zoneMemberView = (uid: string) => {
    const u = userStore.get(uid);
    return { userId: uid, name: u?.username || uid, isAdmin: !!u?.isAdmin };
  };
  app.get('/admin/zone/:id/members', (req, res) => {
    if (!admin(req, res)) return;
    const id = req.params.id;
    if (!zones.has(id)) return void res.status(404).json({ error: 'no such zone' });
    const ownerId = zones.zoneOwner(id);
    res.json({
      owner: ownerId ? zoneMemberView(ownerId) : null,
      admins: zones.listZoneAdmins(id).map(zoneMemberView),
      acl: zones.listAcl(id).map(zoneMemberView),
    });
  });

  app.post('/admin/zone/:id/acl', json, (req, res) => {
    if (!admin(req, res)) return;
    const id = req.params.id;
    if (!zones.has(id)) return void res.status(404).json({ error: 'no such zone' });
    const targetId = normalizeLoginId((req.body as { userId?: unknown } | undefined)?.userId);
    if (!targetId || !userStore.get(targetId)) return void res.status(400).json({ error: 'no such user' });
    zones.aclAdd(id, targetId);
    res.json({ ok: true });
  });

  app.delete('/admin/zone/:id/acl/:userId', (req, res) => {
    if (!admin(req, res)) return;
    const id = req.params.id;
    if (!zones.has(id)) return void res.status(404).json({ error: 'no such zone' });
    zones.aclRemove(id, normalizeLoginId(req.params.userId));
    res.json({ ok: true });
  });

  // Zone-admins (co-editors): the one set of zone routes an owner may call
  // without being a global admin — see zoneGrantAdminAuth above. Shared by the
  // admin website's Zones tab and Pixels' own "Zone admins" panel (both call
  // this same route; see client/src/shared/zoneAdminsWidget.ts).
  app.get('/admin/zone/:id/admins', (req, res) => {
    const id = req.params.id;
    if (!zoneGrantAdminAuth(req, res, id)) return;
    if (!zones.has(id)) return void res.status(404).json({ error: 'no such zone' });
    res.json({ admins: zones.listZoneAdmins(id).map(zoneMemberView) });
  });

  app.post('/admin/zone/:id/admins', json, (req, res) => {
    const id = req.params.id;
    if (!zoneGrantAdminAuth(req, res, id)) return;
    if (!zones.has(id)) return void res.status(404).json({ error: 'no such zone' });
    const targetId = normalizeLoginId((req.body as { userId?: unknown } | undefined)?.userId);
    if (!targetId || !userStore.get(targetId)) return void res.status(400).json({ error: 'no such user' });
    zones.setZoneAdmin(id, targetId, true);
    res.json({ ok: true });
  });

  app.delete('/admin/zone/:id/admins/:userId', (req, res) => {
    const id = req.params.id;
    if (!zoneGrantAdminAuth(req, res, id)) return;
    if (!zones.has(id)) return void res.status(404).json({ error: 'no such zone' });
    zones.setZoneAdmin(id, normalizeLoginId(req.params.userId), false);
    res.json({ ok: true });
  });

  // Set/clear a zone's entry password ('' → clears the lock). Owner or global admin.
  app.put('/admin/zone/:id/password', json, (req, res) => {
    const id = req.params.id;
    if (!zoneCapabilityAuth(req, res, id, 'zone.managePassword')) return;
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
    const id = req.params.id;
    if (!zoneCapabilityAuth(req, res, id, 'zone.manageMonitors')) return;
    if (!zones.has(id)) return void res.status(404).json({ error: 'no such zone' });
    const locked = new Set(zones.lockedMonitors(id));
    const layout = layouts.getActiveLayout(id) as { furniture?: PlacedFurniture[] } | null;
    const monitors = (layout?.furniture ?? [])
      .filter((f) => getCatalogEntry(f.type)?.conference)
      .map((f) => ({ key: `${f.col},${f.row}`, name: f.name ?? '', locked: locked.has(`${f.col},${f.row}`) }));
    res.json({ monitors });
  });

  // Set/clear a monitor's call password (key = "col,row"). Owner or global admin.
  app.put('/admin/zone/:id/monitor', json, (req, res) => {
    const id = req.params.id;
    if (!zoneCapabilityAuth(req, res, id, 'zone.manageMonitors')) return;
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

  // ── Arcade cabinet game restrictions ────────────────────────────────────
  // Global admins only — unlike monitors/passwords, a zone owner does NOT get
  // this (see permissions.ts: no capability branch, so only the isAdmin
  // short-circuit in can() would ever allow it; simpler to just gate on the
  // plain admin() helper directly, same as /admin/zone/:id/owner).
  // Ids not in the current catalog are dropped — never persist a selection
  // the client couldn't actually offer.
  const cleanGameIds = (raw: unknown): string[] | null => {
    if (!Array.isArray(raw)) return null;
    const valid = new Set(getArcadeCatalog().map((g) => g.id));
    return raw.filter((x): x is string => typeof x === 'string' && valid.has(x));
  };

  // The default new cabinets follow. Resolved to a concrete list (never null)
  // for display — the admin UI edits/saves an explicit list; there's no
  // separate "unset" affordance beyond selecting every game.
  app.get('/admin/arcade/default-games', (req, res) => {
    if (!admin(req, res)) return;
    res.json({ gameIds: resolveAllowedGames(getArcadeDefaultGames()) });
  });

  app.put('/admin/arcade/default-games', json, (req, res) => {
    if (!admin(req, res)) return;
    const gameIds = cleanGameIds((req.body as { gameIds?: unknown } | undefined)?.gameIds);
    if (!gameIds) return void res.status(400).json({ error: 'bad gameIds' });
    setArcadeDefaultGames(gameIds);
    res.json({ ok: true, gameIds });
  });

  // Cabinets come from the zone's active saved layout (where admins place them
  // in the editor), same sourcing as Monitors above.
  app.get('/admin/zone/:id/arcade-cabinets', (req, res) => {
    if (!admin(req, res)) return;
    const id = req.params.id;
    if (!zones.has(id)) return void res.status(404).json({ error: 'no such zone' });
    const layout = layouts.getActiveLayout(id) as { furniture?: PlacedFurniture[] } | null;
    const cabinets = (layout?.furniture ?? [])
      .filter((f) => getCatalogEntry(f.type)?.arcade)
      .map((f) => {
        const key = `${f.col},${f.row}`;
        const override = zones.cabinetGamesOverride(id, key);
        return { key, name: f.name ?? '', override, effective: resolveAllowedGames(override) };
      });
    res.json({ cabinets });
  });

  // Set/clear one cabinet's own game list (key = "col,row"). null clears the
  // override so it goes back to following the default.
  app.put('/admin/zone/:id/arcade-cabinet', json, (req, res) => {
    if (!admin(req, res)) return;
    const id = req.params.id;
    if (!zones.has(id)) return void res.status(404).json({ error: 'no such zone' });
    const body = (req.body ?? {}) as { key?: unknown; gameIds?: unknown };
    const key = typeof body.key === 'string' && /^\d+,\d+$/.test(body.key) ? body.key : '';
    if (!key) return void res.status(400).json({ error: 'bad cabinet key' });
    let gameIds: string[] | null = null;
    if (body.gameIds !== null) {
      const cleaned = cleanGameIds(body.gameIds);
      if (!cleaned) return void res.status(400).json({ error: 'bad gameIds' });
      gameIds = cleaned;
    }
    zones.setCabinetGames(id, key, gameIds);
    res.json({ ok: true, effective: resolveAllowedGames(gameIds) });
  });
}
