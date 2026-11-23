/**
 * Time-based one-time passwords (RFC 6238 over RFC 4226), plus the recovery codes that go with them.
 *
 * Written out rather than pulled from a library because the whole algorithm is an HMAC and a
 * truncation, and the parameters are fixed to the only ones every authenticator app agrees on:
 * SHA-1, six digits, a 30-second step. An app that is offered anything else (SHA-256, eight
 * digits) silently computes SHA-1 codes anyway in several popular implementations, and the user
 * then sees "wrong code" with nothing to point at — so those knobs deliberately do not exist.
 *
 * Pure functions only. Storage, replay protection and throttling live in `totpStore.ts` and
 * `auth.ts`; this file must stay testable against the RFC's own vectors.
 */
import crypto from 'node:crypto';

export const TOTP_DIGITS = 6;
export const TOTP_STEP_SEC = 30;
/** Steps accepted either side of now. One is the standard allowance for clock drift and for a
 *  code typed in the last second of its window; more widens what a shoulder-surfed code is worth. */
export const TOTP_DRIFT_STEPS = 1;
/** 160 bits, the size RFC 4226 recommends for HMAC-SHA1 (and what every app expects to scan). */
const SECRET_BYTES = 20;

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** Decode base32, ignoring case, spaces and padding. Returns null on any other character. */
export function base32Decode(s: string): Buffer | null {
  const clean = s.toUpperCase().replace(/[\s=]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const v = B32.indexOf(ch);
    if (v < 0) return null;
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateSecret(): string {
  return base32Encode(crypto.randomBytes(SECRET_BYTES));
}

/** RFC 4226 HOTP for one counter value. */
export function hotp(key: Buffer, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac('sha1', key).update(msg).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** TOTP_DIGITS;
  return String(bin).padStart(TOTP_DIGITS, '0');
}

export function stepAt(ms: number): number {
  return Math.floor(ms / 1000 / TOTP_STEP_SEC);
}

/** Strip what people type around a code (spaces, a dash in "123 456"). */
export function normalizeCode(raw: unknown): string {
  return String(raw ?? '')
    .slice(0, 64)
    .replace(/[\s-]/g, '');
}

/**
 * The step a code matches within the drift window, or null.
 *
 * Returns the STEP rather than a boolean so the caller can refuse a replay: a code is valid for
 * up to 90 s, and without remembering the last step used, anyone who saw it typed could use it
 * again inside that window. `afterStep` is that memory — only steps strictly later are accepted.
 * Every candidate is compared in constant time, and all of them are computed, so how long a
 * refusal takes does not say which neighbour was close.
 */
export function verifyTotp(secret: string, code: string, nowMs: number, afterStep = -1): number | null {
  const key = base32Decode(secret);
  if (!key || key.length === 0 || !/^\d{6}$/.test(code)) return null;
  const now = stepAt(nowMs);
  let hit: number | null = null;
  for (let d = -TOTP_DRIFT_STEPS; d <= TOTP_DRIFT_STEPS; d++) {
    const step = now + d;
    const ok = crypto.timingSafeEqual(Buffer.from(hotp(key, step)), Buffer.from(code));
    if (ok && step > afterStep && hit === null) hit = step;
  }
  return hit;
}

/**
 * The `otpauth://` URI an authenticator app scans. The issuer appears twice (label prefix and
 * parameter) because apps disagree on which one they read.
 */
export function otpauthUri(secret: string, issuer: string, account: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SEC),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// ── Recovery codes ──────────────────────────────────────────────────────────────────────────────

export const RECOVERY_CODE_COUNT = 10;
/** No 0/O/1/I/L: these get read off paper. */
const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

/** Ten codes of ten characters (~49 bits each), shown as `xxxxx-xxxxx`. */
export function generateRecoveryCodes(): string[] {
  const codes: string[] = [];
  for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
    let s = '';
    for (const b of crypto.randomBytes(10)) s += RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length];
    codes.push(`${s.slice(0, 5)}-${s.slice(5)}`);
  }
  return codes;
}

/** Canonical form for hashing and comparing: lowercase, separators gone. */
export function normalizeRecoveryCode(raw: unknown): string {
  return String(raw ?? '')
    .slice(0, 64)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * A recovery code is stored hashed, like a password, so a database copy does not hand out working
 * second factors. Plain SHA-256 rather than scrypt is deliberate: the codes are random with ~49
 * bits each, so there is no dictionary to slow down, and a login must check up to ten of them.
 */
export function hashRecoveryCode(code: string): string {
  return crypto.createHash('sha256').update(normalizeRecoveryCode(code)).digest('hex');
}
