// TimeTracking protocol rules — the two derivations that decide what the world
// shows and which buttons the clock offers.
//
// These live in the main process because it is the only part of the project
// that talks to the vendor's API, so this is where they are tested. Everything
// needing a live TimeTracking install (the login, the entry endpoints, the
// poller) is verified by hand — mocking the vendor's HTTP surface would only
// assert our own fixture.
//
// `normalizeBaseUrl` is deliberately not tested here: it lives in settings.ts,
// which imports `electron` at module load and so cannot be required outside a
// running Electron process.
import assert from 'node:assert/strict';
import test from 'node:test';

import { bookingForAction, statusFromEntry, type AllowedBooking } from './protocol.js';

const booking = (bookingType: string, bookingDirection: 'BEGINNING' | 'ENDING'): AllowedBooking =>
  ({ bookingType, bookingDirection }) as AllowedBooking;

// ── statusFromEntry: what goes over the character's head ──────────

test('a running entry reads its status from the booking that opened it', () => {
  assert.equal(statusFromEntry('COMING', null, true), 'working');
  assert.equal(statusFromEntry('ON_COMPANY_GROUND', null, true), 'working');
  assert.equal(statusFromEntry('HOMEOFFICE', null, true), 'homeoffice');
  assert.equal(statusFromEntry('BUSINESS_TRIP', null, true), 'trip');
  assert.equal(statusFromEntry('BUSINESS_DRIVE', null, true), 'trip');
});

test('an unmapped booking type still reads as at work while running', () => {
  // An employer who renames a custom booking type should not blank their
  // people's status — showing them working is the safer failure.
  assert.equal(statusFromEntry('CUSTOM_TYPE_1', null, true), 'working');
});

test('a closed entry distinguishes a break from the end of the day', () => {
  assert.equal(statusFromEntry('COMING', 'BREAK', false), 'break');
  assert.equal(statusFromEntry('COMING', 'LEAVING', false), 'away');
  assert.equal(statusFromEntry('HOMEOFFICE', 'LEAVING', false), 'away');
  // Nothing booked at all today.
  assert.equal(statusFromEntry(null, null, false), 'away');
});

// ── bookingForAction: which buttons the clock offers ──────────────

test('start prefers COMING among the allowed beginning bookings', () => {
  const allowed = [booking('HOMEOFFICE', 'BEGINNING'), booking('COMING', 'BEGINNING')];
  assert.equal(bookingForAction('start', allowed)?.bookingType, 'COMING');
});

test('start falls back to whatever beginning booking the install offers', () => {
  // An install permitting only home office must still have a working button.
  assert.equal(bookingForAction('start', [booking('HOMEOFFICE', 'BEGINNING')])?.bookingType, 'HOMEOFFICE');
});

test('pause is BREAK or nothing', () => {
  assert.equal(bookingForAction('pause', [booking('BREAK', 'ENDING')])?.bookingType, 'BREAK');
  // LEAVING is an ending booking too, but it ends the day — it is not a pause.
  assert.equal(bookingForAction('pause', [booking('LEAVING', 'ENDING')]), null);
});

test('end prefers LEAVING and never resolves to BREAK', () => {
  const both = [booking('BREAK', 'ENDING'), booking('LEAVING', 'ENDING')];
  assert.equal(bookingForAction('end', both)?.bookingType, 'LEAVING');
  assert.equal(bookingForAction('end', [booking('BREAK', 'ENDING')]), null);
  assert.equal(bookingForAction('end', [booking('BUSINESS_TRIP', 'ENDING')])?.bookingType, 'BUSINESS_TRIP');
});

test('an action the install forbids resolves to null, so its button stays disabled', () => {
  assert.equal(bookingForAction('start', []), null);
  assert.equal(bookingForAction('pause', []), null);
  assert.equal(bookingForAction('end', []), null);
  // Direction matters: a COMING listed as an ENDING is not a way to start.
  assert.equal(bookingForAction('start', [booking('COMING', 'ENDING')]), null);
  assert.equal(bookingForAction('pause', [booking('BREAK', 'BEGINNING')]), null);
});
