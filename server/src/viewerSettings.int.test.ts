/**
 * A viewer preference is personal, and it has to survive two things that are easy
 * to get wrong when a new one is added.
 *
 * The first is the UPGRADE: every existing world already has a `viewerSettings`
 * blob written before the new key existed, so the row a real user reads back is
 * always partial. If a missing key does not fall back to the documented default,
 * the feature arrives switched on (or off) for everybody who ever opened
 * Settings, and only for them — the worst kind of "works on my machine".
 *
 * The second is ISOLATION: these are keyed by the authenticated userId (see
 * AGENTS.md § Security), so one viewer's write must be invisible to the next.
 *
 * `iframeOverlay` is the case under test because it changes what the screen does
 * — a window over the world instead of a column beside it — so a wrong default is
 * immediately visible to the wrong person.
 *
 * TEST BOUNDARIES:
 *   @real-dependency: appStore + SQLite -- Mock? NO. The merge of a stored blob
 *       over the defaults IS the store, and a stub would only restate my own
 *       assumption about it. A throwaway PIXEL_STREAM_DATA_DIR keeps it away from
 *       a developer's world, which is why appStore is imported dynamically (db.ts
 *       resolves that path at module load).
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'pixel-viewersettings-'));
process.env.PIXEL_STREAM_DATA_DIR = dir;
const { appStore, defaultViewerSettings } = await import('./appStore.js');
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));

test('a viewer nobody has ever stored anything for gets the documented defaults', () => {
  const s = appStore.getViewerSettings('never-seen');
  assert.deepEqual(s, defaultViewerSettings());
  // Named individually, because this is the answer an anonymous viewer and a
  // fresh account both get, and 'off' is what keeps an upgrade invisible: the
  // docked column is the shape this always had.
  assert.equal(s.iframeOverlay, false, 'an iframe action still docks beside the game until asked otherwise');
  assert.equal(s.soundEnabled, true);
  assert.equal(s.cameraFollow, true);
  assert.equal(s.alwaysShowLabels, false);
  assert.equal(s.alertVolume, 1);
});

test('SimRoom hands an anonymous viewer exactly what a stored one would read', () => {
  // The room has no row to read for a guest, so it sends defaultViewerSettings().
  // Those two lists living in different files is how a preference ends up meaning
  // one thing for a guest and another for an account.
  assert.deepEqual(Object.keys(defaultViewerSettings()).sort(), Object.keys(appStore.getViewerSettings('never-seen')).sort());
});

test('a preference persists, and is invisible to every other viewer', () => {
  appStore.setViewerSetting('ann', 'iframeOverlay', true);
  assert.equal(appStore.getViewerSettings('ann').iframeOverlay, true);
  assert.equal(appStore.getViewerSettings('bo').iframeOverlay, false, "ann's window must not open over bo's world");
  // Turning it back off is a real answer, not "unset".
  appStore.setViewerSetting('ann', 'iframeOverlay', false);
  assert.equal(appStore.getViewerSettings('ann').iframeOverlay, false);
});

test('one preference does not disturb the others', () => {
  appStore.setViewerSetting('cy', 'alertVolume', 0.25);
  appStore.setViewerSetting('cy', 'iframeOverlay', true);
  const s = appStore.getViewerSettings('cy');
  assert.equal(s.alertVolume, 0.25);
  assert.equal(s.iframeOverlay, true);
  assert.equal(s.soundEnabled, true, 'an untouched preference keeps its default');
});

test('a row written before this preference existed reads back the default for it', () => {
  // Exactly what every deployed world holds: the blob as it was written when
  // `iframeOverlay` was not a key yet.
  appStore.setSetting('viewerSettings', { dee: { soundEnabled: false, alwaysShowLabels: true, alertVolume: 0.5, cameraFollow: false } });
  const s = appStore.getViewerSettings('dee');
  assert.equal(s.iframeOverlay, false, 'a key the row predates must not arrive switched on');
  // …and the preferences that row DID carry are untouched by the merge.
  assert.equal(s.soundEnabled, false);
  assert.equal(s.alwaysShowLabels, true);
  assert.equal(s.alertVolume, 0.5);
  assert.equal(s.cameraFollow, false);
});

test('an anonymous write goes nowhere: there is no key to store it under', () => {
  appStore.setViewerSetting('', 'iframeOverlay', true);
  assert.equal(appStore.getViewerSettings('').iframeOverlay, false);
});
