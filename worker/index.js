// Cloudflare Worker for the hosted site (wrangler.jsonc). The local node server (server.js) is
// unchanged; this does the same jobs at the edge:
//   - static pages from public/ (the assets binding)
//   - /api/{tycoon,esi,fuzzwork,…}/*: caching proxy, since EVE Tycoon, Goonmetrics, Adam4EVE and
//     Mokaam send no CORS headers (the others go through it too, for one cache and User-Agent)
//   - /sso/* and /api/me/*: EVE sign-in, one Session Durable Object per browser, keyed by an
//     HttpOnly cookie. Tokens stay in that object's storage and never reach the page.
//   - /api/config: tells the pages to run the market scans in the browser (public/js/scan-client.js)
//
// Settings (Workers → Settings → Variables): EVE_CLIENT_ID (enables sign-in), EVE_CALLBACK_URL
// (default: this site's /sso/callback), CONTACT (User-Agent contact for community APIs).

import { DurableObject } from 'cloudflare:workers';
import { createSso } from '../sso.js';

const UPSTREAMS = {
  tycoon: { base: 'https://evetycoon.com/api/', maxConcurrent: 3 },
  esi: { base: 'https://esi.evetech.net/latest/', maxConcurrent: 6 },
  fuzzwork: { base: 'https://market.fuzzwork.co.uk/', maxConcurrent: 2 },
  goon: { base: 'https://goonmetrics.apps.goonswarm.org/api/', maxConcurrent: 2 },
  adam4eve: { base: 'https://api.adam4eve.eu/v1/', maxConcurrent: 1, minInterval: 5_200, minTtl: 10 * 60_000 },
  evepraisal: { base: 'https://evepraisal.itworks.cc/', maxConcurrent: 2, minTtl: 5 * 60_000 },
  zkill: { base: 'https://zkillboard.com/api/', maxConcurrent: 1, minInterval: 1_000, minTtl: 3600_000 },
  mokaam: { base: 'https://mokaam.dk/API/market/', maxConcurrent: 1, minInterval: 1_000, minTtl: 3600_000 },
};
const POST_ALLOW = [/^esi\/universe\/ids\/$/, /^esi\/universe\/names\/$/];
const MIN_TTL = 60_000, DEFAULT_TTL = 5 * 60_000;
const MEM_BYTES = 24 * 1024 * 1024;   // per-isolate cache budget (isolates have 128 MB)
const COOKIE = 'eve_arbi_sid';

const json = (status, obj, headers = {}) => new Response(JSON.stringify(obj), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
});
const userAgent = (env) => {
  const contact = env.CONTACT ?? '';
  return `eve-arbi/1.0 (hosted market tool; read-only${contact ? `; ${contact}` : ''})`;
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;
    try {
      if (p === '/api/config') return json(200, { serverScans: false, sso: !!env.EVE_CLIENT_ID });
      const m = p.match(/^\/api\/(tycoon|esi|fuzzwork|goon|adam4eve|evepraisal|zkill|mokaam)\/(.*)$/);
      if (m) return await proxy(request, env, ctx, m[1], m[2] + url.search);
      if (p.startsWith('/sso/') || p === '/api/me' || p.startsWith('/api/me/')) return await account(request, env, url);
      if (/^\/api\/(scan|uscan|cscan)(\/|$)/.test(p)) return json(404, { error: 'Scans run in your browser on the hosted site' });
      if (p.startsWith('/api/')) return json(404, { error: 'Not found' });
      return env.ASSETS.fetch(request);
    } catch (e) {
      return json(500, { error: String(e.message || e) });
    }
  },
};

// ---------------------------------------------------------------------------
// Caching proxy. Two layers: this isolate's memory, then Cloudflare's cache (the Cache API only
// stores on a custom domain; on workers.dev it's a no-op and the memory layer does the work).
// ---------------------------------------------------------------------------
const mem = new Map();      // target URL → entry
let memBytes = 0;
const inflight = new Map();
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
  return Math.max(minTtl, exp - date);
}

function remember(target, entry) {
  const old = mem.get(target);
  if (old) { memBytes -= old.body.byteLength; mem.delete(target); }
  if (entry.body.byteLength > MEM_BYTES / 4) return;
  mem.set(target, entry);
  memBytes += entry.body.byteLength;
  for (const [k, v] of mem) { if (memBytes <= MEM_BYTES) break; mem.delete(k); memBytes -= v.body.byteLength; }
}

function respond(e, state) {
  return new Response(e.body, {
    status: e.status,
    headers: {
      'Content-Type': e.type, 'Cache-Control': 'no-store', 'X-Cache': state,
      'X-Fetched-At': new Date(e.fetchedAt).toISOString(), 'X-Expires-At': new Date(e.expires).toISOString(),
      ...(e.pages && { 'X-Pages': e.pages }), ...(e.lastModified && { 'X-Upstream-Modified': e.lastModified }),
    },
  });
}

async function fromEdgeCache(key) {
  const r = await caches.default.match(key).catch(() => null);
  if (!r) return null;
  return {
    status: r.status, body: await r.arrayBuffer(), type: r.headers.get('content-type') || 'application/json',
    expires: Number(r.headers.get('x-expires')) || 0, fetchedAt: Number(r.headers.get('x-fetched')) || Date.now(),
    pages: r.headers.get('x-pages'), lastModified: r.headers.get('x-upstream-modified'),
  };
}

async function proxy(request, env, ctx, name, rest) {
  const target = UPSTREAMS[name].base + rest;
  const headers = { 'User-Agent': userAgent(env), Accept: 'application/json' };

  if (request.method === 'POST') {
    if (!POST_ALLOW.some(rx => rx.test(`${name}/${rest.split('?')[0]}`))) return json(405, { error: 'Method not allowed' });
    const body = await request.arrayBuffer();
    const r = await withGate(name, () => fetch(target, {
      method: 'POST', body, headers: { ...headers, 'Content-Type': 'application/json' },
    }));
    return new Response(r.body, { status: r.status, headers: { 'Content-Type': r.headers.get('content-type') || 'application/json', 'X-Cache': 'BYPASS', 'Cache-Control': 'no-store' } });
  }
  if (request.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const now = Date.now();
  let hit = mem.get(target);
  if (hit && hit.expires > now) return respond(hit, 'HIT');
  const cacheKey = new Request(`${new URL(request.url).origin}/__proxy-cache/${name}/${rest}`);
  const edge = await fromEdgeCache(cacheKey);
  if (edge && edge.expires > now) { remember(target, edge); return respond(edge, 'HIT'); }
  hit ||= edge;

  let p = inflight.get(target);
  if (!p) {
    p = withGate(name, async () => {
      const r = await fetch(target, { headers });
      if (r.status === 429 || r.status === 420) gates[name].blockedUntil = Date.now() + (Number(r.headers.get('retry-after')) || 30) * 1000;
      const ttl = ttlFrom(r.headers, UPSTREAMS[name].minTtl);
      return {
        status: r.status, body: await r.arrayBuffer(), type: r.headers.get('content-type') || 'application/json',
        expires: Date.now() + ttl, fetchedAt: Date.now(), ttl,
        pages: r.headers.get('x-pages'), lastModified: r.headers.get('last-modified'),
      };
    }).finally(() => inflight.delete(target));
    inflight.set(target, p);
  }
  try {
    const e = await p;
    if (e.status >= 200 && e.status < 300) {
      remember(target, e);
      ctx.waitUntil(caches.default.put(cacheKey, new Response(e.body.slice(0), {
        status: e.status,
        headers: {
          'Content-Type': e.type, 'Cache-Control': `max-age=${Math.ceil(e.ttl / 1000)}`,
          'X-Expires': String(e.expires), 'X-Fetched': String(e.fetchedAt),
          ...(e.pages && { 'X-Pages': e.pages }), ...(e.lastModified && { 'X-Upstream-Modified': e.lastModified }),
        },
      })).catch(() => {}));
      return respond(e, 'MISS');
    }
    if (hit) return respond(hit, 'STALE'); // upstream error: fall back to the last good copy
    return new Response(e.body, { status: e.status, headers: { 'Content-Type': e.type, 'X-Cache': 'MISS', 'Cache-Control': 'no-store' } });
  } catch (err) {
    if (hit) return respond(hit, 'STALE');
    return json(502, { error: String(err.message || err) });
  }
}

// ---------------------------------------------------------------------------
// EVE sign-in: one Session Durable Object per browser
// ---------------------------------------------------------------------------
const sidOf = (request) => {
  const m = (request.headers.get('cookie') || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([0-9a-f]{64})(?:;|$)`));
  return m ? m[1] : null;
};
const newSid = () => [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, '0')).join('');
const sidCookie = (sid, url, maxAge = 90 * 86400) =>
  `${COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${url.protocol === 'https:' ? '; Secure' : ''}`;

function page(status, title, msg) {
  const esc = (s) => String(s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  return new Response(`<!doctype html><meta charset="utf-8"><title>${esc(title)}</title>
    <body style="font:15px system-ui;background:#0b0f14;color:#dbe4ee;padding:40px"><h1 style="font-size:20px">${esc(title)}</h1>
    <p>${esc(msg)}</p><p><a style="color:#2dd4bf" href="/market.html">Back to the dashboard</a></p></body>`,
  { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

async function account(request, env, url) {
  const callbackUrl = env.EVE_CALLBACK_URL || `${url.origin}/sso/callback`;
  const notConfigured = { configured: false, callbackUrl, loggedIn: false, characterId: null, name: null, scopes: [],
    hint: `Set the EVE_CLIENT_ID variable on the Worker (app callback: ${callbackUrl})` };
  let sid = sidOf(request);
  const stub = () => env.SESSIONS.get(env.SESSIONS.idFromName(sid));
  const run = (op, ...args) => stub().run(callbackUrl, op, args);
  const p = url.pathname;

  if (p === '/sso/login') {
    if (!env.EVE_CLIENT_ID) return page(503, 'Sign-in not set up', notConfigured.hint);
    const fresh = !sid;
    sid ||= newSid();
    const r = await run('loginUrl', url.searchParams.get('return') || '/market.html');
    if (r.error) return page(r.status, 'Sign-in failed', r.error);
    return new Response(null, { status: 302, headers: { Location: r.value, 'Cache-Control': 'no-store', ...(fresh && { 'Set-Cookie': sidCookie(sid, url) }) } });
  }
  if (p === '/sso/callback') {
    if (url.searchParams.get('error')) return page(400, 'Sign-in cancelled', 'EVE login did not complete. You can try again from the dashboard.');
    if (!sid) return page(400, 'Sign-in failed', 'Your browser did not send the sign-in cookie — allow cookies for this site and try again.');
    const r = await run('finishLogin', { code: url.searchParams.get('code'), state: url.searchParams.get('state') });
    if (r.error) return page(r.status, 'Sign-in failed', r.error);
    return new Response(null, { status: 302, headers: { Location: r.value.returnTo, 'Cache-Control': 'no-store' } });
  }
  if (p === '/api/me' && request.method === 'GET') {
    if (!env.EVE_CLIENT_ID) return json(200, notConfigured);
    if (!sid) return json(200, { configured: true, callbackUrl, loggedIn: false, characterId: null, name: null, scopes: [] });
    const r = await run('status');
    return r.error ? json(r.status, { error: r.error }) : json(200, r.value);
  }
  if (p === '/api/me/logout' && request.method === 'POST') {
    // A custom header can't be sent cross-site without a CORS preflight, which we never grant.
    if (request.headers.get('x-eve-arbi') !== '1') return json(403, { error: 'Forbidden' });
    if (sid) await run('logout');
    return json(200, { loggedIn: false }, { 'Set-Cookie': sidCookie('', url, 0) });
  }
  if (request.method === 'GET') {
    const op = { '/api/me/location': 'location', '/api/me/online': 'online', '/api/me/ship': 'ship',
      '/api/me/wallet': 'wallet', '/api/me/orders': 'orders' }[p];
    const st = p.match(/^\/api\/me\/structure\/(\d+)$/);
    if (op || st) {
      if (!sid) return json(401, { error: 'Not signed in' });
      const types = (url.searchParams.get('types') || '').split(',').map(Number).filter(n => n > 0);
      const r = op ? await run(op) : await run('structureMarket', Number(st[1]), types.length ? types : null);
      return r.error ? json(r.status, { error: r.error }) : json(200, r.value);
    }
  }
  return json(404, { error: 'Not found' });
}

// One browser's EVE login: sso.js with its tokens in this object's storage.
export class Session extends DurableObject {
  #sso = null;
  #callbackUrl = null;

  #client(callbackUrl) {
    if (!this.#sso || this.#callbackUrl !== callbackUrl) {
      const storage = this.ctx.storage;
      this.#callbackUrl = callbackUrl;
      this.#sso = createSso({
        clientId: this.env.EVE_CLIENT_ID || '', callbackUrl, userAgent: userAgent(this.env), log: () => {},
        store: { get: (k) => storage.get(k), put: (k, v) => storage.put(k, v), delete: (k) => storage.delete(k) },
      });
    }
    return this.#sso;
  }

  /** RPC from the Worker: returns {value} or {error, status}, since thrown errors lose their status. */
  async run(callbackUrl, op, args = []) {
    const allowed = ['status', 'loginUrl', 'finishLogin', 'location', 'online', 'ship', 'wallet', 'orders', 'structureMarket', 'logout'];
    if (!allowed.includes(op)) return { error: 'Unknown operation', status: 400 };
    const sso = this.#client(callbackUrl);
    try {
      const value = await sso[op](...args);
      if (op === 'logout') { await this.ctx.storage.deleteAll(); this.#sso = null; }
      return { value: value ?? null };
    } catch (e) {
      return { error: e.message || String(e), status: e.status || 502 };
    }
  }
}
