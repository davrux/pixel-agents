/**
 * Local Mumble configuration and certificate trust.
 *
 * Nothing here ever reaches the pixel-agents server: the connection details live
 * in `userData/mumble.json`, and the two secrets (server password, certificate
 * passphrase) go through Electron's safeStorage, which is backed by the OS
 * keychain. The client certificate itself stays wherever the user put it — we
 * only remember the path.
 */
import { BrowserWindow, app, safeStorage } from 'electron';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PeerCertificate } from 'node:tls';

import { ensureTrusted } from '../certTrust.js';
import type { MumbleSettings } from '../ipc.js';

const SETTINGS_FILE = 'mumble.json';
const SECRETS_FILE = 'mumble-secrets.bin';
/** A PKCS#12 identity is a few kB; anything larger is not one. */
const MAX_CERT_BYTES = 64 * 1024;

export const DEFAULT_MUMBLE_SETTINGS: MumbleSettings = {
  host: '',
  port: 64738,
  username: '',
  channel: '',
  certPath: null,
  autoConnect: false,
};

export interface MumbleSecrets {
  password: string;
  passphrase: string;
}

const EMPTY_SECRETS: MumbleSecrets = { password: '', passphrase: '' };

function settingsPath(): string {
  return join(app.getPath('userData'), SETTINGS_FILE);
}

function secretsPath(): string {
  return join(app.getPath('userData'), SECRETS_FILE);
}

export async function loadMumbleSettings(): Promise<MumbleSettings> {
  let raw: string;
  try {
    raw = await readFile(settingsPath(), 'utf8');
  } catch {
    return { ...DEFAULT_MUMBLE_SETTINGS };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<MumbleSettings>;
    return {
      host: str(parsed.host, ''),
      port: port(parsed.port),
      username: str(parsed.username, '').slice(0, 64),
      channel: str(parsed.channel, '').slice(0, 128),
      certPath: typeof parsed.certPath === 'string' && parsed.certPath ? parsed.certPath : null,
      autoConnect: parsed.autoConnect === true,
    };
  } catch {
    return { ...DEFAULT_MUMBLE_SETTINGS };
  }
}

export async function saveMumbleSettings(patch: Partial<MumbleSettings>): Promise<MumbleSettings> {
  const current = await loadMumbleSettings();
  const next: MumbleSettings = {
    host: patch.host !== undefined ? str(patch.host, current.host).trim().slice(0, 255) : current.host,
    port: patch.port !== undefined ? port(patch.port) : current.port,
    username:
      patch.username !== undefined ? str(patch.username, current.username).trim().slice(0, 64) : current.username,
    channel: patch.channel !== undefined ? str(patch.channel, current.channel).trim().slice(0, 128) : current.channel,
    certPath:
      patch.certPath !== undefined
        ? typeof patch.certPath === 'string' && patch.certPath
          ? patch.certPath
          : null
        : current.certPath,
    autoConnect: patch.autoConnect !== undefined ? patch.autoConnect === true : current.autoConnect,
  };
  await writeFile(settingsPath(), JSON.stringify(next), 'utf8');
  return next;
}

export function keychainAvailable(): boolean {
  return safeStorage.isEncryptionAvailable();
}

/** Both secrets live in one encrypted blob. Returns empties when the keychain is
 *  unavailable or the blob cannot be decrypted (e.g. written under another OS
 *  key) — the user is then asked to re-enter them rather than being locked out. */
export async function loadMumbleSecrets(): Promise<MumbleSecrets> {
  if (!keychainAvailable()) return { ...EMPTY_SECRETS };
  let ciphertext: Buffer;
  try {
    ciphertext = await readFile(secretsPath());
  } catch {
    return { ...EMPTY_SECRETS };
  }
  try {
    const parsed = JSON.parse(safeStorage.decryptString(ciphertext)) as Partial<MumbleSecrets>;
    return { password: str(parsed.password, ''), passphrase: str(parsed.passphrase, '') };
  } catch {
    return { ...EMPTY_SECRETS };
  }
}

/** Persist one or both secrets. Throws when there is no keychain — the caller
 *  surfaces that rather than silently writing plaintext to disk. */
export async function saveMumbleSecrets(patch: Partial<MumbleSecrets>): Promise<void> {
  if (!keychainAvailable()) {
    throw new Error('no system keychain available; refusing to store the password in plaintext');
  }
  const current = await loadMumbleSecrets();
  const next: MumbleSecrets = {
    password: patch.password !== undefined ? patch.password : current.password,
    passphrase: patch.passphrase !== undefined ? patch.passphrase : current.passphrase,
  };
  if (!next.password && !next.passphrase) {
    await rm(secretsPath(), { force: true });
    return;
  }
  await writeFile(secretsPath(), safeStorage.encryptString(JSON.stringify(next)));
}

/** Read the user's PKCS#12 identity. Returns null when the path is unset or the
 *  file has gone missing — the caller falls back to a guest connection. */
export async function readCertFile(path: string | null): Promise<Buffer | null> {
  if (!path) return null;
  try {
    const data = await readFile(path);
    if (data.length === 0 || data.length > MAX_CERT_BYTES) return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * Trust check for the Mumble socket. Node's `tls` does not go through Chromium's
 * certificate verify proc, so this asks the shared store (and the user) itself.
 *
 * Chromium records fingerprints as `sha256/<base64>` while Node reports
 * `AA:BB:..` hex, so convert before comparing — otherwise a certificate trusted
 * through one path would prompt again through the other.
 */
export function verifyMumblePeer(
  getWindow: () => BrowserWindow | null,
  host: string,
): (cert: PeerCertificate) => Promise<boolean> {
  return async (cert: PeerCertificate): Promise<boolean> => {
    const fingerprint = toChromiumFingerprint(cert.fingerprint256);
    if (!fingerprint) return false;
    return ensureTrusted(getWindow(), {
      host,
      subject: describeName(cert.subject) || cert.subjectaltname || '(unknown)',
      issuer: describeName(cert.issuer) || '(self-signed)',
      fingerprint,
      what: 'voice server',
    });
  };
}

function toChromiumFingerprint(hexWithColons: string | undefined): string | null {
  if (!hexWithColons) return null;
  const hex = hexWithColons.replace(/:/g, '');
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return null;
  return `sha256/${Buffer.from(hex, 'hex').toString('base64')}`;
}

function describeName(name: PeerCertificate['subject'] | undefined): string {
  if (!name) return '';
  const parts: string[] = [];
  if (name.CN) parts.push(`CN=${name.CN}`);
  if (name.O) parts.push(`O=${name.O}`);
  return parts.join(', ');
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function port(value: unknown): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_MUMBLE_SETTINGS.port;
}
