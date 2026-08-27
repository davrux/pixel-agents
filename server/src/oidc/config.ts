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
 */

/** Everything this server needs to run a login, resolved from the environment. */
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

let resolved: OidcConfig | null | undefined;

/**
 * The configuration, or null when OIDC login is off. Memoized: every route asks, and the answer
 * cannot change without a restart.
 *
 * A half-configured provider (an issuer with no client id, or no redirect URI) is treated as OFF
 * with a loud error rather than as a fatal boot failure — password login still works, and an
 * operator mid-rollout gets a world they can still reach and a line telling them what is
 * missing.
 */
export function oidcConfig(): OidcConfig | null {
  if (resolved !== undefined) return resolved;
  resolved = readConfig();
  return resolved;
}

/** Test seam: forget the memoized answer (and the discovery cache) after changing the env. */
export function resetOidcConfig(): void {
  resolved = undefined;
  discovered = undefined;
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
    console.error(`[oidc] login disabled — missing ${missing.join(', ')}`);
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
  if (discovered && Date.now() - discoveredAt < DISCOVERY_TTL_MS) return discovered;
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
  discoveredAt = Date.now();
  return endpoints;
}
