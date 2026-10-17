import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIndex } from '../scripts/build-wh-statics.js';

test('parseIndex pairs each static with where it leads, keeping systems only', () => {
  const rows = [
    { k: 't', n: 'A239', c: 'ls' },
    { k: 's', n: 'J100211', c: 'c1', r: 'A-R00002', s: 'N110', sc: 1, sd: 'hs' },
    { k: 's', n: 'J000102', c: 'c13', r: 'H-R00032', e: 'Wolf-Rayet Star', s: 'Q003 Z006', sc: 2, sd: 'ns c3', x: 1 },
    { k: 'e', n: 'Pulsar' },
  ];
  assert.deepEqual(parseIndex(rows), {
    J000102: ['c13', 'H-R00032', 'Wolf-Rayet Star', 1, [['Q003', 'ns'], ['Z006', 'c3']]],
    J100211: ['c1', 'A-R00002', null, 0, [['N110', 'hs']]],
  });
  assert.deepEqual(Object.keys(parseIndex(rows)), ['J000102', 'J100211']);
});

test('parseIndex rejects a system whose statics and destinations do not line up', () => {
  assert.throws(() => parseIndex([{ k: 's', n: 'J1', s: 'A B', sd: 'hs' }]), /2 statics but 1/);
  assert.deepEqual(parseIndex(null), {});
});
