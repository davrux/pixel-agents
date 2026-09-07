/**
 * A malformed token count in a transcript may not reach the wire — and may not stop a world.
 *
 * This is a regression test for a crash that was reproduced end to end on 2026-09-07: a feed line
 * whose `usage.input_tokens` was the STRING `"99999"` — which a tool that quotes numbers writes
 * without malice — travelled unvalidated through the parser into `CharacterSync.inputTokens`, a
 * `uint32`. `@colyseus/schema` throws on a type mismatch AT ASSIGNMENT, that assignment happens in
 * `SimRoom.syncCharacters` inside the simulation timer, and nothing caught it. Node exited with
 * status 1: one line from any account's feed took down the whole server, every zone with it.
 *
 * The measured behaviour of the schema is what makes this class of bug sharp, and it is worth
 * knowing before adding the next synced field: a wrong TYPE throws (string into a number field,
 * number into a string field), while an out-of-range number, a NaN or a non-boolean boolean go
 * through quietly. So type is what has to be guaranteed, and range is what has to be clamped.
 *
 * Three layers are pinned here, deliberately not one:
 *
 *  1. `agentCount` — the boundary. It decides what a count IS, and every route into the engine
 *     goes through it.
 *  2. `setAgentTokens` — the engine's public setter clamps anyway, so no other caller can poison
 *     the state either.
 *  3. What the numbers must satisfy to be safe in a `uint32` at all.
 *
 * The tick guard itself (SimRoom catching a throw instead of letting the process die) is not
 * testable from here without a room; it is the fourth layer and exists for the NEXT field.
 *
 * TEST BOUNDARIES:
 *   @real-dependency: the real parser, the real engine, the real schema class -- Mock? NO. The bug
 *       was precisely a disagreement between what the parser produced and what the schema accepts,
 *       so a stub of either end would test the assumption that broke.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';

import { OfficeState } from '@pixel/shared/office/engine/officeState.js';
import { agentCount } from '@pixel/shared/protocol';
import { CharacterSync } from '@pixel/shared/schema';
import type { AgentEvent } from '@pixel/shared/protocol';

import { newParseState, parseLine } from './ingest/transcriptParser.js';

/** The events one JSONL line produces, with a fresh per-agent parser state. */
function eventsFor(line: unknown): AgentEvent[] {
  const out: AgentEvent[] = [];
  parseLine(7, JSON.stringify(line), newParseState(), (ev) => out.push(ev));
  return out;
}

const emptyMap = (cols = 10, rows = 10) => ({
  cols,
  rows,
  tiles: new Array(cols * rows).fill(1),
  walls: { horizontal: [], vertical: [] },
  furniture: [] as Array<Record<string, unknown>>,
});

test('a quoted token count is a number by the time it leaves the parser', () => {
  const events = eventsFor({ type: 'assistant', message: { usage: { input_tokens: '99999', output_tokens: 5 } } });
  const tokens = events.find((e) => e.t === 'tokens');
  assert.ok(tokens, 'the line produced no tokens event at all');
  assert.equal(typeof (tokens as { inputTokens: unknown }).inputTokens, 'number');
  assert.equal((tokens as { inputTokens: number }).inputTokens, 99999, 'a numeric string is a formatting choice, not a lie');
  assert.equal((tokens as { outputTokens: number }).outputTokens, 5);
});

test('nonsense produces no event rather than a zero', () => {
  // Overwriting a real count with 0 because one line was malformed would be a second bug: the
  // agent would appear to have used nothing.
  for (const usage of [
    { input_tokens: 'abc' },
    { input_tokens: {} },
    { input_tokens: null },
    { input_tokens: [] },
    { input_tokens: true },
  ]) {
    const events = eventsFor({ type: 'assistant', message: { usage } });
    assert.equal(
      events.some((e) => e.t === 'tokens'),
      false,
      `${JSON.stringify(usage)} should not have produced a tokens event`,
    );
  }
});

test('agentCount answers with something a uint32 can hold, or with nothing', () => {
  const MAX = 0xffffffff;
  assert.equal(agentCount(1234), 1234);
  assert.equal(agentCount('1234'), 1234, 'a quoted number is still a number');
  assert.equal(agentCount(12.7), 12, 'floored: a token count is not fractional');
  assert.equal(agentCount(-5), 0, 'clamped, because a uint32 would read -5 as four billion');
  assert.equal(agentCount(1e12), MAX, 'clamped to what the field can hold');
  assert.equal(agentCount(Number.NaN), null);
  assert.equal(agentCount(Number.POSITIVE_INFINITY), null);
  assert.equal(agentCount('abc'), null);
  assert.equal(agentCount(''), null, 'an empty string is not a zero');
  assert.equal(agentCount(undefined), null);
  assert.equal(agentCount({}), null);
});

test('the engine setter cannot be poisoned by any caller', () => {
  // Layer two: the parser is not the only way in (SimRoom re-applies the director's stored counts
  // on a rejoin), so the engine's own API clamps.
  const os = new OfficeState(emptyMap() as never);
  os.addAgent(7, undefined, undefined, false, 'owner');
  const ch = os.getCharacter(7);
  assert.ok(ch);

  os.setAgentTokens(7, 10, 20);
  assert.deepEqual([ch.inputTokens, ch.outputTokens], [10, 20]);

  // A string, the exact value that killed the process. It must not land in the character.
  os.setAgentTokens(7, '99999' as never, 5);
  assert.equal(typeof ch.inputTokens, 'number');
  assert.equal(ch.inputTokens, 99999);

  // And unusable input leaves the previous count standing rather than zeroing it.
  os.setAgentTokens(7, Number.NaN, Number.NaN);
  assert.deepEqual([ch.inputTokens, ch.outputTokens], [99999, 5]);
});

test('what the character holds can always be assigned to the schema', () => {
  // The end of the chain, asserted against the real schema class: this is the assignment that threw
  // inside the tick. Every value the engine can hold after the clamps must survive it.
  const os = new OfficeState(emptyMap() as never);
  os.addAgent(7, undefined, undefined, false, 'owner');
  const ch = os.getCharacter(7)!;
  const cs = new CharacterSync();

  for (const bad of ['99999', 'abc', -5, 1e12, Number.NaN, Number.POSITIVE_INFINITY, null, undefined, {}, []]) {
    os.setAgentTokens(7, bad as never, bad as never);
    // Would have thrown "a 'number' was expected" before the clamps existed.
    cs.inputTokens = ch.inputTokens;
    cs.outputTokens = ch.outputTokens;
    assert.equal(typeof cs.inputTokens, 'number', `schema rejected what the engine held after ${JSON.stringify(bad)}`);
    assert.ok(cs.inputTokens >= 0 && cs.inputTokens <= 0xffffffff);
  }
});
