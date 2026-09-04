/**
 * Attachments: the pure format helpers plus `MatrixMedia`, the per-session
 * upload/download cache the store owns.
 *
 * Two shapes, and the difference is *rendering*, not sending:
 *
 * - **Pictures** (`m.image`) are shown inline. Only PNG, JPEG and GIF are ever
 *   *sent* as one, recognised by `sniffImage` from magic bytes rather than from
 *   `File.type` or the extension. Displaying is deliberately wider
 *   (`RENDERABLE_TYPES`): an attachment from another client is shown if a
 *   browser can decode it safely, because refusing to render a WebP someone
 *   sent from Element is worse for the reader than the format asymmetry.
 * - **Files** (`m.file`, plus other clients' `m.audio`/`m.video`) are a name, a
 *   size and a download. That is what makes "any file from disk" safe to
 *   support: the bytes normally only ever leave here as an
 *   `application/octet-stream` blob for the browser to save, so no sniffing,
 *   no allowlist and no decoder is involved on the way in or out.
 * - **Video** is the one exception to that, and it is the picture rule rather
 *   than a third one: an attachment whose *declared* type is in
 *   `PLAYABLE_VIDEO_TYPES` can additionally be fetched as a real, typed blob
 *   for a `<video>` (`videoUrl`), on an explicit click and never to draw a row.
 *   The same bytes stay available as an opaque download under their own cache
 *   key — the two entries differ in exactly the thing that matters, the blob's
 *   type.
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

/** Hard client-side ceiling on both directions for a *picture*. Homeservers
 *  impose their own (usually smaller) `m.upload.size`; exceeding that surfaces
 *  as M_TOO_LARGE and is translated in `uploadImage()`. This cap exists for the
 *  case the server has no opinion: encrypting and base64ing a 500 MB file in a
 *  browser tab is not a thing we should attempt at all.
 *
 *  It is lower than `MAX_FILE_BYTES` on purpose: a picture is *decoded* into a
 *  timeline row, so it costs the tab a bitmap on top of the bytes, and it is
 *  fetched without the reader asking for it. */
export const MAX_IMAGE_BYTES = 16 * 1024 * 1024;

/** The UPLOAD ceiling for a plain file (a picture uploads under the smaller cap
 *  above). 50 MB matches Synapse's default `max_upload_size`, so the usual
 *  failure is our own message rather than an M_TOO_LARGE after a full upload —
 *  and an encrypted send still holds the plaintext *and* the ciphertext in the
 *  tab's heap at once, which is the real reason this is not simply "whatever
 *  the server allows". Downloads have their own, higher ceiling below. */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;

/** The ceiling for a file or video the reader CLICKED to fetch. Higher than the
 *  upload cap on purpose: the two numbers answer different questions. The
 *  upload cap is about what this tab should attempt to encrypt and what Synapse
 *  accepts by default; a download is an explicit choice by somebody who was
 *  shown the size first, and other clients on other homeservers send clips
 *  well past 50 MB (which is what the split was made for — a video that played
 *  in Element failed here as "larger than this client will download"). It is
 *  still a ceiling and not infinity: the bytes are read into one buffer and then
 *  a blob, and an encrypted clip holds ciphertext and plaintext at once, so a
 *  tab on a small machine has to be able to hold twice this. Pictures keep
 *  `MAX_IMAGE_BYTES` — they are fetched unasked and decoded into a bitmap. */
export const MAX_DOWNLOAD_BYTES = 250 * 1024 * 1024;

/** MIME types we will hand to an `<img>`. Deliberately excludes
 *  `image/svg+xml` — see the file header. */
const RENDERABLE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/apng', 'image/bmp']);

/** MIME types we will hand to a `<video>`. Same rule as `RENDERABLE_TYPES`, for
 *  the same reason: the type is the *event's* claim passed through an allowlist,
 *  so a homeserver's Content-Type can never decide what a decoder is pointed at,
 *  and anything else stays an opaque blob no element will play. All three play
 *  in both browsers this client supports (AGENTS rule 9) — Firefox reaches
 *  H.264 through the OS decoder. A container this list accepts can still hold a
 *  codec the browser cannot decode (HEVC in an MP4), which is why the viewer has
 *  a failure path and not just a `<video>`. */
const PLAYABLE_VIDEO_TYPES = new Set(['video/mp4', 'video/webm', 'video/ogg']);

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

export interface MxFileInfo {
  mimetype: string;
  size: number;
}

export interface MxImageInfo extends MxFileInfo {
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

/** A downloadable attachment: what we send for anything that is not one of the
 *  three picture formats, and what we accept for the `m.audio`/`m.video` other
 *  clients send. Always saveable; additionally playable when `isPlayableVideo`
 *  recognises its declared type. */
export interface MxFileContent {
  msgtype: 'm.file' | 'm.audio' | 'm.video';
  body: string;
  info: MxFileInfo;
  url?: string;
  file?: MxEncryptedFile;
}

export type MxAttachmentContent = MxImageContent | MxFileContent;

// ------------------------------------------------------------------ base64

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

/** Unpadded standard base64 — what the spec requires for `iv` and
 *  `hashes.sha256` ("encoded as unpadded base64").
 *
 *  This is not cosmetic. Element verifies the ciphertext by *string*-comparing
 *  our `hashes.sha256` against its own re-encoding of the digest it computed,
 *  and its encoder strips the padding. A trailing '=' here therefore fails
 *  that comparison for bytes that are perfectly intact, and every picture we
 *  send lands in Element as "Error decrypting image". */
function toBase64Unpadded(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/=+$/, '');
}

function toBase64Url(bytes: Uint8Array): string {
  return toBase64Unpadded(bytes).replace(/\+/g, '-').replace(/\//g, '_');
}

/** Tolerant on purpose: other clients disagree about padding and about
 *  url-safe vs standard alphabet for these fields, and a picture failing to
 *  open because of a '=' is not an acceptable interop story. Existing padding
 *  is dropped before re-padding, so an already-padded input can't end up
 *  over-padded (which `atob` rejects outright). */
function fromBase64(s: string): Uint8Array<ArrayBuffer> {
  const norm = s.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
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

function isWebp(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  const riff = String.fromCharCode(...Array.from(bytes.subarray(0, 4)));
  const webp = String.fromCharCode(...Array.from(bytes.subarray(8, 12)));
  return riff === 'RIFF' && webp === 'WEBP';
}

/** Type-only sniff, for media whose dimensions we don't need — avatars, which
 *  are fetched at a size we chose anyway. Includes WebP (Synapse emits it for
 *  some thumbnails) precisely because no dimension parsing is required here.
 *
 *  This is the gate that keeps an avatar from being a scriptable document: the
 *  bytes must look like a known raster format or they are not rendered at all,
 *  regardless of what Content-Type the homeserver attached. */
export function sniffImageType(bytes: Uint8Array): string | null {
  if (isPng(bytes)) return 'image/png';
  if (isJpeg(bytes)) return 'image/jpeg';
  if (isGif(bytes)) return 'image/gif';
  if (isWebp(bytes)) return 'image/webp';
  return null;
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
      iv: toBase64Unpadded(iv),
      hashes: { sha256: toBase64Unpadded(new Uint8Array(digest)) },
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

/** The msgtypes we accept as a plain download. `m.audio`/`m.video` are in here
 *  because another client's voice message or clip is still a file the reader can
 *  save — the alternative was the old "(not supported in this client)" row. */
const FILE_MSGTYPES = new Set(['m.file', 'm.audio', 'm.video']);

/** Narrow a raw event content to a downloadable attachment, or null. Same
 *  contract as `imageContentOf`: everything the row touches is validated here.
 *  Note what is *not* validated — `info.mimetype` is remote text we keep only
 *  to show the reader, never to pick a blob type (see the file header). */
export function fileContentOf(content: Record<string, unknown>): MxFileContent | null {
  const msgtype = content.msgtype;
  if (typeof msgtype !== 'string' || !FILE_MSGTYPES.has(msgtype)) return null;
  const info = asRecord(content.info) ?? {};
  const file = asEncryptedFile(content.file);
  const url = typeof content.url === 'string' && content.url.startsWith('mxc://') ? content.url : undefined;
  if (!file && !url) return null;
  const body = typeof content.body === 'string' && content.body ? content.body : 'file';
  return {
    msgtype: msgtype as MxFileContent['msgtype'],
    body,
    info: {
      mimetype: typeof info.mimetype === 'string' ? info.mimetype : '',
      size: typeof info.size === 'number' && info.size > 0 ? info.size : 0,
    },
    url,
    file: file ?? undefined,
  };
}

/** Can this attachment be played in place, or only saved?
 *
 *  Keyed off the *declared type* rather than the msgtype, deliberately: another
 *  client's `m.video` and the `m.file` this one sends for the very same clip
 *  (uploads are only ever `m.image` or `m.file` — see `uploadAttachment`) are
 *  the same bytes, and a reader has no use for that distinction. The type is
 *  remote text either way, which is exactly why the answer is an allowlist
 *  lookup and not a `startsWith('video/')`. */
export function isPlayableVideo(content: MxFileContent): boolean {
  return PLAYABLE_VIDEO_TYPES.has(content.info.mimetype);
}

/** The cache key for a piece of media: its mxc URI, which is content-addressed
 *  by the homeserver and identical for the encrypted and plain cases. */
export function mediaKeyOf(content: { url?: string; file?: MxEncryptedFile }): string {
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
    const mxc = mediaKeyOf(content);
    if (!mxc) return Promise.reject(new MatrixError(0, '', 'This picture has no address.'));
    return this.cached(cacheKey('img', mxc), () => this.download(content));
  }

  /** The same for a plain file: one download per mxc URI, handed back as an
   *  opaque blob for the browser to save. Kept under a *different* cache key
   *  from `objectUrl` even for the same mxc — the two differ precisely in the
   *  blob's type, and handing a picture's `image/png` blob to a "save this
   *  file" click (or the reverse) is how that distinction gets lost. */
  attachmentUrl(content: MxFileContent): Promise<string> {
    const mxc = mediaKeyOf(content);
    if (!mxc) return Promise.reject(new MatrixError(0, '', 'This file has no address.'));
    return this.cached(cacheKey('file', mxc), () => this.downloadFile(content));
  }

  /** A *playable* blob: URL for a video attachment — a third cache entry for the
   *  same mxc, for precisely the reason `attachmentUrl` is a second one: these
   *  blobs differ only in their type, and this is the one that carries a real
   *  one. Same click-only rule as a file: a room full of clips must never
   *  download itself to draw its rows. */
  videoUrl(content: MxFileContent): Promise<string> {
    const mxc = mediaKeyOf(content);
    if (!mxc) return Promise.reject(new MatrixError(0, '', 'This video has no address.'));
    if (!isPlayableVideo(content)) {
      return Promise.reject(new MatrixError(0, '', "This client can't play that video format."));
    }
    return this.cached(cacheKey('video', mxc), () => this.downloadVideo(content));
  }

  /** A cropped square thumbnail of a profile/room avatar, cached per
   *  (mxc, size). Avatars are never encrypted — they are profile and room
   *  state, readable by anyone in the room — so there is no `EncryptedFile`
   *  path here.
   *
   *  Goes through the homeserver's thumbnail endpoint rather than `objectUrl`:
   *  a room list of twenty people would otherwise pull twenty full-size
   *  originals (megabytes each) to paint twenty 34px squares. */
  avatarUrl(mxc: string, sizePx: number): Promise<string> {
    if (!mxc.startsWith('mxc://')) return Promise.reject(new MatrixError(0, '', 'Not a media address.'));
    return this.cached(cacheKey('avatar', `${mxc}|${sizePx}`), () => this.downloadThumbnail(mxc, sizePx));
  }

  /** The full-size original of an avatar, for the "view this chat's picture"
   *  lightbox. Same trust rules as the thumbnail path: an avatar has no event
   *  to declare a mimetype, so the bytes are sniffed and anything that is not
   *  a known raster format is refused rather than rendered. */
  avatarOriginalUrl(mxc: string): Promise<string> {
    if (!mxc.startsWith('mxc://')) return Promise.reject(new MatrixError(0, '', 'Not a media address.'));
    return this.cached(cacheKey('avatar', `${mxc}|orig`), () => this.downloadThumbnail(mxc, undefined));
  }

  /** Register bytes we already hold (the file we are about to upload) under
   *  the mxc URI the server just gave it, so our own local echo renders
   *  instantly instead of downloading back what we just sent. */
  seed(kind: MediaKind, mxc: string, blob: Blob): void {
    const key = cacheKey(kind, mxc);
    if (this.destroyed || !mxc || this.urls.has(key)) return;
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
    return this.putImage(o, bytes, sniffed);
  }

  /** The general "send this file" path: a picture if the bytes are one, an
   *  `m.file` otherwise. Everything a reader sees about a non-picture — its
   *  name, its declared type — is metadata; the bytes themselves are never
   *  inspected, because nothing here will ever decode them. Throws a
   *  `MatrixError` with a display-ready message on every failure path. */
  async uploadAttachment(o: {
    file: File;
    encrypt: boolean;
    onProgress?: (fraction: number) => void;
    signal?: AbortSignal;
  }): Promise<MxAttachmentContent> {
    if (o.file.size > MAX_FILE_BYTES) {
      throw new MatrixError(0, '', `That file is too big (limit ${Math.floor(MAX_FILE_BYTES / 1024 / 1024)} MB).`);
    }
    const bytes = new Uint8Array(await o.file.arrayBuffer());
    const sniffed = sniffImage(bytes);
    if (sniffed) {
      // A picture goes out as `m.image` so every client shows it inline — and
      // therefore has to fit the (lower) picture cap, or we would send a row
      // our own timeline then refuses to download.
      if (bytes.byteLength > MAX_IMAGE_BYTES) {
        throw new MatrixError(
          0,
          '',
          `That picture is too big (limit ${Math.floor(MAX_IMAGE_BYTES / 1024 / 1024)} MB).`,
        );
      }
      return this.putImage(o, bytes, sniffed);
    }

    const mimetype = declaredType(o.file.type);
    const name = sanitizeFilename(o.file.name, 'file');
    const info: MxFileInfo = { mimetype, size: bytes.byteLength };
    const where = await this.put({ ...o, bytes, name, mimetype, kind: 'file' });
    return { msgtype: 'm.file', body: name, info, ...where };
  }

  destroy(): void {
    this.destroyed = true;
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear();
    this.inflight.clear();
  }

  // ---- cache -------------------------------------------------------------

  /** One download per key, shared by concurrent callers and kept for the
   *  session. Every public resolver above is this plus a loader. */
  private cached(key: string, load: () => Promise<string>): Promise<string> {
    const hit = this.urls.get(key);
    if (hit) return Promise.resolve(hit);
    const running = this.inflight.get(key);
    if (running) return running;

    const p = load()
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

  // ---- upload ------------------------------------------------------------

  /** Shared tail of both upload paths: build the `m.image` content around
   *  bytes that have already been sniffed. */
  private async putImage(
    o: { file: File; encrypt: boolean; onProgress?: (fraction: number) => void; signal?: AbortSignal },
    bytes: Uint8Array,
    sniffed: NonNullable<SniffedImage>,
  ): Promise<MxImageContent> {
    const info: MxImageInfo = {
      // From the bytes, not from File.type — this is what every other client
      // will believe about the attachment.
      mimetype: sniffed.mimetype,
      size: bytes.byteLength,
      w: sniffed.w,
      h: sniffed.h,
    };
    const name = sanitizeFilename(o.file.name, DEFAULT_NAMES[sniffed.mimetype] ?? 'image');
    const where = await this.put({ ...o, bytes, name, mimetype: sniffed.mimetype, kind: 'img' });
    return { msgtype: 'm.image', body: name, info, ...where };
  }

  /** Put the bytes on the server and return whichever of `url` / `file` the
   *  event should carry, seeding the cache so our own echo needs no download. */
  private async put(o: {
    file: File;
    bytes: Uint8Array;
    name: string;
    mimetype: string;
    kind: MediaKind;
    encrypt: boolean;
    onProgress?: (fraction: number) => void;
    signal?: AbortSignal;
  }): Promise<{ url?: string; file?: MxEncryptedFile }> {
    const progressHandler = (p: { loaded: number; total: number }): void =>
      o.onProgress?.(p.total ? p.loaded / p.total : 0);
    try {
      if (o.encrypt) {
        const { ciphertext, file } = await encryptAttachment(bufferOf(o.bytes));
        const res = await this.client.uploadContent(new Blob([ciphertext], { type: 'application/octet-stream' }), {
          // The name and the real type are both metadata the server has no
          // business seeing for an encrypted attachment — the filename lives
          // in the (encrypted) event body instead.
          includeFilename: false,
          type: 'application/octet-stream',
          abortController: toAbortController(o.signal),
          progressHandler,
        });
        this.seedUploaded(o, res.content_uri);
        return { file: { ...file, url: res.content_uri } };
      }

      // The original File, not the bytes we read: the SDK streams it, and it is
      // the same content either way.
      const res = await this.client.uploadContent(o.file, {
        name: o.name,
        type: o.mimetype,
        abortController: toAbortController(o.signal),
        progressHandler,
      });
      this.seedUploaded(o, res.content_uri);
      return { url: res.content_uri };
    } catch (err) {
      throw uploadError(err, o.kind === 'img' ? 'picture' : 'file');
    }
  }

  private seedUploaded(o: { bytes: Uint8Array; mimetype: string; kind: MediaKind }, mxc: string): void {
    // Same rule as the download side: a file's blob is opaque, only a picture
    // gets a real type.
    const type = o.kind === 'img' ? o.mimetype : 'application/octet-stream';
    this.seed(o.kind, mxc, new Blob([bufferOf(o.bytes)], { type }));
  }

  // ---- download ----------------------------------------------------------

  private async download(content: MxImageContent): Promise<string> {
    const mxc = mediaKeyOf(content);
    const buf = await this.fetchMedia(mxc, { cap: MAX_IMAGE_BYTES, what: 'picture' });
    const plain = content.file ? await decryptAttachment(buf, content.file) : buf;
    // See the file header: the type is the event's claim, allowlisted — never
    // the server's Content-Type.
    const type = RENDERABLE_TYPES.has(content.info.mimetype) ? content.info.mimetype : 'application/octet-stream';
    return URL.createObjectURL(new Blob([plain], { type }));
  }

  private async downloadFile(content: MxFileContent): Promise<string> {
    const mxc = mediaKeyOf(content);
    const buf = await this.fetchMedia(mxc, { cap: MAX_DOWNLOAD_BYTES, what: 'file' });
    const plain = content.file ? await decryptAttachment(buf, content.file) : buf;
    // Always opaque, never `info.mimetype`: this blob's only destination is a
    // `download` link, and a type is the one thing that could turn a saved
    // file into something the browser renders in place instead.
    return URL.createObjectURL(new Blob([plain], { type: 'application/octet-stream' }));
  }

  private async downloadVideo(content: MxFileContent): Promise<string> {
    const mxc = mediaKeyOf(content);
    const buf = await this.fetchMedia(mxc, { cap: MAX_DOWNLOAD_BYTES, what: 'video' });
    const plain = content.file ? await decryptAttachment(buf, content.file) : buf;
    // The event's claim, allowlisted — never the server's Content-Type (see the
    // file header). `videoUrl` already refused anything else, so this cannot
    // fall through in practice; it stays because the fallback is what makes the
    // rule true of this function rather than of one caller.
    const type = isPlayableVideo(content) ? content.info.mimetype : 'application/octet-stream';
    return URL.createObjectURL(new Blob([plain], { type }));
  }

  /** `sizePx` undefined means the original, un-thumbnailed bytes — still
   *  capped and still sniffed like any thumbnail. */
  private async downloadThumbnail(mxc: string, sizePx: number | undefined): Promise<string> {
    const buf = await this.fetchMedia(mxc, { cap: MAX_IMAGE_BYTES, what: 'picture', thumbPx: sizePx });
    // No event to declare a mimetype for an avatar, so it is sniffed from the
    // bytes. Anything unrecognised (an SVG the server couldn't thumbnail, an
    // error page) is refused outright — the caller keeps its initials square.
    const type = sniffImageType(new Uint8Array(buf));
    if (!type) throw new MatrixError(0, '', 'Not a displayable picture.');
    return URL.createObjectURL(new Blob([buf], { type }));
  }

  /** Authenticated media (Matrix 1.11+) first, falling back to the legacy
   *  unauthenticated route only when the server says it doesn't know the new
   *  one. The access token goes in a header, never in a query string, so it
   *  can't end up in a server log or a Referer. */
  private async fetchMedia(mxc: string, o: { cap: number; what: string; thumbPx?: number }): Promise<ArrayBuffer> {
    const token = this.client.getAccessToken();
    // Passing width/height switches mxcUrlToHttp to the /thumbnail route;
    // 'crop' is what makes a square out of a non-square avatar (the default,
    // 'scale', letterboxes it).
    const thumbPx = o.thumbPx;
    const method = thumbPx === undefined ? undefined : 'crop';
    const authUrl = this.client.mxcUrlToHttp(mxc, thumbPx, thumbPx, method, false, true, true);
    if (authUrl && token) {
      const res = await doFetch(authUrl, { Authorization: `Bearer ${token}` }, o.what);
      if (res.ok) return readCapped(res, o);
      if (res.status !== 400 && res.status !== 404 && res.status !== 401) throw mediaError(res.status, o.what);
    }
    const legacyUrl = this.client.mxcUrlToHttp(mxc, thumbPx, thumbPx, method, false, true, false);
    if (!legacyUrl) throw new MatrixError(0, '', `This ${o.what} has an address this client cannot read.`);
    const res = await doFetch(legacyUrl, {}, o.what);
    if (!res.ok) throw mediaError(res.status, o.what);
    return readCapped(res, o);
  }
}

/** Which flavour of blob a cache entry holds — the cache is keyed by it (see
 *  `attachmentUrl`), and it decides the blob's type on both the upload-seed and
 *  the download side. */
type MediaKind = 'img' | 'file' | 'video' | 'avatar';

function cacheKey(kind: MediaKind, id: string): string {
  return `${kind}|${id}`;
}

// ---------------------------------------------------------------- helpers

function toAbortController(signal?: AbortSignal): AbortController | undefined {
  if (!signal) return undefined;
  const ac = new AbortController();
  if (signal.aborted) ac.abort();
  else signal.addEventListener('abort', () => ac.abort(), { once: true });
  return ac;
}

/** An `ArrayBuffer` holding exactly these bytes — WebCrypto and `Blob` both
 *  take the whole buffer, so a view into a larger one has to be copied. */
function bufferOf(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) return bytes.buffer as ArrayBuffer;
  return bytes.slice().buffer as ArrayBuffer;
}

async function doFetch(url: string, headers: Record<string, string>, what: string): Promise<Response> {
  try {
    return await fetch(url, { headers, credentials: 'omit', referrerPolicy: 'no-referrer' });
  } catch {
    throw new MatrixError(0, '', `Couldn't reach the homeserver to load this ${what}.`);
  }
}

async function readCapped(res: Response, o: { cap: number; what: string }): Promise<ArrayBuffer> {
  const tooBig = new MatrixError(
    0,
    '',
    `That ${o.what} is larger than this client will download (limit ${Math.floor(o.cap / 1024 / 1024)} MB).`,
  );
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > o.cap) throw tooBig;
  const buf = await res.arrayBuffer();
  if (buf.byteLength > o.cap) throw tooBig;
  return buf;
}

function mediaError(status: number, what: string): MatrixError {
  if (status === 404) return new MatrixError(404, 'M_NOT_FOUND', `This ${what} is no longer on the server.`);
  if (status === 403) return new MatrixError(403, 'M_FORBIDDEN', `You don't have access to this ${what}.`);
  return new MatrixError(status, '', `Couldn't load this ${what}.`);
}

function uploadError(err: unknown, what: string): MatrixError {
  const e = MatrixError.from(err);
  if (e.errcode === 'M_TOO_LARGE') {
    return new MatrixError(e.status, e.errcode, `The homeserver rejected that ${what} as too large.`);
  }
  if (e.errcode === 'M_FORBIDDEN') {
    return new MatrixError(e.status, e.errcode, "The homeserver won't accept uploads from this account.");
  }
  if (e.isNetwork) return new MatrixError(0, '', `Couldn't reach the homeserver to upload that ${what}.`);
  return e;
}

const DEFAULT_NAMES: Record<string, string> = {
  'image/png': 'image.png',
  'image/jpeg': 'image.jpg',
  'image/gif': 'image.gif',
};

/** Filenames travel to other clients and (unencrypted) to the server, and end
 *  up in a `download` attribute here. Keep them to a plain basename; a
 *  clipboard paste often carries no name at all, hence the caller's fallback. */
function sanitizeFilename(name: string, fallback: string): string {
  const base = name.split(/[/\\]/).pop() ?? '';
  // Strip C0/C1 controls (including the newlines that would break a header or
  // a one-line UI row) rather than trusting whatever the OS picker handed us.
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return clean.slice(0, 120) || fallback;
}

/** A syntactically valid MIME type. */
const MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,62}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,62}$/;

/** Markup and scriptable document types. Nothing here *renders* an
 *  attachment's claimed type (see the file header), but `info.mimetype` is also
 *  how every other client decides what to do with the bytes — so an upload from
 *  here never volunteers "this is a document you should execute" on the user's
 *  behalf just because the OS attached that type to the file. The bytes go out
 *  unchanged either way; only the claim is downgraded. */
const UNSAFE_DECLARED_TYPES = new Set([
  'image/svg+xml',
  'text/html',
  'text/xml',
  'application/xml',
  'application/xhtml+xml',
  'text/javascript',
  'application/javascript',
]);

/** What the event will claim a non-picture attachment is: the OS's guess when
 *  it is a plausible and inert type, opaque bytes otherwise. */
function declaredType(fileType: string): string {
  const type = fileType.trim().toLowerCase().split(';')[0]?.trim() ?? '';
  if (!MIME_RE.test(type) || UNSAFE_DECLARED_TYPES.has(type)) return 'application/octet-stream';
  return type;
}
