#!/usr/bin/env -S node --import tsx
/**
 * How much does a moving world cost on the wire? Measure it, don't estimate it.
 *
 * This exists because two estimates in a row were wrong by more than a factor of two, in both
 * directions. It joins N headless viewers, walks every one of them back and forth, and reports
 * what ONE of them receives — plus the per-entity cost, which is the number that extrapolates.
 *
 * Measured 2026-09-08 on uponu, protocol 15:
 *
 *   walkers   moving   per viewer     bytes/msg   PER MOVING ENTITY   server CPU
 *        10      8.6    1.30 KB/s            74          155 B/s          6.2 %
 *        30     24.8    3.73 KB/s           214          154 B/s         12.3 %
 *
 * Linear, and that linearity is the point: the wire cost is (moving entities × viewers × 154 B/s),
 * so 300 walkers in front of 100 viewers is ~37 Mbit/s of uplink. For comparison, the furniture
 * bug this replaced cost 46 Mbit/s at 100 viewers with NOTHING moving.
 *
 * Two things to know before reading a run:
 *
 *  - **A viewer is also a walker here.** Each headless client is a pawn in the world AND a
 *    receiver, which is the realistic shape (people move) but means viewers and movers rise
 *    together. Separate them with `--watchers` if you want the axes apart.
 *  - **It creates accounts.** `/desktop/token` with the admin token creates the user it names, and
 *    those rows can only be removed with SQL — so this refuses to run against anything but
 *    localhost unless you pass `--i-know`, and it prints the names it made.
 *
 * Usage: scripts/wire-load.sh [--url http://localhost:2599] [--walkers 10] [--watchers 0]
 *                             [--seconds 20] [--zone uponu] [--token test12] [--i-know]
 */
import { readFileSync } from 'node:fs';

import { Client } from '@colyseus/sdk';

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const URL_BASE = arg('url', 'http://localhost:2599');
const WALKERS = Number(arg('walkers', '10'));
const WATCHERS = Number(arg('watchers', '0'));
const SECONDS = Number(arg('seconds', '20'));
const ZONE = arg('zone', 'uponu');
const ADMIN = arg('token', process.env.PIXEL_ADMIN_TOKEN ?? 'test12');
const PREFIX = arg('prefix', 'loadtest');

if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(URL_BASE) && !process.argv.includes('--i-know')) {
  console.error(
    `refusing to load-test ${URL_BASE}: it creates accounts that only SQL can remove.\n` +
      `Point it at an isolated instance, or pass --i-know if you really mean it.`,
  );
  process.exit(1);
}

/** utime + stime of a local server, so CPU is a delta and not ps's lifetime average. */
function cpuTicks(pid: string): number | null {
  try {
    const f = readFileSync(`/proc/${pid}/stat`, 'utf8').split(' ');
    return Number(f[13]) + Number(f[14]);
  } catch {
    return null;
  }
}
const PID = arg('pid', '');

/** The little of a joined room this script reads — the SDK joins schemaless, so state is
 *  reflected, not typed (same shape the client itself deals with). */
type LoadRoom = {
  send(type: string, message: unknown): void;
  connection: { transport?: { ws?: WebSocket }; ws?: WebSocket };
  state: { characters: Map<string, { x: number; y: number }>; pets: Map<string, unknown> };
};

async function joinOne(name: string): Promise<LoadRoom> {
  const res = await fetch(`${URL_BASE}/desktop/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: name, password: `${name}-pw12345`, token: ADMIN }),
  });
  const { token } = (await res.json()) as { token?: string };
  if (!token) throw new Error(`no bearer for ${name} — is the admin token right?`);
  const client = new Client(URL_BASE.replace('http', 'ws'));
  client.auth.token = token;
  return (await client.joinOrCreate('world', { zone: ZONE })) as unknown as LoadRoom;
}

const rooms: LoadRoom[] = [];
const names: string[] = [];
for (let i = 0; i < WALKERS + WATCHERS; i++) {
  const name = `${PREFIX}${i}`;
  names.push(name);
  rooms.push(await joinOne(name));
}
console.log(`joined ${rooms.length} viewer(s) as ${names[0]}…${names[names.length - 1]} on ${ZONE}`);
await new Promise((r) => setTimeout(r, 3000));

// Two tiles far enough apart that the walk lasts longer than the interval, so nobody stands
// still waiting for the next order. The offsets fan the group out so they do not queue up on
// one tile (occupancy is per tile — a blocked walker is a walker that stops moving).
const A = { col: 28, row: 40 };
const B = { col: 40, row: 47 };
let flip = false;
const orders = setInterval(() => {
  flip = !flip;
  const target = flip ? A : B;
  for (let i = 0; i < WALKERS; i++) {
    rooms[i].send('playerMove', { col: target.col + (i % 5), row: target.row + Math.floor(i / 5) });
  }
}, 4000);

// One viewer's socket, counted raw. The SDK gives no byte counters, so wrap onmessage.
const room = rooms[0];
const sock = room.connection.transport?.ws ?? room.connection.ws;
if (!sock) {
  console.error('no socket to count — the SDK internals moved');
  process.exit(1);
}
let msgs = 0;
let bytes = 0;
const inner = sock.onmessage;
sock.onmessage = (ev: MessageEvent) => {
  msgs++;
  bytes += (ev.data as ArrayBuffer)?.byteLength ?? (ev.data as string)?.length ?? 0;
  return inner?.call(sock, ev);
};

// How many characters actually moved, sampled — the divisor for the per-entity number. Sampling
// rather than counting orders: a walker that is blocked, seated or done walking is not moving,
// and dividing by the number of ORDERS would flatter the result.
let movingTotal = 0;
let samples = 0;
let previous = new Map<string, string>();
const sampler = setInterval(() => {
  const now = new Map<string, string>();
  let moving = 0;
  for (const [key, ch] of room.state.characters) {
    const at = `${ch.x},${ch.y}`;
    if (previous.get(key) && previous.get(key) !== at) moving++;
    now.set(key, at);
  }
  previous = now;
  movingTotal += moving;
  samples++;
}, 200);

await new Promise((r) => setTimeout(r, 2000)); // let the first walk get going
msgs = 0;
bytes = 0;
movingTotal = 0;
samples = 0;
const cpu0 = PID ? cpuTicks(PID) : null;
const t0 = performance.now();
await new Promise((r) => setTimeout(r, SECONDS * 1000));
const secs = (performance.now() - t0) / 1000;
const cpu1 = PID ? cpuTicks(PID) : null;
clearInterval(orders);
clearInterval(sampler);

const moving = samples ? movingTotal / samples : 0;
const perViewer = bytes / secs;
const perEntity = moving ? perViewer / moving : null;
const viewers = rooms.length;

console.log(
  [
    ``,
    `${ZONE}: ${room.state.characters.size} character(s), ${room.state.pets.size} pet(s), ` +
      `${viewers} viewer(s), ${secs.toFixed(1)} s`,
    `  moving (sampled)        ${moving.toFixed(1)}`,
    `  per viewer              ${(perViewer / 1024).toFixed(2)} KB/s in ${(msgs / secs).toFixed(1)} msg/s ` +
      `(${msgs ? Math.round(bytes / msgs) : 0} B/msg)`,
    `  per moving entity       ${perEntity === null ? 'n/a — nothing moved' : `${perEntity.toFixed(0)} B/s`}`,
    `  this room's uplink      ${((perViewer * viewers) / 1024).toFixed(1)} KB/s (${viewers} viewer(s))`,
    cpu0 !== null && cpu1 !== null
      ? `  server CPU              ${(((cpu1 - cpu0) / 100 / secs) * 100).toFixed(1)} % of one core`
      : `  server CPU              (pass --pid <server pid> for this)`,
    ``,
    perEntity === null
      ? ``
      : `Extrapolated from ${perEntity.toFixed(0)} B/s per moving entity per viewer:` +
        [30, 100, 300, 1000]
          .map((e) =>
            `\n  ${String(e).padStart(4)} moving  ${((e * perEntity) / 1024).toFixed(0).padStart(4)} KB/s per viewer` +
            `   ${(((e * perEntity * 100) / 1024 / 1024) * 8).toFixed(0).padStart(4)} Mbit/s at 100 viewers`,
          )
          .join(''),
    ``,
    `Accounts created (removable only with SQL): ${names.join(', ')}`,
  ].join('\n'),
);
process.exit(0);
