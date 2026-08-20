#!/usr/bin/env node
/**
 * Memory-leak section of the mmo-readiness check.
 *
 * A leak here is not a crash, which is exactly the problem: an MMO-style server runs for
 * weeks and a browser tab stays open all day, so anything that only ever grows is found by
 * a user reporting that "it gets slow", weeks later, with no stack trace. That is worth
 * checking mechanically rather than remembering.
 *
 * Same shape as the security section: find the surfaces where THIS code accumulates —
 * per-connection state, event-bus subscriptions, timers, blob URLs, GPU textures, module
 * caches — and require the release to exist in the code that acquires. Anything that grows
 * on purpose is named in an allow-list WITH the bound that makes it safe, so "this one is
 * fine" is a decision somebody wrote down rather than an absence nobody noticed.
 *
 * Exit code: 1 if any hard check fails, else 0.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
let failed = 0;
const pass = (m) => console.log(`  \x1b[32m✓ PASS\x1b[0m  ${m}`);
const bad = (m) => {
  console.log(`  \x1b[31m✗ FAIL\x1b[0m  ${m}`);
  failed = 1;
};
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
    if (statSync(join(ROOT, rel)).isDirectory()) sources(rel, out);
    else if (e.endsWith('.ts') && !e.includes('.test.')) out.push(rel);
  }
  return out;
}

/** Comments blanked, offsets kept — prose says "leak" and "delete" a lot, and a scanner
 *  that counts words in sentences reports balance where there is none. */
function blankComments(src) {
  const out = src.split(''); // code units, not code points: emoji would shift the offsets
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

const FILES = [...sources('server/src'), ...sources('client/src'), ...sources('shared/src')];
const code = new Map(FILES.map((f) => [f, blankComments(readFileSync(join(ROOT, f), 'utf8'))]));
const count = (src, re) => (src.match(re) ?? []).length;
const lineOf = (src, at) => src.slice(0, at).split('\n').length;

console.log('\n\x1b[1m5c. Memory — nothing that only grows\x1b[0m');

// ── 1. Per-connection / per-entity state can shrink ─────────────────────────
//
// A Map field on a room or a renderer is keyed by something that comes and goes: a
// sessionId, a player id, a pet id, a skin. If nothing ever deletes from it, the room
// holds every visitor it ever had. `savedSpots` was exactly that — a write-dedup entry
// per user that outlived the user.
//
// Three things make this checkable rather than noisy, and all three are load-bearing:
//
//   * LIFETIME. Only a class FIELD or a MODULE-level collection can leak; a
//     function-local Map dies with the call, and there are ~90 of those in this tree
//     (path-finding visited sets, per-frame tallies). Scoping is therefore parsed, not
//     grepped: `classFieldsAndModuleState` walks brace depth and asks what each `{`
//     opened.
//   * GROWTH. A collection built once from a literal and then only read — every
//     `SAFE_SCHEMES`-style lookup table — cannot grow, so it is not a leak surface
//     whatever it never deletes. The check needs an `.add(`/`.set(` on it somewhere.
//   * RELEASE ANYWHERE. The release is often not in the file that declares the field:
//     SimRoom's `activity` is cleaned in `applyEvent.ts`. So the identifier is looked
//     for tree-wide. That trades a false negative (two fields sharing a name, one of
//     which is cleaned) for silence on the common case — and the alternative, per-file
//     matching, produced 30 findings nobody would read.

/**
 * Collections that grow on purpose, keyed by `file:name` with the bound that makes them
 * safe. Keyed by location, not by bare name: "the one in sprites.ts is fine" must not
 * excuse a field somebody later gives the same name in a room.
 */
const BOUNDED_FIELDS = new Map([
  // Art stores: keyed by CONTENT or by an id the tileset table offers, so the art bounds them.
  ['client/src/render/sprites.ts:pages', 'atlas pages: bounded by the art actually drawn, reused for the session'],
  ['client/src/render/sprites.ts:byContent', 'atlas frames keyed by the sprite content hash — bounded by how much art exists'],
  ['client/src/scenes/OfficeScene.ts:loadedSheets', 'one name per tileset the layout named — the loading phase fetches each once'],
  ['client/src/render/sprites.ts:refAttempts', 'one entry per reference image the layout names, so it is fetched once'],
  ['shared/src/office/colorize.ts:colorizeCache', 'keyed by sprite identity + colour; the palette is the map\'s'],
  // Warn-once sets: one entry per id that has already been complained about. Bounded by
  // the id space, and the alternative is a warning per frame.
  ['client/src/render/sprites.ts:staleInAtlas', 'ids warned about once — bounded by the catalog'],
  ['client/src/render/sprites.ts:missingArt', 'ids warned about once — bounded by the catalog'],
  ['shared/src/office/floorTiles.ts:warnedSets', 'ground sets warned about once — bounded by the tileset table'],
  ['shared/src/office/wallTiles.ts:warnedWallSets', 'wall sets warned about once — likewise'],
  // Session-lifetime tables built from a fixed key space.
  ['client/src/matrix/MatrixUI.ts:sections', 'one element per ViewName — built once, the views are an enum'],
  ['client/src/conference/videoFilters.ts:generated', 'one data URL per filter preset — bounded by the preset table'],
  // Per-room / per-account state whose key space is the world, not the traffic.
  ['server/src/sim/director.ts:ownerZone', 'one zone id per feed owner — bounded by the users table'],
  ['client/src/matrix/MatrixUI.ts:lastEncryptedState', 'one boolean per room opened — bounded by the room list'],
  ['client/src/matrix/MatrixUI.ts:membersCache', 'one member list per room whose member panel was opened; each open overwrites'],
  // Preferences the user set by hand, deliberately persisted across reconnects.
  ['client/src/conference/LiveKitConference.ts:savedVolumes', 'one volume per peer the viewer adjusted; mirrored to localStorage'],
  ['client/src/voice/MumbleVoice.ts:userVolumes', 'same, for Mumble peers'],
]);

/**
 * Does this `{` open a class BODY? The text before it must reach back to `class` without
 * crossing a brace — except that a type argument may contain braces of its own, which is
 * how `class SimRoom extends Room<{ state: RoomState }> {` fooled the first version of
 * this: the generic's `{}` hid the keyword, every field in the room counted as a
 * function-local, and rule 1 passed on a file whose Maps it had not looked at. So nested
 * brace pairs are folded away first.
 */
function opensClassBody(head) {
  let h = head;
  for (let n = 0; n < 20; n++) {
    const shorter = h.replace(/\{[^{}]*\}/g, ' ');
    if (shorter === h) break;
    h = shorter;
  }
  return /\bclass\b[^{}]*$/.test(h);
}

/**
 * Every `new Map`/`new Set` assigned to a class field or to module-level state, with the
 * name it is bound to. Brace depth decides: depth 0 is module state, and a `{` that
 * follows a `class` header opens a body whose direct members are fields.
 */
function classFieldsAndModuleState(src) {
  const decl =
    /(?:^|[\n;{}])[ \t]*(?:(?:private|public|protected|static|readonly|declare|abstract)\s+)*(?:const\s+|let\s+|var\s+)?([A-Za-z_$][\w$]*)(?:\??\s*:[^=;\n]*)?\s*=\s*new\s+(Map|Set|WeakMap|WeakSet)\s*[<(]/g;
  const decls = [...src.matchAll(decl)].map((m) => ({ at: m.index, name: m[1], weak: m[2].startsWith('Weak') }));
  const found = [];
  const stack = [];
  let i = 0;
  for (const dcl of decls) {
    while (i < dcl.at) {
      const c = src[i];
      if (c === '{') stack.push(opensClassBody(src.slice(Math.max(0, i - 400), i)) ? 'class' : 'block');
      else if (c === '}') stack.pop();
      i++;
    }
    // A WeakMap/WeakSet cannot hold its keys alive, which is the whole point of using one.
    if (dcl.weak) continue;
    const kind = stack.length === 0 ? 'module' : stack.length === 1 && stack[0] === 'class' ? 'field' : null;
    if (kind) found.push({ ...dcl, kind });
  }
  return found;
}

/** Character ranges of every `constructor(...) { … }` in a file. */
function constructorBodies(src) {
  const out = [];
  for (const m of src.matchAll(/\bconstructor\s*\(/g)) {
    let i = src.indexOf('{', m.index);
    if (i < 0) continue;
    let d = 0;
    for (let k = i; k < src.length; k++) {
      if (src[k] === '{') d++;
      else if (src[k] === '}' && --d === 0) {
        out.push([i, k]);
        break;
      }
    }
  }
  return out;
}

/**
 * A collection is released either by losing entries (`delete`/`clear`) or by being
 * REBUILT wholesale — `this.points = layoutToSitPoints(…)` on a layout change bounds it
 * by the layout however much it gains in between. The rebuild must be somewhere other
 * than the declaration and outside a constructor, since assigning a fresh Map once per
 * instance is the declaration written differently, not a release.
 */
function releasedSomewhere(name, declFile, declAt) {
  const shrinks = new RegExp(String.raw`\b${name}\.(delete|clear)\(`);
  // Released anywhere in the tree: the release is often not in the file that declares
  // the field — SimRoom's `activity` is cleaned in applyEvent.ts. That trades a false
  // negative (two fields sharing a name, one of them cleaned) for silence on the common
  // case; per-file matching produced 30 findings nobody would have read.
  if ([...code.values()].some((s) => shrinks.test(s))) return true;
  const src = code.get(declFile);
  const bodies = constructorBodies(src);
  const rebuild = new RegExp(String.raw`(?:this\.)?\b${name}\s*=\s*(?!=)`, 'g');
  for (const m of src.matchAll(rebuild)) {
    if (Math.abs(m.index - declAt) < 40) continue; // the declaration itself
    if (bodies.some(([a, b]) => m.index > a && m.index < b)) continue;
    return true;
  }
  return false;
}

const growing = [];
for (const [file, src] of code) {
  for (const dcl of classFieldsAndModuleState(src)) {
    if (BOUNDED_FIELDS.has(`${file}:${dcl.name}`)) continue;
    const grows = new RegExp(String.raw`\b${dcl.name}\.(set|add)\(`);
    if (![...code.values()].some((s) => grows.test(s))) continue; // built once, never grows
    if (releasedSomewhere(dcl.name, file, dcl.at)) continue;
    growing.push(`${dcl.name}  (${file}:${lineOf(src, dcl.at)}, ${dcl.kind})`);
  }
}
if (growing.length) {
  bad(`${growing.length} long-lived collection(s) grow and are never released:`);
  listing(growing);
  console.log('        Delete where the thing goes away, rebuild the collection, or name the bound in BOUNDED_FIELDS.');
} else {
  pass('every long-lived Map/Set that grows is deleted from or rebuilt');
}

// ── 2. Subscriptions on a process-wide emitter are balanced ────────────────
//
// A module singleton outlives every room, so a room that subscribes and never
// unsubscribes is retained for the life of the server together with its state, its
// clients and its layout. This is the biggest single leak this codebase can have, and
// there are two such emitters (`controlBus` and the agent `director`) — hence the rule
// asks the general question: is the emitter IMPORTED, i.e. shared with everybody else?
// A `ws.on('close')` or a `sprite.on('pointerdown')` is a subscription on an object the
// subscriber owns, and it goes when that object goes; naming the two buses instead would
// have kept passing the day a third one arrives.

/** Imported names in a file — the emitters whose lifetime is NOT the subscriber's. */
function importedNames(src) {
  const names = new Set();
  for (const m of src.matchAll(/import\s+([^;]*?)\s+from\s*['"][^'"]+['"]/g)) {
    for (const part of m[1].replace(/[{}]/g, ' ').split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name && /^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  return names;
}

const busBad = [];
for (const [file, src] of code) {
  const imported = importedNames(src);
  const tally = new Map();
  for (const m of src.matchAll(/\b([A-Za-z_$][\w$]*)\.(on|off|removeListener|removeAllListeners)\(/g)) {
    if (!imported.has(m[1])) continue; // an emitter this file owns dies with the owner
    const t = tally.get(m[1]) ?? { on: 0, off: 0 };
    if (m[2] === 'on') t.on++;
    else t.off++;
    tally.set(m[1], t);
  }
  for (const [name, t] of tally) {
    if (t.on > t.off) busBad.push(`${file}: ${t.on} ${name}.on( vs ${t.off} ${name}.off(`);
  }
}
if (busBad.length) {
  bad('a subscription on a shared emitter is never removed — it retains the subscriber for ever:');
  listing(busBad);
} else {
  pass('every subscription on an imported emitter has its unsubscribe');
}

// ── 3. Intervals are cleared, or unref'd when they live as long as the process ──
const timerBad = [];
for (const [file, src] of code) {
  const set = count(src, /setInterval\(/g);
  if (set === 0) continue;
  const released = count(src, /clearInterval\(/g) + count(src, /\.unref\(\)/g);
  if (set > released) timerBad.push(`${file}: ${set} setInterval( vs ${released} clearInterval/unref`);
}
if (timerBad.length) {
  bad('an interval is neither cleared nor unref\'d — it keeps its closure, and the event loop, alive:');
  listing(timerBad);
} else {
  pass('every setInterval is cleared or unref\'d');
}

// ── 4. Blob URLs are revoked ────────────────────────────────────────────────
//
// A createObjectURL keeps the whole Blob alive until it is revoked — a few of them are
// megabytes of image or audio.

/** Files whose URLs cannot be revoked on creation, and why. */
const URL_KEPT = new Map([
  [
    'client/src/matrix/media.ts',
    'three of them are handed to a download link; revoking before the click cancels the save',
  ],
]);
const urlBad = [];
for (const [file, src] of code) {
  const made = count(src, /URL\.createObjectURL\(/g);
  if (made === 0 || URL_KEPT.has(file)) continue;
  if (count(src, /URL\.revokeObjectURL\(/g) === 0) urlBad.push(`${file}: ${made} createObjectURL, no revoke`);
}
if (urlBad.length) {
  bad('a blob URL is never revoked, so its Blob is never freed:');
  listing(urlBad);
} else {
  pass('every file that creates a blob URL also revokes one');
}

// ── 5. Per-entity textures are removed ─────────────────────────────────────
//
// A texture is GPU memory the garbage collector cannot help with. The Matrix effect makes
// one per character; a canvas texture per uploaded image is another.

/** Files whose textures live as long as the session, and why. */
const TEXTURES_KEPT = new Map([
  [
    'client/src/render/sprites.ts',
    'atlas pages and sheet textures ARE the session\'s art store; they are reused, not per-entity',
  ],
  ['client/src/render/markerIcons.ts', 'one icon set, rasterised per zoom step and reused'],
]);
const texBad = [];
for (const [file, src] of code) {
  const made = count(src, /textures\.(createCanvas|addImage|addBase64)\(/g);
  if (made === 0 || TEXTURES_KEPT.has(file)) continue;
  if (count(src, /textures\.remove\(/g) === 0) texBad.push(`${file}: ${made} texture(s) created, none removed`);
}
if (texBad.length) {
  bad('a texture is created per entity and never removed — GPU memory the GC cannot reclaim:');
  listing(texBad);
} else {
  pass('every file that creates textures per entity removes them too');
}

// ── 6. Synced entities leave the schema ────────────────────────────────────
//
// A MapSchema entry that is never deleted is worse than a leak: it grows the state EVERY
// client decodes, forever.
const schemaBad = [];
for (const [file, src] of code) {
  for (const m of src.matchAll(/state\.([A-Za-z_$][\w$]*)\.set\(/g)) {
    const name = m[1];
    if (new RegExp(String.raw`state\.${name}\.delete\(`).test(src)) continue;
    schemaBad.push(`${file}: state.${name} is set but never deleted`);
  }
}
if (schemaBad.length) {
  bad('a synced collection never loses an entry — every client decodes it forever:');
  listing([...new Set(schemaBad)]);
} else {
  pass('every synced collection that gains entries also drops them');
}

// ── What a human still decides ─────────────────────────────────────────────
check('a NEW module-level cache: is it keyed by CONTENT (bounded by the art) or by a session/entity (unbounded)?');
check('a window/document listener: is its owner constructed once per page? (balance is not the\n          test — a page-singleton never needs the remove, a per-call object always does)');
check('anything held across a zone switch or a reconnect — the room is new, the module state is not');

process.exit(failed);
