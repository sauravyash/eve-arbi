// Zero-dependency local server: static files + caching proxy for EVE Tycoon, ESI, Fuzzwork and Goonmetrics.
// EVE Tycoon and Goonmetrics send no CORS headers, so the browser can't call them directly.
// The proxy honours upstream Expires, dedupes in-flight requests, caps concurrency,
// and backs off on 429/420 using Retry-After.

import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
import { buildUniverse, buildTypes, buildStations, OUT_FILE as UNIVERSE_FILE, TYPES_FILE, STATIONS_FILE } from './scripts/build-universe.js';
import { createUniverseScanner, hubView } from './public/js/scan/universe-scanner.js';
import { createContractScanner } from './public/js/scan/contract-scanner.js';
import { createSso } from './sso.js';
import { cleanItems } from './public/js/watchlist.js';
import { wandererConnections } from './wanderer.js';
import { loadCache, saveCache, saveCacheSync } from './proxy-store.js';
import { createDemandStore, parseRegions } from './public/js/demand-store.js';

const PORT = Number(process.env.PORT) || 8000;
const HOST = process.env.HOST || '127.0.0.1';
const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(APP_DIR, 'public');
// Community APIs (Adam4EVE, Evepraisal) ask for a way to reach the operator in the User-Agent.
// Override with CONTACT (e.g. an EVE character name); CONTACT="" sends none.
const CONTACT = process.env.CONTACT ?? 'yash@yaa.sh';
// Scan server for the hosted site (README, "Scans on your own server"): with SCAN_SECRET set, only
// requests addressed to this machine, or carrying the secret (the Worker's), are answered.
const SCAN_SECRET = process.env.SCAN_SECRET || '';
const USER_AGENT = `eve-arbi/1.0 (local market tool; read-only${CONTACT ? `; ${CONTACT}` : ''})`;

const UPSTREAMS = {
  tycoon: { base: 'https://evetycoon.com/api/', maxConcurrent: 3 },
  esi: { base: 'https://esi.evetech.net/latest/', maxConcurrent: 6 },
  // Contract contents (one call per contract, contract-scanner.js only): its own lane so a
  // contract scan doesn't starve the pages' ESI calls.
  esic: { base: 'https://esi.evetech.net/latest/', maxConcurrent: 16 },
  fuzzwork: { base: 'https://market.fuzzwork.co.uk/', maxConcurrent: 2 },
  goon: { base: 'https://goonmetrics.apps.goonswarm.org/api/', maxConcurrent: 2 },
  // Community APIs with published limits: minInterval spaces requests out, minTtl stops re-polling
  // data that only changes every few minutes/hours.
  adam4eve: { base: 'https://api.adam4eve.eu/v1/', maxConcurrent: 1, minInterval: 5_200, minTtl: 10 * 60_000 },
  evepraisal: { base: 'https://evepraisal.itworks.cc/', maxConcurrent: 2, minTtl: 5 * 60_000 },
  zkill: { base: 'https://zkillboard.com/api/', maxConcurrent: 1, minInterval: 1_000, minTtl: 3600_000 },
  mokaam: { base: 'https://mokaam.dk/API/market/', maxConcurrent: 1, minInterval: 1_000, minTtl: 3600_000 },
};
// The only non-GET calls allowed: ESI name ↔ ID resolution (public, unauthenticated).
const POST_ALLOW = [/^esi\/universe\/ids\/$/, /^esi\/universe\/names\/$/];

const MIN_TTL = 60_000, DEFAULT_TTL = 5 * 60_000, MAX_ENTRIES = 1000;
// url -> {status, body, type, expires, fetchedAt}; kept in .cache so it survives restarts
const PROXY_CACHE_FILE = path.join(APP_DIR, '.cache', 'proxy-cache.json.gz');
const cache = await loadCache(PROXY_CACHE_FILE);
const inflight = new Map(); // url -> Promise

// Saved 30 s after the first change since the last save, and on exit.
let saveTimer = null, dirty = false;
function cacheChanged() {
  dirty = true;
  saveTimer ||= setTimeout(() => {
    saveTimer = null; dirty = false;
    saveCache(PROXY_CACHE_FILE, cache).catch(e => console.warn(`Proxy cache not saved: ${e.message}`));
  }, 30_000);
  saveTimer.unref();
}
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (dirty) try { saveCacheSync(PROXY_CACHE_FILE, cache); } catch (e) { console.warn(`Proxy cache not saved: ${e.message}`); }
    process.exit(0);
  });
}

// --- per-upstream concurrency gate with Retry-After backoff -----------------
const gates = Object.fromEntries(Object.keys(UPSTREAMS).map(k => [k, { active: 0, queue: [], blockedUntil: 0, lastStart: 0 }]));

async function withGate(name, fn) {
  const g = gates[name];
  const { maxConcurrent, minInterval = 0 } = UPSTREAMS[name];
  while (g.active >= maxConcurrent || Date.now() < Math.max(g.blockedUntil, g.lastStart + minInterval)) {
    const wait = Math.max(0, g.blockedUntil - Date.now(), g.active < maxConcurrent ? g.lastStart + minInterval - Date.now() : 0);
    if (wait > 0) await new Promise(r => setTimeout(r, Math.min(wait, 5000)));
    else await new Promise(r => g.queue.push(r));
  }
  g.active++;
  g.lastStart = Date.now();
  try { return await fn(); }
  finally { g.active--; g.queue.shift()?.(); }
}

function ttlFrom(headers, minTtl = MIN_TTL) {
  const exp = Date.parse(headers.get('expires') || '');
  const date = Date.parse(headers.get('date') || '') || Date.now();
  if (Number.isNaN(exp)) return Math.max(minTtl, DEFAULT_TTL);
  return Math.max(minTtl, exp - date); // use upstream clock delta to avoid local skew
}

async function fetchUpstream(name, url, init = {}) {
  return withGate(name, async () => {
    const res = await fetch(url, {
      ...init,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...init.headers },
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 429 || res.status === 420) {
      const ra = Number(res.headers.get('retry-after')) || 30;
      gates[name].blockedUntil = Date.now() + ra * 1000;
      console.warn(`[${name}] rate limited, backing off ${ra}s`);
    }
    const body = Buffer.from(await res.arrayBuffer());
    const ttl = ttlFrom(res.headers, UPSTREAMS[name].minTtl);
    return {
      status: res.status, body, type: res.headers.get('content-type') || 'application/json', ttl,
      pages: res.headers.get('x-pages'), lastModified: res.headers.get('last-modified'), expiresAt: Date.now() + ttl,
      ...(res.headers.has('x-esi-error-limit-remain') && {
        errorRemain: Number(res.headers.get('x-esi-error-limit-remain')), errorReset: Number(res.headers.get('x-esi-error-limit-reset')),
      }),
    };
  });
}

async function proxy(req, res, name, rest) {
  const upstream = UPSTREAMS[name];
  const url = upstream.base + rest;

  if (req.method === 'POST') {
    if (!POST_ALLOW.some(rx => rx.test(`${name}/${rest.split('?')[0]}`))) return send(res, 405, 'Method not allowed');
    const chunks = []; for await (const c of req) chunks.push(c);
    try {
      const r = await fetchUpstream(name, url, { method: 'POST', body: Buffer.concat(chunks), headers: { 'Content-Type': 'application/json' } });
      return send(res, r.status, r.body, { 'Content-Type': r.type, 'X-Cache': 'BYPASS' });
    } catch (e) { return send(res, 502, JSON.stringify({ error: String(e.message || e) }), { 'Content-Type': 'application/json' }); }
  }
  if (req.method !== 'GET') return send(res, 405, 'Method not allowed');

  const hit = cache.get(url);
  if (hit && hit.expires > Date.now()) return sendCached(res, hit, 'HIT');

  let p = inflight.get(url);
  if (!p) {
    p = fetchUpstream(name, url).finally(() => inflight.delete(url));
    inflight.set(url, p);
  }
  try {
    const r = await p;
    if (r.status >= 200 && r.status < 300) {
      const entry = { status: r.status, body: r.body, type: r.type, expires: Date.now() + r.ttl, fetchedAt: Date.now(),
                      pages: r.pages, lastModified: r.lastModified };
      cache.set(url, entry);
      if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
      cacheChanged();
      return sendCached(res, entry, 'MISS');
    }
    if (hit) return sendCached(res, hit, 'STALE'); // upstream error: fall back to last good copy
    return send(res, r.status, r.body, { 'Content-Type': r.type, 'X-Cache': 'MISS' });
  } catch (e) {
    if (hit) return sendCached(res, hit, 'STALE');
    return send(res, 502, JSON.stringify({ error: String(e.message || e) }), { 'Content-Type': 'application/json' });
  }
}

// Fresh copies may be kept by the browser until the upstream expiry, so reloads and other tabs
// don't ask again. A stale fallback isn't kept: the next request should retry upstream.
const browserCache = (e, state) => {
  const left = Math.floor((e.expires - Date.now()) / 1000);
  return state !== 'STALE' && left > 0 ? `max-age=${left}` : 'no-store';
};

function sendCached(res, e, state) {
  send(res, e.status, e.body, {
    'Cache-Control': browserCache(e, state),
    'Content-Type': e.type,
    'X-Cache': state,
    'X-Fetched-At': new Date(e.fetchedAt).toISOString(),
    'X-Expires-At': new Date(e.expires).toISOString(),
    ...(e.pages && { 'X-Pages': e.pages }),
    ...(e.lastModified && { 'X-Upstream-Modified': e.lastModified }),
  });
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

// --- static files ------------------------------------------------------------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon' };

async function serveStatic(req, res, pathname) {
  const rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT + path.sep)) return send(res, 403, 'Forbidden');
  try {
    const body = await readFile(file);
    send(res, 200, body, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  } catch { send(res, 404, 'Not found'); }
}

// --- scans (public/js/scan/*; the Cloudflare build runs the same code in the browser) ----------
// Static data from public/data, results kept as .cache/{key}.json so they survive restarts.
const DATA_FILES = { types: TYPES_FILE, universe: UNIVERSE_FILE, stations: STATIONS_FILE };
// Built from the SDE on first start (bottom of this file). A scan that finds a file missing waits for
// that build, or starts one, instead of failing; a failed build is tried again by the next scan.
const BUILDS = { universe: buildUniverse, stations: buildStations, types: buildTypes };
const building = {};
const build = (name) => (building[name] ||= BUILDS[name]().finally(() => { building[name] = null; }));
const data = async (name) => {
  const read = async () => JSON.parse(await readFile(DATA_FILES[name], 'utf8'));
  try { return await read(); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  try { await build(name); } catch (e) { throw new Error(`${name}.json is missing and building it failed (${e.message}); retry with "npm run build:map"`); }
  return read();
};
const CACHE_DIR = path.join(APP_DIR, '.cache');
const store = {
  get: (key) => readFile(path.join(CACHE_DIR, `${key}.json`), 'utf8').then(JSON.parse, () => undefined),
  put: async (key, value) => {
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(path.join(CACHE_DIR, `${key}.json`), JSON.stringify(value));
  },
};

// Universe-wide scan: every region, every station (see universe-scanner.js).
const universeScanner = createUniverseScanner({ fetchUpstream, data, store, hubs: true });

// Whole-market scan: the five hubs, worked out from the universe scan's order book, so both share
// one set of ESI pages. (The browser build still runs hub-scanner.js on its own: it's smaller.)
const scanner = hubView(universeScanner);

// Public contracts valued against the hub markets (see contract-scanner.js).
const contractScanner = createContractScanner({ fetchUpstream, data, store });

// Regional demand: 90 days of ESI history per item and region, kept in .cache/demand/{typeId}.json.gz
// and re-fetched once a day per region (see demand-store.js).
const DEMAND_DIR = path.join(CACHE_DIR, 'demand');
const demandStore = createDemandStore({
  regionIds: async () => (await data('universe')).regions.map(r => r.id),
  fetchHistory: async (regionId, typeId) => {
    const r = await fetchUpstream('esi', `${UPSTREAMS.esi.base}markets/${regionId}/history/?type_id=${typeId}`);
    return { status: r.status, rows: r.status === 200 ? JSON.parse(r.body) : null };
  },
  load: async (typeId) => JSON.parse(gunzipSync(await readFile(path.join(DEMAND_DIR, `${typeId}.json.gz`)))),
  save: async (typeId, entry) => {
    await mkdir(DEMAND_DIR, { recursive: true });
    await writeFile(path.join(DEMAND_DIR, `${typeId}.json.gz`), gzipSync(JSON.stringify(entry)));
  },
});

async function demandApi(req, res, typeId, params) {
  if (req.method !== 'GET') return send(res, 405, 'Method not allowed');
  try {
    const body = Buffer.from(JSON.stringify(await demandStore.get(typeId, parseRegions(params.get('regions')))));
    const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    send(res, 200, gz ? gzipSync(body) : body, { 'Content-Type': 'application/json', ...(gz && { 'Content-Encoding': 'gzip' }) });
  } catch (e) {
    send(res, e.status || 502, JSON.stringify({ error: e.message }), { 'Content-Type': 'application/json' });
  }
}

// With SCAN_SECRET set, forced rescans from the hosted site's visitors wait this long after the last one.
const REMOTE_FORCE_GAP = 5 * 60_000;

async function scanApi(req, res, sub, search, scanner) {
  const json = (status, obj) => send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json' });
  if (sub === '' && req.method === 'GET') return json(200, scanner.status());
  if (sub === '' && req.method === 'POST') {
    const last = scanner.status().result?.finishedAt || 0;
    const force = search.get('force') === '1' && (!SCAN_SECRET || isLocalRequest(req) || Date.now() - last > REMOTE_FORCE_GAP);
    const outcome = await scanner.start({
      force,
      ...(search.has('scope') && { scope: search.get('scope') }),
      ...(search.has('minPrice') && { minPrice: Number(search.get('minPrice')) }),
    });
    return json(202, { ...outcome, ...scanner.status() });
  }
  if (sub === '/result' && req.method === 'GET') {
    const r = scanner.result();
    if (!r) return json(404, { error: 'No scan yet' });
    const body = Buffer.from(JSON.stringify(r));
    if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
      return send(res, 200, gzipSync(body), { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' });
    }
    return send(res, 200, body, { 'Content-Type': 'application/json' });
  }
  return json(405, { error: 'Method not allowed' });
}

// --- EVE SSO: sign in so the dashboards can follow your character's location ------------------
// Client ID from EVE_CLIENT_ID or sso.config.json ({"clientId": "…", "callbackUrl": "…"}).
const ssoConfig = await readFile(path.join(APP_DIR, 'sso.config.json'), 'utf8').then(JSON.parse).catch(() => ({}));
const sso = createSso({
  clientId: process.env.EVE_CLIENT_ID || ssoConfig.clientId || '',
  callbackUrl: process.env.EVE_CALLBACK_URL || ssoConfig.callbackUrl || `http://localhost:${PORT}/sso/callback`,
  tokenFile: path.join(APP_DIR, '.cache', 'sso.json'),
  userAgent: USER_AGENT,
  ...(Array.isArray(ssoConfig.scopes) && { scopes: ssoConfig.scopes }),
});

// Account endpoints answer only requests addressed to this machine (blocks DNS rebinding).
const isLocalHost = (host = '') => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host);
// Addressed to this machine and not relayed by Cloudflare: a tunnel may be set to rewrite Host, and a
// Worker's own requests carry CF-Worker.
const isLocalRequest = (req) => isLocalHost(req.headers.host)
  && !req.headers['cf-ray'] && !req.headers['cf-connecting-ip'] && !req.headers['cf-worker'];
const hasScanSecret = (req) => {
  const got = Buffer.from(String(req.headers['x-scan-secret'] || '')), want = Buffer.from(SCAN_SECRET);
  return got.length === want.length && timingSafeEqual(got, want);
};

// Watchlists of signed-in characters (public/js/watchlist.js): .cache/watchlists.json,
// {characterId: {hub: [...], market: [...]}}. Signed-out pages keep theirs in localStorage.
const WATCHLISTS_FILE = path.join(APP_DIR, '.cache', 'watchlists.json');
let watchlistWrite = Promise.resolve();

async function watchlistApi(req, name, json) {
  const st = await sso.status();
  if (!st.loggedIn) return json(401, { error: 'Not signed in' });
  const all = await readFile(WATCHLISTS_FILE, 'utf8').then(JSON.parse, () => ({}));
  const mine = all[st.characterId]?.[name];
  if (req.method === 'GET') return json(200, { items: mine ?? [], saved: mine !== undefined });
  if (req.method !== 'PUT') return json(405, { error: 'Method not allowed' });
  if (req.headers['x-eve-arbi'] !== '1') return json(403, { error: 'Forbidden' }); // no cross-site writes
  let body = '';
  for await (const c of req) { body += c; if (body.length > 64 * 1024) return json(413, { error: 'Too large' }); }
  let items;
  try { items = cleanItems(JSON.parse(body || '{}').items); } catch { return json(400, { error: 'Bad JSON' }); }
  // Writes queue up so two saves in a row can't interleave; one failing doesn't block the next.
  const write = watchlistWrite.then(async () => {
    const cur = await readFile(WATCHLISTS_FILE, 'utf8').then(JSON.parse, () => ({}));
    (cur[st.characterId] ||= {})[name] = items;
    await mkdir(path.dirname(WATCHLISTS_FILE), { recursive: true });
    await writeFile(WATCHLISTS_FILE, JSON.stringify(cur));
  });
  watchlistWrite = write.catch(() => {});
  await write;
  return json(200, { items, saved: true });
}

async function ssoApi(req, res, u) {
  const json = (status, obj) => send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json' });
  const page = (status, title, msg) => send(res, status, `<!doctype html><meta charset="utf-8"><title>${title}</title>
    <body style="font:15px system-ui;background:#0b0f14;color:#dbe4ee;padding:40px"><h1 style="font-size:20px">${title}</h1>
    <p>${msg}</p><p><a style="color:#2dd4bf" href="/">Back to the dashboard</a></p></body>`, { 'Content-Type': 'text/html; charset=utf-8' });
  if (!isLocalHost(req.headers.host)) return send(res, 403, 'Forbidden');
  try {
    if (u.pathname === '/sso/login') {
      res.writeHead(302, { Location: sso.loginUrl(u.searchParams.get('return') || '/'), 'Cache-Control': 'no-store' });
      return res.end();
    }
    if (u.pathname === '/sso/callback') {
      if (u.searchParams.get('error')) return page(400, 'Sign-in cancelled', 'EVE login did not complete. You can try again from the dashboard.');
      const { returnTo } = await sso.finishLogin({ code: u.searchParams.get('code'), state: u.searchParams.get('state') });
      res.writeHead(302, { Location: returnTo, 'Cache-Control': 'no-store' });
      return res.end();
    }
    if (u.pathname === '/api/me' && req.method === 'GET') return json(200, await sso.status());
    const wl = u.pathname.match(/^\/api\/me\/watchlists\/(hub|market)$/);
    if (wl) return await watchlistApi(req, wl[1], json);
    if (req.method === 'GET') {
      if (u.pathname === '/api/me/location') return json(200, await sso.location());
      if (u.pathname === '/api/me/online') return json(200, await sso.online());
      if (u.pathname === '/api/me/ship') return json(200, await sso.ship());
      if (u.pathname === '/api/me/wallet') return json(200, await sso.wallet());
      if (u.pathname === '/api/me/orders') return json(200, await sso.orders());
      if (u.pathname === '/api/me/assets') return json(200, await sso.assets());
      if (u.pathname === '/api/me/mining') return json(200, await sso.mining());
      if (u.pathname === '/api/me/corporation') return json(200, await sso.corporation());
      const st = u.pathname.match(/^\/api\/me\/structure\/(\d+)$/);
      if (st) {
        const types = (u.searchParams.get('types') || '').split(',').map(Number).filter(n => n > 0);
        return json(200, await sso.structureMarket(Number(st[1]), types.length ? types : null));
      }
    }
    if (u.pathname === '/api/me/logout' && req.method === 'POST') {
      // A custom header can't be sent cross-site without a CORS preflight, which we never grant.
      if (req.headers['x-eve-arbi'] !== '1') return json(403, { error: 'Forbidden' });
      await sso.logout();
      return json(200, { loggedIn: false });
    }
    return json(404, { error: 'Not found' });
  } catch (e) {
    if (u.pathname === '/api/config') send(res, 200, JSON.stringify({ serverScans: true }), { 'Content-Type': 'application/json' });
    else if (u.pathname.startsWith('/sso/')) return page(e.status || 502, 'Sign-in failed', String(e.message).replace(/[<>&]/g, ''));
    return json(e.status || 502, { error: e.message });
  }
}

http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const m = u.pathname.match(/^\/api\/(tycoon|esi|fuzzwork|goon|adam4eve|evepraisal|zkill|mokaam)\/(.*)$/);
  const scanMatch = u.pathname.match(/^\/api\/(scan|uscan|cscan)(\/result)?$/);
  const scanners = { scan: scanner, uscan: universeScanner, cscan: contractScanner };
  const demandMatch = u.pathname.match(/^\/api\/demand\/([1-9]\d{0,9})$/);
  try {
    if (SCAN_SECRET && !isLocalRequest(req) && !hasScanSecret(req)) send(res, 403, 'Forbidden');
    else if (u.pathname === '/api/config') send(res, 200, JSON.stringify({ serverScans: true }), { 'Content-Type': 'application/json' });
    else if (u.pathname.startsWith('/sso/') || u.pathname === '/api/me' || u.pathname.startsWith('/api/me/')) await ssoApi(req, res, u);
    else if (u.pathname === '/api/wanderer/connections') {
      // Carries a map token: only for pages on this machine, like the account endpoints.
      if (!isLocalHost(req.headers.host)) send(res, 403, 'Forbidden');
      else if (req.method !== 'GET') send(res, 405, 'Method not allowed');
      else {
        const r = await wandererConnections(u.searchParams, req.headers['x-wanderer-token'], USER_AGENT);
        send(res, r.status, r.body, { 'Content-Type': 'application/json' });
      }
    }
    else if (demandMatch) await demandApi(req, res, Number(demandMatch[1]), u.searchParams);
    else if (scanMatch) await scanApi(req, res, scanMatch[2] || '', u.searchParams, scanners[scanMatch[1]]);
    else if (m) await proxy(req, res, m[1], m[2] + u.search);
    else await serveStatic(req, res, u.pathname);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, 'Internal error');
  }
}).listen(PORT, HOST, () => console.log(`EVE hub arbitrage → http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`));

// Static data (changes only with new EVE content): build once if missing. Old-format star maps (no heights) are rebuilt too.
readFile(UNIVERSE_FILE, 'utf8').then(t => { if (!JSON.parse(t).systems?.z3) throw Object.assign(new Error('old format'), { old: true }); }).catch(why => build('universe').catch(e =>
  console.error(why.old
    ? `Star map rebuild failed (${e.message}); the 3D map will be flat until it succeeds. Retry with "npm run build:map".`
    : `Star map build failed (${e.message}). The schematic view still works; retry with "npm run build:map".`)));
access(STATIONS_FILE).catch(() => build('stations').catch(e =>
  console.error(`Station list build failed (${e.message}); the universe scan will show station IDs. Retry with "npm run build:map".`)));
// Item lists in an older format (Tritanium without its group and mining kind) are rebuilt too.
readFile(TYPES_FILE, 'utf8').then(t => { const tr = JSON.parse(t)[34]; if (typeof tr?.[3] !== 'number' || tr[4] !== 'mineral') throw new Error('old format'); }).catch(() => build('types').catch(e =>
  console.error(`Item list build failed (${e.message}); the market scan will show type IDs. Retry with "npm run build:map".`)));
