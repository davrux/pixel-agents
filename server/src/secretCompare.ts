/**
 * Constant-time comparison for anything a caller *presents* to prove it may act:
 * the admin token at login, the same token on a zone push, and whatever comes
 * next.
 *
 * One implementation on purpose. This existed twice — in auth.ts and in
 * zonePushApi.ts — and two copies of a security primitive is one copy that can
 * quietly grow a `===` shortcut, an early return on a length mismatch outside
 * the safe compare, or a missing `String()` on a non-string body field.
 *
 * `timingSafeEqual` throws on differing lengths, so the length check has to come
 * first; it leaks the *length* of the expected secret and nothing else, which is
 * the standard trade and not worth padding around.
 */
import crypto from 'node:crypto';

export function secretEquals(provided: unknown, expected: string): boolean {
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
