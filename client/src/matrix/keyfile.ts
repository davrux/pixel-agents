/**
 * Element-compatible "MEGOLM SESSION DATA" key-file codec (docs/design/matrix-e2ee-design.md §5.3).
 *
 * matrix-js-sdk@42.1.0 exports no `encryptMegolmKeyFile`/`decryptMegolmKeyFile`/`MEGOLM_KEY_FILE` —
 * that codec lives in the app layer (matrix-react-sdk), not the SDK — so this is hand-rolled on plain
 * WebCrypto and MUST stay byte-compatible with Element in both directions: a file exported here has to
 * open in Element and vice versa.
 *
 * No SDK import here at all: this module only ever sees the plaintext JSON string that
 * `CryptoApi.exportRoomKeysAsJson()`/`importRoomKeysAsJson()` produce/accept, and never inspects it.
 *
 * Secrets handling (docs/design/matrix-e2ee-design.md §8.1): the passphrase is a JS string and cannot be
 * zeroed — that is a platform limit, not an oversight; every derived Uint8Array (PBKDF2 output, the AES
 * and HMAC subkeys) is `.fill(0)`ed as soon as it is no longer needed. Nothing here is ever logged.
 */

const HEADER = '-----BEGIN MEGOLM SESSION DATA-----';
const FOOTER = '-----END MEGOLM SESSION DATA-----';
const DEFAULT_ROUNDS = 500_000;
// version(1) + salt(16) + iv(16) + rounds(4) + hmac(32), the minimum body with zero-length ciphertext.
const MIN_BODY_LEN = 1 + 16 + 16 + 4 + 32;
// The PBKDF2 round count is read straight out of the (untrusted, user-chosen) file and fed to
// crypto.subtle.deriveBits with no cap of its own — a file declaring rounds near 2^32 would hang the
// main thread (no cancel path exists in the import UI) for effectively forever. Element has the same
// gap; this is user-supplied-file hygiene, not a compatibility break with it.
const MAX_ROUNDS = 2_000_000;

export type KeyFileErrorKind = 'not-a-key-file' | 'bad-passphrase' | 'corrupt';

export class KeyFileError extends Error {
  readonly kind: KeyFileErrorKind;
  constructor(kind: KeyFileErrorKind, message: string) {
    super(message);
    this.name = 'KeyFileError';
    this.kind = kind;
  }
}

/** PBKDF2-SHA512(passphrase, salt, rounds) -> 64 bytes; [0..32) AES-256 key, [32..64) HMAC-SHA256 key. */
async function deriveKeys(
  passphrase: string,
  salt: Uint8Array<ArrayBuffer>,
  rounds: number,
): Promise<{ aesKey: Uint8Array<ArrayBuffer>; hmacKey: Uint8Array<ArrayBuffer> }> {
  const passKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: rounds, hash: 'SHA-512' },
    passKey,
    64 * 8,
  );
  const bytes = new Uint8Array(bits);
  const aesKey = bytes.slice(0, 32);
  const hmacKey = bytes.slice(32, 64);
  bytes.fill(0);
  return { aesKey, hmacKey };
}

function concatBytes(...parts: Uint8Array<ArrayBuffer>[]): Uint8Array<ArrayBuffer> {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function u32be(n: number): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, false);
  return b;
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array<ArrayBuffer>): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function wrapBase64(b64: string, cols = 64): string {
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += cols) lines.push(b64.slice(i, i + cols));
  return lines.join('\n');
}

export async function encryptKeyFile(
  plaintextJson: string,
  passphrase: string,
  rounds: number = DEFAULT_ROUNDS,
): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(16));
  // Clear the top bit of iv[8] so the 64-bit AES-CTR counter (the second half of the 16-byte block)
  // can never overflow into the nonce half — matches Element.
  iv[8] &= 0x7f;

  const { aesKey, hmacKey } = await deriveKeys(passphrase, salt, rounds);
  try {
    const aesCryptoKey = await crypto.subtle.importKey('raw', aesKey, { name: 'AES-CTR' }, false, ['encrypt']);
    const plaintextBytes = new TextEncoder().encode(plaintextJson);
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-CTR', counter: iv, length: 64 }, aesCryptoKey, plaintextBytes),
    );

    const roundsBytes = u32be(rounds);
    const version = new Uint8Array([0x01]);
    const macInput = concatBytes(version, salt, iv, roundsBytes, ciphertext);
    const hmacCryptoKey = await crypto.subtle.importKey('raw', hmacKey, { name: 'HMAC', hash: 'SHA-256' }, false, [
      'sign',
    ]);
    const hmac = new Uint8Array(await crypto.subtle.sign('HMAC', hmacCryptoKey, macInput));

    const body = concatBytes(macInput, hmac);
    const b64 = wrapBase64(bytesToBase64(body));
    return `${HEADER}\n${b64}\n${FOOTER}`;
  } finally {
    aesKey.fill(0);
    hmacKey.fill(0);
  }
}

export async function decryptKeyFile(fileText: string, passphrase: string): Promise<string> {
  const headerAt = fileText.indexOf(HEADER);
  const footerAt = fileText.indexOf(FOOTER);
  if (headerAt === -1 || footerAt === -1 || footerAt < headerAt) {
    throw new KeyFileError('not-a-key-file', "That doesn't look like an Element room-key export.");
  }
  const between = fileText.slice(headerAt + HEADER.length, footerAt);
  const b64 = between.replace(/\s+/g, '');

  let body: Uint8Array<ArrayBuffer>;
  try {
    body = base64ToBytes(b64);
  } catch {
    throw new KeyFileError('corrupt', 'The key file is corrupt.');
  }
  if (body.length < MIN_BODY_LEN) {
    throw new KeyFileError('corrupt', 'The key file is corrupt.');
  }

  const version = body[0];
  if (version !== 0x01) {
    throw new KeyFileError('corrupt', 'The key file is corrupt.');
  }
  const salt = body.slice(1, 17);
  const iv = body.slice(17, 33);
  const roundsBytes = body.slice(33, 37);
  const rounds = new DataView(roundsBytes.buffer, roundsBytes.byteOffset, 4).getUint32(0, false);
  if (rounds < 1 || rounds > MAX_ROUNDS) {
    throw new KeyFileError('corrupt', 'The key file is corrupt.');
  }
  const ciphertext = body.slice(37, body.length - 32);
  const hmac = body.slice(body.length - 32);

  const { aesKey, hmacKey } = await deriveKeys(passphrase, salt, rounds);
  try {
    const macInput = concatBytes(body.slice(0, 1), salt, iv, roundsBytes, ciphertext);
    const hmacCryptoKey = await crypto.subtle.importKey('raw', hmacKey, { name: 'HMAC', hash: 'SHA-256' }, false, [
      'verify',
    ]);
    const ok = await crypto.subtle.verify('HMAC', hmacCryptoKey, hmac, macInput);
    if (!ok) {
      throw new KeyFileError('bad-passphrase', "That passphrase didn't open the file.");
    }

    const aesCryptoKey = await crypto.subtle.importKey('raw', aesKey, { name: 'AES-CTR' }, false, ['decrypt']);
    const plaintextBytes = new Uint8Array(
      await crypto.subtle.decrypt({ name: 'AES-CTR', counter: iv, length: 64 }, aesCryptoKey, ciphertext),
    );
    return new TextDecoder().decode(plaintextBytes);
  } finally {
    aesKey.fill(0);
    hmacKey.fill(0);
  }
}
