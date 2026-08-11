// TimeTracking integration — integration tests for the parts that hold state
// or encode rules, exercised against the real SQLite store and the real crypto.
//
// ============================================================================
// SCOPE — what is and is not covered, honestly.
//
// Covered here (no network required):
//   - normalizeBaseUrl: what a user may type into the Server field, including
//     the `/api` suffix everyone copies out of the vendor's docs, and the
//     non-http schemes that must never reach fetch()
//   - secrets seal/open: round-trip, and that GCM rejects a tampered value
//     (which is what makes a rotated key degrade to "reconfigure", not to a
//     silent wrong password)
//   - the store: round-trip against the real `timetracking` table, that view()
//     never leaks the password, and that clear() removes the row
//   - bookingForAction: the rule both sides depend on. The client greys a
//     button out with it and the server books with it, so a disagreement here
//     is a button that fails when pressed.
//   - statusFromEntry / formatWorkedTime: what the hover overlay and the chip
//     actually display.
//
// NOT covered (honest absence): everything that needs a live TimeTracking
// server — authorize/refresh, the entry endpoints, and the poller. Those are
// verified manually against a real instance (see the plan's verification
// steps); mocking the vendor's HTTP surface would only assert our own fixture.
//
// The server DB is a process-wide singleton keyed off PIXEL_STREAM_DATA_DIR at
// module load (server/src/db.ts), so — exactly as in auth.desktop.int.test.ts —
// it is pointed at a fresh temp dir BEFORE the dynamic imports.
// ============================================================================
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { bookingForAction, formatWorkedTime, statusFromEntry, type AllowedBooking } from '@pixel/shared';

// The generated time-clock furniture touches no DB, so it imports statically.
import { timeClockAssets, timeClockSprite } from '../timeClockAssets.js';

let dataDir: string;
let timeTrackingStore: typeof import('./store.js').timeTrackingStore;
let normalizeBaseUrl: typeof import('./store.js').normalizeBaseUrl;
let seal: typeof import('./secrets.js').seal;
let openSealed: typeof import('./secrets.js').open;

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'pixel-timetracking-test-'));
  process.env.PIXEL_STREAM_DATA_DIR = dataDir;
  // A fixed key so the seal/open tests don't depend on the generated key file.
  process.env.PIXEL_SECRET_KEY = 'test-key-for-timetracking-secrets';

  ({ timeTrackingStore, normalizeBaseUrl } = await import('./store.js'));
  ({ seal, open: openSealed } = await import('./secrets.js'));
});

after(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

// ── normalizeBaseUrl ──────────────────────────────────────────────

test('normalizeBaseUrl keeps a plain origin and strips a trailing slash', () => {
  assert.equal(normalizeBaseUrl('https://tt.example.com'), 'https://tt.example.com');
  assert.equal(normalizeBaseUrl('https://tt.example.com/'), 'https://tt.example.com');
  assert.equal(normalizeBaseUrl('  https://tt.example.com  '), 'https://tt.example.com');
});

test('normalizeBaseUrl strips the /api suffix people copy from the docs', () => {
  // The vendor documents the endpoint as "https://host/api", so that is what
  // gets pasted — and every path we build already starts with /api.
  assert.equal(normalizeBaseUrl('https://tt.example.com/api'), 'https://tt.example.com');
  assert.equal(normalizeBaseUrl('https://tt.example.com/api/'), 'https://tt.example.com');
});

test('normalizeBaseUrl preserves a sub-path deployment', () => {
  assert.equal(normalizeBaseUrl('https://intra.example.com/timetracking'), 'https://intra.example.com/timetracking');
  assert.equal(normalizeBaseUrl('https://intra.example.com/timetracking/api'), 'https://intra.example.com/timetracking');
});

test('normalizeBaseUrl rejects anything that is not an http(s) URL', () => {
  for (const bad of ['', '   ', 'tt.example.com', 'javascript:alert(1)', 'file:///etc/passwd', 'ftp://x.example.com', 42, null]) {
    assert.equal(normalizeBaseUrl(bad), null, `expected ${String(bad)} to be rejected`);
  }
});

// ── secrets ───────────────────────────────────────────────────────

test('seal/open round-trips a password, including non-ASCII', () => {
  for (const secret of ['hunter2', 'pässwörd mit Ümlauten', 'x'.repeat(200)]) {
    assert.equal(openSealed(seal(secret)), secret);
  }
});

test('seal produces a different ciphertext each time (fresh nonce)', () => {
  assert.notEqual(seal('same'), seal('same'));
});

test('open returns null for a tampered or malformed value', () => {
  const sealed = seal('hunter2');
  const [iv, tag, body] = sealed.split('.');
  // Flip a byte of the ciphertext: GCM's tag must catch it rather than return
  // garbage that would be sent to the TimeTracking server as a password.
  const flipped = Buffer.from(body, 'base64url');
  flipped[0] ^= 0xff;
  assert.equal(openSealed(`${iv}.${tag}.${flipped.toString('base64url')}`), null);
  assert.equal(openSealed('not-sealed'), null);
  assert.equal(openSealed(''), null);
});

// ── store ─────────────────────────────────────────────────────────

test('store round-trips a config and never exposes the password through view()', () => {
  const userId = 'store-roundtrip';
  timeTrackingStore.set(userId, { baseUrl: 'https://tt.example.com', username: 'thomas', password: 'hunter2' });

  const cfg = timeTrackingStore.get(userId);
  assert.deepEqual(cfg, { baseUrl: 'https://tt.example.com', username: 'thomas', password: 'hunter2' });
  assert.equal(timeTrackingStore.has(userId), true);

  const view = timeTrackingStore.view(userId);
  assert.deepEqual(view, { configured: true, baseUrl: 'https://tt.example.com', username: 'thomas' });
  assert.equal(JSON.stringify(view).includes('hunter2'), false);
});

test('store replaces a config in place rather than accumulating rows', () => {
  const userId = 'store-replace';
  timeTrackingStore.set(userId, { baseUrl: 'https://a.example.com', username: 'a', password: 'one' });
  timeTrackingStore.set(userId, { baseUrl: 'https://b.example.com', username: 'b', password: 'two' });
  assert.deepEqual(timeTrackingStore.get(userId), {
    baseUrl: 'https://b.example.com',
    username: 'b',
    password: 'two',
  });
  assert.equal(timeTrackingStore.userIds().filter((u) => u === userId).length, 1);
});

test('store clear() removes the row and reports unconfigured', () => {
  const userId = 'store-clear';
  timeTrackingStore.set(userId, { baseUrl: 'https://tt.example.com', username: 'x', password: 'y' });
  timeTrackingStore.clear(userId);
  assert.equal(timeTrackingStore.get(userId), null);
  assert.equal(timeTrackingStore.has(userId), false);
  assert.deepEqual(timeTrackingStore.view(userId), { configured: false, baseUrl: '', username: '' });
  assert.equal(timeTrackingStore.userIds().includes(userId), false);
});

test('store treats an unknown user as unconfigured', () => {
  assert.equal(timeTrackingStore.get('never-configured'), null);
  assert.equal(timeTrackingStore.get(''), null);
});

// ── bookingForAction (the rule both sides share) ──────────────────

const booking = (bookingType: string, bookingDirection: 'BEGINNING' | 'ENDING'): AllowedBooking =>
  ({ bookingType, bookingDirection }) as AllowedBooking;

test('start prefers COMING among the allowed beginning bookings', () => {
  const allowed = [booking('HOMEOFFICE', 'BEGINNING'), booking('COMING', 'BEGINNING')];
  assert.equal(bookingForAction('start', allowed)?.bookingType, 'COMING');
});

test('start falls back to whatever beginning booking the install offers', () => {
  // An install that only permits home office must still have a working button.
  assert.equal(bookingForAction('start', [booking('HOMEOFFICE', 'BEGINNING')])?.bookingType, 'HOMEOFFICE');
});

test('pause is BREAK or nothing', () => {
  assert.equal(bookingForAction('pause', [booking('BREAK', 'ENDING')])?.bookingType, 'BREAK');
  // LEAVING is an ending booking too, but it ends the day — it is not a pause.
  assert.equal(bookingForAction('pause', [booking('LEAVING', 'ENDING')]), null);
});

test('end prefers LEAVING and never resolves to BREAK', () => {
  assert.equal(bookingForAction('end', [booking('BREAK', 'ENDING'), booking('LEAVING', 'ENDING')])?.bookingType, 'LEAVING');
  assert.equal(bookingForAction('end', [booking('BREAK', 'ENDING')]), null);
  assert.equal(bookingForAction('end', [booking('BUSINESS_TRIP', 'ENDING')])?.bookingType, 'BUSINESS_TRIP');
});

test('an action the install forbids resolves to null (button stays disabled)', () => {
  assert.equal(bookingForAction('start', []), null);
  // Direction matters: a COMING listed as an ENDING is not a way to start.
  assert.equal(bookingForAction('start', [booking('COMING', 'ENDING')]), null);
  assert.equal(bookingForAction('pause', [booking('BREAK', 'BEGINNING')]), null);
});

// ── what the world actually shows ─────────────────────────────────

test('statusFromEntry reads a running entry from its opening booking', () => {
  assert.equal(statusFromEntry('COMING', null, true), 'working');
  assert.equal(statusFromEntry('HOMEOFFICE', null, true), 'homeoffice');
  assert.equal(statusFromEntry('BUSINESS_TRIP', null, true), 'trip');
  // A booking type nobody mapped (a renamed custom type) still reads as at
  // work rather than blanking the status.
  assert.equal(statusFromEntry('CUSTOM_TYPE_1', null, true), 'working');
});

test('statusFromEntry distinguishes a break from the end of the day', () => {
  assert.equal(statusFromEntry('COMING', 'BREAK', false), 'break');
  assert.equal(statusFromEntry('COMING', 'LEAVING', false), 'away');
  assert.equal(statusFromEntry(null, null, false), 'away');
});

// ── The time clock furniture ──────────────────────────────────────

test('the time clock entry declares the dimensions its sprite actually has', () => {
  // Drift here is the classic generated-asset bug: the catalog says one size,
  // the pixels are another, and the thing renders stretched or clipped.
  const [{ entry }] = timeClockAssets();
  const sprite = timeClockSprite();
  assert.equal(sprite.length, entry.height, 'sprite row count must equal declared height');
  assert.equal(sprite[0].length, entry.width, 'sprite column count must equal declared width');
  // 1×2 tiles at the world's 16px tile size.
  assert.equal(entry.footprintW, 1);
  assert.equal(entry.footprintH, 2);
  assert.equal((entry.footprintW as number) * 16, entry.width);
  assert.equal((entry.footprintH as number) * 16, entry.height);
});

test('the time clock carries the timeClock action, so walking up to it opens the panel', () => {
  const [{ entry }] = timeClockAssets();
  assert.equal(entry.id, 'TIME_CLOCK');
  assert.deepEqual(entry.action, { kind: 'timeClock' });
  assert.equal(entry.canPlaceOnFloor, true);
});

test('every time clock pixel is transparent or a valid #rrggbb', () => {
  const sprite = timeClockSprite();
  let painted = 0;
  for (const row of sprite) {
    assert.equal(row.length, 16);
    for (const px of row) {
      if (px === '') continue;
      assert.match(px, /^#[0-9a-f]{6}$/, `bad pixel value ${px}`);
      painted++;
    }
  }
  // Sanity that it is actually a drawing and not an empty grid.
  assert.ok(painted > 200, `expected a drawn sprite, got ${painted} painted pixels`);
});

test('formatWorkedTime rounds down to the minute', () => {
  assert.equal(formatWorkedTime(0), '0:00');
  assert.equal(formatWorkedTime(59_999), '0:00'); // never show a minute not yet worked
  assert.equal(formatWorkedTime(60_000), '0:01');
  assert.equal(formatWorkedTime(3_600_000), '1:00');
  assert.equal(formatWorkedTime(7 * 3_600_000 + 42 * 60_000), '7:42');
  assert.equal(formatWorkedTime(-5), '0:00');
});
