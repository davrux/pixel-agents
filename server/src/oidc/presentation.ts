/**
 * The three questions every sign-in surface asks about single sign-on, answered in one place:
 * is there a button, what does it say, and does an ungated navigation go straight to the provider.
 *
 * Thin on purpose. The stored settings and their validation live in `adminSettings.ts` (which
 * knows nothing about the environment), the effective connection in `config.ts` (which merges the
 * two); this file only combines them into the answers `auth.ts` and `routes.ts` need, and exists
 * so neither of those has to know that "is there a button" is two facts rather than one.
 */
import { oidcConfig, envOidcConfig } from './config.js';
import { getOidcPresentation } from './adminSettings.js';

/** The label actually shown: the admin's override, else the environment's, else the default. */
export function oidcLabel(): string {
  return getOidcPresentation().label ?? envOidcConfig()?.label ?? 'Zitadel';
}

/**
 * Whether a sign-in surface should offer the provider: a complete configuration AND an admin who
 * has not hidden the button. Hiding it is presentation, not a gate — the routes stay open either
 * way, which is stated where it matters (`routes.ts`) so nobody mistakes this for access control.
 */
export function oidcButtonVisible(): boolean {
  return oidcConfig() !== null && getOidcPresentation().showButton;
}

/** Whether an ungated navigation should go to the provider instead of the login page. */
export function oidcAutoRedirect(): boolean {
  return oidcButtonVisible() && getOidcPresentation().autoRedirect;
}
