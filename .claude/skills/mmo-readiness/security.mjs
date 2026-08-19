#!/usr/bin/env node
/**
 * Security section of the mmo-readiness check — the part that must not be a
 * reading exercise.
 *
 * AGENTS.md § Security says every access-control decision is resolved
 * server-side from the account/session, and that shared/admin actions go through
 * permissions.ts. That is a contract about code that EXISTS, so it can be
 * checked like any other invariant instead of being left to whoever remembers to
 * look. What a human still has to judge is listed at the end as `? CHECK`, and
 * that list is deliberately short.
 *
 * The shape of every check here is the same: find the surface through which a
 * client can reach a resource — an HTTP route, a room message, a voice token, a
 * chat line — and require the gate to be present in the code that serves it. A
 * surface that is public on purpose is named in an allow-list WITH its reason, so
 * "this one is fine" is a decision somebody wrote down rather than an absence.
 *
 * Exit code: 1 if any hard check fails, else 0. Output is the same PASS/FAIL/
 * WARN/CHECK vocabulary as check.sh, which calls this.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
let failed = 0;
const pass = (m) => console.log(`  \x1b[32m✓ PASS\x1b[0m  ${m}`);
const bad = (m) => {
  console.log(`  \x1b[31m✗ FAIL\x1b[0m  ${m}`);
  failed = 1;
};
const warn = (m) => console.log(`  \x1b[33m! WARN\x1b[0m  ${m}`);
const check = (m) => console.log(`  \x1b[36m? CHECK\x1b[0m ${m}`);
const listing = (items) => items.forEach((i) => console.log(`        - ${i}`));

// ── Reading the tree ────────────────────────────────────────────────────────

function sources(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(join(ROOT, dir));
  } catch {
    return out;
  }
  for (const e of entries) {
    const rel = join(dir, e);
    const st = statSync(join(ROOT, rel));
    if (st.isDirectory()) sources(rel, out);
    else if (e.endsWith('.ts') && !e.includes('.test.')) out.push(rel);
  }
  return out;
}

/**
 * Comments blanked out, everything else — including offsets and line breaks — left
 * alone, so a reported line number still points at the real line.
 *
 * Not cosmetic: prose says things like "then broadcast (and keep recent history)",
 * and a scanner that reads that as a call reports a leak in a sentence. Strings and
 * template literals are stepped over rather than blanked, because a route path and a
 * message name ARE string literals and the checks read them. Regex literals are
 * recognised by what precedes them, so the `//` inside a URL stays a URL.
 */
function blankComments(src) {
  // split(''), NOT [...src]: the spread iterates CODE POINTS, so one emoji becomes a
  // single element while every index here counts UTF-16 code units. This file's own
  // targets are full of emoji ('🤝 Meeting area'), and the drift blanked live code a
  // few characters off — which is worse than a missed comment, because blanked code is
  // code the checks never see.
  const out = src.split('');
  let i = 0;
  let prev = '';
  const blank = (from, to) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      const end = src.indexOf('\n', i);
      blank(i, end < 0 ? src.length : end);
      i = end < 0 ? src.length : end;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i);
      blank(i, end < 0 ? src.length : end + 2);
      i = end < 0 ? src.length : end + 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      i++;
      while (i < src.length && src[i] !== c) i += src[i] === '\\' ? 2 : 1;
      i++;
      prev = c;
      continue;
    }
    if (c === '/' && /[(,=:[!&|?{};+\n]/.test(prev || '(')) {
      // Regex literal: skip to the unescaped closing slash on the same line.
      i++;
      while (i < src.length && src[i] !== '/' && src[i] !== '\n') i += src[i] === '\\' ? 2 : 1;
      i++;
      continue;
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out.join('');
}

const read = (rel) => {
  try {
    return blankComments(readFileSync(join(ROOT, rel), 'utf8'));
  } catch {
    return '';
  }
};

/**
 * The text of the call that starts at `open` (the index of its `(`), parens
 * balanced. Strings, template literals and comments are skipped so a `)` inside
 * one cannot end the call early — which matters here, because half the bodies we
 * inspect build LiveKit room names out of template literals.
 */
function callText(src, open) {
  let depth = 0;
  let i = open;
  const tmpl = []; // template-literal nesting: how many `${` we are inside
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      i = src.indexOf('\n', i);
      if (i < 0) break;
      continue;
    }
    if (c === '/' && next === '*') {
      i = src.indexOf('*/', i) + 2;
      continue;
    }
    if (c === "'" || c === '"') {
      const quote = c;
      i++;
      while (i < src.length && src[i] !== quote) i += src[i] === '\\' ? 2 : 1;
      i++;
      continue;
    }
    if (c === '`') {
      i++;
      while (i < src.length) {
        if (src[i] === '\\') i += 2;
        else if (src[i] === '`') break;
        else if (src[i] === '$' && src[i + 1] === '{') {
          tmpl.push(1);
          i += 2;
          // Code inside ${…}: fall back to the outer scanner until it closes.
          let d = 1;
          while (i < src.length && d > 0) {
            if (src[i] === '{') d++;
            else if (src[i] === '}') d--;
            i++;
          }
          tmpl.pop();
        } else i++;
      }
      i++;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
    i++;
  }
  return src.slice(open);
}

/** Every `<obj>.<verb>(…)` call in `src`, with its first string argument. */
function calls(src, pattern) {
  const out = [];
  const re = new RegExp(pattern, 'g');
  let m;
  while ((m = re.exec(src))) {
    const open = src.indexOf('(', m.index + m[0].length - 1);
    if (open < 0) continue;
    const text = callText(src, open);
    const first = /^\(\s*['"]([^'"]+)['"]/.exec(text);
    out.push({ groups: m.slice(1), name: first ? first[1] : null, text, at: m.index });
    re.lastIndex = m.index + m[0].length;
  }
  return out;
}

const lineOf = (src, at) => src.slice(0, at).split('\n').length;

// ── 1. HTTP routes ──────────────────────────────────────────────────────────
//
// The session gate in auth.ts covers GET only (a navigation must land on the
// login page), so every other verb authorizes itself — and a GET that is served
// BEFORE the gate is installed, or whose path matches the asset/api exemptions,
// is not covered either. Both cases are real: /meet/<slug> and /mumble/config
// are registered pre-gate on purpose. So the rule is: a route either shows a
// gate in its own body, or its path is named below with the reason it may be
// reached without one.

/** Paths anybody may reach, and why. Adding one is a security decision. */
const PUBLIC_ROUTES = new Map([
  ['GET /health', 'liveness probe; returns {ok:true} and nothing about the world'],
  ['POST /login', 'the credential check itself (throttled, length-bounded)'],
  ['GET /logout', 'drops the session it was sent with; nothing to authorize'],
  ['POST /desktop/token', 'same credentials as /login, issues the bearer (throttled)'],
  ['POST /desktop/signout', 'revokes the presented bearer; idempotent by design'],
  ['GET /meet/:slug', 'the invite landing page — a guest has no account yet'],
  ['GET /meet/:slug/info', 'says only whether the slug exists and needs a password'],
  ['GET /assets/tiled/sets.json', 'the tileset table; art is served openly (see the asset exemption)'],
]);

/** GET routes that rely on the central gate in auth.ts rather than their own. */
const CENTRALLY_GATED = new Set(['GET /arcade/catalog', 'GET /arcade/allowed-games']);

/** What a gate looks like: the helpers that resolve identity or a capability. */
const AUTH_PRIMITIVES = [
  'hasValidSession',
  'hasValidBearerSession',
  'reqUserId(',
  'admin(req',
  'authorized(req',
  'zoneCapabilityAuth(',
  'zoneGrantAdminAuth(',
  'verifyCredentials(',
  'secretEquals(',
  'can(',
  'may(',
  'verifyPassword(',
];
const hasGate = (body) => AUTH_PRIMITIVES.some((p) => body.includes(p));

/**
 * `--list-handlers` prints every message type a client may send, one per line.
 *
 * Section 4 of check.sh used to grep this list itself and required the name on the
 * same line as `onMessage(` — so the two registrations written across lines,
 * 'meetingRoomCreate' and 'meetingRoomToken', never appeared on the list a human is
 * asked to review. They are the two that hand out access to a call. One parser for
 * both sections is the fix; a second way of counting is how a gap like that hides.
 */
const LIST_ONLY = process.argv.includes('--list-handlers');

if (!LIST_ONLY) console.log('\n\x1b[1m5b. Security — no unauthorized access to a resource\x1b[0m');

const serverFiles = sources('server/src');

if (LIST_ONLY) {
  const found = [];
  for (const file of serverFiles) {
    const src = read(file);
    for (const c of calls(src, String.raw`\bonMessage\s*\(`)) if (c.name) found.push(c.name);
  }
  found.sort().forEach((n) => console.log(n));
  process.exit(0);
}

const routes = [];
for (const file of serverFiles) {
  const src = read(file);
  for (const c of calls(src, String.raw`\bapp\.(get|post|put|patch|delete)\s*\(`)) {
    if (!c.name) continue;
    routes.push({ file, line: lineOf(src, c.at), verb: c.groups[0].toUpperCase(), path: c.name, body: c.text });
  }
}
const ungated = routes.filter((r) => !hasGate(r.body));
const unexplained = ungated.filter((r) => {
  const key = `${r.verb} ${r.path}`;
  return !PUBLIC_ROUTES.has(key) && !(r.verb === 'GET' && CENTRALLY_GATED.has(key));
});
if (routes.length === 0) {
  warn('no HTTP routes found — the parser or the layout changed; this check is blind');
} else if (unexplained.length) {
  bad(`${unexplained.length} HTTP route(s) neither authorize themselves nor are on an allow-list:`);
  listing(unexplained.map((r) => `${r.verb} ${r.path}  (${r.file}:${r.line})`));
  console.log('        Add the gate, or name the path in PUBLIC_ROUTES/CENTRALLY_GATED with its reason.');
} else {
  pass(`all ${routes.length} HTTP routes gated or explicitly public (${ungated.length} on the allow-lists)`);
}

// The central gate must still exist, and its exemption list must not grow
// unnoticed: every exemption is a path served without a session.
const authSrc = read('server/src/auth.ts');
const gateLine = /const\s+isApi\s*=([^;]+);/.exec(authSrc);
if (!/needsAuth[^;]*hasValidSession|hasValidSession[^)]*\)\s*&&\s*!hasValidBearerSession/.test(authSrc.replace(/\n/g, ' '))) {
  bad('the central session gate in auth.ts no longer checks hasValidSession/hasValidBearerSession');
} else if (!gateLine) {
  bad("auth.ts has no `isApi` exemption list — the gate's shape changed; re-read it before shipping");
} else {
  const exempt = [...gateLine[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]).sort();
  const expected = ['/health', '/login', '/matchmake'];
  const extra = exempt.filter((p) => !expected.includes(p));
  if (extra.length) {
    bad(`the session gate exempts path(s) nobody signed off on: ${extra.join(', ')}`);
  } else {
    pass(`session gate intact; exempts only ${exempt.join(', ')}`);
  }
}

// ── 2. Room messages ────────────────────────────────────────────────────────
//
// A message that acts on an id, name or slug taken from its own payload is the
// classic hole: the client picks whose data it edits. Such a handler must
// resolve the actor server-side (authOf / players.get(sessionId)) or check a
// capability (may) — the payload may then only say WHAT, never WHO.

const IDENTITY_PRIMITIVES = ['authOf(client', 'players.get(client.sessionId', 'this.may(client', 'mayRunCommand('];
const CLIENT_ID_FIELDS = /msg\??\.(id|userId|user|name|slug|zoneId|ownerId|owner|to|target|assetType)\b/;

const handlers = [];
for (const file of serverFiles) {
  const src = read(file);
  for (const c of calls(src, String.raw`\bonMessage\s*\(`)) {
    if (!c.name) continue;
    handlers.push({ file, line: lineOf(src, c.at), name: c.name, body: c.text });
  }
}
const identityOf = (h) => IDENTITY_PRIMITIVES.some((p) => h.body.includes(p));
const keyedByPayload = handlers.filter((h) => CLIENT_ID_FIELDS.test(h.body) && !identityOf(h));
if (handlers.length === 0) {
  warn('no onMessage handlers found — the parser or the room layout changed');
} else if (keyedByPayload.length) {
  bad(`${keyedByPayload.length} message handler(s) act on a client-supplied id without resolving the actor:`);
  listing(keyedByPayload.map((h) => `${h.name}  (${h.file}:${h.line})`));
} else {
  pass(`all ${handlers.length} message handlers resolve the actor server-side before using payload ids`);
}

// A message type nobody sends is a door with no visitors — and doors like that
// stop being maintained while staying open. 'meetingRoomJoin' was exactly this:
// dead since furniture meetings moved to "membership on arrival", and it added
// membership from any distance, which is a token for a call you are not standing
// at. Nothing sent it, so nothing noticed. Hence: every handler must have a
// sender in real client code, or be named below with the reason it has none.

/** Message types with no literal `send('…')` in client code, and why that is fine. */
const SENDERLESS_OK = new Map([
  // (empty on purpose — a dynamic-only sender goes here WITH its reason)
]);

const clientSideFiles = [...sources('client/src'), ...sources('desktop/src'), ...sources('shared/src')];
const clientSideText = clientSideFiles.map((f) => read(f)).join('\n');
const senderless = handlers.filter(
  (h) => !new RegExp(String.raw`send\(\s*['"\`]` + h.name + String.raw`['"\`]`).test(clientSideText) && !SENDERLESS_OK.has(h.name),
);
if (handlers.length === 0) {
  // already reported above
} else if (senderless.length) {
  bad(`${senderless.length} message handler(s) nobody sends — dead surface, remove or justify:`);
  listing(senderless.map((h) => `${h.name}  (${h.file}:${h.line})`));
  console.log('        A door nobody uses is a door nobody checks. Delete it, or add it to SENDERLESS_OK with the reason.');
} else {
  pass(`all ${handlers.length} message types are actually sent by client code (no dead surface)`);
}

// Privilege must never arrive in a payload.
const privFromPayload = [];
for (const h of handlers) {
  if (/\b(isAdmin|role|allowPixels|isSpectator|capabilit\w*)\s*[:=][^;\n]*\bmsg\b/.test(h.body)) {
    privFromPayload.push(`${h.name}  (${h.file}:${h.line})`);
  }
}
if (privFromPayload.length) {
  bad('privilege taken from a client payload (must come from the account/session):');
  listing(privFromPayload);
} else {
  pass('no handler derives isAdmin/role/capabilities from a client payload');
}

// Zone entry: private zones and the entry password are decided in onAuth, not
// by the client that asks to join.
const roomSrc = read('server/src/rooms/SimRoom.ts');
const entryOk =
  /canEnterPrivateZone/.test(roomSrc) && /zoneHasPassword/.test(roomSrc) && (roomSrc.match(/gateEntry\(/g) ?? []).length >= 3;
if (entryOk) pass('zone entry gated in onAuth (privacy ACL + entry password, both auth paths)');
else bad('SimRoom.onAuth no longer gates zone entry through gateEntry/canEnterPrivateZone/zoneHasPassword');

// ── 3. Meetings and voice ───────────────────────────────────────────────────
//
// A voice token IS the access to a call: whoever holds one is in the room. So
// the identity in it must be the server's answer, and the request must prove the
// caller is where the call is.

const tokenHandler = handlers.find((h) => h.name === 'meetingRoomToken');
if (!tokenHandler) {
  warn("no 'meetingRoomToken' handler found — in-world calls changed shape; re-check by hand");
} else if (!/meetingRooms\.get\([^)]*\)\?\.has\(/.test(tokenHandler.body)) {
  bad("'meetingRoomToken' does not check membership — any client could mint a token for any call");
} else {
  pass("'meetingRoomToken' mints only for a member of that call (membership is the gate)");
}

const mintSites = [];
for (const file of serverFiles) {
  const src = read(file);
  for (const c of calls(src, String.raw`\bmintVoiceToken\s*\(`)) {
    const args = c.text.slice(1, -1);
    if (/\bmsg\b|\breq\.body\b|\bbody\./.test(args)) mintSites.push(`${file}:${lineOf(src, c.at)}`);
  }
}
if (mintSites.length) {
  bad('a voice token takes its identity/room from client input (identity must be server-derived):');
  listing(mintSites);
} else {
  pass('every voice token is minted with a server-derived identity');
}

const meetApi = read('server/src/meetingRoomApi.ts');
const joinCall = calls(meetApi, String.raw`\bapp\.post\s*\(`).find((c) => c.name === '/meet/:slug/join');
if (!joinCall) {
  warn('no POST /meet/:slug/join found — guest access to meetings changed; re-check by hand');
} else {
  const missing = [];
  if (!/verifyPassword\(/.test(joinCall.text)) missing.push('password verification');
  if (!/isThrottled\(|noteFail\(/.test(joinCall.text)) missing.push('brute-force throttling');
  if (!/roomUsable\(|isExpired\(/.test(joinCall.text)) missing.push('expiry/owner check');
  if (missing.length) bad(`guest meeting join is missing: ${missing.join(', ')}`);
  else pass('guest meeting join verifies password, throttles guesses and honours expiry');
}

const roomStore = read('server/src/meetingRoomStore.ts');
if (!/randomBytes\(/.test(roomStore)) bad('meeting-room slugs are not generated from crypto randomness (a guessable link is the whole lock)');
else if (!/hashPassword\(|scrypt/.test(roomStore)) bad('meeting-room passwords are not hashed (pwhash.ts/scrypt)');
else pass('meeting-room links are crypto-random and their passwords are hashed');

// ── 4. Chat ─────────────────────────────────────────────────────────────────
//
// Chat reaches every viewer in the zone, so the sender must be the server's idea
// of who they are, the text must be bounded, and the rate must be capped.

const chat = handlers.find((h) => h.name === 'chat');
if (!chat) {
  warn("no 'chat' handler found — re-check the chat path by hand");
} else {
  const missing = [];
  if (/msg\??\.(from|name|author|id)\b/.test(chat.body)) missing.push('sender name comes from the payload');
  if (!/chatNameFor\(client|authOf\(client/.test(chat.body)) missing.push('sender not resolved from the session');
  if (!/\.slice\(0,\s*\d+\)/.test(chat.body)) missing.push('no length cap on the text');
  if (!/lastChatAt|Date\.now\(\)\s*-/.test(chat.body)) missing.push('no rate limit');
  if (missing.length) bad(`chat: ${missing.join('; ')}`);
  else pass('chat is session-attributed, length-capped and rate-limited');
}

// ── 5. Secrets and identity plumbing ────────────────────────────────────────

const SECRET_NAMES = /LIVEKIT_API_SECRET|LIVEKIT_API_KEY|PIXEL_ADMIN_TOKEN|scryptSync|passwordHash|pwHash/;
const clientLeaks = [];
for (const file of sources('client/src')) {
  const src = read(file);
  src.split('\n').forEach((l, i) => {
    if (SECRET_NAMES.test(l)) clientLeaks.push(`${file}:${i + 1}  ${l.trim().slice(0, 80)}`);
  });
}
if (clientLeaks.length) {
  bad('a server secret is named in client code:');
  listing(clientLeaks);
} else {
  pass('no server secret named anywhere in client/src');
}

const sendLeaks = [];
for (const file of serverFiles) {
  const src = read(file);
  for (const c of calls(src, String.raw`\b(?:client\.send|broadcast)\s*\(`)) {
    if (/apiSecret|API_SECRET|adminToken|passwordHash|pwHash|scryptHash/.test(c.text)) {
      sendLeaks.push(`${file}:${lineOf(src, c.at)}`);
    }
  }
}
if (sendLeaks.length) {
  bad('a secret is put into a message sent to clients:');
  listing(sendLeaks);
} else {
  pass('no secret appears in a client.send/broadcast payload');
}

const indexSrc = read('server/src/index.ts');
if (!/define\(WORLD_ROOM,\s*SimRoom,\s*\{[^}]*authRequired:\s*true/.test(indexSrc)) {
  bad('the world room is defined without authRequired: true — there is no anonymous mode');
} else if (!/attachFeedServer\([^)]*authRequired:\s*true/.test(indexSrc)) {
  bad('the agent feed is attached without authRequired: true');
} else {
  pass('world room and agent feed both require an account');
}

const feed = read('server/src/ingest/feedServer.ts');
if (!/getByAgentToken\(/.test(feed)) bad("the feed does not resolve its owner from the agent token — an agent's identity would be self-declared");
else pass("the feed resolves an agent's owner from the per-user agent token");

// ── What a human still decides ──────────────────────────────────────────────
check('a NEW public route / message: is its allow-list entry above still the smallest thing that works?');
check('rate limits and length caps on anything a compromised client can repeat (scrypt paths especially)');
check('personal data added to a synced schema: does every viewer being able to read it match what it is?');

process.exit(failed);
