// Keeps server.js's proxy cache on disk (.cache/proxy-cache.json.gz), so a restart doesn't
// re-fetch everything the pages had already loaded. Expired entries are kept too: the proxy
// serves them as the last good copy (X-Cache: STALE) when the upstream fails.
//
//   const cache = await loadCache(file);   // Map url → {status, body: Buffer, type, expires, fetchedAt, …}
//   await saveCache(file, cache);          // newest first, bodies up to maxBytes in total

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { writeFileSync, renameSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { gzip, gunzip, gzipSync } from 'node:zlib';

const MAX_BYTES = 64 * 1024 * 1024;  // bodies written per save
const MAX_AGE = 24 * 3600_000;       // entries this long past expiry are dropped on load

// JSON and text bodies are stored as text (gzip packs them far better than base64).
const isText = (type = '') => /json|text|xml/i.test(type);

function serialize(cache, maxBytes) {
  const rows = [...cache].sort((a, b) => b[1].fetchedAt - a[1].fetchedAt);
  const out = [];
  let bytes = 0;
  for (const [url, e] of rows) {
    bytes += e.body.byteLength;
    if (bytes > maxBytes) break;
    const text = isText(e.type);
    out.push([url, { ...e, body: e.body.toString(text ? 'utf8' : 'base64'), enc: text ? 'utf8' : 'base64' }]);
  }
  return Buffer.from(JSON.stringify({ v: 1, entries: out.reverse() })); // oldest first, like the Map
}

/** @returns {Promise<Map>} empty when there's no file or it can't be read */
export async function loadCache(file, { now = Date.now(), maxAge = MAX_AGE } = {}) {
  const cache = new Map();
  try {
    const { v, entries } = JSON.parse(await promisify(gunzip)(await readFile(file)));
    if (v !== 1) return cache;
    for (const [url, { enc, body, ...e }] of entries) {
      if (e.expires + maxAge < now) continue;
      cache.set(url, { ...e, body: Buffer.from(body, enc) });
    }
  } catch { /* missing or corrupt: start empty */ }
  return cache;
}

/** Writes to a temp file first, so a crash mid-save leaves the previous file intact. */
export async function saveCache(file, cache, { maxBytes = MAX_BYTES } = {}) {
  const data = await promisify(gzip)(serialize(cache, maxBytes));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, data);
  await rename(`${file}.tmp`, file);
}

/** For exit handlers, where async work never finishes. */
export function saveCacheSync(file, cache, { maxBytes = MAX_BYTES } = {}) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, gzipSync(serialize(cache, maxBytes)));
  renameSync(`${file}.tmp`, file);
}
