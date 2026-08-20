#!/usr/bin/env node
/**
 * Do the security and memory checks actually catch anything?
 *
 * A checker that greps for a gate is worthless the moment the code it greps
 * moves: it keeps printing PASS at a file it no longer understands, which is
 * worse than no check at all because it reads like evidence. So each rule in
 * security.mjs and leaks.mjs gets a hole punched into the real source here, and
 * must fail on it. Every case below is a hole somebody could plausibly leave
 * behind — an ungated route, a handler acting on a payload's userId, a voice
 * token minted for whoever asked, a per-user Map nothing deletes from.
 *
 * Two of the leak cases are regressions rather than inventions: `savedSpots`
 * really did accumulate an entry per user with no delete site, and an interval
 * really was neither cleared nor unref'd. A rule earns its place by catching the
 * bug that motivated it.
 *
 * Safety: the patches are written into the working tree and reverted with
 * `git checkout --`, so this REFUSES to run while any file it touches has
 * uncommitted changes. It restores every file it patched, including on a crash.
 *
 * Run via: bash .claude/skills/mmo-readiness/check.sh --selftest
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const HERE = new URL('.', import.meta.url).pathname;

/** [name, file, anchor to replace, replacement, text the failure must mention] */
const SECURITY_CASES = [
  [
    'an ungated GET route',
    'server/src/index.ts',
    "  app.get('/health',",
    "  app.get('/world-dump', (_req, res) => res.json({ secretish: true }));\n  app.get('/health',",
    'GET /world-dump',
  ],
  [
    'an ungated POST route',
    'server/src/adminApi.ts',
    "  app.get('/admin/users', (req, res) => {",
    "  app.post('/admin/nuke', json, (_req, res) => res.json({ ok: true }));\n  app.get('/admin/users', (req, res) => {",
    'POST /admin/nuke',
  ],
  [
    'a widened session-gate exemption',
    'server/src/auth.ts',
    "const isApi = p === '/health'",
    "const isApi = p === '/backdoor' || p === '/health'",
    '/backdoor',
  ],
  [
    "a handler acting on someone else's userId",
    'server/src/rooms/SimRoom.ts',
    "    this.onMessage('chat',",
    "    this.onMessage('peek', (_client, msg: { userId?: string }) => {\n      console.log(userStore.get(String(msg.userId)));\n    });\n    this.onMessage('chat',",
    'peek',
  ],
  [
    'privilege taken from a payload',
    'server/src/rooms/SimRoom.ts',
    "    this.onMessage('workStatus',",
    "    this.onMessage('promote', (_client, msg: { isAdmin?: boolean }) => {\n      const isAdmin = msg.isAdmin === true;\n      void isAdmin;\n    });\n    this.onMessage('workStatus',",
    'promote',
  ],
  [
    'a voice token minted without membership',
    'server/src/rooms/SimRoom.ts',
    'if (!this.meetingRooms.get(key)?.has(id)) return;',
    'if (false) return;',
    'membership',
  ],
  [
    "a voice token identity from the client's payload",
    'server/src/rooms/SimRoom.ts',
    'const token = await this.mintVoiceToken(id, roomName);',
    'const token = await this.mintVoiceToken(Number(msg?.col), roomName);',
    'identity/room from client input',
  ],
  [
    'a guest meeting join without the password check',
    'server/src/meetingRoomApi.ts',
    '!meetingRoomStore.verifyPassword(slug, password)',
    'false',
    'password verification',
  ],
  ['a server secret named in client code', 'client/src/net/room.ts', 'export ', 'const leak = process.env.LIVEKIT_API_SECRET;\nexport ', 'secret is named in client code'],
  [
    'a secret inside a broadcast payload',
    'server/src/rooms/SimRoom.ts',
    "this.broadcast('m', this.zoneMapMessage());",
    "this.broadcast('m', { adminToken: process.env.PIXEL_ADMIN_TOKEN });",
    'secret is put into a message',
  ],
  ['the world room without authRequired', 'server/src/index.ts', '{ authRequired: true, version }', '{ authRequired: false, version }', 'anonymous mode'],
  [
    'an agent feed that trusts a self-declared identity',
    'server/src/ingest/feedServer.ts',
    'userStore.getByAgentToken(creds.token)',
    '({ userId: String(creds.user) })',
    'agent token',
  ],
  [
    'a message type nobody sends',
    'server/src/rooms/SimRoom.ts',
    "    this.onMessage('chat',",
    "    this.onMessage('forgottenDoor', (_client) => {\n      void 0;\n    });\n    this.onMessage('chat',",
    'forgottenDoor',
  ],
  ['chat without a length cap', 'server/src/rooms/SimRoom.ts', '.trim().slice(0, 200)', '.trim()', 'length cap'],
  [
    'zone entry without the privacy ACL',
    'server/src/rooms/SimRoom.ts',
    'this.zones.canEnterPrivateZone(zoneId',
    'this.zones.alwaysTrue(zoneId',
    'zone entry',
  ],
  ['zone entry without the entry password', 'server/src/rooms/SimRoom.ts', 'this.zones.zoneHasPassword(zoneId)', 'false', 'zone entry'],
];

/** Same shape, for the memory section — one planted leak per rule in leaks.mjs. */
const LEAK_CASES = [
  [
    'a per-user Map with no delete site',
    'server/src/rooms/SimRoom.ts',
    '  private readonly savedSpots = new Map<string, string>();',
    '  private readonly visitorLog = new Map<string, number>();\n  private noteVisitor(id: string): void {\n    this.visitorLog.set(id, 1);\n  }\n  private readonly savedSpots = new Map<string, string>();',
    'visitorLog',
  ],
  [
    'the savedSpots regression: the delete on leave removed again',
    'server/src/rooms/SimRoom.ts',
    'if (userId && !this.hasOtherSession(client)) this.savedSpots.delete(`${userId}|${this.zone.id}`);',
    'void userId;',
    'savedSpots',
  ],
  [
    'a control-bus subscription without its unsubscribe',
    'server/src/rooms/SimRoom.ts',
    '    controlBus.off(PRESENCE_EVENT, this.onPresenceChanged);',
    '    void this.onPresenceChanged;',
    'controlBus.off(',
  ],
  [
    // The rule used to name controlBus; the director is the emitter it did NOT know about,
    // so this case is what proves the generalisation rather than the original hardcoding.
    'a director subscription without its unsubscribe',
    'server/src/rooms/SimRoom.ts',
    "    director.off('reroute', this.onReroute);",
    '    void this.onReroute;',
    'director.off(',
  ],
  [
    "an interval neither cleared nor unref'd",
    'server/src/appStore.ts',
    "    if (typeof t.unref === 'function') t.unref();",
    '    void t;',
    'setInterval',
  ],
  [
    'a blob URL that is never revoked',
    'client/src/net/room.ts',
    'export function getServerHttpOrigin(): string {',
    'export function leakedBlob(): string {\n  return URL.createObjectURL(new Blob([]));\n}\n\nexport function getServerHttpOrigin(): string {',
    'createObjectURL',
  ],
  [
    'a texture created per entity and never removed',
    'client/src/scenes/OfficeScene.ts',
    '  private loadedSheets = new Set<string>();',
    "  private loadedSheets = new Set<string>();\n  private leakTexture(id: string): void {\n    this.textures.createCanvas(id, 8, 8);\n  }",
    'texture',
  ],
  [
    'a synced entity that never leaves the schema',
    'server/src/rooms/SimRoom.ts',
    'if (!live.has(key)) this.state.characters.delete(key);',
    'void key;',
    'state.characters',
  ],
];

const SUITES = [
  { label: 'security', script: 'security.mjs', cases: SECURITY_CASES },
  { label: 'memory', script: 'leaks.mjs', cases: LEAK_CASES },
];

const files = [...new Set(SUITES.flatMap((s) => s.cases).map(([, f]) => f))];
const dirty = execFileSync('git', ['status', '--porcelain', '--', ...files], { cwd: ROOT, encoding: 'utf8' }).trim();
if (dirty) {
  console.log('  \x1b[33m! WARN\x1b[0m  self-test skipped: it patches tracked files and these have uncommitted changes:');
  dirty.split('\n').forEach((l) => console.log(`        ${l.trim()}`));
  process.exit(0);
}

const restore = (rel) => execFileSync('git', ['checkout', '--', rel], { cwd: ROOT });

/** Punch each hole, run that suite's script, and require it to notice. */
function runSuite({ label, script, cases }) {
  const missed = [];
  for (const [name, rel, anchor, replacement, expect] of cases) {
    const abs = join(ROOT, rel);
    const src = readFileSync(abs, 'utf8');
    if (!src.includes(anchor)) {
      missed.push(`${name} — anchor no longer in ${rel}; this case tests nothing`);
      continue;
    }
    writeFileSync(abs, src.replace(anchor, replacement));
    let out = '';
    let code = 0;
    try {
      out = execFileSync('node', [join(HERE, script)], { cwd: ROOT, encoding: 'utf8' });
    } catch (e) {
      out = `${e.stdout ?? ''}`;
      code = e.status ?? 1;
    } finally {
      restore(rel);
    }
    if (code !== 0 && out.toLowerCase().includes(expect.toLowerCase())) continue;
    missed.push(`${name} — went unnoticed (exit ${code})`);
  }
  if (missed.length === 0) {
    console.log(`  \x1b[32m✓ PASS\x1b[0m  ${label} self-test: all ${cases.length} planted holes were caught`);
    return 0;
  }
  console.log(`  \x1b[31m✗ FAIL\x1b[0m  ${label} self-test: ${missed.length} of ${cases.length} holes slipped through:`);
  missed.forEach((m) => console.log(`        - ${m}`));
  console.log(`        A rule that cannot fail is not a check — fix ${script} (or this case, if the code moved).`);
  return 1;
}

let bad = 0;
for (const suite of SUITES) bad += runSuite(suite);
process.exit(bad === 0 ? 0 : 1);
