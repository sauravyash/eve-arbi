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
    req.onsuccess = () => {
      // Let another tab upgrade or delete the database instead of blocking it.
      req.result.onversionchange = () => { req.result.close(); dbP = null; };
      resolve(req.result);
    };
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
// The hosted site can share contract contents between visitors (worker/index.js, D1).
const config = fetch(new URL('/api/config', self.location)).then(r => (r.ok ? r.json() : {})).catch(() => ({}));
async function sharedItems(contracts) {
  const res = await fetch(new URL('/api/contract-items', self.location), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contracts }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
const scannerFor = (kind) => (scanners[kind] ||= config.then(c => FACTORIES[kind]({
  fetchUpstream, data, store, log, ...(c.sharedContracts && kind === 'cscan' && { sharedItems }),
})));

// Tabs of the same site share IndexedDB but each runs its own worker, so they keep each other up to
// date over a BroadcastChannel:
//   {type: 'progress', kind, status}  sent every second by the tab running a scan
//   {type: 'done', kind}              sent once its result is saved; the others reload from IndexedDB
//   {type: 'hello'}                   sent by a new worker, answered with 'progress' by running tabs
// A Web Lock per kind makes sure only one tab scans at a time. The page hears about changes it
// didn't ask for as {event: 'started'|'done', kind}.
const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('eve-arbi-scans') : null;
const REMOTE_TTL = 5000;   // a tab closed mid-scan stops sending progress; forget it after this
const remote = {};         // kind → {status, at}: a scan running in another tab
const running = {};        // kind → scanner: scans running in this tab
const busy = (st) => st?.state === 'running' || st?.state === 'computing';
const remoteStatus = (kind) => (remote[kind] && Date.now() - remote[kind].at < REMOTE_TTL ? remote[kind].status : null);
const notify = (event, kind) => self.postMessage({ event, kind });

if (channel) {
  channel.onmessage = ({ data: msg }) => {
    const { type, kind } = msg || {};
    if (type === 'hello') {
      for (const [k, s] of Object.entries(running)) channel.postMessage({ type: 'progress', kind: k, status: s.status() });
    } else if (type === 'progress' && FACTORIES[kind]) {
      const was = remoteStatus(kind);
      remote[kind] = { status: msg.status, at: Date.now() };
      if (!was) notify('started', kind);
    } else if (type === 'done' && FACTORIES[kind]) {
      delete remote[kind];
      // Drop the scanner so the next request builds a new one from what the other tab saved.
      if (!running[kind]) delete scanners[kind];
      notify('done', kind);
    }
  };
  channel.postMessage({ type: 'hello' });
}

// Resolves with a release function, or null when another tab holds the lock.
function tryLock(kind) {
  if (!self.navigator?.locks) return Promise.resolve(() => {});
  return new Promise((resolve, reject) => {
    navigator.locks.request(`eve-arbi-scan:${kind}`, { ifAvailable: true }, (lock) => {
      if (!lock) { resolve(null); return undefined; }
      return new Promise(release => resolve(release));
    }).catch(reject);
  });
}

// Tell the other tabs how the scan is going until it has finished and saved its result.
function announce(kind, s, release) {
  running[kind] = s;
  const send = () => channel?.postMessage({ type: 'progress', kind, status: s.status() });
  send();
  const timer = setInterval(send, 1000);
  s.idle().finally(() => {
    clearInterval(timer);
    delete running[kind];
    release();
    channel?.postMessage({ type: 'done', kind });
  });
}

const OPS = {
  async status(s, kind) {
    await s.ready;
    const own = s.status(), other = !busy(own) && remoteStatus(kind);
    return other ? { ...other, remote: true, result: own.result } : own;
  },
  async result(s) { await s.ready; return s.result(); },
  async start(s, kind, opts = {}) {
    await s.ready;
    const args = {
      force: opts.force === true || opts.force === '1',
      ...(opts.scope != null && { scope: opts.scope }),
      ...(opts.minPrice != null && { minPrice: Number(opts.minPrice) }),
    };
    if (busy(s.status())) return { ...(await s.start(args)), ...s.status() };
    const release = await tryLock(kind);
    if (!release) {
      const other = remoteStatus(kind) || { state: 'running', done: 0, total: 0, warnings: [] };
      return { started: false, reason: 'running', ...other, remote: true };
    }
    let outcome;
    try { outcome = await s.start(args); } catch (e) { release(); throw e; }
    if (outcome.started) announce(kind, s, release); else release();
    return { ...outcome, ...s.status() };
  },
};

self.onmessage = async ({ data: { id, kind, op, opts } }) => {
  try {
    if (!FACTORIES[kind] || !OPS[op]) throw new Error(`Unknown scan request ${kind}/${op}`);
    self.postMessage({ id, value: await OPS[op](await scannerFor(kind), kind, opts) });
  } catch (e) {
    self.postMessage({ id, error: e.message || String(e) });
  }
};
