/**
 * Everything a mapper may write is offered in Tiled's dropdown, and nothing else is.
 *
 * `actionKind` has been a real enum in Pixels.tiled-project since long before the race existed —
 * which is why nobody noticed that six kinds had been added to the code and none of them to the
 * list. A mapper opening a race map saw a dropdown that did not contain `raceGate`, so the only
 * way to author one was to type the string by hand into a property that looked like it had a fixed
 * set of values. That is worse than having no enum at all.
 *
 * So the two lists are compared here rather than kept in step by memory: `sanitizeAction` is the
 * allow-list of what a layout may carry (AGENTS.md § Security — it runs on every write path), and
 * the dropdown must offer exactly that.
 *
 * TEST BOUNDARIES:
 *   @real-dependency: the committed .tiled-project and the real sanitizeAction -- Mock? NO. The
 *       claim is about those two files agreeing, so a stub of either proves nothing.
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { sanitizeAction } from './layoutSanitize.js';

const ROOT = join(import.meta.dirname, '..', '..');
const PROJECT = join(ROOT, 'assets', 'tiled', 'Pixels.tiled-project');

interface PropertyType {
  name: string;
  type: string;
  values?: string[];
  members?: Array<{ name: string; type: string; propertyType?: string }>;
}

const project = (): PropertyType[] =>
  (JSON.parse(readFileSync(PROJECT, 'utf8')) as { propertyTypes: PropertyType[] }).propertyTypes;

const typeNamed = (name: string): PropertyType => {
  const t = project().find((x) => x.name === name);
  assert.ok(t, `Pixels.tiled-project has no property type "${name}"`);
  return t;
};

test('every action kind the server accepts is in the Tiled dropdown', () => {
  const offered = new Set(typeNamed('ActionKind').values ?? []);
  // What the server accepts, asked of the allow-list itself rather than of a list written twice.
  // `appliance` needs its pose and `iframe` its url, so each is offered a minimal valid payload.
  const payloads: Record<string, Record<string, unknown>> = {
    appliance: { pose: 'coffee' },
    iframe: { url: 'https://example.com' },
  };
  for (const kind of [
    'meetingRoom', 'meetingManager', 'iframe', 'appliance', 'arcade', 'timeClock', 'petScores',
    'portal', 'toggle', 'spawnPoint', 'talkingObject',
    'raceGate', 'raceStart', 'raceRough', 'raceFinish', 'raceRecords',
  ]) {
    // Each of these really is accepted — so the list below is the server's own answer, not a
    // second copy of it that could drift in the other direction.
    assert.ok(
      sanitizeAction({ kind, ...(payloads[kind] ?? {}) }),
      `sanitizeAction rejects "${kind}", so this list is out of date, not the dropdown`,
    );
    assert.ok(offered.has(kind), `Tiled's actionKind dropdown does not offer "${kind}"`);
  }
});

test('the dropdown offers nothing the server would throw away', () => {
  const payloads: Record<string, Record<string, unknown>> = {
    appliance: { pose: 'coffee' },
    iframe: { url: 'https://example.com' },
  };
  for (const kind of typeNamed('ActionKind').values ?? []) {
    if (kind === '') continue; // the empty choice is "no action", which is how you clear one
    assert.ok(
      sanitizeAction({ kind, ...(payloads[kind] ?? {}) }),
      `Tiled offers "${kind}" but the server strips it on save — a mapper would lose the work`,
    );
  }
});

test('a race gate and a grid slot can be authored at all', () => {
  // The payload fields are as invisible as the kind was: without them on the class, a mapper can
  // pick `raceGate` from the dropdown and has nowhere to put its NUMBER, which is the whole of
  // what a gate is.
  const members = new Set((typeNamed('ActionArea').members ?? []).map((m) => m.name));
  for (const field of ['actionGate', 'actionSlot', 'actionDir']) {
    assert.ok(members.has(field), `ActionArea has no "${field}", so race markers cannot be authored`);
  }
  // And they mean what the sanitiser reads.
  assert.deepEqual(sanitizeAction({ kind: 'raceGate', gate: 7 }), { kind: 'raceGate', gate: 7 });
  assert.deepEqual(sanitizeAction({ kind: 'raceStart', slot: 3, dir: 90 }), { kind: 'raceStart', slot: 3, dir: 90 });
});
