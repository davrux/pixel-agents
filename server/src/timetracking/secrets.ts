/**
 * Encryption at rest for the one secret this server has to be able to *read
 * back*: a user's TimeTracking password.
 *
 * Everything else we store is either hashed (account passwords — see pwhash.ts)
 * or not a secret at all. This one is different: the API hands out access tokens
 * that live 300 seconds, so to keep a user's status current without re-prompting
 * them every five minutes the server must be able to log in as them again. That
 * rules out hashing, so the next best thing is AES-256-GCM under a key that
 * lives outside the database.
 *
 * The key comes from PIXEL_SECRET_KEY when set (the deployment-friendly path:
 * a mounted secret, never in the DB backup), otherwise from a `secret.key` file
 * generated 0600 beside pixel.db. Losing the key is not fatal — sealed values
 * simply fail to open and the user is asked to re-enter their password.
 *
 * This protects a stolen *database file*, which is the realistic threat here
 * (backups, a copied volume). It does not protect against someone who already
 * has code execution on the server — nothing that must decrypt on demand can.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';

import { dataPath } from '../paths.js';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12; // GCM standard nonce length
const KEY_FILE = 'secret.key';

let cachedKey: Buffer | null = null;

/** The 32-byte data key, from the env or the (generated) key file. */
function key(): Buffer {
  if (cachedKey) return cachedKey;

  const fromEnv = process.env.PIXEL_SECRET_KEY?.trim();
  if (fromEnv) {
    // Any length accepted: hashed to exactly 32 bytes so a human-typed
    // passphrase works as well as a base64 key.
    cachedKey = crypto.createHash('sha256').update(fromEnv).digest();
    return cachedKey;
  }

  const path = dataPath(KEY_FILE);
  try {
    const raw = fs.readFileSync(path);
    if (raw.length >= 32) {
      cachedKey = raw.subarray(0, 32);
      return cachedKey;
    }
  } catch {
    /* not created yet — fall through and generate it */
  }
  const generated = crypto.randomBytes(32);
  // 0600 and wx: if two workers race, the loser re-reads the winner's file.
  try {
    fs.writeFileSync(path, generated, { mode: 0o600, flag: 'wx' });
    cachedKey = generated;
  } catch {
    cachedKey = fs.readFileSync(path).subarray(0, 32);
  }
  return cachedKey;
}

/** Encrypt a secret for storage. Returns `iv.tag.ciphertext`, base64url each. */
export function seal(plain: string): string {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, key(), iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64url')}.${tag.toString('base64url')}.${body.toString('base64url')}`;
}

/** Decrypt a sealed secret, or null when the key changed / the value is corrupt.
 *  Callers treat null as "not configured" and ask the user to re-enter it. */
export function open(sealed: string): string | null {
  const parts = sealed.split('.');
  if (parts.length !== 3) return null;
  try {
    const [iv, tag, body] = parts.map((p) => Buffer.from(p, 'base64url'));
    const decipher = crypto.createDecipheriv(ALGO, key(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  } catch {
    return null; // wrong key or tampered ciphertext — GCM caught it
  }
}
