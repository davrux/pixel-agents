/**
 * The part of the single-sign-on setup an admin may change from inside the app.
 *
 * The split is the whole point of this file, and it is a security boundary, not a taste
 * judgement. Everything that decides **who gets in and what they get** stays in the environment,
 * where it takes a deployment to change:
 *
 *   issuer | client id | client secret | redirect URI | scopes | roles claim |
 *   admin role | CLAIM_EXISTING | END_SESSION
 *
 * A stolen admin session must not be able to point this world at another identity provider, widen
 * the scopes, rename the claim that grants admin, or let a directory username adopt an existing
 * account. Those are exactly the knobs that would turn one compromised session into a permanent
 * one, so they are not writable over HTTP at all — the admin API only ever READS them, and never
 * the secret (`hasClientSecret`, never the value).
 *
 * What is left is presentation, and it is genuinely useful to change without a restart:
 *
 *   • the button's LABEL — what the directory is called to the people using it;
 *   • whether the button is SHOWN at all — for a staged rollout, or while the provider is being
 *     fixed;
 *   • whether an anonymous navigation goes STRAIGHT to the provider instead of showing the login
 *     page, which is what an SSO-first deployment wants.
 *
 * None of the three can grant access: the routes are open either way (hiding a button is not a
 * gate — see `routes.ts`), and the auto-redirect only changes which of two pages an
 * unauthenticated NAVIGATION lands on. `/login` deliberately keeps rendering the password form
 * even with the redirect on, so the break-glass path AGENTS.md § Accounts insists on survives a
 * provider outage: it stays one URL away rather than one deployment away.
 *
 * Stored as one row in `settings` — a single global object, not a per-user blob (AGENTS.md
 * § Memory says why that distinction matters) — and read at request time, so a change takes
 * effect on the next page load with nothing to restart and no cache to invalidate.
 */
import { appStore } from '../appStore.js';
import { oidcConfig } from './config.js';

const KEY = 'oidcPresentation';

/** Longest button label. The sign-in box is a fixed 26rem, and a label longer than this stops
 *  being a name and starts being a sentence. */
export const MAX_LABEL_LEN = 32;

export interface OidcPresentation {
  /** Button label, or null to follow `PIXEL_OIDC_LABEL` (which itself defaults to "Zitadel"). */
  label: string | null;
  /** Offer the provider button on the sign-in screens (browser and desktop). */
  showButton: boolean;
  /** Send an ungated browser NAVIGATION straight to the provider. `/login` still shows the form. */
  autoRedirect: boolean;
}

const DEFAULTS: OidcPresentation = { label: null, showButton: true, autoRedirect: false };

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

export function getOidcPresentation(): OidcPresentation {
  const stored = appStore.getSetting<Partial<OidcPresentation> | null>(KEY, null);
  if (!stored || typeof stored !== 'object') return { ...DEFAULTS };
  const label = typeof stored.label === 'string' ? cleanLabel(stored.label) : '';
  return {
    label: label || null,
    showButton: typeof stored.showButton === 'boolean' ? stored.showButton : DEFAULTS.showButton,
    autoRedirect: typeof stored.autoRedirect === 'boolean' ? stored.autoRedirect : DEFAULTS.autoRedirect,
  };
}

/**
 * Apply a patch from the admin API.
 *
 * Only the three fields above are read, by name. That is what keeps this endpoint from becoming a
 * way to write the security-relevant configuration: an unknown key is not rejected with an error,
 * it simply has nowhere to go.
 */
export function setOidcPresentation(patch: Record<string, unknown>): OidcPresentation {
  const current = getOidcPresentation();
  const next: OidcPresentation = {
    label: 'label' in patch ? cleanLabel(patch.label) || null : current.label,
    showButton: typeof patch.showButton === 'boolean' ? patch.showButton : current.showButton,
    autoRedirect: typeof patch.autoRedirect === 'boolean' ? patch.autoRedirect : current.autoRedirect,
  };
  appStore.setSetting(KEY, next);
  return next;
}

/** The label actually shown: the admin's override, else the environment's, else the default. */
export function oidcLabel(): string {
  return getOidcPresentation().label ?? oidcConfig()?.label ?? 'Zitadel';
}

/** Whether a sign-in surface should offer the provider: configured AND not hidden by an admin. */
export function oidcButtonVisible(): boolean {
  return oidcConfig() !== null && getOidcPresentation().showButton;
}

/** Whether an ungated navigation should go to the provider instead of the login page. */
export function oidcAutoRedirect(): boolean {
  return oidcButtonVisible() && getOidcPresentation().autoRedirect;
}
