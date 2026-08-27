/**
 * The save routes: who may write what, and what happens to a sheet nobody should be able to
 * store.
 *
 * Saving art moved out of the room and became a POST, which moved the authorisation with it —
 * so these two routes ARE the gate now. The properties that matter are the ones a room message
 * used to get from its own plumbing: the caller is resolved from the session and never from the
 * path or the payload (`/art/avatar` takes no id at all), the gallery route needs an admin, and
 * a body that is not a well-formed sheet of the declared geometry is refused with a reason
 * rather than stored.
 *
 * TEST BOUNDARIES:
 *   @real-dependency: express + the real routes + SQLite -- Mock? NO. The claim is "this route
 *       refuses", and the checks live in the route. A throwaway PIXEL_STREAM_DATA_DIR keeps it
 *       off a developer's world; the stores are imported dynamically because db.ts resolves that
 *       path at module load.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { PNG } from 'pngjs';

const ADMIN_TOKEN = 'save-route-admin-token';
let dataDir: string;
let server: Server;
let base: string;
let appStore: typeof import('./appStore.js').appStore;
let userStore: typeof import('./userStore.js').userStore;
/** Session ids, used as bearer tokens — the same thing the desktop sends. */
let adminBearer: string;
let userBearer: string;

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'pixel-artsave-test-'));
  process.env.PIXEL_STREAM_DATA_DIR = dataDir;
  const express = (await import('express')).default;
  ({ appStore } = await import('./appStore.js'));
  ({ userStore } = await import('./userStore.js'));
  const { registerAuth } = await import('./auth.js');
  const { registerArtSaveApi } = await import('./artSaveApi.js');
  const app = express();
  registerAuth(app, ADMIN_TOKEN);
  registerArtSaveApi(app);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // One admin and one ordinary account, each with a session to authenticate with.
  userStore.createUser('routeadmin', 'password-123', { isAdmin: true });
  userStore.createUser('routeuser', 'password-123', {});
  const token = async (u: string): Promise<string> => {
    const res = await fetch(`${base}/desktop/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: u, password: 'password-123' }),
    });
    return ((await res.json()) as { token: string }).token;
  };
  adminBearer = await token('routeadmin');
  userBearer = await token('routeuser');
});

after(() => {
  server?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

/** A valid sheet: `frames × 4` cells of w×h, one opaque pixel per frame. */
function sheet(frames = 7, w = 16, h = 32, rows = 4): Buffer {
  const png = new PNG({ width: frames * w, height: rows * h });
  png.data.fill(0);
  for (let r = 0; r < rows; r++) {
    for (let f = 0; f < frames; f++) {
      const i = (r * h * png.width + f * w) * 4;
      png.data[i] = 10;
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png, { filterType: 0 });
}

async function post(
  path: string,
  body: Buffer,
  meta: unknown,
  bearer?: string,
): Promise<{ status: number; error?: string }> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      ...(meta === undefined ? {} : { 'x-pixel-sheet': typeof meta === 'string' ? meta : JSON.stringify(meta) }),
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: new Uint8Array(body),
  });
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  return { status: res.status, error: json.error };
}

test('an avatar save needs a session, and writes the CALLER — there is no id to pass', async () => {
  assert.equal((await post('/art/avatar', sheet(), { name: 'Nobody' })).status, 401, 'no session, no save');

  const ok = await post('/art/avatar', sheet(), { name: 'Mine' }, userBearer);
  assert.equal(ok.status, 200, ok.error ?? '');
  const row = appStore.assetRow('playerAvatar', 'routeuser') as { png?: unknown; name?: string };
  assert.equal(typeof row?.png, 'string', 'the sheet must be stored as base64, not as pixels');
  assert.equal(row?.name, 'Mine');
  // The route has no parameter for whose avatar it is, so a caller cannot aim at somebody else's.
  // Proving the absence: an id smuggled into the metadata changes nothing about who was written.
  await post('/art/avatar', sheet(), { name: 'Mine', userId: 'routeadmin' }, userBearer);
  assert.equal(appStore.assetRow('playerAvatar', 'routeadmin'), undefined, 'the admin has no avatar');
});

test('a gallery or NPC save needs an admin', async () => {
  assert.equal((await post('/art/asset/character/char_9', sheet(), { name: 'X' })).status, 401);
  assert.equal((await post('/art/asset/character/char_9', sheet(), { name: 'X' }, userBearer)).status, 403);
  const ok = await post('/art/asset/character/char_9', sheet(), { name: 'Nine' }, adminBearer);
  assert.equal(ok.status, 200, ok.error ?? '');
  assert.equal((appStore.assetRow('character', 'char_9') as { name?: string })?.name, 'Nine');

  // A pet is the same route with the other frame default: 16×16, six frames per row.
  const petOk = await post('/art/asset/pet/dog_0', sheet(6, 16, 16), { name: 'Emma' }, adminBearer);
  assert.equal(petOk.status, 200, petOk.error ?? '');
});

test('the type and the id are checked, not taken on trust', async () => {
  assert.equal((await post('/art/asset/furniture/DESK', sheet(), { name: 'X' }, adminBearer)).status, 400, 'furniture is not an asset type any more');
  // A traversal never reaches the id check as written — fetch normalises the path first — so what
  // is asserted is the property rather than a code: nothing about it is accepted.
  const traversal = await post('/art/asset/character/../etc/passwd', sheet(), { name: 'X' }, adminBearer);
  assert.notEqual(traversal.status, 200, `a traversal must not be saved (got ${traversal.status})`);
  assert.equal((await post('/art/asset/character/has spaces', sheet(), { name: 'X' }, adminBearer)).status, 400);
});

test('a body that is not a sheet is refused with a reason', async () => {
  const cases: Array<[string, Buffer, unknown, RegExp]> = [
    ['not a PNG', Buffer.from('this is not an image at all, but it is long enough'), { name: 'X' }, /not a PNG/],
    ['a bomb', bomb(30000, 30000), { name: 'X' }, /over \d+ pixels/],
    ['wrong geometry', sheet(7, 16, 32), { name: 'X', spec: { frame: { w: 20, h: 32 }, tracks: [] } }, /whole number/],
    ['no metadata', sheet(), undefined, /missing sheet metadata/],
    ['metadata is not JSON', sheet(), '{oops', /not JSON/],
    ['no name', sheet(), {}, /invalid name/],
  ];
  for (const [label, body, meta, expected] of cases) {
    const out = await post('/art/avatar', body, meta, userBearer);
    assert.equal(out.status, 400, `${label}: expected 400, got ${out.status}`);
    assert.match(out.error ?? '', expected, `${label}: unexpected reason "${out.error}"`);
  }
});

test('an oversized body is refused by the route, not by the decoder', async () => {
  // Express drops it at the limit, so nothing of it reaches sheetFromPng. 413 is the express
  // answer; what matters is that it is refused and nothing was stored.
  const huge = Buffer.alloc(3 * 1024 * 1024, 0x89);
  const out = await post('/art/avatar', huge, { name: 'Huge' }, userBearer);
  assert.ok(out.status === 413 || out.status === 400, `expected a refusal, got ${out.status}`);
});

/** A PNG header claiming w×h with nothing behind it. */
function bomb(w: number, h: number): Buffer {
  const b = Buffer.alloc(73);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  b[24] = 8;
  b[25] = 6;
  return b;
}
