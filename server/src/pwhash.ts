/**
 * Password hashing shared by every credential in the system: user accounts,
 * password-locked Pixels rooms (zones), and password-locked conference monitors.
 * One self-describing scrypt scheme (`scrypt$N$r$p$salt$hash`) so a stored hash
 * carries its own parameters and we can migrate the cost later.
 */
import * as crypto from 'node:crypto';

// scrypt cost parameters (memory ≈ 128·N·r ≈ 16 MB, well within the default cap).
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 } as const;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

/** Verify a password against a self-describing `scrypt$N$r$p$salt$hash` string. */
export function verifyHash(stored: string | null | undefined, password: string): boolean {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts[0] !== 'scrypt' || parts.length !== 6) return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64');
  let actual: Buffer;
  try {
    actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
    });
  } catch {
    return false;
  }
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}
