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
}

/** A privileged action. `zone.edit` is scoped to a specific zone (pass ctx.zoneId). */
export type Capability =
  | 'gallery.edit' // shared avatar/NPC/furniture galleries
  | 'zone.create'
  | 'zone.delete'
  | 'zone.grantAdmin' // assign per-zone admins
  | 'zone.edit'; // layout / arrival / rename / NPC spawn set of one zone

export interface PolicyEnv {
  /** Whether login is enforced. False = open dev mode (no accounts → full access). */
  authRequired: boolean;
  /** Whether `userId` is a designated admin of `zoneId`. */
  isZoneAdmin: (zoneId: string, userId: string) => boolean;
}

export function can(
  principal: Principal,
  capability: Capability,
  env: PolicyEnv,
  ctx: { zoneId?: string } = {},
): boolean {
  if (!env.authRequired) return true; // open dev: no accounts, everyone edits
  if (principal.isAdmin) return true; // global admin: everything
  // The only capability a non-global-admin can hold is editing a zone they admin.
  if (capability === 'zone.edit') {
    return !!principal.userId && !!ctx.zoneId && env.isZoneAdmin(ctx.zoneId, principal.userId);
  }
  return false;
}
