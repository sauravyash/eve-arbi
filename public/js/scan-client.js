// One interface to the scans for every page:
//   - with the local node server (npm start), the scans run there: /api/{scan,uscan,cscan}
//   - without one (the Cloudflare build), they run in this browser, in a Web Worker
//     (scan/scan-worker.js), and results are kept in IndexedDB
// /api/config tells them apart.
//
//   const uscan = scanClient('uscan');
//   await uscan.status(); await uscan.start({ force: '1' }); await uscan.result();
//   uscan.onChange(({ type }) => …);   // another tab started ('started') or finished ('done') a scan
//
// Open tabs keep each other up to date (scan/scan-worker.js has the details), so a scan started in
// one tab shows its progress in the others, and they pick up its result when it's done.

let modeP = null;
let browserMode = false;
// Shown while a scan runs in this browser: it lives in the Web Worker of the tab that started it.
export const tabNote = (st) => (st?.remote ? ' · running in another tab' : browserMode ? ' · runs in this tab, keep it open' : '');

// Scan progress in a <div class="progress"><i></i></div>: a filling bar while pages are counted, a
// sliding one while the total isn't known yet, while matching, or while a result is `loading`.
export function showProgress(bar, st, loading = false) {
  const busy = st?.state === 'running' || st?.state === 'computing';
  const known = busy && st.state === 'running' && st.total > 0;
  bar.hidden = !busy && !loading;
  bar.classList.toggle('indeterminate', !bar.hidden && !known);
  bar.firstElementChild.style.width = known ? `${Math.min(100, Math.round(100 * st.done / st.total))}%` : '';
}

const listeners = { scan: new Set(), uscan: new Set(), cscan: new Set() };
const emit = (kind, type) => { for (const cb of listeners[kind] || []) { try { cb({ type }); } catch (e) { console.error(e); } } };
// With the scan server, a tab starting a scan tells the others so they start polling it too.
const pages = typeof BroadcastChannel === 'function' ? new BroadcastChannel('eve-arbi-scan-pages') : null;
if (pages) pages.onmessage = ({ data }) => { if (data?.kind) emit(data.kind, 'started'); };
export const scanMode = () => (modeP ||= fetch('/api/config')
  .then(r => (r.ok ? r.json() : {})).then(c => { browserMode = !c.serverScans; return browserMode ? 'browser' : 'server'; }).catch(() => { browserMode = true; return 'browser'; }));

let worker = null, seq = 0;
const pending = new Map();
function call(kind, op, opts) {
  if (!worker) {
    worker = new Worker(new URL('./scan/scan-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data: { id, value, error, event, kind } }) => {
      if (event) { emit(kind, event); return; }
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
      const res = await serverJson(`/api/${kind}${q.size ? `?${q}` : ''}`, { method: 'POST' });
      if (res.started) pages?.postMessage({ kind });
      return res;
    },
    /** The latest result, or null when there's none yet. */
    async result() {
      if ((await scanMode()) !== 'server') return call(kind, 'result');
      try { return await serverJson(`/api/${kind}/result`); } catch (e) { if (e.status === 404) return null; throw e; }
    },
    /** Hear about scans other tabs start ('started') and finish ('done'). Returns an unsubscribe. */
    onChange(cb) {
      listeners[kind].add(cb);
      // In the browser the worker is what listens to the other tabs, so make sure there is one.
      scanMode().then(m => { if (m === 'browser') call(kind, 'status').catch(() => {}); });
      return () => listeners[kind].delete(cb);
    },
  };
}
