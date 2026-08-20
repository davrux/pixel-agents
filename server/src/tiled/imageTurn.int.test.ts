/**
 * A placed picture can be turned to any angle — and the angle has to survive being saved.
 *
 * Images are the easy half of rotation: a free pixel box, no cells, no behaviour, so unlike
 * furniture there is nothing to refuse and no footprint to keep in step. Two things can still
 * go wrong quietly, and both are pinned here.
 *
 * The first is the PIVOT. Tiled documents an object's rotation as "clockwise around (x, y)",
 * and for a tile object that point is the bottom-left corner of the unrotated box — so the
 * layout keeps storing the unrotated box and the renderer turns it around that corner. Store
 * a rotated bounding box instead and nudging the angle in Tiled would move the picture.
 *
 * The second is the SANITIZER. Every layout is rewritten field by field before it is
 * persisted (`sanitizeLayoutImages` builds a whitelist), so a new field that nobody adds
 * there is silently dropped on the way to the database — the map would look right after the
 * import and wrong after a restart.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';

import { TILE_SIZE } from '@pixel/shared/office/constants';

import { sanitizeLayoutImages } from '../layoutSanitize.js';
import { ASSETS_ROOT } from '../assets.js';
import { importTmjToLayout } from './mapBridge.js';
import { loadTiledRegistry } from './tiledRegistry.js';

const registry = loadTiledRegistry(ASSETS_ROOT);
const noImages = (): null => null;

/** One image object, at Tiled's bottom-left anchor, turned `rotation`. */
function mapWith(rotation: number): Record<string, unknown> {
  const set = registry.bySource('images.tsj');
  assert.ok(set, 'assets/tiled/images.tsj is not on disk');
  return {
    width: 20,
    height: 20,
    tilesets: [{ firstgid: 1, source: '../images.tsj' }],
    layers: [
      {
        class: 'ImageLayer',
        name: 'Images',
        type: 'objectgroup',
        objects: [
          {
            id: 1,
            gid: 1,
            x: 4 * TILE_SIZE,
            y: 8 * TILE_SIZE,
            width: 6 * TILE_SIZE,
            height: 4 * TILE_SIZE,
            visible: true,
            rotation,
            name: '',
          },
        ],
      },
    ],
  };
}

test('an image keeps any angle, not just a quarter turn', () => {
  for (const rotation of [37, 90, 180, 270, 359]) {
    const { layout } = importTmjToLayout(mapWith(rotation), registry, noImages);
    const img = layout.images?.[0];
    assert.ok(img, `${rotation}°: the image did not survive the import`);
    assert.equal(img.angle, rotation, `${rotation}° must be kept as it is`);
  }
});

test('the stored box is the UNROTATED one, so the pivot stays Tiled\'s own', () => {
  const upright = importTmjToLayout(mapWith(0), registry, noImages).layout.images?.[0];
  const turned = importTmjToLayout(mapWith(90), registry, noImages).layout.images?.[0];
  assert.ok(upright && turned);
  assert.deepEqual(
    { x: turned.x, y: turned.y, width: turned.width, height: turned.height },
    { x: upright.x, y: upright.y, width: upright.width, height: upright.height },
    'turning must not move or resize the stored box — the renderer pivots at (x, y + height)',
  );
  assert.equal(upright.angle, undefined, 'and an upright image carries no angle at all');
});

test('a negative or over-full turn is normalized', () => {
  assert.equal(importTmjToLayout(mapWith(-90), registry, noImages).layout.images?.[0]?.angle, 270);
  assert.equal(importTmjToLayout(mapWith(450), registry, noImages).layout.images?.[0]?.angle, 90);
  assert.equal(importTmjToLayout(mapWith(360), registry, noImages).layout.images?.[0]?.angle, undefined);
});

test('the path to the picture survives the save — the field the whitelist forgot', () => {
  // Found while verifying the rotation, and older than it: `src` (layout v3, "a map's
  // pictures are files") was never added to this whitelist, so every write path stripped it
  // and the renderer skipped every image for want of a path. uponu's own logo was not being
  // drawn. Pinned here because the failure is invisible — the import reports the image, the
  // layout carries it, and only the picture is missing.
  const kept = sanitizeLayoutImages({
    images: [{ uid: 'a', x: 0, y: 0, width: 32, height: 32, imageId: 'x', src: 'png/src/images/x.png' }],
  }).images as Array<{ src?: string }>;
  assert.equal(kept[0].src, 'png/src/images/x.png', 'without this the picture is never fetched');

  // It becomes a URL the client fetches, and a pushed map is untrusted: only a relative
  // path to an image inside assets/tiled survives.
  for (const bad of [
    '../../etc/passwd',
    '/etc/passwd',
    'https://evil.example/x.png',
    '//evil.example/x.png',
    'png/src/images/x.svg',
    'png/src/images/x.png.js',
    '',
    'a'.repeat(201) + '.png',
  ]) {
    const out = sanitizeLayoutImages({
      images: [{ uid: 'a', x: 0, y: 0, width: 32, height: 32, imageId: 'x', src: bad }],
    }).images as Array<{ src?: string }>;
    assert.equal(out[0].src, undefined, `"${bad.slice(0, 40)}" must not reach a fetch`);
  }
});

test('the angle survives the save, and nonsense does not', () => {
  // The whitelist is the point: a field nobody names here never reaches the database.
  const kept = sanitizeLayoutImages({
    images: [{ uid: 'a', x: 0, y: 0, width: 32, height: 32, imageId: 'x', angle: 90 }],
  }).images as Array<{ angle?: number }>;
  assert.equal(kept[0].angle, 90, 'a valid angle must be persisted');

  const normalized = sanitizeLayoutImages({
    images: [{ uid: 'a', x: 0, y: 0, width: 32, height: 32, imageId: 'x', angle: -90 }],
  }).images as Array<{ angle?: number }>;
  assert.equal(normalized[0].angle, 270, 'and normalized like the import does');

  for (const bogus of [Number.NaN, Infinity, 'sideways', null, 360]) {
    const out = sanitizeLayoutImages({
      images: [{ uid: 'a', x: 0, y: 0, width: 32, height: 32, imageId: 'x', angle: bogus }],
    }).images as Array<{ angle?: number }>;
    assert.equal(out[0].angle, undefined, `${String(bogus)} must not reach a renderer`);
  }
});
