/**
 * The map writer must keep a map's own formatting: a one-field change that comes
 * back as a 25 000-line diff is unreviewable and unmergeable, and that is exactly
 * what re-serializing a Tiled-written .tmj produced.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';

import { removeField, removeObjectContaining, removeObjectWithin, setStringField } from '../../scripts/lib/jsonEdit.mjs';

/** Tiled's own compact style, indentation and all. */
const TILED_STYLE = `{ "compressionlevel":-1,
 "height":4,
 "layers":[
        {
         "objects":[
                {
                 "gid":7387,
                 "height":48,
                 "id":430,
                 "name":"",
                 "properties":[
                        {
                         "name":"label",
                         "type":"string",
                         "value":"Fountain"
                        }, 
                        {
                         "name":"bogus",
                         "type":"string",
                         "value":"x"
                        }],
                 "type":"",
                 "width":48
                }],
         "type":"objectgroup"
        }],
 "width":4
}`;

test('setting a class changes one line and nothing else', () => {
  const out = setStringField(TILED_STYLE, '"id":430', 'type', 'FurnitureObject');
  const before = TILED_STYLE.split('\n');
  const after = out.split('\n');
  assert.equal(before.length, after.length, 'no line may be added or removed');
  const changed = before.map((l, i) => (l === after[i] ? null : i)).filter((i) => i !== null);
  assert.equal(changed.length, 1, `exactly one line changes, got ${changed.length}`);
  assert.match(after[changed[0] as number], /"type":"FurnitureObject"/);
  // …and it is still the same map.
  const parsed = JSON.parse(out) as { layers: Array<{ objects: Array<{ type: string; id: number }> }> };
  assert.equal(parsed.layers[0].objects[0].type, 'FurnitureObject');
  assert.equal(parsed.layers[0].objects[0].id, 430);
});

test('a missing key is inserted with its siblings, not appended anywhere', () => {
  const noType = TILED_STYLE.replace('\n                 "type":"",', '');
  const out = setStringField(noType, '"id":430', 'type', 'FurnitureObject');
  assert.equal(out.split('\n').length, noType.split('\n').length + 1, 'exactly one line more');
  assert.equal((JSON.parse(out) as { layers: Array<{ objects: Array<{ type: string }> }> }).layers[0].objects[0].type, 'FurnitureObject');
});

test('removing a property drops it and its comma, leaving the rest untouched', () => {
  const out = removeObjectContaining(TILED_STYLE, '"name":"bogus"');
  const props = (JSON.parse(out) as { layers: Array<{ objects: Array<{ properties: Array<{ name: string }> }> }> }).layers[0].objects[0].properties;
  assert.deepEqual(props.map((p) => p.name), ['label'], 'only the bogus property goes');
  assert.ok(out.includes('"value":"Fountain"'), 'the kept property keeps its text');
  assert.ok(!out.includes('bogus'), 'no leftovers');
});

test('a brace inside a string does not fool the scanner', () => {
  const tricky = TILED_STYLE.replace('"value":"Fountain"', '"value":"Fountain {of} \\"life\\""');
  const out = setStringField(tricky, '"id":430', 'type', 'FurnitureObject');
  const parsed = JSON.parse(out) as { layers: Array<{ objects: Array<{ type: string; properties: Array<{ value: string }> }> }> };
  assert.equal(parsed.layers[0].objects[0].type, 'FurnitureObject');
  assert.equal(parsed.layers[0].objects[0].properties[0].value, 'Fountain {of} "life"');
});

test('an ambiguous or missing anchor is refused, never guessed', () => {
  assert.throws(() => setStringField(TILED_STYLE, '"type":"string"', 'type', 'X'), /not unique/);
  assert.throws(() => setStringField(TILED_STYLE, '"id":999', 'type', 'X'), /not found/);
});

test('a property is removed from the right placement, not the first that matches', () => {
  // Two placements, both carrying a property called label — the name alone points
  // at nothing, which is why the removal is scoped to one object.
  const two = `{"objects":[
   {"id":1,"properties":[{"name":"label","value":"a"},{"name":"bogus","value":"x"}]},
   {"id":2,"properties":[{"name":"label","value":"b"},{"name":"bogus","value":"y"}]}
  ]}`;
  const out = removeObjectWithin(two, '"id":2', '"name":"bogus"');
  const objs = (JSON.parse(out) as { objects: Array<{ id: number; properties: Array<{ name: string; value: string }> }> }).objects;
  assert.deepEqual(objs[0].properties.map((p) => p.name), ['label', 'bogus'], 'the other placement is untouched');
  assert.deepEqual(objs[1].properties.map((p) => p.name), ['label'], 'only the addressed one loses it');
  assert.equal(objs[1].properties[0].value, 'b');
  assert.throws(() => removeObjectWithin(two, '"id":3', '"name":"bogus"'), /not found/);
});

test('a placement that loses its last property loses the empty array too', () => {
  const one = `{"objects":[
   {"id":7,"name":"","properties":[{"name":"bogus","value":"x"}],"type":"FurnitureObject"}
  ]}`;
  const stripped = removeObjectWithin(one, '"id":7', '"name":"bogus"');
  const out = removeField(stripped, '"id":7', 'properties');
  const obj = (JSON.parse(out) as { objects: Array<Record<string, unknown>> }).objects[0];
  assert.equal('properties' in obj, false, 'the key is gone, not left as []');
  assert.equal(obj.type, 'FurnitureObject', 'its siblings survive');
  assert.equal(obj.id, 7);
  assert.ok(!out.includes(',,') && !out.includes('{,') && !out.includes(',}'), 'no dangling commas');
});
