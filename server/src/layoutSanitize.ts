/**
 * Content checks applied to a layout blob right before it's persisted —
 * shared by every write path (the live save/save-as messages in SimRoom.ts,
 * and the offline Tiled import in tiled/zoneImport.ts) so a saved layout
 * means the same thing regardless of where it came from. Furniture/tiles
 * otherwise have no content check at all; this mirrors the client's own
 * caps (LayoutEditor's Text tool, Action chooser) in case a client is
 * patched, or a hand-edited .tmj carries something malformed.
 */
import {
  MAX_TEXT_LABEL_LEN,
  MAX_TEXT_LABELS,
  MAX_PLACED_IMAGES,
  MAX_IMAGE_FOOTPRINT_TILES,
  TEXT_LABEL_DEFAULT_FONT_SIZE,
  MAX_NAME_LEN,
  clampTextLabelFontSize,
  sanitizeTextLabelFontFamily,
  cleanName,
} from '@pixel/shared';
// TILE_SIZE from the engine's own constants, not the barrel: the barrel used to
// re-export a second copy from the pre-Tiled worldConfig, and this import was
// silently taking that one (same value, but the wrong source).
import { TILE_SIZE } from '@pixel/shared/office/constants.js';
import type { Action } from '@pixel/shared/office/types.js';

/** Cap a saved layout's free-text labels (OfficeLayout.texts) to a sane
 *  length/count before it's persisted. Mutates and returns the same object;
 *  other fields pass through untouched. */
export function sanitizeLayoutTexts(layout: Record<string, unknown>): Record<string, unknown> {
  const texts = layout.texts;
  if (!Array.isArray(texts)) return layout;
  const clean: Array<{ uid: string; x: number; y: number; text: string; fontSize?: number; fontFamily?: string; angle?: number; color?: string }> = [];
  for (const t of texts) {
    if (clean.length >= MAX_TEXT_LABELS) break;
    if (!t || typeof t !== 'object') continue;
    const rec = t as Record<string, unknown>;
    if (typeof rec.uid !== 'string' || typeof rec.x !== 'number' || typeof rec.y !== 'number') continue;
    if (!Number.isFinite(rec.x) || !Number.isFinite(rec.y)) continue;
    const text = cleanName(rec.text, MAX_TEXT_LABEL_LEN);
    if (!text) continue;
    const entry: (typeof clean)[number] = {
      uid: rec.uid,
      x: rec.x,
      y: rec.y,
      text,
    };
    if (rec.fontSize !== undefined) {
      const size = clampTextLabelFontSize(rec.fontSize);
      if (size !== TEXT_LABEL_DEFAULT_FONT_SIZE) entry.fontSize = size;
    }
    const fontFamily = sanitizeTextLabelFontFamily(rec.fontFamily);
    if (fontFamily) entry.fontFamily = fontFamily;
    if (typeof rec.angle === 'number' && Number.isFinite(rec.angle)) {
      const angle = ((rec.angle % 360) + 360) % 360;
      if (angle !== 0) entry.angle = angle;
    }
    if (typeof rec.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(rec.color)) entry.color = rec.color;
    clean.push(entry);
  }
  layout.texts = clean;
  return layout;
}

/** Cap a saved layout's placed background images (OfficeLayout.images) — same
 *  kind of save-time content check as sanitizeLayoutTexts. Doesn't check that
 *  imageId references an existing uploaded image (same as furniture types
 *  aren't checked against the catalog here either) — the renderer already
 *  has to tolerate a missing reference (a deleted image, a stale layout). */
export function sanitizeLayoutImages(layout: Record<string, unknown>): Record<string, unknown> {
  const images = layout.images;
  if (!Array.isArray(images)) return layout;
  const MAX_DIMENSION_PX = MAX_IMAGE_FOOTPRINT_TILES * TILE_SIZE;
  const clean: Array<{
    uid: string;
    x: number;
    y: number;
    width: number;
    height: number;
    imageId: string;
    src?: string;
    flippedHorizontally?: boolean;
    flippedVertically?: boolean;
    angle?: number;
    opacity?: number;
  }> = [];
  for (const img of images) {
    if (clean.length >= MAX_PLACED_IMAGES) break;
    if (!img || typeof img !== 'object') continue;
    const rec = img as Record<string, unknown>;
    if (typeof rec.uid !== 'string' || typeof rec.x !== 'number' || typeof rec.y !== 'number') continue;
    if (!Number.isFinite(rec.x) || !Number.isFinite(rec.y)) continue;
    if (typeof rec.imageId !== 'string' || !rec.imageId) continue;
    const w = Number(rec.width);
    const h = Number(rec.height);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0 || w > MAX_DIMENSION_PX || h > MAX_DIMENSION_PX) continue;
    const entry: (typeof clean)[number] = { uid: rec.uid, x: rec.x, y: rec.y, width: w, height: h, imageId: rec.imageId };
    // WHERE the picture is (layout v3). This list is a whitelist, so a field missing from it
    // is silently dropped on every write path — which is what happened to `src` when images
    // became files: the import kept working, the renderer then skipped every image for want
    // of a path, and a map's pictures simply stopped appearing.
    //
    // Validated rather than copied, because a pushed map is untrusted input and this string
    // becomes a URL the client fetches: a relative path under assets/tiled, no traversal, no
    // scheme, and an image extension.
    if (typeof rec.src === 'string' && isSafeAssetPath(rec.src)) entry.src = rec.src;
    if (rec.flippedHorizontally === true) entry.flippedHorizontally = true;
    if (rec.flippedVertically === true) entry.flippedVertically = true;
    // Normalized, not just type-checked, for the same reason opacity is clamped below:
    // this list is a whitelist, and a NaN or a 1e9 angle would reach a renderer that then
    // draws the picture somewhere nobody placed it.
    const ang = Number(rec.angle);
    if (Number.isFinite(ang) && ang % 360 !== 0) entry.angle = ((ang % 360) + 360) % 360;
    // Clamped, not just type-checked: this list is a whitelist, so an opacity
    // outside 0..1 (or NaN) must not reach a renderer that would make the image
    // invisible or draw it out of range.
    const op = Number(rec.opacity);
    if (Number.isFinite(op) && op >= 0 && op < 1) entry.opacity = op;
    clean.push(entry);
  }
  layout.images = clean;
  return layout;
}

/** A path to a picture inside `assets/tiled`, as PlacedImage.src carries it. Relative,
 *  no traversal, no scheme or protocol-relative host, an image extension, and bounded —
 *  the client turns it straight into a fetch. */
function isSafeAssetPath(p: string): boolean {
  if (p.length === 0 || p.length > 200) return false;
  if (p.startsWith('/') || p.startsWith('\\')) return false;
  if (p.includes('..') || p.includes('\\') || p.includes('://') || p.includes('\0')) return false;
  return /\.(png|jpg|jpeg|gif|webp)$/i.test(p);
}

const MAX_IFRAME_URL_LEN = 500;

/** Parse+validate one Action (from an untrusted save payload) — https://
 *  only for iframe, closed sets of literal kinds elsewhere. Returns null for
 *  anything malformed (dropped, not defaulted). */
export function sanitizeAction(raw: unknown): Action | null {
  if (!raw || typeof raw !== 'object') return null;
  const rec = raw as Record<string, unknown>;
  switch (rec.kind) {
    case 'meetingRoom': {
      // Same cap as every other user-entered name (32 chars, whitespace collapsed,
      // trimmed — see cleanName), applied here too and not only at import: this
      // runs on every write path, and the value ends up as a window title.
      const meetingRoomName = cleanName(rec.meetingRoomName, MAX_NAME_LEN);
      return { kind: 'meetingRoom', video: rec.video !== false, ...(meetingRoomName ? { meetingRoomName } : {}) };
    }
    case 'meetingManager':
      return { kind: 'meetingManager' };
    case 'iframe': {
      const url = typeof rec.url === 'string' ? rec.url.trim().slice(0, MAX_IFRAME_URL_LEN) : '';
      return url.startsWith('https://') ? { kind: 'iframe', url } : null;
    }
    case 'appliance':
      return rec.pose === 'coffee' ? { kind: 'appliance', pose: 'coffee' } : null;
    case 'arcade':
      return { kind: 'arcade' };
    case 'timeClock':
      return { kind: 'timeClock' };
    case 'portal':
      return { kind: 'portal' };
    case 'toggle':
      return { kind: 'toggle' };
    case 'spawnPoint':
      return { kind: 'spawnPoint' };
    default:
      return null;
  }
}

/** Validate/clamp a saved layout's tile actions (OfficeLayout.tileActions)
 *  and any per-instance furniture action overrides — the same kind of
 *  save-time content check as sanitizeLayoutTexts, for the same reason
 *  (furniture/tiles otherwise have none; this mirrors the client's own
 *  Action-tool validation in case a client is patched or malicious).
 *  Mutates and returns the same object; other fields pass through untouched. */
export function sanitizeLayoutActions(layout: Record<string, unknown>): Record<string, unknown> {
  const cols = typeof layout.cols === 'number' ? layout.cols : 0;
  const rows = typeof layout.rows === 'number' ? layout.rows : 0;
  const tileActions = layout.tileActions;
  if (Array.isArray(tileActions)) {
    const total = cols * rows;
    const clean: Array<Action | null> = new Array(total).fill(null);
    for (let i = 0; i < Math.min(total, tileActions.length); i++) clean[i] = sanitizeAction(tileActions[i]);
    layout.tileActions = clean;
  }
  const furniture = layout.furniture;
  if (Array.isArray(furniture)) {
    const SIDES = new Set(['N', 'S', 'E', 'W']);
    for (const item of furniture) {
      if (!item || typeof item !== 'object') continue;
      const rec = item as Record<string, unknown>;
      if (rec.action !== undefined) {
        const action = sanitizeAction(rec.action);
        if (action) rec.action = action;
        else delete rec.action;
      }
      if (rec.approachSides !== undefined) {
        const sides = Array.isArray(rec.approachSides)
          ? [...new Set(rec.approachSides.filter((s): s is string => typeof s === 'string' && SIDES.has(s)))]
          : [];
        if (sides.length > 0) rec.approachSides = sides;
        else delete rec.approachSides;
      }
      if (rec.approachThrough !== undefined) {
        if (rec.approachThrough === true) rec.approachThrough = true;
        else delete rec.approachThrough;
      }
    }
  }
  return layout;
}
