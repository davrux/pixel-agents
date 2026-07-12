// Proves the +100 item-id band shift transforms (migrateItemIds) remap exactly the
// right ids and leave everything else — block ids, tool names, sizes, indices,
// string armor ids — untouched. Pure functions, no DB (that's why they live in
// itemIdShift.ts). Run via the server "test" script (node --import tsx --test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shiftNumericId, shiftStringId, shiftCountMapJson, shiftSettingsJson } from './itemIdShift.js';

test('shiftNumericId: blocks stay, materials/tools move +100', () => {
  assert.equal(shiftNumericId(0), 0);
  assert.equal(shiftNumericId(1), 1);
  assert.equal(shiftNumericId(99), 99); // top of old block band — unchanged
  assert.equal(shiftNumericId(100), 200); // old COAL_LUMP → new
  assert.equal(shiftNumericId(202), 302); // old pick_steel → new
  assert.equal(shiftNumericId(252), 352); // old bucket_lava → new
});

test('shiftStringId: only mat:/b forms with embedded ≥100 numbers move', () => {
  assert.equal(shiftStringId('pick_wood'), 'pick_wood'); // tool name, no number
  assert.equal(shiftStringId('block:1'), 'block:1'); // block id < 100
  assert.equal(shiftStringId('block:99'), 'block:99');
  assert.equal(shiftStringId('b250'), 'b350'); // bucket
  assert.equal(shiftStringId('b243'), 'b343'); // flint & steel
  assert.equal(shiftStringId('mat:100'), 'mat:200'); // coal lump
  assert.equal(shiftStringId('mat:124'), 'mat:224'); // mese crystal
  assert.equal(shiftStringId('armor:steel_torso'), 'armor:steel_torso'); // string id
});

test('shiftCountMapJson: remaps keys, preserves counts (inventory/chest/durability)', () => {
  const out = JSON.parse(shiftCountMapJson('{"1":5,"202":1,"250":3}')) as Record<string, number>;
  assert.deepEqual(out, { 1: 5, 302: 1, 350: 3 });
});

test('shiftSettingsJson: hotbar slots + wield keys shift; sizes/indices/armor untouched', () => {
  const input = JSON.stringify({
    hotbarSize: 8,
    sel: 2,
    hotbar: { slots: ['pick_wood', 'block:1', 'b250'] },
    wield: { b250: { x: 1 }, pick_wood: { y: 2 }, 'mat:100': { z: 3 } },
    armor: { torso: 'armor:steel_torso' },
  });
  const out = JSON.parse(shiftSettingsJson(input)) as Record<string, unknown>;
  assert.deepEqual((out.hotbar as { slots: string[] }).slots, ['pick_wood', 'block:1', 'b350']);
  assert.deepEqual(out.wield, { b350: { x: 1 }, pick_wood: { y: 2 }, 'mat:200': { z: 3 } });
  assert.equal(out.hotbarSize, 8); // a size, not an id
  assert.equal(out.sel, 2); // a slot index, not an id
  assert.deepEqual(out.armor, { torso: 'armor:steel_torso' }); // string id, unchanged
});
