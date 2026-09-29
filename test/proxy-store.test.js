import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadCache, saveCache, saveCacheSync } from '../proxy-store.js';

const entry = (body, fetchedAt, type = 'application/json; charset=utf-8') => ({
  status: 200, body: Buffer.from(body), type, expires: fetchedAt + 60_000, fetchedAt, pages: '2', lastModified: null,
});

async function withDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'proxy-store-'));
  try { await fn(path.join(dir, 'sub', 'proxy-cache.json.gz')); } finally { await rm(dir, { recursive: true, force: true }); }
}

test('saveCache and loadCache round-trip text and binary bodies in order', () => withDir(async (file) => {
  const now = Date.now();
  const cache = new Map([
    ['https://a/1', entry('{"é":1}', now - 2000)],
    ['https://a/2', entry('\x00\xff raw', now - 1000, 'application/octet-stream')],
  ]);
  await saveCache(file, cache);
  const back = await loadCache(file, { now });
  assert.deepEqual([...back.keys()], ['https://a/1', 'https://a/2']);
  assert.deepEqual(back.get('https://a/1'), cache.get('https://a/1'));
  assert.deepEqual(back.get('https://a/2').body, cache.get('https://a/2').body);
}));

test('loadCache keeps recently expired entries and drops old ones', () => withDir(async (file) => {
  const now = Date.now();
  saveCacheSync(file, new Map([['old', entry('1', now - 3 * 3600_000)], ['recent', entry('2', now - 600_000)]]));
  const back = await loadCache(file, { now, maxAge: 3600_000 });
  assert.deepEqual([...back.keys()], ['recent']);
}));

test('saveCache keeps the newest entries within the byte budget', () => withDir(async (file) => {
  const now = Date.now();
  const cache = new Map([['a', entry('x'.repeat(60), now - 3)], ['b', entry('y'.repeat(60), now - 1)], ['c', entry('z'.repeat(60), now - 2)]]);
  await saveCache(file, cache, { maxBytes: 130 });
  assert.deepEqual([...(await loadCache(file, { now })).keys()], ['c', 'b']);
}));

test('loadCache starts empty when the file is missing or corrupt', () => withDir(async (file) => {
  assert.equal((await loadCache(file)).size, 0);
  await saveCache(file, new Map());
  await writeFile(file, 'not gzip');
  assert.equal((await loadCache(file)).size, 0);
}));
