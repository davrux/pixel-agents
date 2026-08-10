/**
 * Image attachments (PNG, JPEG, GIF): the pure format helpers plus
 * `MatrixMedia`, the per-session upload/download cache the store owns.
 *
 * Sending is limited to those three by `sniffImage` — recognised from magic
 * bytes, not from `File.type` or the extension. Displaying is deliberately
 * wider (`RENDERABLE_TYPES`): an attachment from another client is shown if a
 * browser can decode it safely, because refusing to render a WebP someone
 * sent from Element is worse for the reader than the format asymmetry.
 *
 * Two things here are security-load-bearing and must not be "simplified":
 *
 * - **The blob's MIME type never comes from the homeserver.** A malicious or
 *   compromised server can answer a media download with any Content-Type it
 *   likes; handing that straight to `new Blob()` and then to an `<img src>`
 *   is how `image/svg+xml` (a scriptable document format) gets rendered. The
 *   type is taken from the *event's* claimed `info.mimetype`, passed through
 *   `RENDERABLE_TYPES` below, and anything else becomes an opaque
 *   `application/octet-stream` that `<img>` simply refuses to decode — the
 *   caller then shows its "couldn't load" fallback. Same reason the response
 *   is never used as a `Response.blob()`.
 * - **Encrypted attachments are hash-checked before decryption.** The
 *   `hashes.sha256` in the event content arrives over the (authenticated,
 *   E2EE) timeline, while the ciphertext comes from the unauthenticated media
 *   repo; skipping the comparison means the server can feed arbitrary bytes
 *   into AES-CTR, which — being a stream cipher with no integrity of its own —
 *   will happily "decrypt" them into attacker-chosen plaintext.
 *
 * The `EncryptedFile` codec below implements the same on-the-wire format as
 * Element's `matrix-encrypt-attachment` (AES-CTR-256, 8 random IV bytes + a
 * 64-bit counter, SHA-256 over the ciphertext). matrix-js-sdk does not ship
 * it — it lives in a separate package Element pulls in — so it is hand-rolled
 * here on WebCrypto, which behaves identically in Chrome, Firefox and the
 * Electron `app://` renderer (all three are secure contexts, so
 * `crypto.subtle` exists; `app://` is registered as privileged+secure in
 * desktop/src/main.ts).
 *
 * No DOM beyond `URL.createObjectURL` — nothing here renders anything.
 */
import type { MatrixClient } from './sdk.js';
import { MatrixError } from './types.js';

/** Hard client-side ceiling on both directions. Homeservers impose their own
 *  (usually smaller) `m.upload.size`; exceeding that surfaces as M_TOO_LARGE
 *  and is translated in `uploadImage()`. This cap exists for the case the
 *  server has no opinion: encrypting and base64ing a 500 MB file in a browser
 *  tab is not a thing we should attempt at all. */
export const MAX_IMAGE_BYTES = 16 * 1024 * 1024;

/** MIME types we will hand to an `<img>`. Deliberately excludes
 *  `image/svg+xml` — see the file header. */
const RENDERABLE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/apng', 'image/bmp']);

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** The spec's `EncryptedFile`: the JWK + IV + ciphertext hash that replace a
 *  plain `url` on an attachment sent into an encrypted room. */
export interface MxEncryptedFile {
  url: string;
  key: { kty: 'oct'; key_ops: string[]; alg: 'A256CTR'; k: string; ext: true };
  iv: string;
  hashes: { sha256: string };
  v: string;
}

export interface MxImageInfo {
  mimetype: string;
  size: number;
  w?: number;
  h?: number;
}

/** The `m.image` message content this module produces and consumes. Exactly
 *  one of `url` (unencrypted room) / `file` (encrypted room) is set. */
export interface MxImageContent {
  msgtype: 'm.image';
  body: string;
  info: MxImageInfo;
  url?: string;
  file?: MxEncryptedFile;
}

// ------------------------------------------------------------------ base64

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/** Tolerant on purpose: other clients disagree about padding and about
 *  url-safe vs standard alphabet for these fields, and a picture failing to
 *  open because of a '=' is not an acceptable interop story. */
function fromBase64(s: string): Uint8Array<ArrayBuffer> {
  const norm = s.replace(/-/g, '+').replace(/_/g, '/');
  const padded = norm + '='.repeat((4 - (norm.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ------------------------------------------------------------- image sniff

/** What `sniffImage` recognises. The MIME type it returns is derived from the
 *  bytes, never from `File.type` or the extension — a screenshot renamed
 *  `.png` must not be announced to every other client as a PNG. */
export type SniffedImage = { mimetype: 'image/png' | 'image/jpeg' | 'image/gif'; w: number; h: number } | null;

export function isPng(bytes: Uint8Array): boolean {
  if (bytes.length < PNG_MAGIC.length) return false;
  return PNG_MAGIC.every((b, i) => bytes[i] === b);
}

function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

function isGif(bytes: Uint8Array): boolean {
  if (bytes.length < 10) return false;
  const sig = String.fromCharCode(...Array.from(bytes.subarray(0, 6)));
  return sig === 'GIF87a' || sig === 'GIF89a';
}

/** Identify a supported image and read its dimensions out of the header.
 *  Header parsing rather than `createImageBitmap`: no decode, no worker, no
 *  per-browser size limits, and these numbers only feed the `aspect-ratio`
 *  box the timeline reserves before the picture arrives. Returns null for
 *  anything we do not send. */
export function sniffImage(bytes: Uint8Array): SniffedImage {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (isPng(bytes)) {
    const size = pngSize(bytes, view);
    return size ? { mimetype: 'image/png', ...size } : null;
  }
  if (isJpeg(bytes)) {
    const size = jpegSize(bytes, view);
    return size ? { mimetype: 'image/jpeg', ...size } : null;
  }
  if (isGif(bytes)) {
    // Logical-screen descriptor, little-endian, immediately after the 6-byte
    // signature. A GIF's frames can be smaller than this, but this is the
    // canvas every renderer composites onto, so it is the displayed size.
    const w = view.getUint16(6, true);
    const h = view.getUint16(8, true);
    return w > 0 && h > 0 ? { mimetype: 'image/gif', w, h } : null;
  }
  return null;
}

/** Width/height straight out of the IHDR chunk, which a valid PNG is required
 *  to place first: 8 magic bytes, 4 length, 4 type, then two big-endian
 *  uint32s. */
function pngSize(bytes: Uint8Array, view: DataView): { w: number; h: number } | null {
  if (bytes.length < 24) return null;
  if (String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!) !== 'IHDR') return null;
  const w = view.getUint32(16, false);
  const h = view.getUint32(20, false);
  if (w <= 0 || h <= 0) return null;
  return { w, h };
}

/** JPEG has no fixed header: the dimensions live in whichever Start-Of-Frame
 *  segment the encoder used (baseline, progressive, arithmetic, …), which sits
 *  an arbitrary number of variable-length segments in. Walk the segment chain
 *  to the first SOF and stop at SOS (the entropy-coded scan, past which
 *  segment lengths no longer apply). */
function jpegSize(bytes: Uint8Array, view: DataView): { w: number; h: number } | null {
  let i = 2;
  while (i + 3 < bytes.length) {
    if (bytes[i] !== 0xff) {
      i++; // resync over fill/garbage rather than give up
      continue;
    }
    const marker = bytes[i + 1]!;
    // 0xFF padding, and the standalone markers that carry no length field.
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      i += 2;
      continue;
    }
    if (marker === 0xda) return null; // start of scan — dimensions must precede it
    const segLen = view.getUint16(i + 2, false);
    if (segLen < 2) return null;
    // SOF0..SOFF, minus DHT (C4), JPG (C8) and DAC (CC), which share the range.
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (i + 9 > bytes.length) return null;
      const h = view.getUint16(i + 5, false);
      const w = view.getUint16(i + 7, false);
      return w > 0 && h > 0 ? { w, h } : null;
    }
    i += 2 + segLen;
  }
  return null;
}

// --------------------------------------------------- encrypted attachments

function subtleCrypto(): SubtleCrypto {
  const c = globalThis.crypto;
  if (!c?.subtle) {
    throw new MatrixError(0, '', 'This browser has no WebCrypto, so encrypted pictures are unavailable.');
  }
  return c.subtle;
}

export async function encryptAttachment(data: ArrayBuffer): Promise<{
  ciphertext: ArrayBuffer;
  file: Omit<MxEncryptedFile, 'url'>;
}> {
  const subtle = subtleCrypto();
  const keyBytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(keyBytes);
  // Only the top 8 bytes are random: the bottom 8 are the AES-CTR counter and
  // must start at zero, or a long file's counter overflows into the nonce and
  // silently reuses keystream.
  const iv = new Uint8Array(16);
  globalThis.crypto.getRandomValues(iv.subarray(0, 8));

  const key = await subtle.importKey('raw', keyBytes, 'AES-CTR', true, ['encrypt', 'decrypt']);
  const ciphertext = await subtle.encrypt({ name: 'AES-CTR', counter: iv, length: 64 }, key, data);
  const digest = await subtle.digest('SHA-256', ciphertext);

  return {
    ciphertext,
    file: {
      // Written by hand rather than via exportKey('jwk') so the field set is
      // byte-identical across browsers — Firefox and Chrome do not agree on
      // which optional JWK members they emit for AES-CTR.
      key: { kty: 'oct', key_ops: ['encrypt', 'decrypt'], alg: 'A256CTR', k: toBase64Url(keyBytes), ext: true },
      iv: toBase64(iv),
      hashes: { sha256: toBase64(new Uint8Array(digest)) },
      v: 'v2',
    },
  };
}

export async function decryptAttachment(ciphertext: ArrayBuffer, file: MxEncryptedFile): Promise<ArrayBuffer> {
  const subtle = subtleCrypto();
  if (file.v !== 'v2' && file.v !== 'v1') {
    throw new MatrixError(0, '', `Unsupported encrypted-file version "${file.v}".`);
  }
  const expected = file.hashes?.sha256;
  if (typeof expected !== 'string' || !expected) {
    throw new MatrixError(0, '', 'This picture is missing its integrity hash.');
  }
  const digest = new Uint8Array(await subtle.digest('SHA-256', ciphertext));
  // Compare decoded bytes, not the strings — see fromBase64's note on padding.
  const want = fromBase64(expected);
  if (digest.length !== want.length || !digest.every((b, i) => b === want[i])) {
    throw new MatrixError(0, '', 'This picture failed its integrity check and was not opened.');
  }

  const keyBytes = fromBase64(file.key.k);
  const iv = fromBase64(file.iv);
  const key = await subtle.importKey('raw', keyBytes, 'AES-CTR', false, ['decrypt']);
  return subtle.decrypt({ name: 'AES-CTR', counter: iv, length: 64 }, key, ciphertext);
}

// -------------------------------------------------------------- projection

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
}

function asEncryptedFile(v: unknown): MxEncryptedFile | null {
  const f = asRecord(v);
  const key = asRecord(f?.key);
  if (!f || !key) return null;
  if (typeof f.url !== 'string' || !f.url.startsWith('mxc://')) return null;
  if (typeof key.k !== 'string' || typeof f.iv !== 'string') return null;
  const hashes = asRecord(f.hashes);
  if (typeof hashes?.sha256 !== 'string') return null;
  return {
    url: f.url,
    key: { kty: 'oct', key_ops: ['encrypt', 'decrypt'], alg: 'A256CTR', k: key.k, ext: true },
    iv: f.iv,
    hashes: { sha256: hashes.sha256 },
    v: typeof f.v === 'string' ? f.v : 'v2',
  };
}

/** Narrow a raw event content to a renderable `m.image`, or null. Everything
 *  the renderer touches is validated here so no other module has to re-check
 *  a remote-controlled shape. */
export function imageContentOf(content: Record<string, unknown>): MxImageContent | null {
  if (content.msgtype !== 'm.image') return null;
  const info = asRecord(content.info) ?? {};
  const mimetype = typeof info.mimetype === 'string' ? info.mimetype : '';
  const body = typeof content.body === 'string' && content.body ? content.body : 'image';
  const file = asEncryptedFile(content.file);
  const url = typeof content.url === 'string' && content.url.startsWith('mxc://') ? content.url : undefined;
  if (!file && !url) return null;
  return {
    msgtype: 'm.image',
    body,
    info: {
      mimetype,
      size: typeof info.size === 'number' ? info.size : 0,
      w: typeof info.w === 'number' && info.w > 0 ? info.w : undefined,
      h: typeof info.h === 'number' && info.h > 0 ? info.h : undefined,
    },
    url,
    file: file ?? undefined,
  };
}

/** The cache key for a piece of media: its mxc URI, which is content-addressed
 *  by the homeserver and identical for the encrypted and plain cases. */
export function mediaKeyOf(content: MxImageContent): string {
  return content.file?.url ?? content.url ?? '';
}

// --------------------------------------------------------------- the cache

export class MatrixMedia {
  private readonly urls = new Map<string, string>();
  private readonly inflight = new Map<string, Promise<string>>();
  private destroyed = false;

  constructor(private readonly client: MatrixClient) {}

  /** Resolve (and cache) a blob: URL for an image event. Repeat calls for the
   *  same mxc URI share one download; the URL stays alive until `destroy()`,
   *  because timeline rows are rebuilt constantly and revoking per-row would
   *  break every `<img>` still pointing at it. */
  objectUrl(content: MxImageContent): Promise<string> {
    const key = mediaKeyOf(content);
    if (!key) return Promise.reject(new MatrixError(0, '', 'This picture has no address.'));
    const cached = this.urls.get(key);
    if (cached) return Promise.resolve(cached);
    const running = this.inflight.get(key);
    if (running) return running;

    const p = this.download(content)
      .then((url) => {
        // destroy() may have run while this was in flight — don't leak a URL
        // nothing will ever revoke.
        if (this.destroyed) {
          URL.revokeObjectURL(url);
          throw new MatrixError(0, '', 'Signed out.');
        }
        this.urls.set(key, url);
        return url;
      })
      .finally(() => {
        this.inflight.delete(key);
      });
    this.inflight.set(key, p);
    return p;
  }

  /** Register bytes we already hold (the file we are about to upload) under
   *  the mxc URI the server just gave it, so our own local echo renders
   *  instantly instead of downloading back what we just sent. */
  seed(key: string, blob: Blob): void {
    if (this.destroyed || !key || this.urls.has(key)) return;
    this.urls.set(key, URL.createObjectURL(blob));
  }

  /** Read a PNG off disk/clipboard, upload it (encrypting first when the room
   *  is encrypted) and return the `m.image` content to send. Throws a
   *  `MatrixError` with a display-ready message on every failure path. */
  async uploadImage(o: {
    file: File;
    encrypt: boolean;
    onProgress?: (fraction: number) => void;
    signal?: AbortSignal;
  }): Promise<MxImageContent> {
    // Size first, before the file is ever read into the tab's heap.
    if (o.file.size > MAX_IMAGE_BYTES) {
      throw new MatrixError(0, '', `That picture is too big (limit ${Math.floor(MAX_IMAGE_BYTES / 1024 / 1024)} MB).`);
    }
    const bytes = new Uint8Array(await o.file.arrayBuffer());
    const sniffed = sniffImage(bytes);
    if (!sniffed) {
      throw new MatrixError(0, '', 'That file is not a PNG, JPEG or GIF.');
    }
    const info: MxImageInfo = {
      // From the bytes, not from File.type — this is what every other client
      // will believe about the attachment.
      mimetype: sniffed.mimetype,
      size: bytes.byteLength,
      w: sniffed.w,
      h: sniffed.h,
    };
    const name = sanitizeFilename(o.file.name, sniffed.mimetype);

    try {
      if (o.encrypt) {
        const { ciphertext, file } = await encryptAttachment(bytes.buffer as ArrayBuffer);
        const res = await this.client.uploadContent(new Blob([ciphertext], { type: 'application/octet-stream' }), {
          // The name and the real type are both metadata the server has no
          // business seeing for an encrypted attachment — the filename lives
          // in the (encrypted) event body instead.
          includeFilename: false,
          type: 'application/octet-stream',
          abortController: toAbortController(o.signal),
          progressHandler: (p) => o.onProgress?.(p.total ? p.loaded / p.total : 0),
        });
        const content: MxImageContent = {
          msgtype: 'm.image',
          body: name,
          info,
          file: { ...file, url: res.content_uri },
        };
        this.seed(res.content_uri, new Blob([bytes], { type: sniffed.mimetype }));
        return content;
      }

      const res = await this.client.uploadContent(o.file, {
        name,
        type: sniffed.mimetype,
        abortController: toAbortController(o.signal),
        progressHandler: (p) => o.onProgress?.(p.total ? p.loaded / p.total : 0),
      });
      this.seed(res.content_uri, new Blob([bytes], { type: sniffed.mimetype }));
      return { msgtype: 'm.image', body: name, info, url: res.content_uri };
    } catch (err) {
      throw uploadError(err);
    }
  }

  destroy(): void {
    this.destroyed = true;
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear();
    this.inflight.clear();
  }

  // ---- download ----------------------------------------------------------

  private async download(content: MxImageContent): Promise<string> {
    const mxc = mediaKeyOf(content);
    const buf = await this.fetchMedia(mxc);
    const plain = content.file ? await decryptAttachment(buf, content.file) : buf;
    // See the file header: the type is the event's claim, allowlisted — never
    // the server's Content-Type.
    const type = RENDERABLE_TYPES.has(content.info.mimetype) ? content.info.mimetype : 'application/octet-stream';
    return URL.createObjectURL(new Blob([plain], { type }));
  }

  /** Authenticated media (Matrix 1.11+) first, falling back to the legacy
   *  unauthenticated route only when the server says it doesn't know the new
   *  one. The access token goes in a header, never in a query string, so it
   *  can't end up in a server log or a Referer. */
  private async fetchMedia(mxc: string): Promise<ArrayBuffer> {
    const token = this.client.getAccessToken();
    const authUrl = this.client.mxcUrlToHttp(mxc, undefined, undefined, undefined, false, true, true);
    if (authUrl && token) {
      const res = await doFetch(authUrl, { Authorization: `Bearer ${token}` });
      if (res.ok) return readCapped(res);
      if (res.status !== 400 && res.status !== 404 && res.status !== 401) throw mediaError(res.status);
    }
    const legacyUrl = this.client.mxcUrlToHttp(mxc, undefined, undefined, undefined, false, true, false);
    if (!legacyUrl) throw new MatrixError(0, '', 'This picture has an address this client cannot read.');
    const res = await doFetch(legacyUrl, {});
    if (!res.ok) throw mediaError(res.status);
    return readCapped(res);
  }
}

// ---------------------------------------------------------------- helpers

function toAbortController(signal?: AbortSignal): AbortController | undefined {
  if (!signal) return undefined;
  const ac = new AbortController();
  if (signal.aborted) ac.abort();
  else signal.addEventListener('abort', () => ac.abort(), { once: true });
  return ac;
}

async function doFetch(url: string, headers: Record<string, string>): Promise<Response> {
  try {
    return await fetch(url, { headers, credentials: 'omit', referrerPolicy: 'no-referrer' });
  } catch {
    throw new MatrixError(0, '', "Couldn't reach the homeserver to load this picture.");
  }
}

async function readCapped(res: Response): Promise<ArrayBuffer> {
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > MAX_IMAGE_BYTES) {
    throw new MatrixError(0, '', 'That picture is larger than this client will download.');
  }
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_IMAGE_BYTES) {
    throw new MatrixError(0, '', 'That picture is larger than this client will download.');
  }
  return buf;
}

function mediaError(status: number): MatrixError {
  if (status === 404) return new MatrixError(404, 'M_NOT_FOUND', 'This picture is no longer on the server.');
  if (status === 403) return new MatrixError(403, 'M_FORBIDDEN', "You don't have access to this picture.");
  return new MatrixError(status, '', "Couldn't load this picture.");
}

function uploadError(err: unknown): MatrixError {
  const e = MatrixError.from(err);
  if (e.errcode === 'M_TOO_LARGE') {
    return new MatrixError(e.status, e.errcode, 'The homeserver rejected that picture as too large.');
  }
  if (e.errcode === 'M_FORBIDDEN') {
    return new MatrixError(e.status, e.errcode, "The homeserver won't accept uploads from this account.");
  }
  if (e.isNetwork) return new MatrixError(0, '', "Couldn't reach the homeserver to upload that picture.");
  return e;
}

const DEFAULT_NAMES: Record<string, string> = {
  'image/png': 'image.png',
  'image/jpeg': 'image.jpg',
  'image/gif': 'image.gif',
};

/** Filenames travel to other clients and (unencrypted) to the server, and end
 *  up in a `download` attribute here. Keep them to a plain basename; a
 *  clipboard paste often carries no name at all, hence the per-type fallback. */
function sanitizeFilename(name: string, mimetype: string): string {
  const base = name.split(/[/\\]/).pop() ?? '';
  // Strip C0/C1 controls (including the newlines that would break a header or
  // a one-line UI row) rather than trusting whatever the OS picker handed us.
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return clean.slice(0, 120) || DEFAULT_NAMES[mimetype] || 'image';
}
