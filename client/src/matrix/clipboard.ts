/**
 * Matrix chat panel: clipboard helpers.
 *
 * Both helpers speak the async Clipboard API only — `document.execCommand` is
 * deprecated in both browsers and this app always runs in a secure context
 * (TLS in the browser, `app://` on the desktop), which is the API's one
 * requirement. Every failure is rethrown as a display-ready message, matching
 * the media/store convention: callers show `err.message`, never a raw
 * DOMException.
 */

export async function copyText(text: string): Promise<void> {
  if (!navigator.clipboard?.writeText) {
    throw new Error("This browser doesn't offer clipboard access here.");
  }
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    throw new Error("Couldn't copy — the browser refused clipboard access.");
  }
}

/**
 * Copy a picture to the clipboard. Takes a *loader* rather than a blob so the
 * `ClipboardItem` can be constructed synchronously inside the user's click:
 * Chrome accepts a Promise as the item's value, which keeps a copy that still
 * has to download/decrypt/re-encode inside the gesture's transient-activation
 * window. Firefox (≤ current) rejects Promise values with a TypeError, so that
 * path falls back to resolving the bytes first and writing once more — fine
 * there, because Firefox's activation window survives the await.
 */
export async function copyImage(load: () => Promise<Blob>): Promise<void> {
  if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) {
    throw new Error("This browser can't copy pictures to the clipboard.");
  }
  const refused = new Error("Couldn't copy the picture — the browser refused clipboard access.");
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': load().then(asPng) })]);
    return;
  } catch (e) {
    if (!(e instanceof TypeError)) throw refused;
  }
  const blob = await asPng(await load());
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
  } catch {
    throw refused;
  }
}

/** Chrome's clipboard takes only `image/png`, so a JPEG/GIF is re-encoded
 *  through a canvas (a GIF loses its animation — a clipboard holds one frame
 *  anyway). PNG bytes pass through untouched. */
async function asPng(blob: Blob): Promise<Blob> {
  if (blob.type === 'image/png') return blob;
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(blob);
  } catch {
    throw new Error("Couldn't decode this picture to copy it.");
  }
  const canvas = document.createElement('canvas');
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    bmp.close();
    throw new Error("Couldn't re-encode this picture to copy it.");
  }
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (png) => (png ? resolve(png) : reject(new Error("Couldn't re-encode this picture to copy it."))),
      'image/png',
    );
  });
}
