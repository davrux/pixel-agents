/**
 * Admin-only REST API backing the in-game admin overlay. Every route
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
import { ZoneMapStore } from './zoneMapStore.js';
import { appStore } from './appStore.js';
import { meetingRoomStore } from './meetingRoomStore.js';
import { controlBus, KICK_EVENT } from './controlBus.js';
import { can, type Principal } from './permissions.js';
import { effectiveAction, getCatalogEntry } from '@pixel/shared/office/layout/furnitureCatalog.js';
import type { OfficeLayout } from '@pixel/shared/office/types.js';
import { getArcadeCatalog } from './arcadeCatalog.js';
import { getArcadeDefaultGames, setArcadeDefaultGames, resolveAllowedGames } from './arcadeDefaults.js';
import { oidcConfig, envOidcConfig } from './oidc/config.js';
import {
  CALLBACK_PATH,
  MAX_LABEL_LEN,
  getOidcConnectionOverride,
  getOidcPresentation,
  setOidcConnectionOverride,
  setOidcPresentation,
} from './oidc/adminSettings.js';

// Fresh stores over the shared DB (reads/writes hit the same tables the rooms use).
// The layout store only needs DB-backed saved layouts here (where admins place
// monitors), so no bundled default is registered.
const zones = new ZoneStore();
const zoneMaps = new ZoneMapStore();

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
  // owner calls this from inside Pixels' own in-game panels as themselves,
  // while the admin overlay (only ever offered to global admins in the first
  // place) calls the very same route as a global admin.
  const zoneCapabilityAuth = (
    req: Request,
    res: Response,
    zoneId: string,
    capability: 'zone.grantAdmin' | 'zone.managePassword' | 'zone.managePrivacy',
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
      // A password reset should invalidate whatever session(s) let someone in
      // under the old one — otherwise a stolen cookie/bearer token keeps
      // working for its full TTL even after the password changes.
      appStore.deleteSessionsForUser(id);
      controlBus.emit(KICK_EVENT, id);
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
    // One DELETE. Sessions, preferences, stored positions, arcade saves, zone grants and
    // meeting rooms go with it: every table that belongs to an account declares
    // ON DELETE CASCADE (schema/tables.ts), which is what stopped this from being a list each
    // caller had to remember — `/delete` and this route had already drifted apart, and the
    // world had 22 rows nobody owned. Proven by userDataCascade.int.test.ts.
    userStore.deleteUser(id);
    // Disconnect them from the game right now too, if they're online — same
    // reach as /kick. Without this their WebSocket stays open (Colyseus only
    // re-runs onAuth on a fresh connection, not on an already-open one) even
    // though their HTTP session is already dead.
    controlBus.emit(KICK_EVENT, id);
    // The two things a foreign key cannot express. The avatar is one row of the shared `assets`
    // table, keyed (type='playerAvatar', name=userId) — a constraint cannot be conditional on
    // another column. And a zone the user OWNED must survive them: it becomes ownerless, which is
    // SET NULL rather than a cascade.
    appStore.deletePlayerAvatar(id);
    zones.disownZonesOf(id);
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
  // ownerless, not gone — see zoneStore.ts disownZonesOf).
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
    const layout = zoneMaps.get(id) as OfficeLayout | null;
    const cabinets = (layout?.furniture ?? [])
      .filter((f) => effectiveAction(f, getCatalogEntry(f.id))?.kind === 'arcade')
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
  // ── Single sign-on (OIDC / Zitadel) ──────────────────────────────────────
  //
  // Read everything, write only the presentation. The split is stated and enforced in
  // oidc/presentation.ts: issuer, client id, secret, redirect URI, scopes, roles claim, admin
  // role, CLAIM_EXISTING and END_SESSION decide who gets in and what they get, so they are
  // environment-only — a stolen admin session must not be able to repoint this world at another
  // identity provider or rename the claim that grants admin. They are shown here (an admin
  // configuring the button wants to see what it is pointed at) with ONE exception: the client
  // secret is reported as a boolean and never as a value, because "secrets stay on the server"
  // has no admin-shaped hole in it.
  app.get('/admin/oidc', (req, res) => {
    if (!admin(req, res)) return;
    const cfg = oidcConfig();
    const env = envOidcConfig();
    const override = getOidcConnectionOverride();
    const source = (o: string, e: string | undefined): 'admin' | 'env' | 'unset' => (o ? 'admin' : e ? 'env' : 'unset');
    res.json({
      configured: cfg !== null,
      presentation: getOidcPresentation(),
      maxLabelLength: MAX_LABEL_LEN,
      callbackPath: CALLBACK_PATH,
      // The editable connection: what is in force, where it came from, and what the environment
      // would say if the override were cleared (so "Reset to the deployment's value" can tell the
      // admin what they are resetting to).
      connection: {
        issuer: { value: cfg?.issuer ?? '', override: override.issuer, env: env?.issuer ?? '', source: source(override.issuer, env?.issuer) },
        clientId: { value: cfg?.clientId ?? '', override: override.clientId, env: env?.clientId ?? '', source: source(override.clientId, env?.clientId) },
        redirectUri: {
          value: cfg?.redirectUri ?? '',
          override: override.redirectUri,
          env: env?.redirectUri ?? '',
          source: source(override.redirectUri, env?.redirectUri),
        },
      },
      // The secret is reported as two booleans and never as a value: whether the environment holds
      // one, and whether it is actually IN USE — an overridden issuer or client id withholds it
      // (see oidc/adminSettings.ts), which turns the flow into a public/PKCE client and is the
      // single most surprising consequence of editing the connection here.
      secret: {
        configured: env?.clientSecret !== null && env?.clientSecret !== undefined,
        active: cfg?.clientSecret !== null && cfg?.clientSecret !== undefined,
      },
      // Still environment-only: each of these decides who becomes an admin, or whose local account
      // a directory username may adopt. Shown so an admin can check what the world is doing.
      environment: env
        ? {
            scopes: env.scopes,
            envLabel: env.label,
            adminRole: env.adminRole,
            rolesClaim: env.rolesClaim,
            claimExisting: env.claimExisting,
            endSession: env.endSession,
          }
        : null,
    });
  });

  // Two patches in one route, and the split is what makes it reviewable: the presentation fields
  // and the three connection fields are each read BY NAME (see oidc/adminSettings.ts), so a key
  // this endpoint does not know — `adminRole`, `claimExisting`, `clientSecret`, `scopes` — has
  // nowhere to go rather than being checked against a deny-list somebody has to maintain.
  //
  // A connection value that does not validate refuses the WHOLE request with the reason, so a
  // mistake can never leave half a connection behind (a new issuer with the old client id).
  app.put('/admin/oidc', json, (req, res) => {
    const caller = admin(req, res);
    if (!caller) return;
    const body = req.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return void res.status(400).json({ error: 'bad body' });
    }
    const patch = body as Record<string, unknown>;
    const touchesConnection = ['issuer', 'clientId', 'redirectUri'].some((k) => k in patch);
    if (touchesConnection) {
      const before = getOidcConnectionOverride();
      const result = setOidcConnectionOverride(patch);
      if (!result.ok) return void res.status(400).json({ error: result.error, field: result.field });
      // Audited: which directory this world trusts is now something a session can change, so every
      // change says who made it. The secret is not in here; the issuer and client id are not secret
      // (a browser sees both in the authorize URL).
      if (JSON.stringify(before) !== JSON.stringify(result.connection)) {
        console.log(
          `[oidc] connection changed by "${caller.userId}": ` +
            `issuer=${result.connection.issuer || '(environment)'} client=${result.connection.clientId || '(environment)'} ` +
            `redirect=${result.connection.redirectUri || '(environment)'}`,
        );
      }
    }
    const presentation = setOidcPresentation(patch);
    const cfg = oidcConfig();
    res.json({
      ok: true,
      presentation,
      configured: cfg !== null,
      secretActive: cfg?.clientSecret !== null && cfg?.clientSecret !== undefined,
    });
  });
}
