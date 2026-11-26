/**
 * Televisions: who may change one, what a picture may be, and where it is kept.
 *
 * The properties that matter, each a way this could go wrong without anything looking broken:
 *
 *  - The upload names no television. It names a TICKET, which the room issued to the account that
 *    walked up, and the route honours it only for that account — so a client cannot put a picture
 *    on a television it is not standing at, nor use somebody else's ticket.
 *  - A picture is a PNG of exactly the grid its metadata promises (`tvGrid`), within the bounds in
 *    `shared/office/tvScreen.ts`, and what is stored is this server's re-encode.
 *  - It is served only at its current hash, so an old URL does not keep a replaced picture alive.
 *  - It is keyed by the television's anchor TILE, because a placement's uid changes on every import.
 *  - The map's own action carries the glass rect from Tiled, and the layout sanitizer keeps it
 *    bounded on every write path.
 *
 * TEST BOUNDARIES:
 *   @real-dependency: express + the real routes + SQLite + pngjs -- Mock? NO. The claim is "this
 *       route refuses", and the checks live in the route. Data dir is the per-test temp one
 *       (test-data-dir.mjs); stores are imported dynamically because db.ts resolves it at load.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { PNG } from 'pngjs';

import {
  TV_MAX_FRAMES,
  TV_MAX_FRAME_W,
  TV_UPLOAD_HEADER,
  parseTvScreenRect,
  tvFrameDelay,
  tvGrid,
  tvScreenKey,
  tvScreenWorldRect,
} from '@pixel/shared/office/tvScreen.js';

const ADMIN_TOKEN = 'tv-route-admin-token';
let server: Server;
let base: string;
let aliceBearer: string;
let bobBearer: string;
let issueTvTicket: typeof import('./tvTickets.js').issueTvTicket;
let tvScreenStore: typeof import('./tvScreenStore.js').tvScreenStore;
let controlBus: typeof import('./controlBus.js').controlBus;
let TV_SCREEN_CHANGED_EVENT: string;

before(async () => {
  const express = (await import('express')).default;
  const { userStore } = await import('./userStore.js');
  const { registerAuth } = await import('./auth.js');
  const { registerTvScreenApi } = await import('./tvScreenApi.js');
  ({ issueTvTicket } = await import('./tvTickets.js'));
  ({ tvScreenStore } = await import('./tvScreenStore.js'));
  ({ controlBus, TV_SCREEN_CHANGED_EVENT } = await import('./controlBus.js'));
  const app = express();
  registerAuth(app, ADMIN_TOKEN);
  registerTvScreenApi(app);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  userStore.createUser('tvalice', 'password-123', {});
  userStore.createUser('tvbob', 'password-123', {});
  const token = async (u: string): Promise<string> => {
    const res = await fetch(`${base}/desktop/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: u, password: 'password-123' }),
    });
    return ((await res.json()) as { token: string }).token;
  };
  aliceBearer = await token('tvalice');
  bobBearer = await token('tvbob');
});

after(() => {
  server?.close();
});

/** A packed grid of `frames` frames of w×h, each a different grey. */
function grid(frames: number, w: number, h: number, size = tvGrid(w, h, frames)): Buffer {
  const png = new PNG({ width: size.width, height: size.height });
  png.data.fill(255);
  for (let i = 0; i < frames; i++) png.data[i * 4] = i;
  return PNG.sync.write(png);
}

async function upload(bearer: string, meta: unknown, body: Buffer): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}/tv/screen`, {
    method: 'POST',
    headers: { authorization: `Bearer ${bearer}`, [TV_UPLOAD_HEADER]: JSON.stringify(meta), 'content-type': 'application/octet-stream' },
    body: new Uint8Array(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

test('a picture goes up with a ticket for the caller, and lands on the television the ticket names', async () => {
  const heard: unknown[] = [];
  const listen = (c: unknown): void => void heard.push(c);
  controlBus.on(TV_SCREEN_CHANGED_EVENT, listen);
  try {
    const ticket = issueTvTicket('tvalice', 'zone-a', tvScreenKey(3, 4));
    const out = await upload(aliceBearer, { ticket, frameW: 40, frameH: 30, delays: [50, 0, 70] }, grid(3, 40, 30));
    assert.equal(out.status, 200, JSON.stringify(out.body));
    const stored = tvScreenStore.get('zone-a', '3,4');
    assert.ok(stored);
    assert.deepEqual([stored.frameW, stored.frameH], [40, 30]);
    // A "0" delay plays as 100 ms, as every browser plays a GIF.
    assert.deepEqual(stored.delays, [50, 100, 70]);
    assert.deepEqual(heard, [{ zoneId: 'zone-a', screen: '3,4' }]);

    // Served at its hash, and only there.
    const at = (h: string): Promise<Response> =>
      fetch(`${base}/tv/zone-a/3%2C4/${h}`, { headers: { authorization: `Bearer ${bobBearer}` } });
    const hit = await at(stored.hash);
    assert.equal(hit.status, 200);
    assert.equal(hit.headers.get('content-type'), 'image/png');
    const served = PNG.sync.read(Buffer.from(await hit.arrayBuffer()));
    assert.deepEqual([served.width, served.height], [120, 30]);
    assert.equal((await at('0'.repeat(24))).status, 404);
    assert.equal((await fetch(`${base}/tv/zone-a/3%2C4/${stored.hash}`)).status, 401, 'no session, no picture');

    // A spent ticket does not work twice.
    const again = await upload(aliceBearer, { ticket, frameW: 40, frameH: 30, delays: [50] }, grid(1, 40, 30));
    assert.equal(again.status, 403);
  } finally {
    controlBus.off(TV_SCREEN_CHANGED_EVENT, listen);
  }
});

test("a ticket is only good for the account it was issued to", async () => {
  const ticket = issueTvTicket('tvalice', 'zone-b', '1,1');
  const out = await upload(bobBearer, { ticket, frameW: 10, frameH: 10, delays: [100] }, grid(1, 10, 10));
  assert.equal(out.status, 403);
  assert.equal(tvScreenStore.get('zone-b', '1,1'), null);
  // …and the refusal did not spend it: Alice can still use it.
  assert.equal((await upload(aliceBearer, { ticket, frameW: 10, frameH: 10, delays: [100] }, grid(1, 10, 10))).status, 200);
});

test('a picture that is not the promised grid, or is out of bounds, is refused before it is stored', async () => {
  const cases: Array<[string, unknown, Buffer]> = [
    ['wrong grid', { frameW: 40, frameH: 30, delays: [100, 100] }, grid(3, 40, 30)],
    ['frame too wide', { frameW: TV_MAX_FRAME_W + 1, frameH: 10, delays: [100] }, grid(1, TV_MAX_FRAME_W + 1, 10)],
    ['too many frames', { frameW: 8, frameH: 8, delays: new Array(TV_MAX_FRAMES + 1).fill(100) }, grid(TV_MAX_FRAMES + 1, 8, 8)],
    ['not a PNG', { frameW: 8, frameH: 8, delays: [100] }, Buffer.from('GIF89a not really')],
    // A header claiming an enormous image, with nothing behind it: refused from 25 bytes.
    ['header bomb', { frameW: 8, frameH: 8, delays: [100] }, bomb(30000, 30000)],
  ];
  for (const [name, meta, body] of cases) {
    const ticket = issueTvTicket('tvalice', 'zone-c', '2,2');
    const out = await upload(aliceBearer, { ...(meta as object), ticket }, body);
    assert.equal(out.status, 400, `${name}: ${JSON.stringify(out.body)}`);
    assert.equal(tvScreenStore.get('zone-c', '2,2'), null, name);
  }
});

/** A PNG signature and IHDR claiming w×h, and nothing else. */
function bomb(w: number, h: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  b[24] = 8;
  b[25] = 6;
  return b;
}

test('switching a television off needs a ticket too, and removes the picture', async () => {
  const ticket = issueTvTicket('tvalice', 'zone-d', '5,5');
  assert.equal((await upload(aliceBearer, { ticket, frameW: 8, frameH: 8, delays: [100] }, grid(1, 8, 8))).status, 200);
  const clear = (bearer: string, t: string): Promise<Response> =>
    fetch(`${base}/tv/screen/clear`, { method: 'POST', headers: { authorization: `Bearer ${bearer}`, [TV_UPLOAD_HEADER]: JSON.stringify({ ticket: t }) } });
  assert.equal((await clear(bobBearer, issueTvTicket('tvalice', 'zone-d', '5,5'))).status, 403);
  assert.ok(tvScreenStore.get('zone-d', '5,5'));
  assert.equal((await clear(aliceBearer, issueTvTicket('tvalice', 'zone-d', '5,5'))).status, 200);
  assert.equal(tvScreenStore.get('zone-d', '5,5'), null);
});

test('the shared geometry: delays, grid and the glass rect', () => {
  assert.equal(tvFrameDelay(0), 100);
  assert.equal(tvFrameDelay(10), 100);
  assert.equal(tvFrameDelay(40), 40);
  assert.equal(tvFrameDelay(1e9), 10_000);
  assert.equal(tvFrameDelay('nonsense'), 100);
  // Wraps at the sheet width, row-major.
  assert.deepEqual(tvGrid(128, 96, 48), { cols: 16, rows: 3, width: 2048, height: 288 });
  assert.deepEqual(tvGrid(40, 30, 1), { cols: 1, rows: 1, width: 40, height: 30 });

  assert.deepEqual(parseTvScreenRect('5,14,38,25'), { x: 5, y: 14, w: 38, h: 25 });
  assert.deepEqual(parseTvScreenRect({ x: 1, y: 2, w: 3, h: 4 }), { x: 1, y: 2, w: 3, h: 4 });
  for (const bad of ['', '1,2,3', '1,2,0,4', '-1,2,3,4', '1.5,2,3,4', 'a,b,c,d', { x: 1 }, 7, null]) {
    assert.equal(parseTvScreenRect(bad), undefined, JSON.stringify(bad));
  }
  // A placement drawn at twice the art's size carries its glass with it.
  assert.deepEqual(tvScreenWorldRect({ x: 100, y: 50 }, 96, 96, 48, 48, { x: 5, y: 14, w: 38, h: 25 }), { x: 110, y: 78, w: 76, h: 50 });
  assert.deepEqual(tvScreenWorldRect({ x: 0, y: 0 }, 48, 48, 48, 48, undefined), { x: 0, y: 0, w: 48, h: 48 });
});

test('the map carries the action and its rect, and the sanitizer keeps it bounded', async () => {
  const { actionFromProps } = await import('./tiled/actionProps.js');
  const { sanitizeAction } = await import('./layoutSanitize.js');
  assert.deepEqual(actionFromProps({ actionKind: 'tvScreen', actionScreen: '5,14,38,25' }), {
    kind: 'tvScreen',
    screen: { x: 5, y: 14, w: 38, h: 25 },
  });
  assert.deepEqual(actionFromProps({ actionKind: 'tvScreen', actionScreen: '' }), { kind: 'tvScreen' });
  assert.deepEqual(sanitizeAction({ kind: 'tvScreen', screen: { x: 5, y: 14, w: 38, h: 25 } }), {
    kind: 'tvScreen',
    screen: { x: 5, y: 14, w: 38, h: 25 },
  });
  assert.deepEqual(sanitizeAction({ kind: 'tvScreen', screen: { x: 5, y: 14, w: 1e9, h: 25 } }), { kind: 'tvScreen' });
});

test('the bundled CRT television is a television out of the box', async () => {
  const { loadTiledRegistry } = await import('./tiled/tiledRegistry.js');
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { ASSETS_ROOT } = await import('./assets.js');
  const { actionFromProps } = await import('./tiled/actionProps.js');
  loadTiledRegistry(ASSETS_ROOT); // the tileset must still parse
  const tsj = JSON.parse(readFileSync(join(ASSETS_ROOT, 'assets/tiled/furniture-electronics.tsj'), 'utf8')) as {
    tiles: Array<{ imagewidth: number; imageheight: number; properties: Array<{ name: string; value: string | number | boolean }> }>;
  };
  const tile = tsj.tiles.find((t) => t.properties.some((p) => p.name === 'id' && p.value === 'CRT_TV'));
  assert.ok(tile, 'CRT_TV is in furniture-electronics');
  const props = Object.fromEntries(tile.properties.map((p) => [p.name, p.value]));
  const action = actionFromProps(props);
  assert.equal(action?.kind, 'tvScreen');
  const screen = action && action.kind === 'tvScreen' ? action.screen : undefined;
  assert.ok(screen, 'it says where its glass is');
  assert.ok(screen.x + screen.w <= tile.imagewidth && screen.y + screen.h <= tile.imageheight, 'the glass is inside the art');
});
