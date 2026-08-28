/**
 * OpenID Connect login (Zitadel), read from the environment once and discovered once.
 *
 * This is the second way into an account, beside the login id + password in `auth.ts`. It is
 * deliberately additive: the admin token stays the break-glass path, because an identity
 * provider that is down, renamed or misconfigured must not be able to lock every admin out of
 * the world. Nothing here is reachable — no route is even registered — unless an issuer and a
 * client id are configured (see {@link oidcConfig}).
 *
 * **Why no OIDC library.** The authorization-code flow this server needs is one redirect and
 * one POST, and Node 26 has `fetch` and `node:crypto`. What a library would add is JWT
 * signature verification, and this flow does not need it: the code is exchanged by the SERVER,
 * over TLS, directly with the token endpoint named by the issuer's own discovery document, and
 * the claims are then read from `userinfo` with the resulting access token. So every claim this
 * server acts on came back over an authenticated channel from the issuer itself, never through
 * the browser. That is what lets `provision.ts` treat `sub` as identity without parsing a JWT.
 *
 * **What is checked rather than trusted.** The discovery document decides where credentials are
 * sent, so its endpoints must live on the issuer's own origin ({@link sameOrigin}); a document
 * that points the token endpoint somewhere else is refused, not followed. Every fetch is
 * bounded in time and size, because an unbounded read on the login path is a DoS.
 *
 * **Where each value comes from.** The environment is the baseline; three fields — issuer, client
 * id, redirect URI — may be overridden by an admin from the panel (`adminSettings.ts`), because
 * that was asked for. {@link oidcConfig} merges the two on every call, and it is the ONLY place
 * that decides what wins. One rule comes with it and is enforced here rather than described
 * anywhere: **an overridden issuer or client id drops the client secret**, so the secret the
 * environment holds can never be sent to a directory the environment did not name. An overridden
 * connection is therefore a public client and authenticates with PKCE alone.
 */

import { getOidcConnectionOverride } from './adminSettings.js';

/** Everything this server needs to run a login, resolved from the environment and the panel. */
export interface OidcConfig {
  /** Issuer URL, e.g. `https://auth.example.com` (Zitadel instance or custom domain). */
  issuer: string;
  clientId: string;
  /** A confidential client's secret, or null for a public client (PKCE only). */
  clientSecret: string | null;
  /** The exact redirect URI registered with the provider — never derived from a request. */
  redirectUri: string;
  scopes: string;
  /** What the sign-in button says. */
  label: string;
  /** Role that grants admin, or null to leave the admin flag alone. */
  adminRole: string | null;
  /** Claim carrying the roles (Zitadel: a project-roles object keyed by role name). */
  rolesClaim: string;
  /** May a first login adopt an existing account whose login id matches? See provision.ts. */
  claimExisting: boolean;
  /** Also end the session at the provider on /logout (RP-initiated logout). */
  endSession: boolean;
}

const env = (name: string): string => (process.env[name] ?? '').trim();
const flag = (name: string, def: boolean): boolean => {
  const v = env(name).toLowerCase();
  if (v === '') return def;
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
};

let resolvedEnv: OidcConfig | null | undefined;

/**
 * What the ENVIRONMENT alone says. Memoized — it cannot change without a restart — and exported
 * so the admin panel can show which values are the deployment's and which an admin has overridden.
 *
 * A half-configured provider (an issuer with no client id, or no redirect URI) is treated as
 * absent with a loud error rather than as a fatal boot failure. That is deliberate now in a second
 * way: with the connection editable, "the environment names nothing" is a legitimate state, and an
 * admin can complete it from the panel.
 */
export function envOidcConfig(): OidcConfig | null {
  if (resolvedEnv !== undefined) return resolvedEnv;
  resolvedEnv = readConfig();
  return resolvedEnv;
}

/**
 * The configuration actually in force: the environment with an admin's overrides applied, or null
 * when the three fields a login needs are not all present from one source or the other.
 *
 * Not memoized, on purpose — an admin changing the issuer has to take effect on the next request,
 * and the cost is two primary-key lookups in `settings` (0.004 ms each). The secret rule lives
 * here: overriding the issuer or the client id makes this a public client.
 */
export function oidcConfig(): OidcConfig | null {
  const env = envOidcConfig();
  const override = getOidcConnectionOverride();
  const issuer = override.issuer || env?.issuer || '';
  const clientId = override.clientId || env?.clientId || '';
  const redirectUri = override.redirectUri || env?.redirectUri || '';
  if (!issuer || !clientId || !redirectUri) return null;

  // The secret belongs to the client the ENVIRONMENT named. Point either half of that identity
  // somewhere else and it is withheld — see the note in the file header.
  const connectionIsEnvs = override.issuer === '' && override.clientId === '';
  return {
    issuer,
    clientId,
    clientSecret: connectionIsEnvs ? (env?.clientSecret ?? null) : null,
    redirectUri,
    scopes: env?.scopes ?? 'openid profile email',
    label: env?.label ?? 'Zitadel',
    adminRole: env?.adminRole ?? null,
    rolesClaim: env?.rolesClaim ?? 'urn:zitadel:iam:org:project:roles',
    claimExisting: env?.claimExisting ?? true,
    endSession: env?.endSession ?? false,
  };
}

/** Test seam: forget the memoized environment (and the discovery cache) after changing it. */
export function resetOidcConfig(): void {
  resolvedEnv = undefined;
  discovered = undefined;
  discoveredFor = '';
  discoveredAt = 0;
}

function readConfig(): OidcConfig | null {
  const issuer = env('PIXEL_OIDC_ISSUER').replace(/\/+$/, '');
  const clientId = env('PIXEL_OIDC_CLIENT_ID');
  const redirectUri = env('PIXEL_OIDC_REDIRECT_URI');
  if (!issuer && !clientId && !redirectUri) return null; // not configured at all: silence

  const missing: string[] = [];
  if (!issuer) missing.push('PIXEL_OIDC_ISSUER');
  if (!clientId) missing.push('PIXEL_OIDC_CLIENT_ID');
  if (!redirectUri) missing.push('PIXEL_OIDC_REDIRECT_URI');
  if (missing.length > 0) {
    // Not necessarily an error any more: an admin may fill these in from the panel. Said once, at
    // boot, so a deployment that MEANT to configure the environment still hears about it.
    console.warn(`[oidc] the environment names no complete provider (missing ${missing.join(', ')}) — the admin panel can supply the issuer, client id and redirect URI`);
    return null;
  }
  if (!/^https?:\/\//.test(issuer)) {
    console.error(`[oidc] login disabled — PIXEL_OIDC_ISSUER must be an absolute URL, got "${issuer}"`);
    return null;
  }
  if (!/^https?:\/\//.test(redirectUri)) {
    console.error(`[oidc] login disabled — PIXEL_OIDC_REDIRECT_URI must be an absolute URL, got "${redirectUri}"`);
    return null;
  }

  const scopes = env('PIXEL_OIDC_SCOPES') || 'openid profile email';
  return {
    issuer,
    clientId,
    clientSecret: env('PIXEL_OIDC_CLIENT_SECRET') || null,
    redirectUri,
    scopes: /\bopenid\b/.test(scopes) ? scopes : `openid ${scopes}`,
    label: env('PIXEL_OIDC_LABEL') || 'Zitadel',
    adminRole: env('PIXEL_OIDC_ADMIN_ROLE') || null,
    rolesClaim: env('PIXEL_OIDC_ROLES_CLAIM') || 'urn:zitadel:iam:org:project:roles',
    claimExisting: flag('PIXEL_OIDC_CLAIM_EXISTING', true),
    endSession: flag('PIXEL_OIDC_END_SESSION', false),
  };
}

/** Whether a "sign in with …" button should exist at all. */
export function oidcEnabled(): boolean {
  return oidcConfig() !== null;
}

/** The endpoints this flow uses, from the provider's discovery document. */
export interface OidcEndpoints {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  userinfoEndpoint: string;
  endSessionEndpoint: string | null;
}

/** Discovery is stable for the life of a deployment; re-read hourly so a rotated
 *  endpoint is picked up without a restart, and on every failure (nothing is cached). */
const DISCOVERY_TTL_MS = 60 * 60 * 1000;
let discovered: OidcEndpoints | undefined;
/** Which issuer the cached endpoints belong to. Keyed rather than time-only, because the issuer is
 *  editable now: a change has to take effect on the next login, not in up to an hour. */
let discoveredFor = '';
let discoveredAt = 0;

const FETCH_TIMEOUT_MS = 8000;
/** Enough for any real discovery document or userinfo response; refuses a hose. */
const MAX_JSON_BYTES = 256 * 1024;

/** A JSON fetch that cannot hang and cannot be made to allocate without bound. */
export async function fetchJsonBounded(url: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), cache: 'no-store' });
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_JSON_BYTES) throw new Error(`response from ${url} exceeds ${MAX_JSON_BYTES} bytes`);
  const text = new TextDecoder().decode(buf);
  if (!res.ok) {
    // The body often says exactly what is wrong (an unregistered redirect URI, a bad secret),
    // so it is worth surfacing — bounded, and never at a level a client can read.
    throw new Error(`${url} answered ${res.status}: ${text.slice(0, 400)}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${url} did not answer JSON`);
  }
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/**
 * The provider's endpoints, cached. Refuses a document whose endpoints live off the issuer's
 * origin: this is where the client secret and the authorization code are sent, so following a
 * redirection of that would hand credentials to whoever could influence the document.
 */
export async function discover(cfg: OidcConfig): Promise<OidcEndpoints> {
  if (discovered && discoveredFor === cfg.issuer && Date.now() - discoveredAt < DISCOVERY_TTL_MS) return discovered;
  const url = `${cfg.issuer}/.well-known/openid-configuration`;
  const doc = (await fetchJsonBounded(url)) as Record<string, unknown>;
  const str = (k: string): string => (typeof doc[k] === 'string' ? (doc[k] as string) : '');

  const endpoints: OidcEndpoints = {
    authorizationEndpoint: str('authorization_endpoint'),
    tokenEndpoint: str('token_endpoint'),
    userinfoEndpoint: str('userinfo_endpoint'),
    endSessionEndpoint: str('end_session_endpoint') || null,
  };
  for (const [name, value] of [
    ['authorization_endpoint', endpoints.authorizationEndpoint],
    ['token_endpoint', endpoints.tokenEndpoint],
    ['userinfo_endpoint', endpoints.userinfoEndpoint],
  ] as const) {
    if (!value) throw new Error(`${url} names no ${name}`);
    if (!sameOrigin(value, cfg.issuer)) {
      throw new Error(`${url} points ${name} at ${new URL(value).origin}, not at the issuer's own origin`);
    }
  }
  discovered = endpoints;
  discoveredFor = cfg.issuer;
  discoveredAt = Date.now();
  return endpoints;
}
