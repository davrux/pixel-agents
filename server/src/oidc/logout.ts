/**
 * RP-initiated logout: ending the session at the provider too, not just here.
 *
 * Its own file so `auth.ts` can ask the question without importing the routes (which import
 * `auth.ts` for the login page — a cycle). Answers null in every case where the redirect would
 * be wrong, so the caller's fallback is always the plain local logout:
 *
 *  • the feature is off (the default: the provider must have the post-logout URL registered, and
 *    bouncing a user to a URL the provider refuses is a worse ending than a local logout);
 *  • this account has no provider identity — it is a local, password account;
 *  • the provider advertises no `end_session_endpoint`, or discovery is unreachable. Logging out
 *    must not depend on the provider being up.
 *
 * No `id_token_hint`: this server does not keep ID tokens (nothing needs one after the login —
 * see routes.ts), so the request carries `client_id` and `post_logout_redirect_uri` instead. A
 * provider may then ask the user to confirm, which is a fair trade for not storing a token whose
 * only use would be this.
 */
import { discover, oidcConfig } from './config.js';
import { oauthIdentityStore } from './identityStore.js';
import { PROVIDER } from './provision.js';

export async function providerLogoutUrl(userId: string): Promise<string | null> {
  const cfg = oidcConfig();
  if (!cfg || !cfg.endSession) return null;
  if (!oauthIdentityStore.isLinked(PROVIDER, userId)) return null;
  try {
    const endpoints = await discover(cfg);
    if (!endpoints.endSessionEndpoint) return null;
    const url = new URL(endpoints.endSessionEndpoint);
    url.searchParams.set('client_id', cfg.clientId);
    // Back to this server's own login page. Derived from the configured redirect URI rather than
    // from the request, for the same reason the redirect URI itself is: it has to be a URL the
    // provider has been told about, and a Host header is not that.
    url.searchParams.set('post_logout_redirect_uri', new URL('/login', cfg.redirectUri).toString());
    return url.toString();
  } catch (err) {
    console.warn(`[oidc] provider logout skipped: ${(err as Error)?.message}`);
    return null;
  }
}
