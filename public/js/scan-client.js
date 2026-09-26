// One interface to the scans for every page:
//   - with the local node server (npm start), the scans run there: /api/{scan,uscan,cscan}
//   - without one (the Cloudflare build), they run in this browser, in a Web Worker
//     (scan/scan-worker.js), and results are kept in IndexedDB
// /api/config tells them apart.
//
//   const uscan = scanClient('uscan');
//   await uscan.status(); await uscan.start({ force: '1' }); await uscan.result();

let modeP = null;
let browserMode = false;
// Shown while a scan runs in this browser: it lives in this tab's Web Worker.
export const tabNote = () => (browserMode ? ' · runs in this tab, keep it open' : '');
export const scanMode = () => (modeP ||= fetch('/api/config')
  .then(r => (r.ok ? r.json() : {})).then(c => { browserMode = !c.serverScans; return browserMode ? 'browser' : 'server'; }).catch(() => { browserMode = true; return 'browser'; }));

let worker = null, seq = 0;
const pending = new Map();
function call(kind, op, opts) {
  if (!worker) {
    worker = new Worker(new URL('./scan/scan-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data: { id, value, error } }) => {
      const p = pending.get(id);
      pending.delete(id);
      if (error) p?.reject(new Error(error)); else p?.resolve(value);
    };
    worker.onerror = (e) => { for (const p of pending.values()) p.reject(new Error(e.message || 'Scan worker failed')); pending.clear(); };
  }
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, kind, op, opts });
  });
}

async function serverJson(url, init) {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || `HTTP ${res.status}`), { status: res.status });
  return body;
}

/** @param {'scan'|'uscan'|'cscan'} kind  hub market, universe or contract scan */
export function scanClient(kind) {
  return {
    async status() {
      return (await scanMode()) === 'server' ? serverJson(`/api/${kind}`) : call(kind, 'status');
    },
    /** @param {{force?: '1', scope?: string, minPrice?: number}} [opts] */
    async start(opts = {}) {
      if ((await scanMode()) !== 'server') return call(kind, 'start', opts);
      const q = new URLSearchParams(Object.entries(opts).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]));
      return serverJson(`/api/${kind}${q.size ? `?${q}` : ''}`, { method: 'POST' });
    },
    /** The latest result, or null when there's none yet. */
    async result() {
      if ((await scanMode()) !== 'server') return call(kind, 'result');
      try { return await serverJson(`/api/${kind}/result`); } catch (e) { if (e.status === 404) return null; throw e; }
    },
  };
}
