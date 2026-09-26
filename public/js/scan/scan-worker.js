// Browser runtime for the scans (used when there's no scan server, e.g. on Cloudflare): runs the
// same scanner modules as server.js inside a Web Worker, calling ESI directly (it sends CORS
// headers) and keeping results in IndexedDB, so a scan survives reloads.
//
// Messages in:  {id, kind: 'scan'|'uscan'|'cscan', op: 'status'|'start'|'result', opts}
// Messages out: {id, value} or {id, error}

import { createScanner } from './hub-scanner.js';
import { createUniverseScanner } from './universe-scanner.js';
import { createContractScanner } from './contract-scanner.js';

// Parallel requests per lane; the scanners pick the lane ('esic' = contract contents).
const LANES = { esi: 8, esic: 16 };
const gates = {};

async function withGate(name, fn) {
  const g = gates[name] ||= { active: 0, queue: [], blockedUntil: 0 };
  while (g.active >= (LANES[name] || 4) || Date.now() < g.blockedUntil) {
    if (Date.now() < g.blockedUntil) await new Promise(r => setTimeout(r, Math.min(g.blockedUntil - Date.now(), 5000)));
    else await new Promise(r => g.queue.push(r));
  }
  g.active++;
  try { return await fn(); }
  finally { g.active--; g.queue.shift()?.(); }
}

// Same result shape as server.js fetchUpstream. Browsers don't let pages set User-Agent.
async function fetchUpstream(name, url) {
  return withGate(name, async () => {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (res.status === 429 || res.status === 420) {
      const ra = Number(res.headers.get('retry-after')) || 30;
      gates[name].blockedUntil = Date.now() + ra * 1000;
    }
    const body = await res.text();
    const exp = Date.parse(res.headers.get('expires') || '');
    const remain = res.headers.get('x-esi-error-limit-remain');
    return {
      status: res.status, body, pages: res.headers.get('x-pages'),
      expiresAt: Number.isNaN(exp) ? Date.now() + 5 * 60_000 : Math.max(exp, Date.now() + 60_000),
      ...(remain != null && { errorRemain: Number(remain), errorReset: Number(res.headers.get('x-esi-error-limit-reset')) }),
    };
  });
}

const dataCache = {};
const data = (name) => (dataCache[name] ||= fetch(new URL(`../../data/${name}.json`, import.meta.url))
  .then(r => { if (!r.ok) throw new Error(`data/${name}.json: HTTP ${r.status}`); return r.json(); }));

// Minimal IndexedDB key-value store.
let dbP = null;
function db() {
  return dbP ||= new Promise((resolve, reject) => {
    const req = indexedDB.open('eve-arbi', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function tx(mode, fn) {
  return db().then(d => new Promise((resolve, reject) => {
    const t = d.transaction('kv', mode);
    const req = fn(t.objectStore('kv'));
    t.oncomplete = () => resolve(req.result);
    t.onerror = t.onabort = () => reject(t.error);
  }));
}
const store = {
  get: (key) => tx('readonly', s => s.get(key)).catch(() => undefined),
  put: (key, value) => tx('readwrite', s => s.put(value, key)),
};

const log = (...a) => console.debug('[scan]', ...a);
const FACTORIES = { scan: createScanner, uscan: createUniverseScanner, cscan: createContractScanner };
const scanners = {};
const scannerFor = (kind) => (scanners[kind] ||= FACTORIES[kind]({ fetchUpstream, data, store, log }));

const OPS = {
  async status(s) { await s.ready; return s.status(); },
  async result(s) { await s.ready; return s.result(); },
  async start(s, opts = {}) {
    const outcome = await s.start({
      force: opts.force === true || opts.force === '1',
      ...(opts.scope != null && { scope: opts.scope }),
      ...(opts.minPrice != null && { minPrice: Number(opts.minPrice) }),
    });
    return { ...outcome, ...s.status() };
  },
};

self.onmessage = async ({ data: { id, kind, op, opts } }) => {
  try {
    if (!FACTORIES[kind] || !OPS[op]) throw new Error(`Unknown scan request ${kind}/${op}`);
    self.postMessage({ id, value: await OPS[op](scannerFor(kind), opts) });
  } catch (e) {
    self.postMessage({ id, error: e.message || String(e) });
  }
};
