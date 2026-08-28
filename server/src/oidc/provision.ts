/**
 * From a provider's claims to a local account — the only place that decides who a login IS.
 *
 * Three rules, in this order, and the order is the point:
 *
 *  1. **The link wins.** If this (provider, subject) has been seen before, that is the account,
 *     whatever the claims now say the person is called. A renamed user keeps their avatar, their
 *     agent token, their zone grants and their position.
 *  2. **A login id is derived, never trusted as identity.** `user_id` is this world's owner key
 *     (agents resolve to it, personal rows are keyed by it), so it has to exist and be stable —
 *     but it is derived from `preferred_username` for readability only. Two different subjects
 *     never share one: a collision gets a suffix.
 *  3. **An existing account is adopted only under a stated rule.** `PIXEL_OIDC_CLAIM_EXISTING`
 *     (on by default) lets a first provider login take over the local account whose login id
 *     matches — which is what makes the migration of an existing world painless, since `eric` in
 *     the directory means the `eric` who already has an avatar here. It is a real trust
 *     statement: whoever can set usernames in the provider can then sign in as that local
 *     account. It is defensible because in this deployment the provider IS the company
 *     directory (and whoever administers it can already mint an account with the admin role
 *     anyway), and it is a switch so a deployment where that is not true can turn it off — then
 *     a colliding id yields `eric-2` and an admin can merge by hand. An account already linked
 *     to another subject of the same provider is NEVER adopted, switch or no switch.
 *
 * Roles: with `PIXEL_OIDC_ADMIN_ROLE` set, the provider is authoritative for the accounts it
 * signs in — the role is granted when the claim carries it and revoked when it does not, so
 * access is managed in one place. The one thing it may not do is revoke the LAST usable admin:
 * a misconfigured role mapping would otherwise leave a world nobody can administer, and the
 * fix would need the very admin panel it just closed.
 */
import * as crypto from 'node:crypto';

import { normalizeLoginId, userStore } from '../userStore.js';
import { oauthIdentityStore } from './identityStore.js';

import type { OidcConfig } from './config.js';

/** The claims this server reads. Everything else in a userinfo response is ignored. */
export interface OidcClaims {
  sub: string;
  preferredUsername: string;
  email: string;
  name: string;
  roles: string[];
}

/** Provider key stored beside the subject. One provider today; the column exists so a second
 *  one does not need a migration (and cannot collide with this one's subjects). */
export const PROVIDER = 'oidc';

/** Bound on anything read out of a claim before it is stored or compared. */
const MAX_CLAIM_LEN = 256;

const asString = (v: unknown): string => (typeof v === 'string' ? v.trim().slice(0, MAX_CLAIM_LEN) : '');

/**
 * Read the claims out of a userinfo (or ID token) payload.
 *
 * Roles arrive in two shapes and both are real: Zitadel's project-roles claim is an OBJECT keyed
 * by role name (`{ "pixel-admin": { "orgid": "domain" } }`), while a plain `groups`/`roles` claim
 * is an array of strings. Anything else yields no roles rather than an error — a login must not
 * fail because a claim has an unexpected shape; it just does not grant admin.
 */
export function readClaims(payload: unknown, cfg: OidcConfig): OidcClaims | { error: string } {
  if (typeof payload !== 'object' || payload === null) return { error: 'The identity provider returned no profile.' };
  const p = payload as Record<string, unknown>;
  const sub = asString(p.sub);
  if (!sub) return { error: 'The identity provider returned no subject for this user.' };

  const raw = p[cfg.rolesClaim];
  let roles: string[] = [];
  if (Array.isArray(raw)) roles = raw.filter((r): r is string => typeof r === 'string');
  else if (typeof raw === 'object' && raw !== null) roles = Object.keys(raw as Record<string, unknown>);
  roles = roles.map((r) => r.trim().slice(0, MAX_CLAIM_LEN)).filter((r) => r !== '').slice(0, 100);

  const given = asString(p.given_name);
  const family = asString(p.family_name);
  return {
    sub,
    preferredUsername: asString(p.preferred_username),
    email: asString(p.email),
    name: asString(p.name) || [given, family].filter((s) => s !== '').join(' '),
    roles,
  };
}

/**
 * The login id a set of claims suggests, before collisions are dealt with.
 *
 * `preferred_username` is Zitadel's login name, which is often `someone@org.example` — the local
 * part is the readable half and the whole string would eat most of the 32-character budget. The
 * last resort is derived from the subject, so an account is always creatable even for a user
 * whose directory entry has neither a username nor an email.
 */
export function deriveLoginId(claims: OidcClaims): string {
  const localPart = (s: string): string => (s.includes('@') ? s.slice(0, s.indexOf('@')) : s);
  for (const candidate of [localPart(claims.preferredUsername), localPart(claims.email)]) {
    const id = normalizeLoginId(candidate);
    if (id) return id;
  }
  return `oidc-${crypto.createHash('sha256').update(claims.sub).digest('hex').slice(0, 12)}`;
}

/** A free login id near `base`: `base`, then `base-2` … `base-9`, then a random suffix. */
function freeLoginId(base: string): string {
  if (!userStore.exists(base)) return base;
  for (let n = 2; n <= 9; n++) {
    const id = normalizeLoginId(`${base.slice(0, 30)}-${n}`);
    if (id && !userStore.exists(id)) return id;
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    const id = normalizeLoginId(`${base.slice(0, 25)}-${crypto.randomBytes(3).toString('hex')}`);
    if (id && !userStore.exists(id)) return id;
  }
  throw new Error(`no free login id near "${base}"`);
}

export type ProvisionResult = { userId: string; created: boolean } | { error: string; status?: number };

/**
 * Resolve (and if necessary create) the account these claims sign in as.
 *
 * Everything here is decided server-side from claims that came back over TLS from the token and
 * userinfo endpoints — never from anything the browser carried. The caller's only input is the
 * authorization code it exchanged.
 */
export function resolveOidcUser(claims: OidcClaims, cfg: OidcConfig): ProvisionResult {
  const linked = oauthIdentityStore.userIdFor(PROVIDER, claims.sub);
  let userId = linked && userStore.exists(linked) ? linked : undefined;
  let created = false;

  if (!userId) {
    const base = deriveLoginId(claims);
    const existing = userStore.get(base);
    const adoptable = existing && cfg.claimExisting && !oauthIdentityStore.isLinked(PROVIDER, existing.userId);
    if (adoptable) {
      userId = existing.userId;
      console.log(`[oidc] linked provider subject to existing account "${userId}" (login id matched)`);
    } else {
      const id = freeLoginId(base);
      userId = userStore.createProvisionedUser(id, { username: claims.name }).userId;
      created = true;
      console.log(`[oidc] provisioned account "${userId}"${id === base ? '' : ` (login id "${base}" was taken)`}`);
    }
    oauthIdentityStore.link(PROVIDER, claims.sub, userId);
  }

  const user = userStore.get(userId);
  if (!user) return { error: 'Could not create an account for this login.', status: 500 };
  // Checked after the account is resolved, and reported as its own thing: a suspension has to
  // hold against every way in, not just against the password form.
  if (user.disabled) return { error: 'This account has been disabled.', status: 403 };

  // The display name follows the directory: it is the provider's to own, and a user who fixes
  // their name there expects it to change here. Only when the provider offers one.
  if (claims.name && claims.name !== user.username) userStore.setUsername(user.userId, claims.name);

  syncAdminRole(user.userId, claims, cfg);
  return { userId: user.userId, created };
}

/** Grant or revoke admin from the provider's roles — see the note at the top of this file. */
function syncAdminRole(userId: string, claims: OidcClaims, cfg: OidcConfig): void {
  if (!cfg.adminRole) return; // The provider says nothing about roles: leave the local flag alone.
  const shouldBeAdmin = claims.roles.includes(cfg.adminRole);
  const user = userStore.get(userId);
  if (!user || user.isAdmin === shouldBeAdmin) return;
  if (!shouldBeAdmin && userStore.enabledAdminCount() <= 1) {
    console.warn(
      `[oidc] NOT revoking admin from "${userId}": it is the last usable admin account. ` +
        `Grant the "${cfg.adminRole}" role to somebody else first, or demote it in the admin panel.`,
    );
    return;
  }
  userStore.setAdmin(userId, shouldBeAdmin);
  console.log(`[oidc] ${shouldBeAdmin ? 'granted' : 'revoked'} admin for "${userId}" from the provider's roles`);
}

/**
 * Connect a provider identity to an account that already exists — the deliberate version of what
 * `PIXEL_OIDC_CLAIM_EXISTING` does automatically at a first login.
 *
 * The account comes from the session that started the flow (`PendingFlow.linkUserId`), never from
 * the claims or the callback, so this cannot be steered into attaching somebody's directory
 * identity to an account they did not choose. Three refusals, each for a different way that would
 * otherwise go wrong:
 *
 *  • the subject already signs in as ANOTHER account — linking would give two people one login;
 *  • this account is already connected to a DIFFERENT subject — silently replacing it would take
 *    somebody's access away without telling them; disconnect first;
 *  • the account is gone or disabled since the flow started.
 *
 * Roles are deliberately NOT synced here: a link is not a sign-in, and `PIXEL_OIDC_ADMIN_ROLE`
 * applies on the next one. Nor is the display name touched — the account has one already, and
 * connecting a login is not a rename.
 */
export function linkOidcAccount(userId: string, claims: OidcClaims, label: string): { ok: true; already: boolean } | { error: string } {
  const user = userStore.get(userId);
  if (!user) return { error: 'That account no longer exists.' };
  if (user.disabled) return { error: 'This account has been disabled.' };

  const owner = oauthIdentityStore.userIdFor(PROVIDER, claims.sub);
  if (owner === user.userId) return { ok: true, already: true };
  if (owner) return { error: `That ${label} account is already connected to another user here.` };

  const existing = oauthIdentityStore.linkFor(PROVIDER, user.userId);
  if (existing) {
    return { error: `This account is already connected to a different ${label} account. Disconnect that one first.` };
  }

  oauthIdentityStore.link(PROVIDER, claims.sub, user.userId);
  console.log(`[oidc] "${user.userId}" connected a ${label} identity to their account`);
  return { ok: true, already: false };
}

/**
 * Disconnect an account from its provider identity.
 *
 * Refused when it would leave the account with no way in at all: an account provisioned by the
 * provider has no password (`createProvisionedUser`), so removing the link would lock its owner
 * out of a world they can still see. Setting a password first is the way through, and the message
 * says so rather than just refusing.
 */
export function unlinkOidcAccount(userId: string, label: string): { ok: true } | { error: string } {
  const user = userStore.get(userId);
  if (!user) return { error: 'That account no longer exists.' };
  if (!oauthIdentityStore.linkFor(PROVIDER, user.userId)) {
    return { error: `This account is not connected to ${label}.` };
  }
  if (!user.hasPassword) {
    return {
      error: `Set a password first: ${label} is currently the only way into this account, so disconnecting it would lock you out.`,
    };
  }
  oauthIdentityStore.unlink(PROVIDER, user.userId);
  console.log(`[oidc] "${user.userId}" disconnected their ${label} identity`);
  return { ok: true };
}
