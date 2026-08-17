/**
 * Local TimeTracking configuration, stored exactly the way Mumble's is
 * (see ../mumble/settings.ts).
 *
 * Nothing here ever reaches the pixel-agents server: the server address and
 * username live in `userData/timetracking.json`, and the password goes through
 * Electron's safeStorage, which is backed by the OS keychain. The server only
 * ever learns the resulting coarse status ("working", "break", …) so it can put
 * a glyph over your character — never the credential that produced it.
 *
 * Unlike an account password we could hash, this one has to be replayable: the
 * API's access tokens live 300 seconds, so keeping a status current means being
 * able to log in again. That is precisely why it belongs in the OS keychain on
 * the user's own machine rather than in any server's database.
 */
import { app, safeStorage } from 'electron';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { TimeTrackingSettings } from '../ipc.js';

const SETTINGS_FILE = 'timetracking.json';
const SECRETS_FILE = 'timetracking-secrets.bin';

export const DEFAULT_TIMETRACKING_SETTINGS: TimeTrackingSettings = {
  baseUrl: '',
  username: '',
};

function settingsPath(): string {
  return join(app.getPath('userData'), SETTINGS_FILE);
}

function secretsPath(): string {
  return join(app.getPath('userData'), SECRETS_FILE);
}

/**
 * Normalise a user-typed server address to an origin API paths can be appended
 * to. Returns '' for anything that is not a plain http(s) URL — which also
 * keeps `file:`/`javascript:` and friends out of the fetch in client.ts.
 *
 * A trailing `/api` is trimmed: the vendor documents the endpoint as
 * `https://host/api`, so that is what people paste, and every path we build
 * already starts with `/api`.
 */
export function normalizeBaseUrl(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim().length === 0 || raw.length > 300) return '';
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return '';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
  const path = url.pathname.replace(/\/+$/, '').replace(/\/api$/i, '');
  return `${url.origin}${path}`;
}

export async function loadTimeTrackingSettings(): Promise<TimeTrackingSettings> {
  let raw: string;
  try {
    raw = await readFile(settingsPath(), 'utf8');
  } catch {
    return { ...DEFAULT_TIMETRACKING_SETTINGS };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<TimeTrackingSettings>;
    return {
      baseUrl: normalizeBaseUrl(parsed.baseUrl),
      username: str(parsed.username, '').slice(0, 200),
    };
  } catch {
    return { ...DEFAULT_TIMETRACKING_SETTINGS };
  }
}

export async function saveTimeTrackingSettings(patch: Partial<TimeTrackingSettings>): Promise<TimeTrackingSettings> {
  const current = await loadTimeTrackingSettings();
  const next: TimeTrackingSettings = {
    baseUrl: patch.baseUrl !== undefined ? normalizeBaseUrl(patch.baseUrl) : current.baseUrl,
    username:
      patch.username !== undefined ? str(patch.username, current.username).trim().slice(0, 200) : current.username,
  };
  await writeFile(settingsPath(), JSON.stringify(next), 'utf8');
  return next;
}

export function keychainAvailable(): boolean {
  return safeStorage.isEncryptionAvailable();
}

/** The stored password, or '' when there is none, the keychain is unavailable,
 *  or the blob cannot be decrypted (e.g. written under another OS key) — the
 *  user is then asked to re-enter it rather than being locked out. */
export async function loadTimeTrackingPassword(): Promise<string> {
  if (!keychainAvailable()) return '';
  let ciphertext: Buffer;
  try {
    ciphertext = await readFile(secretsPath());
  } catch {
    return '';
  }
  try {
    const parsed = JSON.parse(safeStorage.decryptString(ciphertext)) as { password?: unknown };
    return str(parsed.password, '');
  } catch {
    return '';
  }
}

/** Persist (or, with '', clear) the password. Throws when there is no keychain
 *  — the caller surfaces that rather than silently writing plaintext to disk. */
export async function saveTimeTrackingPassword(password: string): Promise<void> {
  if (!password) {
    await rm(secretsPath(), { force: true });
    return;
  }
  if (!keychainAvailable()) {
    throw new Error('no system keychain available; refusing to store the password in plaintext');
  }
  await writeFile(secretsPath(), safeStorage.encryptString(JSON.stringify({ password })));
}

/** Forget everything: used by "Disconnect" on the clock's settings view. */
export async function clearTimeTracking(): Promise<void> {
  await rm(secretsPath(), { force: true });
  await rm(settingsPath(), { force: true });
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}
