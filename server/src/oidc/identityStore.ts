/**
 * The link between an identity provider's subject and a pixel-agents account.
 *
 * The `sub` claim is the identity, not the username and not the email: those are display facts a
 * user can change (and in Zitadel routinely do), while `sub` is immutable for the life of the
 * account at the provider. So one row per (provider, subject) says which local account a login
 * resolves to, and everything else in the claims is treated as a fresh display value on each
 * login rather than as a key.
 *
 * The row belongs to the account, so it cascades with it (see `schema/tables.ts`) — deleting a
 * user takes their provider link, and a re-created account with the same login id does NOT
 * inherit it.
 */
import { db } from '../db.js';
import { userChildDdl } from '../schema/tables.js';

interface Row {
  provider: string;
  subject: string;
  user_id: string;
}

class OauthIdentityStore {
  private readonly db = db;

  constructor() {
    this.db.exec(userChildDdl('oauth_identities'));
  }

  /** Which account this provider subject signs in as, if it has been linked. */
  userIdFor(provider: string, subject: string): string | undefined {
    const r = this.db
      .prepare('SELECT provider, subject, user_id FROM oauth_identities WHERE provider = ? AND subject = ?')
      .get(provider, subject) as Row | undefined;
    return r?.user_id;
  }

  /** Whether this account is already linked to some subject of this provider. Asked before an
   *  existing account is adopted: a second person's subject must not attach to an account that
   *  already belongs to somebody at the same provider. */
  isLinked(provider: string, userId: string): boolean {
    return (
      this.db
        .prepare('SELECT 1 AS one FROM oauth_identities WHERE provider = ? AND user_id = ?')
        .get(provider, userId) !== undefined
    );
  }

  link(provider: string, subject: string, userId: string): void {
    this.db
      .prepare('INSERT OR REPLACE INTO oauth_identities(provider, subject, user_id, created_at) VALUES(?,?,?,?)')
      .run(provider, subject, userId, Date.now());
  }
}

/** Process-wide singleton, like every other store here. */
export const oauthIdentityStore = new OauthIdentityStore();
export { OauthIdentityStore };
