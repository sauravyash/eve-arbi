import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bunzip2, untar } from '../archive.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));

// The fixtures were written by Python's bz2 module; this rebuilds the same sample data.
function sample(n) {
  const words = ['jita', 'amarr', 'kill', 'ship', 'pod', 'null', '{"a":1}', '\n'].map(w => Buffer.from(w));
  const out = [];
  let len = 0, x = 12345;
  while (len < n) {
    x = (Math.imul(x, 1103515245) + 12345) & 0x7fffffff;
    let chunk;
    if (x % 97 === 0) chunk = Buffer.alloc(x % 700, 65 + (x % 26));
    else chunk = Buffer.concat([words[x % words.length], Buffer.from(' ')]);
    out.push(chunk); len += chunk.length;
  }
  return Buffer.concat(out).subarray(0, n);
}

test('bunzip2: several blocks, long runs and a second stream', () => {
  const got = Buffer.from(bunzip2(fixture('bz2-multiblock.bz2')));
  const want = Buffer.concat([sample(260000), Buffer.from('second stream\n')]);
  assert.equal(got.length, want.length);
  assert.ok(got.equals(want));
});

test('bunzip2: rejects what is not bzip2', () => {
  assert.throws(() => bunzip2(Buffer.from('hello world')), /not a bzip2 file/);
  const cut = fixture('bz2-multiblock.bz2').subarray(0, 600);
  assert.throws(() => bunzip2(cut), /bzip2/);
});

test('untar: regular files in order, GNU long names included', () => {
  const files = [];
  untar(bunzip2(fixture('killmails.tar.bz2')), (name, data) => files.push([name, JSON.parse(Buffer.from(data)).killmail_id]));
  assert.deepEqual(files, [['killmails/1.json', 1], [`killmails/${'x'.repeat(120)}.json`, 2]]);
});
