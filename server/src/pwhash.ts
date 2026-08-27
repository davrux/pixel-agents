/**
 * Password hashing shared by every credential in the system: user accounts,
 * password-locked Pixels rooms (zones), and password-locked conference monitors.
 * One self-describing scrypt scheme (`scrypt$N$r$p$salt$hash`) so a stored hash
 * carries its own parameters and we can migrate the cost later.
 */
import * as crypto from 'node:crypto';

// scrypt cost parameters (memory ≈ 128·N·r ≈ 16 MB, well within the default cap).
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 } as const;

/**
 * The most MEMORY a stored hash may ask for when it is verified — one bound, because that is
 * how scrypt actually charges: ≈ 128·N·r bytes.
 *
 * The scheme is self-describing so the cost can be migrated later, which means these numbers
 * come out of the database. Nothing but `hashPassword` writes them today, so this is not an
 * open hole; it is "bound anything you verify" applied to the one input here that is read
 * rather than received — a restored, hand-edited or corrupted row could otherwise make a single
 * login attempt ask for gigabytes and take the process down on somebody else's typo.
 *
 * 96 MB, and passed to scrypt as its own `maxmem`, because the default is 32 MB: at r = 8 that
 * is already exceeded by N = 32768, so a "generous" cap on N alone would have been fiction —
 * the migration it promised would have failed inside scrypt. This way the headroom is real
 * (4× today's N, or the same N at 4× the block size) and the ceiling is one number.
 */
const MAX_VERIFY_MEM = 96 * 1024 * 1024;
const MAX_VERIFY_P = 4;

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
  // Refuse a stored cost outside the bounds instead of handing it to scryptSync. A
  // non-numeric or absurd value fails the comparison rather than allocating for it.
  const cost = { N: Number(n), r: Number(r), p: Number(p), maxmem: MAX_VERIFY_MEM };
  const int = (v: number): boolean => Number.isInteger(v) && v >= 1;
  if (!int(cost.N) || !int(cost.r) || !int(cost.p) || cost.p > MAX_VERIFY_P) return false;
  // N must be a power of two (scrypt requires it) and the pair must fit the memory ceiling.
  if ((cost.N & (cost.N - 1)) !== 0) return false;
  if (128 * cost.N * cost.r > MAX_VERIFY_MEM) return false;
  let actual: Buffer;
  try {
    actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, cost);
  } catch {
    return false;
  }
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}
