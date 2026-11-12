/**
 * Per-account TOTP state (two-factor sign-in). One row per account in `user_totp`, which cascades
 * with the account (schema/tables.ts).
 *
 * A row exists in two states: an ENROLMENT (enabled = 0) holds a secret that has been shown to
 * the user but not yet proved by a code, and an ENABLED row is what `/login` asks for. Starting a
 * new enrolment replaces a pending one but never an enabled one — re-enrolling an account that
 * already has 2FA goes through disabling it first, which requires a code from the current app.
 *
 * Every check that consumes a factor (`verify`) is also a write: the accepted step is remembered
 * so the same code cannot be used twice, and a recovery code is removed when it is used.
 */
import { db } from './db.js';
import { userChildDdl } from './schema/tables.js';
import {
  generateRecoveryCodes,
  generateSecret,
  hashRecoveryCode,
  normalizeCode,
  normalizeRecoveryCode,
  verifyTotp,
} from './totp.js';

interface Row {
  user_id: string;
  secret: string;
  enabled: number;
  last_step: number;
  recovery: string;
  created_at: number;
}

export interface TotpStatus {
  enabled: boolean;
  /** An enrolment was started and not confirmed. */
  pending: boolean;
  recoveryCodesLeft: number;
}

function parseRecovery(json: string): string[] {
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v.filter((h): h is string => typeof h === 'string') : [];
  } catch {
    return [];
  }
}

class TotpStore {
  private readonly db = db;

  constructor() {
    this.db.exec(userChildDdl('user_totp'));
  }

  private row(userId: string): Row | undefined {
    return this.db.prepare('SELECT * FROM user_totp WHERE user_id = ?').get(userId) as Row | undefined;
  }

  isEnabled(userId: string): boolean {
    return this.row(userId)?.enabled === 1;
  }

  status(userId: string): TotpStatus {
    const r = this.row(userId);
    return {
      enabled: r?.enabled === 1,
      pending: r !== undefined && r.enabled !== 1,
      recoveryCodesLeft: r?.enabled === 1 ? parseRecovery(r.recovery).length : 0,
    };
  }

  /** Begin (or restart) an enrolment. Returns null if 2FA is already on. */
  beginEnrolment(userId: string, now = Date.now()): string | null {
    if (this.isEnabled(userId)) return null;
    const secret = generateSecret();
    this.db
      .prepare(
        `INSERT INTO user_totp(user_id, secret, enabled, last_step, recovery, created_at) VALUES(?,?,0,-1,'[]',?)
         ON CONFLICT(user_id) DO UPDATE SET secret = excluded.secret, enabled = 0, last_step = -1, recovery = '[]',
           created_at = excluded.created_at`,
      )
      .run(userId, secret, now);
    return secret;
  }

  /**
   * Finish an enrolment with a code from the app. Returns the plaintext recovery codes — the only
   * time they exist outside the user's hands — or null if there is no pending enrolment or the
   * code is wrong.
   */
  confirmEnrolment(userId: string, code: unknown, now = Date.now()): string[] | null {
    const r = this.row(userId);
    if (!r || r.enabled === 1) return null;
    const step = verifyTotp(r.secret, normalizeCode(code), now, r.last_step);
    if (step === null) return null;
    const codes = generateRecoveryCodes();
    this.db
      .prepare('UPDATE user_totp SET enabled = 1, last_step = ?, recovery = ? WHERE user_id = ? AND enabled = 0')
      .run(step, JSON.stringify(codes.map(hashRecoveryCode)), userId);
    return codes;
  }

  /** The secret of a PENDING enrolment, to render its QR code again. Never for an enabled row. */
  pendingSecret(userId: string): string | null {
    const r = this.row(userId);
    return r && r.enabled !== 1 ? r.secret : null;
  }

  /**
   * Check a second factor for an ENABLED account: a 6-digit app code, or one of the recovery codes.
   * Consumes what it accepts. `false` for an account without 2FA — a caller that asks is a caller
   * that expected one, so "no factor configured" must never read as "factor accepted".
   */
  verify(userId: string, raw: unknown, now = Date.now()): { ok: true; usedRecovery: boolean } | { ok: false } {
    const r = this.row(userId);
    if (!r || r.enabled !== 1) return { ok: false };
    const code = normalizeCode(raw);
    if (/^\d{6}$/.test(code)) {
      const step = verifyTotp(r.secret, code, now, r.last_step);
      if (step === null) return { ok: false };
      // Conditional on the step we read, so two concurrent logins with one code cannot both pass.
      const res = this.db
        .prepare('UPDATE user_totp SET last_step = ? WHERE user_id = ? AND last_step = ?')
        .run(step, userId, r.last_step);
      return Number(res.changes) === 1 ? { ok: true, usedRecovery: false } : { ok: false };
    }
    const norm = normalizeRecoveryCode(raw);
    if (norm.length !== 10) return { ok: false };
    const hashes = parseRecovery(r.recovery);
    const h = hashRecoveryCode(norm);
    const idx = hashes.indexOf(h);
    if (idx < 0) return { ok: false };
    hashes.splice(idx, 1);
    const res = this.db
      .prepare('UPDATE user_totp SET recovery = ? WHERE user_id = ? AND recovery = ?')
      .run(JSON.stringify(hashes), userId, r.recovery);
    return Number(res.changes) === 1 ? { ok: true, usedRecovery: true } : { ok: false };
  }

  /** Replace the recovery codes of an enabled account. Returns the new plaintext codes. */
  regenerateRecoveryCodes(userId: string): string[] | null {
    if (!this.isEnabled(userId)) return null;
    const codes = generateRecoveryCodes();
    this.db.prepare('UPDATE user_totp SET recovery = ? WHERE user_id = ?').run(JSON.stringify(codes.map(hashRecoveryCode)), userId);
    return codes;
  }

  /** Remove 2FA (or a pending enrolment) entirely. Returns whether a row existed. */
  disable(userId: string): boolean {
    const res = this.db.prepare('DELETE FROM user_totp WHERE user_id = ?').run(userId);
    return Number(res.changes) > 0;
  }
}

export const totpStore = new TotpStore();
