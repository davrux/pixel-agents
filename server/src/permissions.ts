/**
 * Central authorization policy. All "may this user do X?" decisions live here so
 * the rule set is in one place and a richer role model later becomes a localised
 * change behind `can()` rather than edits scattered across request handlers.
 *
 * Pure (no DB / Colyseus imports): the caller injects the environment (whether
 * login is enforced + a zone-admin lookup), so this is trivially testable.
 *
 * Today there are effectively three tiers — user → zone admin (scoped) → global
 * admin — and a handful of capabilities. Open dev mode (no admin token) has no
 * accounts, so everyone may edit.
 */

export interface Principal {
  /** Stable login id; '' for an anonymous (open dev) viewer. */
  userId: string;
  /** Global admin: may do everything. */
  isAdmin: boolean;
  /** Account role. `user` may create + edit their own rooms. Absent → treated
   *  as `user` (backwards compatible). */
  role?: 'admin' | 'user';
}

/** A privileged action. `zone.edit` is scoped to a specific zone (pass ctx.zoneId). */
export type Capability =
  | 'gallery.edit' // shared avatar/NPC/furniture galleries
  | 'zone.create'
  | 'zone.delete'
  | 'zone.grantAdmin' // assign per-zone admins
  | 'zone.edit' // layout / arrival / rename / NPC spawn set of one zone
  | 'zone.managePrivacy' // toggle private + manage its ACL/invites — OWNER only, not zone-admins
  | 'zone.managePassword' // set/clear the zone's entry password — OWNER only, not zone-admins
  | 'zone.setOwner'; // take/transfer/clear ownership — GLOBAL ADMIN only, not even the current owner

export interface PolicyEnv {
  /** Whether login is enforced. False = open dev mode (no accounts → full access). */
  authRequired: boolean;
  /** Whether `userId` is a designated admin of `zoneId`. */
  isZoneAdmin: (zoneId: string, userId: string) => boolean;
  /** The zone's owner (null if ownerless — see zoneStore.ts). Only read for
   *  zone.managePrivacy and zone.grantAdmin; other capabilities don't need it. */
  zoneOwner?: (zoneId: string) => string | null;
}

export function can(
  principal: Principal,
  capability: Capability,
  env: PolicyEnv,
  ctx: { zoneId?: string } = {},
): boolean {
  if (!env.authRequired) return true; // open dev: no accounts, everyone edits
  if (principal.isAdmin) return true; // global admin: everything
  // A `user` may create their own rooms (they become that zone's admin on creation).
  if (capability === 'zone.create') return !!principal.userId;
  // A zone admin (e.g. the room's creator) may edit or delete THAT zone.
  if (capability === 'zone.edit' || capability === 'zone.delete') {
    return !!principal.userId && !!ctx.zoneId && env.isZoneAdmin(ctx.zoneId, principal.userId);
  }
  // Privacy/ACL/invite and the entry password are the OWNER's call, not any
  // zone-admin co-editor's — a co-editor can reshape the room but shouldn't
  // be able to lock people out of it or add strangers to its ACL.
  if (capability === 'zone.managePrivacy' || capability === 'zone.managePassword') {
    return !!principal.userId && !!ctx.zoneId && env.zoneOwner?.(ctx.zoneId) === principal.userId;
  }
  // Zone-admin grants are the owner's call too (plus global admins, above) — a
  // zone-admin co-editor can't deputize further co-editors.
  if (capability === 'zone.grantAdmin') {
    return !!principal.userId && !!ctx.zoneId && env.zoneOwner?.(ctx.zoneId) === principal.userId;
  }
  return false;
}
