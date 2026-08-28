/**
 * Everything about single sign-on that an admin may change from inside the app, and the
 * validation that makes each field safe to accept from an HTTP request.
 *
 * Two groups, in two `settings` rows:
 *
 *  • **Connection** — issuer, client id, redirect URI, and the scopes asked for. These decide
 *    WHICH directory this world trusts and WHAT it is asked about, so they were environment-only
 *    at first and are editable here by explicit request. What makes that safe enough to ship is
 *    the rule below about the client secret plus the validation in this file; what it costs is
 *    written down in AGENTS.md § Accounts, because it is a real widening of what an admin session
 *    can do.
 *
 *    Scopes carry one consequence that is worth stating where it can be read rather than
 *    discovered: they decide which CLAIMS come back, and the roles claim is what
 *    `PIXEL_OIDC_ADMIN_ROLE` reads. Drop the scope that carries it and the next sign-in sees a
 *    user with no roles — which is indistinguishable from a user who lost them, so admin is
 *    revoked (all but the last usable one, which `syncAdminRole` refuses to touch). The panel says
 *    so beside the field; nothing here can tell the two apart, so nothing here tries.
 *  • **Presentation** — the button's label, whether it is offered, whether an ungated navigation
 *    goes straight to the provider. None of these can grant access.
 *
 * **The client secret is never editable and never sent to a directory the environment did not
 * name.** It stays in `PIXEL_OIDC_CLIENT_SECRET`, and `config.ts` drops it from the effective
 * configuration as soon as the issuer or the client id is overridden here. That single rule is
 * what keeps an editable issuer from being a way to *exfiltrate* the secret: without it, pointing
 * the issuer at a server you control and waiting for the next login would POST the secret
 * straight to it. With it, an overridden connection is a public client — PKCE only — which is a
 * perfectly ordinary Zitadel application type, and the admin panel says so on the page.
 *
 *  • **The admin role** — the directory role that grants admin here. Editable for a reason worth
 *    writing down, because it looks like the field that should be locked hardest: an admin session
 *    can ALREADY promote anyone (`PATCH /admin/users/:id` takes a role), so keeping this one in the
 *    environment protected almost nothing while costing a redeploy every time a directory's role
 *    was named differently than a deployment guessed. What it does add over a manual promotion is
 *    automation, so it is audited like the connection, and the one refusal that matters stays in
 *    `syncAdminRole`: the last usable admin is never revoked, whatever the directory says.
 *
 * Everything else stays environment-only: the roles CLAIM (which claim carries the roles),
 * `CLAIM_EXISTING` and `END_SESSION`. The first is a wire detail no panel should have to explain,
 * and the other two decide whose existing local account a directory username may adopt.
 *
 * Both rows are read at request time. A settings row is one primary-key lookup (0.004 ms —
 * AGENTS.md § Memory has the measurement), so there is no cache to invalidate and a change takes
 * effect on the next request.
 */
import { appStore } from '../appStore.js';

const PRESENTATION_KEY = 'oidcPresentation';
const CONNECTION_KEY = 'oidcConnection';

/** Longest button label. The sign-in box is a fixed 26rem, and a label longer than this stops
 *  being a name and starts being a sentence. */
export const MAX_LABEL_LEN = 32;
/** Bounds on the connection fields. Generous — an issuer with a realm path is normal (Keycloak) —
 *  but bounded, because these are strings from a request that end up in a URL. */
const MAX_URL_LEN = 512;
const MAX_CLIENT_ID_LEN = 200;

/** The path this server actually serves the callback on (`oidc/routes.ts`). */
export const CALLBACK_PATH = '/auth/oauth/callback';

export interface OidcPresentation {
  /** Button label, or null to follow `PIXEL_OIDC_LABEL` (which itself defaults to "Zitadel"). */
  label: string | null;
  /** Offer the provider button on the sign-in screens (browser and desktop). */
  showButton: boolean;
  /** Send an ungated browser NAVIGATION straight to the provider. `/login` still shows the form. */
  autoRedirect: boolean;
}

/**
 * The connection fields an admin has overridden. An empty string means "not overridden — use the
 * environment", which is how a field is cleared: there is no separate delete.
 */
export interface OidcConnectionOverride {
  issuer: string;
  clientId: string;
  redirectUri: string;
  /** Space-separated scopes for the authorize request. `openid` is added by `config.ts` whether or
   *  not it is written here, so this cannot produce a request that is not an OIDC one. */
  scopes: string;
  /** The directory role that grants admin, or '' to follow `PIXEL_OIDC_ADMIN_ROLE`. */
  adminRole: string;
}

const PRESENTATION_DEFAULTS: OidcPresentation = { label: null, showButton: true, autoRedirect: false };
const CONNECTION_DEFAULTS: OidcConnectionOverride = { issuer: '', clientId: '', redirectUri: '', scopes: '', adminRole: '' };

/** Strip control characters, collapse whitespace, cap the length. The label is written into HTML
 *  (escaped where it is used) and into a DOM text node on the desktop, so this is about it being a
 *  sane one-line name, not about escaping. */
export function cleanLabel(raw: unknown): string {
  return String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_LABEL_LEN);
}

// ── Presentation ────────────────────────────────────────────────────────────

export function getOidcPresentation(): OidcPresentation {
  const stored = appStore.getSetting<Partial<OidcPresentation> | null>(PRESENTATION_KEY, null);
  if (!stored || typeof stored !== 'object') return { ...PRESENTATION_DEFAULTS };
  const label = typeof stored.label === 'string' ? cleanLabel(stored.label) : '';
  return {
    label: label || null,
    showButton: typeof stored.showButton === 'boolean' ? stored.showButton : PRESENTATION_DEFAULTS.showButton,
    autoRedirect: typeof stored.autoRedirect === 'boolean' ? stored.autoRedirect : PRESENTATION_DEFAULTS.autoRedirect,
  };
}

/**
 * Apply a presentation patch from the admin API.
 *
 * Only the three fields above are read, by name. That is what keeps this from becoming a way to
 * write the fields nobody asked to make editable: an unknown key has nowhere to go, rather than
 * being checked against a deny-list somebody would have to maintain.
 */
export function setOidcPresentation(patch: Record<string, unknown>): OidcPresentation {
  const current = getOidcPresentation();
  const next: OidcPresentation = {
    label: 'label' in patch ? cleanLabel(patch.label) || null : current.label,
    showButton: typeof patch.showButton === 'boolean' ? patch.showButton : current.showButton,
    autoRedirect: typeof patch.autoRedirect === 'boolean' ? patch.autoRedirect : current.autoRedirect,
  };
  appStore.setSetting(PRESENTATION_KEY, next);
  return next;
}

// ── Connection ──────────────────────────────────────────────────────────────

export function getOidcConnectionOverride(): OidcConnectionOverride {
  const stored = appStore.getSetting<Partial<OidcConnectionOverride> | null>(CONNECTION_KEY, null);
  if (!stored || typeof stored !== 'object') return { ...CONNECTION_DEFAULTS };
  // Re-validated on READ, not just on write: this row is a JSON blob in a table a restore or a
  // hand-edit can reach, and a bad value here would end up in a URL credentials travel to.
  const keep = (raw: unknown, check: (v: string) => string | null): string => {
    const value = typeof raw === 'string' ? raw.trim() : '';
    return value && check(value) === null ? value : '';
  };
  return {
    issuer: keep(stored.issuer, issuerError),
    clientId: keep(stored.clientId, clientIdError),
    redirectUri: keep(stored.redirectUri, redirectUriError),
    scopes: keep(stored.scopes, scopesError),
    adminRole: keep(stored.adminRole, adminRoleError),
  };
}

/** A URL whose host is the machine itself, where plain http is a development convenience rather
 *  than a mistake. Anything else must be https: tokens and an authorization code travel there. */
function isLoopback(url: URL): boolean {
  const h = url.hostname.toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1' || h.endsWith('.localhost');
}

/** null when the value is acceptable, else the message an admin should read. */
export function issuerError(raw: string): string | null {
  if (raw.length > MAX_URL_LEN) return `The issuer URL must be at most ${MAX_URL_LEN} characters.`;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'The issuer must be an absolute URL, e.g. https://auth.example.com.';
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url))) {
    return 'The issuer must use https (plain http is only allowed for localhost).';
  }
  // A path is legitimate (Keycloak's `/realms/<name>`); a query or a fragment is not — discovery
  // is fetched by appending to this string, and both would corrupt that URL.
  if (url.search || url.hash) return 'The issuer must not contain a query string or a fragment.';
  return null;
}

export function clientIdError(raw: string): string | null {
  if (raw.length > MAX_CLIENT_ID_LEN) return `The client id must be at most ${MAX_CLIENT_ID_LEN} characters.`;
  // Printable ASCII without whitespace: it goes into a query string and, for a confidential
  // client, into an HTTP Basic header.
  if (!/^[\x21-\x7e]+$/.test(raw)) return 'The client id must be printable ASCII with no spaces.';
  return null;
}

export function redirectUriError(raw: string): string | null {
  if (raw.length > MAX_URL_LEN) return `The redirect URI must be at most ${MAX_URL_LEN} characters.`;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `The redirect URI must be an absolute URL ending in ${CALLBACK_PATH}.`;
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url))) {
    return 'The redirect URI must use https (plain http is only allowed for localhost).';
  }
  // The path is not a matter of taste: it is the route this server serves the callback on, so any
  // other path is a login that cannot complete. The HOST is deliberately not checked — behind a
  // proxy the public hostname is not something this process can know — and it does not need to be:
  // the provider only redirects to a URI registered WITH it, so a host nobody registered there
  // simply fails at the provider instead of receiving anything.
  if (url.pathname !== CALLBACK_PATH) return `The redirect URI's path must be exactly ${CALLBACK_PATH}.`;
  if (url.search || url.hash) return 'The redirect URI must not contain a query string or a fragment.';
  return null;
}

/**
 * Scopes, as RFC 6749 defines them: space-separated tokens of printable ASCII without `"` or `\`.
 * Checked rather than passed through because this string is written into the authorize URL, and a
 * space or a quote smuggled into a "token" would either split it or break out of the parameter.
 */
const MAX_SCOPES_LEN = 512;
const MAX_SCOPE_TOKENS = 20;
export function scopesError(raw: string): string | null {
  if (raw.length > MAX_SCOPES_LEN) return `The scopes must be at most ${MAX_SCOPES_LEN} characters.`;
  const tokens = raw.split(/\s+/).filter((t) => t !== '');
  if (tokens.length === 0) return 'Enter at least one scope, or leave the field empty to use the deployment\'s.';
  if (tokens.length > MAX_SCOPE_TOKENS) return `At most ${MAX_SCOPE_TOKENS} scopes.`;
  const bad = tokens.find((t) => !/^[\x21\x23-\x5b\x5d-\x7e]+$/.test(t));
  if (bad) return `"${bad.slice(0, 40)}" is not a valid scope (printable ASCII, no spaces, quotes or backslashes).`;
  return null;
}

/** The stored form: one space between tokens, duplicates dropped, order kept. */
function normalizeScopes(raw: string): string {
  return [...new Set(raw.split(/\s+/).filter((t) => t !== ''))].join(' ');
}

/**
 * A role name, as the directory spells it. Bounded and free of whitespace and control characters:
 * it is compared against what the provider sends, so a name with a stray space would silently
 * never match — which looks exactly like "the role is not arriving" and is the one failure this
 * whole area is hard to debug for.
 */
const MAX_ROLE_LEN = 64;
export function adminRoleError(raw: string): string | null {
  if (raw.length > MAX_ROLE_LEN) return `The role name must be at most ${MAX_ROLE_LEN} characters.`;
  if (!/^[\x21-\x7e]+$/.test(raw)) return 'The role name must be printable ASCII with no spaces.';
  return null;
}

export type ConnectionUpdate = { ok: true; connection: OidcConnectionOverride } | { ok: false; field: string; error: string };

/**
 * Apply a connection patch from the admin API.
 *
 * A field that is absent is left alone; an empty string clears the override and falls back to the
 * environment. A value that does not validate is REFUSED — the whole patch, so a half-applied
 * connection (a new issuer with the old client id) can never be what a mistake leaves behind.
 */
export function setOidcConnectionOverride(patch: Record<string, unknown>): ConnectionUpdate {
  const current = getOidcConnectionOverride();
  const next: OidcConnectionOverride = { ...current };
  const fields: Array<[keyof OidcConnectionOverride, (v: string) => string | null]> = [
    ['issuer', issuerError],
    ['clientId', clientIdError],
    ['redirectUri', redirectUriError],
    ['scopes', scopesError],
    ['adminRole', adminRoleError],
  ];
  for (const [field, check] of fields) {
    if (!(field in patch)) continue;
    const raw = typeof patch[field] === 'string' ? (patch[field] as string).trim() : '';
    if (raw === '') {
      next[field] = '';
      continue;
    }
    const error = check(raw);
    if (error) return { ok: false, field, error };
    // Trailing slashes are stripped from the issuer so the discovery URL is built the same way
    // whether or not somebody typed one; scopes are stored one-space-separated and deduped.
    next[field] = field === 'issuer' ? raw.replace(/\/+$/, '') : field === 'scopes' ? normalizeScopes(raw) : raw;
  }
  appStore.setSetting(CONNECTION_KEY, next);
  return { ok: true, connection: next };
}
